import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../src/db.mjs';
import {extendDatabase} from '../src/pos-extension.mjs';
import {installShopOps} from '../src/shop-ops.mjs';
import {recordContactConsent,shopManagementRoutes,enqueueCustomerMessage} from '../src/shop-management.mjs';
import {createNotificationService,notificationRoutes} from '../src/service-notifications.mjs';

function fixture(t,options={}) {
  const db=openDb(':memory:');extendDatabase(db);installShopOps(db);t.after(()=>db.close());
  const owner={id:Number(db.prepare("INSERT INTO users(username,password_hash,salt,role) VALUES('owner','hash','salt','owner')").run().lastInsertRowid),username:'owner',role:'owner'};
  const customer=Number(db.prepare("INSERT INTO customers(name,email) VALUES('Service Customer','customer@example.test')").run().lastInsertRowid);
  const workOrder=Number(db.prepare("INSERT INTO work_orders(customer_id,customer_name,ref_number,unit_label,stage,balance) VALUES(?,'Service Customer','WO-MAIL','Sea-Doo','Ready',100)").run(customer).lastInsertRowid);
  let time=Date.now(),calls=0;
  const mailProvider=async message=>{calls++;return {status:'provider_accepted',reference:`mock-${message.id}`};};
  const service=createNotificationService({db,now:()=>new Date(time),providerConfigured:true,mailProvider,...options});
  const wo=()=>db.prepare('SELECT * FROM work_orders WHERE id=?').get(workOrder);
  const grant=serviceEmail=>recordContactConsent(db,owner,customer,{serviceEmail,marketingEmail:false,source:'Customer repair intake choice'});
  return {db,owner,customer,workOrder,service,wo,grant,advance:ms=>time+=ms,calls:()=>calls};
}

test('service events queue durably, deduplicate retries and reject changed details under one identity',async t=>{
  const f=fixture(t);f.grant(true);
  const extra={eventId:'ready-change-1',portalUrl:'https://shop.example.test/portal/private-token'};
  const first=f.service.queueEvent('ready_for_pickup',f.wo(),extra),second=f.service.queueEvent('ready_for_pickup',f.wo(),extra);
  assert.equal(first.status,'queued');assert.equal(second.duplicate,true);assert.equal(first.messageId,second.messageId);
  const changed=f.service.queueEvent('ready_for_pickup',{...f.wo(),balance:150},extra);assert.equal(changed.status,'event_conflict');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_message_outbox').get().n,1);
  const sent=await f.service.dispatchDue();assert.equal(sent.results[0].status,'provider_accepted');assert.equal(f.calls(),1);
  await f.service.dispatchDue();assert.equal(f.calls(),1);
  assert.equal(f.service.queueEvent('ready_for_pickup',f.wo(),extra).status,'provider_accepted');
  assert.throws(()=>f.db.prepare('DELETE FROM service_notification_events').run(),/cannot be deleted/);
});

test('service consent blocks delivery, later grant promotes it, and withdrawal prevents queued mail',async t=>{
  const f=fixture(t);
  const blocked=f.service.queueEvent('customer_progress_update',f.wo(),{eventId:'update-1',title:'Pump inspected',body:'Ready for estimate'});
  assert.equal(blocked.status,'consent_required');await f.service.dispatchDue();assert.equal(f.calls(),0);
  f.grant(true);await f.service.dispatchDue();assert.equal(f.calls(),1);
  const next=f.service.queueEvent('ready_for_pickup',f.wo(),{eventId:'ready-2'});assert.equal(next.status,'queued');
  f.grant(false);await f.service.dispatchDue();assert.equal(f.calls(),1);
  assert.equal(f.db.prepare('SELECT status FROM customer_message_outbox WHERE id=?').get(next.messageId).status,'consent_required');
});

test('transient provider failures retry when due; unknown delivery outcomes never automatically resend',async t=>{
  let attempts=0;
  const f=fixture(t,{mailProvider:async()=>{attempts++;return attempts===1?{status:'provider_failed',retryable:true,error:'Temporary test failure'}:{status:'provider_accepted',reference:'mock-accepted'};}});
  f.grant(true);f.service.queueEvent('ready_for_pickup',f.wo(),{eventId:'retry-event'});
  assert.equal((await f.service.dispatchDue()).results[0].status,'retry_wait');
  assert.equal((await f.service.dispatchDue()).results.length,0);f.advance(61_000);
  assert.equal((await f.service.dispatchDue()).results[0].status,'provider_accepted');assert.equal(attempts,2);
  const uncertain=createNotificationService({db:f.db,providerConfigured:true,mailProvider:async()=>{attempts++;throw Error('Connection lost after possible provider acceptance');}});
  uncertain.queueEvent('customer_progress_update',f.wo(),{eventId:'unknown-event',title:'Update',body:'Please contact shop'});
  assert.equal((await uncertain.dispatchDue()).results[0].status,'delivery_unknown');
  await uncertain.dispatchDue();assert.equal(attempts,3);
});

test('provider configuration and valid customer links are prerequisites rather than fake success',async t=>{
  const f=fixture(t,{providerConfigured:false});f.grant(true);
  const queued=f.service.queueEvent('ready_for_pickup',f.wo(),{eventId:'unconfigured'});assert.equal(queued.status,'queued');
  assert.equal((await f.service.dispatchDue()).results[0].status,'waiting_provider');assert.equal(f.calls(),0);
  const unsafe=f.service.queueEvent('approval_requested',f.wo(),{eventId:'unsafe-link',approvalUrl:'http://shop.example.test/approval/token'});
  assert.equal(unsafe.status,'needs_review');assert.match(unsafe.notice,/HTTPS/);
  assert.equal(f.service.queueEvent('ready_for_pickup',{id:999,ref_number:'Imported without customer'},{eventId:'no-customer'}).status,'needs_review');
});

test('reminder drafts use explicit service consent and are not sent by automatic outbox processing',async t=>{
  const f=fixture(t);f.grant(true);
  const start=new Date(Date.now()+3600_000).toISOString(),end=new Date(Date.now()+7200_000).toISOString();
  f.db.prepare('INSERT INTO shop_appointments(customer_id,title,starts_at,ends_at,created_by) VALUES(?,?,?,?,?)').run(f.customer,'Diagnostic dropoff',start,end,f.owner.id);
  const drafts=f.service.createReminderDrafts();assert.equal(drafts.drafts.length,1);assert.equal(drafts.drafts[0].status,'draft');
  assert.equal(f.service.createReminderDrafts().drafts[0].duplicate,true);
  await f.service.dispatchDue();assert.equal(f.calls(),0);
  f.grant(false);assert.equal(f.service.createReminderDrafts().drafts.length,0);
});

test('notification batch and reminder draft endpoints require a manager and strict send confirmation',async t=>{
  const f=fixture(t);let user=null;
  const route=notificationRoutes({service:f.service,currentUser:()=>user,json:(res,status,value)=>{res.status=status;res.value=value;},readBody:async req=>req.body});
  const call=async(path,body={})=>{const res={};await route({method:'POST',body},res,path);return res;};
  assert.equal((await call('/api/management/reminders/drafts')).status,401);
  user={...f.owner,role:'advisor'};assert.equal((await call('/api/management/reminders/drafts')).status,403);
  user=f.owner;assert.equal((await call('/api/management/reminders/drafts')).status,201);
  assert.equal((await call('/api/management/messages/process-due',{confirmSend:'true'})).status,400);
  assert.equal((await call('/api/management/messages/process-due',{confirmSend:true})).status,200);
});


function appointmentFixture(f,notify=(event,wo,extra)=>f.service.queueEvent(event,wo,extra)){
  const start=new Date(Date.now()+3600_000).toISOString(),end=new Date(Date.now()+7200_000).toISOString();
  const id=Number(f.db.prepare('INSERT INTO shop_appointments(customer_id,title,starts_at,ends_at,created_by) VALUES(?,?,?,?,?)').run(f.customer,'Diagnostic dropoff',start,end,f.owner.id).lastInsertRowid);
  const routes=shopManagementRoutes({db:f.db,currentUser:()=>f.owner,json:(res,status,body)=>Object.assign(res,{status,body}),readBody:async req=>req.body,notify});
  const call=async(path,method,body)=>{const res={};await routes({method,body},res,path,new URL('http://test'+path));return res;};
  const change=body=>call(`/api/management/appointments/${id}`,'PATCH',{expectedRevision:1,reason:'Customer requested a change',...body});
  const queue=messageId=>call(`/api/management/messages/${messageId}/queue`,'POST',{confirmQueue:true});
  return {id,start,end,change,queue,call,row:messageId=>f.db.prepare('SELECT * FROM customer_message_outbox WHERE id=?').get(messageId)};
}

test('rescheduling invalidates the old queued reminder, queues a truthful change notice, and creates a new revision draft',async t=>{
  const f=fixture(t);f.grant(true);const a=appointmentFixture(f);
  const old=f.service.createReminderDrafts().drafts[0];
  assert.equal(a.row(old.messageId).appointment_id,a.id);assert.equal(a.row(old.messageId).appointment_revision,1);
  assert.equal((await a.queue(old.messageId)).status,200);
  const changed=await a.change({startsAt:new Date(Date.parse(a.start)+3600_000).toISOString(),endsAt:new Date(Date.parse(a.end)+3600_000).toISOString()});
  assert.equal(changed.status,200);assert.equal(changed.body.notification.status,'queued');assert.equal(changed.body.calendarSync,'local_only');
  assert.equal(a.row(old.messageId).status,'cancelled');
  const replacement=f.service.createReminderDrafts().drafts[0];assert.equal(replacement.status,'draft');assert.notEqual(replacement.messageId,old.messageId);
  assert.equal(a.row(replacement.messageId).appointment_revision,2);
  assert.equal((await a.queue(old.messageId)).status,409);
  await f.service.dispatchDue();assert.equal(f.calls(),1);
  assert.equal(a.row(old.messageId).attempts,0);assert.equal(a.row(replacement.messageId).attempts,0);
  assert.equal((await a.queue(replacement.messageId)).status,200);
  await f.service.dispatchDue();assert.equal(f.calls(),2);
});

test('cancellation invalidates draft and every pending reminder state and consent cannot revive it',async t=>{
  for(const status of ['draft','queued','waiting_provider','retry_wait','consent_required','provider_failed','needs_review'])await t.test(status,async t=>{
    const f=fixture(t);f.grant(true);const a=appointmentFixture(f),reminder=f.service.createReminderDrafts().drafts[0];
    f.db.prepare('UPDATE customer_message_outbox SET status=? WHERE id=?').run(status,reminder.messageId);
    const changed=await a.change({status:'cancelled'});assert.equal(changed.status,200);
    assert.equal(a.row(reminder.messageId).status,'cancelled');assert.equal(f.service.createReminderDrafts().drafts.length,0);
    f.grant(false);f.grant(true);await f.service.dispatchDue();
    assert.equal(a.row(reminder.messageId).attempts,0);assert.equal(f.calls(),1); // Only the cancellation notice.
    assert.match(a.row(changed.body.notification.messageId).message,/cancelled/);
    assert.equal((await a.queue(reminder.messageId)).status,409);
  });
});

test('dispatch checks appointment status and revision immediately before every send, including manual send',async t=>{
  const f=fixture(t);f.grant(true);const a=appointmentFixture(f),reminder=f.service.createReminderDrafts().drafts[0];
  await a.queue(reminder.messageId);
  // Simulate an alternate writer that bypassed the normal invalidation trigger.
  f.db.exec('DROP TRIGGER appointment_invalidates_reminders');
  f.db.prepare("UPDATE shop_appointments SET management_revision=management_revision+1 WHERE id=?").run(a.id);
  const result=await f.service.dispatchDue();assert.equal(result.results[0].status,'cancelled');assert.equal(f.calls(),0);
  assert.equal(a.row(reminder.messageId).attempts,0);
  const second=f.service.createReminderDrafts().drafts[0];await a.queue(second.messageId);
  f.db.prepare("UPDATE shop_appointments SET status='cancelled' WHERE id=?").run(a.id);
  const sent=await a.call(`/api/management/messages/${second.messageId}/send`,'POST',{confirmSend:true});
  assert.equal(sent.status,200);assert.equal(sent.body.status,'cancelled');assert.equal(f.calls(),0);
});

test('elapsed appointment reminders are cancelled at dispatch; accepted and uncertain histories are retained',async t=>{
  const f=fixture(t);f.grant(true);const a=appointmentFixture(f),reminder=f.service.createReminderDrafts().drafts[0];
  await a.queue(reminder.messageId);f.advance(2*3600_000);
  assert.equal((await f.service.dispatchDue()).results[0].status,'cancelled');assert.equal(f.calls(),0);
  const f2=fixture(t);f2.grant(true);const a2=appointmentFixture(f2),accepted=f2.service.createReminderDrafts().drafts[0];
  await a2.queue(accepted.messageId);await f2.service.dispatchDue();
  await a2.change({status:'cancelled'});assert.equal(a2.row(accepted.messageId).status,'provider_accepted');
  const f3=fixture(t,{mailProvider:async()=>({status:'delivery_unknown'})});f3.grant(true);const a3=appointmentFixture(f3),unknown=f3.service.createReminderDrafts().drafts[0];
  await a3.queue(unknown.messageId);await f3.service.dispatchDue();await a3.change({status:'cancelled'});
  assert.equal(a3.row(unknown.messageId).status,'delivery_unknown');
  assert.equal((await a3.call(`/api/management/messages/${unknown.messageId}/retry`,'POST',{acknowledgePossibleDuplicate:true,reason:'Provider history reviewed'})).status,409);
});

test('appointment changes and notification records roll back together if durable callback fails',async t=>{
  const f=fixture(t);f.grant(true);
  const a=appointmentFixture(f,(event,wo,extra)=>{f.service.queueEvent(event,wo,extra);throw Error('Injected transaction failure');});
  const reminder=f.service.createReminderDrafts().drafts[0];await a.queue(reminder.messageId);
  const result=await a.change({status:'cancelled'});assert.equal(result.status,400);
  assert.equal(f.db.prepare('SELECT status,management_revision FROM shop_appointments WHERE id=?').get(a.id).status,'scheduled');
  assert.equal(a.row(reminder.messageId).status,'queued');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM service_notification_events WHERE event_name='appointment_changed'").get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointment_change_events').get().n,0);
});

test('unbound legacy reminders become cancelled history and new reminders require a binding',async t=>{
  const f=fixture(t);f.grant(true);
  const legacy=enqueueCustomerMessage(f.db,f.owner,{customerId:f.customer,category:'service',subject:'Old appointment reminder',message:'Old reminder',idempotencyKey:'legacy-reminder-key'});
  f.db.prepare("INSERT INTO service_notification_events(event_key,event_name,customer_id,identity_fingerprint,outbox_id) VALUES('legacy-event','appointment_reminder',?,'legacy-fingerprint',?)").run(f.customer,legacy.id);
  createNotificationService({db:f.db,providerConfigured:false});
  assert.equal(f.db.prepare('SELECT status FROM customer_message_outbox WHERE id=?').get(legacy.id).status,'cancelled');
  assert.equal(f.service.queueEvent('appointment_reminder',{customer_id:f.customer},{title:'Missing binding',startsAt:new Date().toISOString()}).status,'needs_review');
  const a=appointmentFixture(f),reminder=f.service.createReminderDrafts().drafts[0];
  assert.throws(()=>f.db.prepare('UPDATE customer_message_outbox SET appointment_revision=99 WHERE id=?').run(reminder.messageId),/immutable/);
  f.db.prepare("UPDATE shop_appointments SET sync_status='error' WHERE id=?").run(a.id);
  assert.equal(a.row(reminder.messageId).status,'draft');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../src/db.mjs';
import {extendDatabase} from '../src/pos-extension.mjs';
import {installShopOps} from '../src/shop-ops.mjs';
import {recordContactConsent} from '../src/shop-management.mjs';
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

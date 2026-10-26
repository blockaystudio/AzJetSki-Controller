// Durable customer-service event queue. Provider acceptance is never inbox delivery.
import crypto from 'node:crypto';
import {installShopManagement,enqueueCustomerMessage,dispatchDueOutbox,startOutboxWorker} from './shop-management.mjs';

const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=(value,max=1000)=>String(value ?? '').trim().slice(0,max);
const systemActor={id:0,username:'system:service-notifications',role:'system'};
const templates={
  approval_requested:{subject:'Repair authorization requested',message:(wo,extra)=>`Please review and authorize the proposed work for ${wo.unit_label || 'your unit'}. ${text(extra.authorizedDescription || wo.authorized_work,3000)}`},
  approval_completed:{subject:'Repair authorization recorded',message:(_wo,extra)=>`Your authorization response was recorded: ${text(extra.choice,150)}. Signed by ${text(extra.signerName,150)} on ${text(extra.signedAt,100)}.`},
  customer_progress_update:{subject:'Repair progress update',message:(_wo,extra)=>[text(extra.title,200),text(extra.body,6000),extra.stage&&`Current stage: ${text(extra.stage,100)}`].filter(Boolean).join('\n\n')},
  ready_for_pickup:{subject:'Your unit is ready for pickup',message:wo=>`Your ${wo.unit_label || 'unit'} is ready for pickup. Contact the shop to arrange collection. Current account balance: ${Number(wo.balance || 0).toLocaleString('en-US',{style:'currency',currency:'USD'})}. Payment and release requirements still apply.`},
  invoice_issued:{subject:'Your shop invoice',message:(_wo,extra)=>`An invoice ${text(extra.invoiceNumber || extra.number,100)} is ready for your review. Please use the private invoice link or contact the shop about payment.`},
  appointment_reminder:{subject:'Service appointment reminder',message:(_wo,extra)=>`Reminder: ${text(extra.title,200)} on ${new Date(extra.startsAt).toLocaleString('en-US',{timeZone:'America/Phoenix',dateStyle:'full',timeStyle:'short'})} (Phoenix time). Contact the shop if you need to reschedule.`},
  appointment_changed:{subject:'Service appointment updated',message:(_wo,extra)=>`Your appointment ${text(extra.title,200)} has been ${extra.status==='cancelled'?'cancelled':`rescheduled to ${new Date(extra.startsAt).toLocaleString('en-US',{timeZone:'America/Phoenix',dateStyle:'full',timeStyle:'short'})} (Phoenix time)`}. Contact the shop if you have questions.`}
};

export function installServiceNotifications(db) {
  installShopManagement(db);
  db.exec(`CREATE TABLE IF NOT EXISTS service_notification_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL UNIQUE,event_name TEXT NOT NULL,
    work_order_id INTEGER,customer_id INTEGER,identity_fingerprint TEXT NOT NULL,
    outbox_id INTEGER,queue_status TEXT NOT NULL DEFAULT 'pending',last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TRIGGER IF NOT EXISTS service_event_bound_fields BEFORE UPDATE ON service_notification_events
    WHEN OLD.event_key IS NOT NEW.event_key OR OLD.event_name IS NOT NEW.event_name
      OR OLD.work_order_id IS NOT NEW.work_order_id OR OLD.customer_id IS NOT NEW.customer_id
      OR OLD.identity_fingerprint IS NOT NEW.identity_fingerprint OR OLD.created_at IS NOT NEW.created_at
    BEGIN SELECT RAISE(ABORT,'Service event identity is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS service_event_no_delete BEFORE DELETE ON service_notification_events
    BEGIN SELECT RAISE(ABORT,'Service event history cannot be deleted'); END;
  UPDATE customer_message_outbox SET status='cancelled',next_attempt_at=NULL,
    last_error='Legacy reminder has no appointment revision; prepare a current reminder'
    WHERE appointment_id IS NULL AND status IN ('draft','queued','waiting_provider','retry_wait','consent_required','provider_failed','needs_review')
      AND id IN (SELECT outbox_id FROM service_notification_events WHERE event_name='appointment_reminder');`);
}

export function createNotificationService({db,shopName=process.env.SHOP_NAME || 'Owner Tracker',actor=systemActor,
  now=()=>new Date(),mailProvider,providerConfigured,intervalMs=60000}={}) {
  installServiceNotifications(db);
  let stopWorker=null;

  function queueEvent(event,wo={},extra={}) {
    if(!templates[event])return {status:'unsupported_event',notice:'No automatic customer template exists for this event'};
    const workOrderId=Number.isSafeInteger(wo.id)&&!!db.prepare('SELECT id FROM work_orders WHERE id=?').get(wo.id)?wo.id:null;
    const customerId=Number(wo.customer_id || extra.customerId || 0) || null;
    const appointmentIdentity=extra.appointmentId?`${extra.appointmentId}:${extra.managementRevision || `${extra.startsAt || ''}:${extra.status || ''}`}`:'';
    const identity=text(extra.eventId || extra.approvalId || extra.invoiceId || extra.updateId || appointmentIdentity || extra.signedAt || wo.revision || wo.updated_at || wo.created_at || `${wo.stage || event}:${wo.ref_number || wo.id || customerId}`,300);
    const link=text(extra.approvalUrl || extra.portalUrl || extra.invoiceUrl || extra.link,2000);
    const subject=`${shopName}: ${templates[event].subject}${wo.ref_number?` — ${text(wo.ref_number,100)}`:''}`;
    const message=[wo.customer_name?`Hello ${text(wo.customer_name,150)},`:'Hello,',templates[event].message(wo,extra),`Thank you,\n${shopName}`].join('\n\n');
    const reminder=event==='appointment_reminder'?{appointmentId:extra.appointmentId,appointmentRevision:extra.managementRevision}:{};
    if(event==='appointment_reminder'&&(!Number.isSafeInteger(reminder.appointmentId)||!Number.isSafeInteger(reminder.appointmentRevision)))return {status:'needs_review',notice:'Reminder appointment ID and revision are required'};
    const source={event,workOrderId,customerId,identity,subject,message,link,draft:extra.draft===true,sendAfter:extra.sendAfter || null,...reminder};
    const eventKey='service:'+digest({event,workOrderId,customerId,identity}),fingerprint=digest(source);
    const old=db.prepare('SELECT * FROM service_notification_events WHERE event_key=?').get(eventKey);
    if(old&&old.identity_fingerprint!==fingerprint)return {status:'event_conflict',notice:'Service event identity was reused with changed details; review before sending'};
    if(old?.outbox_id){const message=db.prepare('SELECT id,status,next_attempt_at FROM customer_message_outbox WHERE id=?').get(old.outbox_id);return {status:message?.status || old.queue_status,messageId:old.outbox_id,duplicate:true,notice:'Existing durable service message retained; no new email was sent'};}
    const eventId=old?.id || Number(db.prepare('INSERT INTO service_notification_events(event_key,event_name,work_order_id,customer_id,identity_fingerprint) VALUES(?,?,?,?,?)').run(eventKey,event,workOrderId,customerId,fingerprint).lastInsertRowid);
    try {
      if(!customerId)throw Error('Customer must be linked before automatic notifications can be queued');
      const result=enqueueCustomerMessage(db,actor,{customerId,category:'service',subject,message,link,idempotencyKey:eventKey,...reminder,...(extra.draft===true?{draft:true}:{}),...(extra.sendAfter?{sendAfter:extra.sendAfter}:{})});
      db.prepare('UPDATE service_notification_events SET outbox_id=?,queue_status=?,last_error=? WHERE id=?').run(result.id,result.status,'',eventId);
      db.prepare('INSERT INTO notifications(work_order_id,event,destination,status,detail) VALUES(?,?,?,?,?)').run(workOrderId,event,result.recipient,result.status,JSON.stringify({messageId:result.id,eventId,automatic:true,providerAccepted:false}));
      return {status:result.status,messageId:result.id,duplicate:!!result.duplicate,notice:result.status==='draft'?'Reminder draft prepared for review; no email sent':result.status==='consent_required'?'Saved; customer service-email consent is required':'Saved in the durable outbox; provider acceptance and inbox delivery are not yet confirmed'};
    } catch(error) {
      db.prepare("UPDATE service_notification_events SET queue_status='needs_review',last_error=? WHERE id=?").run(text(error.message,400),eventId);
      return {status:'needs_review',eventId,notice:text(error.message,400)};
    }
  }

  function createReminderDrafts({hoursAhead=24}={}) {
    if(!Number.isInteger(hoursAhead)||hoursAhead<1||hoursAhead>168)throw Error('Reminder horizon must be one to 168 hours');
    const start=now().getTime(),end=start+hoursAhead*3600_000;
    const appointments=db.prepare(`SELECT a.*,c.name customer_name FROM shop_appointments a
      JOIN customers c ON c.id=a.customer_id JOIN customer_contact_consents consent ON consent.customer_id=c.id
      WHERE a.status='scheduled' AND consent.service_email=1 AND julianday(a.starts_at)>julianday(?) AND julianday(a.starts_at)<=julianday(?)
      ORDER BY a.starts_at LIMIT 100`).all(new Date(start).toISOString(),new Date(end).toISOString());
    return {drafts:appointments.map(appointment=>queueEvent('appointment_reminder',{customer_id:appointment.customer_id,customer_name:appointment.customer_name},
      {appointmentId:appointment.id,managementRevision:appointment.management_revision,title:appointment.title,startsAt:appointment.starts_at,draft:true}))};
  }

  function start() {
    if(stopWorker)return stop;
    stopWorker=startOutboxWorker(db,{intervalMs,now,...(mailProvider?{mailProvider}:{}),...(providerConfigured===undefined?{}:{providerConfigured})});
    return stop;
  }
  function stop(){stopWorker?.();stopWorker=null;}
  const dispatchDue=({user:initiator,...options}={})=>{
    const authority=initiator || (['owner','manager'].includes(actor.role)?actor:db.prepare("SELECT id,username,role FROM users WHERE active=1 AND role='owner' ORDER BY id LIMIT 1").get());
    if(!authority)return Promise.resolve({results:[],notice:'An active owner must authorize processing the customer message queue'});
    return dispatchDueOutbox(db,authority,{now,...(mailProvider?{mailProvider}:{}),...(providerConfigured===undefined?{}:{providerConfigured}),...options});
  };
  return {queueEvent,createReminderDrafts,start,stop,dispatchDue};
}

export function notificationRoutes({service,currentUser,json,readBody}) {
  return async(req,res,p)=>{
    if(!['/api/management/reminders/drafts','/api/management/messages/process-due'].includes(p))return false;
    const send=(status,value)=>{json(res,status,value,{'cache-control':'no-store'});return true;};
    const user=currentUser(req);
    if(!user)return send(401,{error:'Login required'});
    if(!['owner','manager'].includes(user.role))return send(403,{error:'Owner/manager notification permission required'});
    if(req.method!=='POST')return send(405,{error:'Method not allowed'});
    try{
      const body=await readBody(req);
      if(p==='/api/management/reminders/drafts')return send(201,service.createReminderDrafts({hoursAhead:body.hoursAhead ?? 24}));
      if(body.confirmSend!==true)return send(400,{error:'Explicit confirmation required before processing due email'});
      return send(200,await service.dispatchDue({user}));
    }catch(error){return send(error.status || 400,{error:String(error.message).slice(0,250)});}
  };
}

import crypto from 'node:crypto';
import {sendInvoiceMail, smtpConfigured} from './shop-mail.mjs';

const staff = new Set(['owner','manager','advisor','service_writer','parts']);
const managers = new Set(['owner','manager']);
const purchasers = new Set(['owner','manager','advisor','parts']);
const text = (v,n=1000) => String(v??'').trim().slice(0,n);
const fail = (status,message) => {const error=new Error(message);error.status=status;throw error;};
const integer = (v,label,min=1,max=100000000) => {const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>max)fail(400,`${label} must be an integer from ${min} to ${max}`);return n;};
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyOf = body => {const key=text(body.idempotencyKey??body.idempotency_key,140);if(key.length<8)fail(400,'An idempotency key of at least eight characters is required');return key;};
const audit = (db,u,action,detail,wo=null) => db.prepare('INSERT INTO audit_log(work_order_id,actor,action,detail) VALUES(?,?,?,?)').run(wo,u.username,action,JSON.stringify(detail));
function tx(db,fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
const tableExists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

export function installShopManagement(db){
  db.exec(`CREATE TABLE IF NOT EXISTS shop_management_policy (
    id INTEGER PRIMARY KEY CHECK(id=1), advisor_purchase_limit_cents INTEGER NOT NULL DEFAULT 50000,
    parts_purchase_limit_cents INTEGER NOT NULL DEFAULT 50000, independent_approval_cents INTEGER NOT NULL DEFAULT 100000,
    updated_by INTEGER, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ); INSERT OR IGNORE INTO shop_management_policy(id) VALUES(1);
  CREATE TABLE IF NOT EXISTS purchase_approval_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, requester_id INTEGER NOT NULL, requester_username TEXT NOT NULL,
    total_cents INTEGER NOT NULL, work_order_ids TEXT NOT NULL, context TEXT NOT NULL, reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', approved_by INTEGER, approver_username TEXT, decision_reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, decided_at TEXT, consumed_at TEXT,
    idempotency_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS purchase_request_bound_fields BEFORE UPDATE ON purchase_approval_requests
    WHEN NEW.requester_id IS NOT OLD.requester_id OR NEW.requester_username IS NOT OLD.requester_username
      OR NEW.total_cents IS NOT OLD.total_cents OR NEW.work_order_ids IS NOT OLD.work_order_ids
      OR NEW.context IS NOT OLD.context OR NEW.reason IS NOT OLD.reason OR NEW.fingerprint IS NOT OLD.fingerprint
      OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT,'Purchase request details cannot be changed'); END;
  CREATE TRIGGER IF NOT EXISTS purchase_request_no_delete BEFORE DELETE ON purchase_approval_requests
    BEGIN SELECT RAISE(ABORT,'Purchase approval history cannot be deleted'); END;
  CREATE TABLE IF NOT EXISTS stock_catalog (
    sku TEXT PRIMARY KEY, barcode TEXT UNIQUE, description TEXT NOT NULL, bin_location TEXT NOT NULL DEFAULT '',
    reorder_level INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS receiving_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_reference TEXT NOT NULL UNIQUE, supplier_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS receiving_order_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES receiving_orders(id), sku TEXT NOT NULL REFERENCES stock_catalog(sku),
    ordered_quantity INTEGER NOT NULL, received_quantity INTEGER NOT NULL DEFAULT 0, returned_quantity INTEGER NOT NULL DEFAULT 0,
    UNIQUE(order_id,sku)
  );
  CREATE TABLE IF NOT EXISTS stock_operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, line_id INTEGER NOT NULL REFERENCES receiving_order_lines(id),
    operation TEXT NOT NULL, quantity INTEGER NOT NULL, reference TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
    actor_id INTEGER NOT NULL, actor_username TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TRIGGER IF NOT EXISTS stock_operations_no_update BEFORE UPDATE ON stock_operations BEGIN SELECT RAISE(ABORT,'Stock operations are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS stock_operations_no_delete BEFORE DELETE ON stock_operations BEGIN SELECT RAISE(ABORT,'Stock operations are immutable'); END;
  CREATE TABLE IF NOT EXISTS customer_contact_consents (
    customer_id INTEGER PRIMARY KEY REFERENCES customers(id), service_email INTEGER NOT NULL DEFAULT 0, marketing_email INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL, recorded_by INTEGER NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS contact_consent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,service_email INTEGER NOT NULL,marketing_email INTEGER NOT NULL,
    source TEXT NOT NULL,actor_id INTEGER NOT NULL,actor_username TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TRIGGER IF NOT EXISTS consent_event_no_update BEFORE UPDATE ON contact_consent_events BEGIN SELECT RAISE(ABORT,'Consent history is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS consent_event_no_delete BEFORE DELETE ON contact_consent_events BEGIN SELECT RAISE(ABORT,'Consent history is immutable'); END;
  CREATE TABLE IF NOT EXISTS customer_message_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL REFERENCES customers(id),category TEXT NOT NULL,
    recipient TEXT NOT NULL,subject TEXT NOT NULL,message TEXT NOT NULL,link TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,last_error TEXT NOT NULL DEFAULT '',provider_reference TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,accepted_at TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notification_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,message_id INTEGER NOT NULL,attempt INTEGER NOT NULL,outcome TEXT NOT NULL,
    detail TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TRIGGER IF NOT EXISTS notification_attempt_no_update BEFORE UPDATE ON notification_attempts BEGIN SELECT RAISE(ABORT,'Delivery attempt history is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS notification_attempt_no_delete BEFORE DELETE ON notification_attempts BEGIN SELECT RAISE(ABORT,'Delivery attempt history is immutable'); END;
  CREATE TABLE IF NOT EXISTS appointment_change_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,appointment_id INTEGER NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,
    reason TEXT NOT NULL,actor_id INTEGER NOT NULL,actor_username TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  const columns=new Set(db.prepare('PRAGMA table_info(work_orders)').all().map(c=>c.name));
  if(!columns.has('service_advisor_id'))db.exec('ALTER TABLE work_orders ADD COLUMN service_advisor_id INTEGER REFERENCES users(id)');
  const appt=new Set(db.prepare('PRAGMA table_info(shop_appointments)').all().map(c=>c.name));
  if(!appt.has('management_revision'))db.exec('ALTER TABLE shop_appointments ADD COLUMN management_revision INTEGER NOT NULL DEFAULT 1');
  const outbox=new Set(db.prepare('PRAGMA table_info(customer_message_outbox)').all().map(c=>c.name));
  if(!outbox.has('sending_started_at'))db.exec('ALTER TABLE customer_message_outbox ADD COLUMN sending_started_at TEXT');
  const approvals=new Set(db.prepare('PRAGMA table_info(purchase_approval_requests)').all().map(c=>c.name));
  if(!approvals.has('target_json'))db.exec("ALTER TABLE purchase_approval_requests ADD COLUMN target_json TEXT NOT NULL DEFAULT ''");
  if(!approvals.has('target_sha256'))db.exec("ALTER TABLE purchase_approval_requests ADD COLUMN target_sha256 TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE TRIGGER IF NOT EXISTS purchase_request_target_immutable BEFORE UPDATE ON purchase_approval_requests
    WHEN OLD.target_json IS NOT NEW.target_json OR OLD.target_sha256 IS NOT NEW.target_sha256
    BEGIN SELECT RAISE(ABORT,'Purchase approval target cannot be changed'); END;`);
}

function purchaseTarget(target,context='purchase'){
  if(!target||typeof target!=='object'||Array.isArray(target))fail(400,'The exact reviewed purchase target is required');
  if(context==='purchase'){
    if(!['repair','retail'].includes(target.kind))fail(400,'Purchase target kind must be repair or retail');
    integer(target.vendorId,'Target vendor ID');integer(target.cartId,'Target cart ID');
    if(!Array.isArray(target.lines)||!target.lines.length||target.lines.length>200)fail(400,'Purchase target must contain its exact reviewed lines');
  }
  function canonical(value,depth=0){
    if(depth>12)fail(400,'Approval target is too deeply nested');
    if(value===null||typeof value==='string'||typeof value==='boolean')return value;
    if(typeof value==='number'){if(!Number.isFinite(value))fail(400,'Approval target contains an invalid number');return value;}
    if(Array.isArray(value))return value.map(item=>canonical(item,depth+1));
    if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key],depth+1)]));
    fail(400,'Approval target contains unsupported values');
  }
  const serialized=JSON.stringify(canonical(target));
  if(serialized.length>200000)fail(400,'Approval target is too large');
  return {serialized,digest:hash(JSON.parse(serialized))};
}

function normalizedWorkOrders(db,ids){
  if(!Array.isArray(ids)||ids.length>100)fail(400,'workOrderIds must be an array of at most 100 IDs');
  const result=[...new Set(ids.map(id=>integer(id,'Work order ID')))].sort((a,b)=>a-b);
  for(const id of result)if(!db.prepare('SELECT id FROM work_orders WHERE id=?').get(id))fail(404,'Work order not found');
  return result;
}
function checkAdvisor(db,user,ids){
  if(user.role==='advisor')for(const id of ids){const row=db.prepare('SELECT service_advisor_id FROM work_orders WHERE id=?').get(id);if(row?.service_advisor_id!==user.id)fail(403,'The advisor must be assigned responsibility for each repair work order');}
}

// Call inside the caller's queue transaction: consuming an approval then rolls
// back if command creation fails. This authorizes only a reviewed manifest.
export function assertPurchaseAuthorized(db,user,totalCents,workOrderIds=[],approvalId=null,context='purchase',target=null){
  if(!user||!purchasers.has(user.role))fail(403,'Purchasing permission required');
  const total=integer(totalCents,'Purchase total',0),ids=normalizedWorkOrders(db,workOrderIds);
  checkAdvisor(db,user,ids);
  const policy=db.prepare('SELECT * FROM shop_management_policy WHERE id=1').get();
  const roleLimit=user.role==='advisor'?policy.advisor_purchase_limit_cents:user.role==='parts'?policy.parts_purchase_limit_cents:Infinity;
  const requires=total>=policy.independent_approval_cents||total>roleLimit;
  if(!requires)return {authorized:true,independentApproval:false};
  let binding;try{binding=purchaseTarget(target,context);}catch{fail(403,'The exact reviewed vendor/cart/line target is required for independent approval');}
  const approval=db.prepare('SELECT * FROM purchase_approval_requests WHERE id=?').get(Number(approvalId)||0);
  if(!approval||approval.requester_id!==user.id||approval.status!=='approved'||approval.total_cents!==total||approval.work_order_ids!==JSON.stringify(ids)||approval.context!==context||approval.approved_by===user.id)fail(403,'A matching independent manager/owner purchase approval is required');
  if(!approval.target_json||approval.target_sha256!==binding.digest||approval.target_json!==binding.serialized)fail(403,'Purchase approval does not match this vendor, cart and exact reviewed lines');
  const approver=db.prepare('SELECT active,role FROM users WHERE id=?').get(approval.approved_by);
  if(!approver?.active||!managers.has(approver.role))fail(403,'Purchase approver is no longer an active manager or owner');
  if(!db.prepare("UPDATE purchase_approval_requests SET status='consumed',consumed_at=CURRENT_TIMESTAMP WHERE id=? AND status='approved'").run(approval.id).changes)fail(409,'Purchase approval was already consumed');
  audit(db,user,'Independent purchase approval consumed',{approvalId:approval.id,totalCents:total,workOrderIds:ids,context,targetSha256:binding.digest});
  return {authorized:true,independentApproval:true,approvalId:approval.id};
}

export function recordContactConsent(db,user,customerId,input){
  const id=integer(customerId,'Customer ID');
  if(!db.prepare('SELECT id FROM customers WHERE id=? AND archived=0').get(id))fail(404,'Customer not found');
  if(typeof input.serviceEmail!=='boolean'||typeof input.marketingEmail!=='boolean'||text(input.source).length<5)fail(400,'Separate explicit service and marketing choices and a consent source are required');
  return tx(db,()=>{
    db.prepare(`INSERT INTO customer_contact_consents(customer_id,service_email,marketing_email,source,recorded_by) VALUES(?,?,?,?,?)
      ON CONFLICT(customer_id) DO UPDATE SET service_email=excluded.service_email,marketing_email=excluded.marketing_email,source=excluded.source,recorded_by=excluded.recorded_by,recorded_at=CURRENT_TIMESTAMP`).run(id,Number(input.serviceEmail),Number(input.marketingEmail),text(input.source),user.id);
    db.prepare('INSERT INTO contact_consent_events(customer_id,service_email,marketing_email,source,actor_id,actor_username) VALUES(?,?,?,?,?,?)').run(id,Number(input.serviceEmail),Number(input.marketingEmail),text(input.source),user.id,user.username);
    if(input.serviceEmail)db.prepare("UPDATE customer_message_outbox SET status='queued' WHERE customer_id=? AND category='service' AND status='consent_required'").run(id);
    else db.prepare("UPDATE customer_message_outbox SET status='consent_required' WHERE customer_id=? AND category='service' AND status IN ('queued','waiting_provider','retry_wait')").run(id);
    if(!input.marketingEmail)db.prepare("UPDATE customer_message_outbox SET status='consent_required' WHERE customer_id=? AND category='marketing' AND status IN ('queued','waiting_provider','retry_wait')").run(id);
    audit(db,user,'Customer contact consent recorded',{customerId:id,serviceEmail:input.serviceEmail,marketingEmail:input.marketingEmail,source:text(input.source)});
    return db.prepare('SELECT * FROM customer_contact_consents WHERE customer_id=?').get(id);
  });
}

export function enqueueCustomerMessage(db,user,input){
  const customerId=integer(input.customerId,'Customer ID'),customer=db.prepare('SELECT id,name,email FROM customers WHERE id=? AND archived=0').get(customerId);
  if(!customer)fail(404,'Customer not found');
  if(!['service','marketing'].includes(input.category))fail(400,'Choose service or marketing category');
  if(input.category==='marketing'&&!managers.has(user.role))fail(403,'Marketing messages require manager/owner approval');
  const recipient=text(customer.email,255);if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient))fail(400,'Customer must have a valid email address');
  const subject=text(input.subject,200),message=text(input.message,12000),link=text(input.link,2000),key=keyOf(input);
  if(!subject||!message)fail(400,'Subject and message are required');
  if(link&&!/^https:\/\//.test(link))fail(400,'Customer links must use HTTPS');
  const scheduled=input.sendAfter?Date.parse(input.sendAfter):null;
  if(scheduled!==null&&!Number.isFinite(scheduled))fail(400,'Invalid scheduled send time');
  const sendAfter=scheduled===null?null:new Date(scheduled).toISOString();
  const fingerprint=hash({customerId,category:input.category,recipient,subject,message,link,sendAfter,draft:input.draft===true});
  return tx(db,()=>{
    const old=db.prepare('SELECT * FROM customer_message_outbox WHERE idempotency_key=?').get(key);
    if(old){if(old.fingerprint!==fingerprint)fail(409,'Message key already used with different details');return {...old,duplicate:true};}
    const consent=db.prepare('SELECT * FROM customer_contact_consents WHERE customer_id=?').get(customerId);
    const permitted=consent?.[input.category==='marketing'?'marketing_email':'service_email']===1;
    const status=input.draft===true?'draft':permitted?'queued':'consent_required';
    const row=db.prepare('INSERT INTO customer_message_outbox(customer_id,category,recipient,subject,message,link,status,created_by,idempotency_key,fingerprint,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(customerId,input.category,recipient,subject,message,link,status,user.id,key,fingerprint,sendAfter);
    audit(db,user,'Customer message queued',{messageId:Number(row.lastInsertRowid),customerId,category:input.category,status});
    return db.prepare('SELECT * FROM customer_message_outbox WHERE id=?').get(Number(row.lastInsertRowid));
  });
}

function providerReady(){return Boolean((process.env.SENDGRID_API_KEY&&process.env.INVOICE_FROM_EMAIL)||smtpConfigured());}
export function marketingPreferenceToken(customerId,secret=process.env.EMAIL_PREFERENCES_SIGNING_KEY||process.env.OWNERTRACKER_SESSION_SECRET||''){
  if(secret.length<32)fail(503,'A private email-preferences signing key is required');
  const id=integer(customerId,'Customer ID');
  return `${id}.${crypto.createHmac('sha256',secret).update(`ownertracker:marketing-opt-out:${id}`).digest('base64url')}`;
}
function preferenceCustomer(db,token,secret){
  const match=token.match(/^(\d+)\.([A-Za-z0-9_-]{43})$/);if(!match)fail(404,'Email preference link not found');
  const expected=marketingPreferenceToken(Number(match[1]),secret),actual=Buffer.from(token),valid=Buffer.from(expected);
  if(actual.length!==valid.length||!crypto.timingSafeEqual(actual,valid))fail(404,'Email preference link not found');
  const customer=db.prepare('SELECT id FROM customers WHERE id=? AND archived=0').get(Number(match[1]));if(!customer)fail(404,'Email preference link not found');return customer;
}
async function sendMessage(message,customer){
  let content=message.message;
  if(message.category==='marketing'){
    const base=text(process.env.PUBLIC_BASE_URL,2000).replace(/\/$/,'');
    if(!/^https:\/\//.test(base))return {status:'provider_failed',retryable:false,error:'Configure the shop HTTPS address before sending marketing email'};
    try{content+=`\n\nStop marketing emails: ${base}/email-preferences/${marketingPreferenceToken(message.customer_id)}`;}
    catch{return {status:'provider_failed',retryable:false,error:'Configure a private email-preferences signing key before sending marketing email'};}
  }
  if(process.env.SENDGRID_API_KEY&&process.env.INVOICE_FROM_EMAIL){
    const response=await fetch('https://api.sendgrid.com/v3/mail/send',{method:'POST',headers:{authorization:`Bearer ${process.env.SENDGRID_API_KEY}`,'content-type':'application/json'},body:JSON.stringify({personalizations:[{to:[{email:message.recipient,name:customer.name}],custom_args:{ownertrackerMessageId:String(message.id)}}],from:{email:process.env.INVOICE_FROM_EMAIL,name:process.env.SHOP_NAME||'Owner Tracker'},subject:message.subject,content:[{type:'text/plain',value:[content,message.link].filter(Boolean).join('\n\n')}]}),signal:AbortSignal.timeout(12000)});
    if(!response.ok)return {status:'provider_failed',error:`Email provider HTTP ${response.status}`,retryable:response.status===429||response.status>=500};
    return {status:'provider_accepted',reference:response.headers.get('x-message-id')||''};
  }
  const result=await sendInvoiceMail({to:message.recipient,name:customer.name,shop:process.env.SHOP_NAME||'Owner Tracker',subject:message.subject,message:content,link:message.link});
  return result.status==='accepted_by_smtp'?{status:'provider_accepted',reference:'smtp_accepted'}:{status:'waiting_provider'};
}

export async function dispatchOutboxMessage(db,user,id,{mailProvider=sendMessage,providerConfigured=providerReady(),now=()=>new Date()}={}){
  const message=tx(db,()=>{
    const row=db.prepare('SELECT * FROM customer_message_outbox WHERE id=?').get(integer(id,'Message ID'));
    if(!row)fail(404,'Message not found');
    if(row.status==='provider_accepted')return {...row,alreadyAccepted:true};
    if(!['queued','waiting_provider','retry_wait','consent_required'].includes(row.status))fail(409,'Message is not eligible for delivery; unknown delivery outcomes require explicit review');
    if(row.next_attempt_at&&Date.parse(row.next_attempt_at)>now().getTime())fail(409,'Message retry is not due yet');
    const consent=db.prepare('SELECT * FROM customer_contact_consents WHERE customer_id=?').get(row.customer_id);
    const current=db.prepare('SELECT id,name,email FROM customers WHERE id=? AND archived=0').get(row.customer_id);
    if(!current||current.email!==row.recipient){db.prepare("UPDATE customer_message_outbox SET status='needs_review',last_error='Recipient changed; create a new message after checking the customer record' WHERE id=?").run(row.id);return {...row,status:'needs_review',blocked:true,notice:'Recipient changed. Check the customer record and create a new message.'};}
    if(consent?.[row.category==='marketing'?'marketing_email':'service_email']!==1){db.prepare("UPDATE customer_message_outbox SET status='consent_required' WHERE id=?").run(row.id);return {...row,status:'consent_required',blocked:true};}
    if(!providerConfigured){db.prepare("UPDATE customer_message_outbox SET status='waiting_provider' WHERE id=?").run(row.id);return {...row,status:'waiting_provider',blocked:true};}
    if(!db.prepare("UPDATE customer_message_outbox SET status='sending',attempts=attempts+1,sending_started_at=? WHERE id=? AND status IN ('queued','waiting_provider','retry_wait','consent_required')").run(now().toISOString(),row.id).changes)fail(409,'Message is already being processed');
    return {...row,attempts:row.attempts+1,customer:current};
  });
  if(message.blocked||message.alreadyAccepted)return {id:message.id,status:message.status,notice:message.notice||(message.alreadyAccepted?'Already accepted by provider; delivery to the inbox is not certified':'Consent or authorized email provider configuration is required')};
  let outcome;
  try{outcome=await mailProvider(message,message.customer);}catch{outcome={status:'delivery_unknown',error:'Provider connection ended without a definitive response. Review the provider before retrying.'};}
  if(!['provider_accepted','provider_failed','delivery_unknown','waiting_provider'].includes(outcome?.status))outcome={status:'delivery_unknown',error:'Provider returned an unsupported delivery outcome; inspect before retrying'};
  return tx(db,()=>{
    const status=outcome.status==='provider_failed'&&outcome.retryable&&message.attempts<5?'retry_wait':outcome.status;
    const next=status==='retry_wait'?new Date(now().getTime()+Math.min(3600,60*2**(message.attempts-1))*1000).toISOString():null;
    db.prepare("UPDATE customer_message_outbox SET status=?,next_attempt_at=?,last_error=?,provider_reference=?,accepted_at=CASE WHEN ?='provider_accepted' THEN CURRENT_TIMESTAMP ELSE accepted_at END WHERE id=? AND status='sending'").run(status,next,text(outcome.error,500),text(outcome.reference,200),status,message.id);
    db.prepare('INSERT INTO notification_attempts(message_id,attempt,outcome,detail) VALUES(?,?,?,?)').run(message.id,message.attempts,status,JSON.stringify({error:text(outcome.error,500),reference:text(outcome.reference,200)}));
    audit(db,user,'Email delivery attempt recorded',{messageId:message.id,status,attempt:message.attempts});
    return {id:message.id,status,nextAttemptAt:next,notice:status==='provider_accepted'?'Accepted by the email provider; inbox delivery is not certified':'Message was not confirmed accepted; inspect its status'};
  });
}

export async function dispatchDueOutbox(db,user,options={}){
  if(!user||!managers.has(user.role))fail(403,'A manager/owner must authorize processing the email queue');
  const now=options.now?.()||new Date();
  const rows=db.prepare("SELECT id FROM customer_message_outbox WHERE status IN ('queued','waiting_provider','retry_wait') AND (next_attempt_at IS NULL OR julianday(next_attempt_at)<=julianday(?)) ORDER BY id LIMIT 5").all(now.toISOString());
  const results=[];
  for(const row of rows){try{results.push(await dispatchOutboxMessage(db,user,row.id,options));}catch(error){results.push({id:row.id,status:'blocked',error:text(error.message,300)});}}
  return {results,notice:'Each result is a provider attempt or an explicit blocked state, not proof of inbox delivery'};
}

// Opt-in worker for a persistent shop server. Disabled by default and in review
// deployments; production must supply authorized provider settings and explicit
// NOTIFICATIONS_AUTO_SEND=true. Unknown outcomes never enter automatic retry.
export function startOutboxWorker(db,{intervalMs=60000,...options}={}){
  if(process.env.NOTIFICATIONS_AUTO_SEND!=='true')return ()=>{};
  let running=false;
  const tick=async()=>{if(running)return;running=true;try{const user=db.prepare("SELECT id,username,role FROM users WHERE active=1 AND role='owner' ORDER BY id LIMIT 1").get();if(user)await dispatchDueOutbox(db,user,options);}catch{/* durable states remain visible to staff */}finally{running=false;}};
  const timer=setInterval(tick,Math.max(30000,intervalMs));timer.unref?.();
  return ()=>clearInterval(timer);
}

export function receiveStock(db,user,lineId,input){
  if(!['receive','return'].includes(input.operation||'receive'))fail(400,'Stock operation must be receive or return');
  const operation=input.operation==='return'?'return':'receive',quantity=integer(input.quantity,'Quantity',1,100000),reference=text(input.reference,180),reason=text(input.reason,500),key=keyOf(input);
  if(reference.length<3||(operation==='return'&&reason.length<5))fail(400,'Supplier receiving/return reference and return reason are required');
  if(operation==='return'&&!managers.has(user.role))fail(403,'Manager/owner permission required for supplier returns');
  const fingerprint=hash({lineId:Number(lineId),operation,quantity,reference,reason});
  return tx(db,()=>{
    const prior=db.prepare('SELECT * FROM stock_operations WHERE idempotency_key=?').get(key);
    if(prior){if(prior.fingerprint!==fingerprint)fail(409,'Stock key reused with different details');return {...prior,duplicate:true};}
    const line=db.prepare('SELECT l.*,o.supplier_reference FROM receiving_order_lines l JOIN receiving_orders o ON o.id=l.order_id WHERE l.id=?').get(integer(lineId,'Receiving line ID'));
    if(!line)fail(404,'Receiving line not found');
    if(operation==='receive'&&line.received_quantity+quantity>line.ordered_quantity)fail(409,'Receiving quantity exceeds the remaining purchase order quantity');
    const onHand=db.prepare('SELECT COALESCE(SUM(quantity_delta),0) n FROM inventory_adjustments WHERE item_sku=?').get(line.sku).n;
    if(operation==='return'&&(line.returned_quantity+quantity>line.received_quantity||quantity>onHand))fail(409,'Return exceeds physically received or available stock');
    const row=db.prepare('INSERT INTO stock_operations(line_id,operation,quantity,reference,reason,actor_id,actor_username,idempotency_key,fingerprint) VALUES(?,?,?,?,?,?,?,?,?)').run(line.id,operation,quantity,reference,reason,user.id,user.username,key,fingerprint);
    db.prepare(`UPDATE receiving_order_lines SET ${operation==='receive'?'received_quantity':'returned_quantity'}=${operation==='receive'?'received_quantity':'returned_quantity'}+? WHERE id=?`).run(quantity,line.id);
    db.prepare('INSERT INTO inventory_adjustments(item_sku,quantity_delta,reason,reference_type,reference_id,actor_id) VALUES(?,?,?,?,?,?)').run(line.sku,operation==='receive'?quantity:-quantity,operation==='receive'?'received':'return',operation==='receive'?'supplier_order':'supplier_return',reference,user.id);
    const complete=!db.prepare('SELECT id FROM receiving_order_lines WHERE order_id=? AND received_quantity<ordered_quantity LIMIT 1').get(line.order_id);
    db.prepare('UPDATE receiving_orders SET status=? WHERE id=?').run(complete?'received':'partially_received',line.order_id);
    audit(db,user,operation==='receive'?'Stock physically received':'Stock returned to supplier',{lineId:line.id,sku:line.sku,quantity,reference,reason});
    return {id:Number(row.lastInsertRowid),operation,quantity,stockAdded:operation==='receive'?quantity:-quantity};
  });
}

function integrationInventory(){
  return [
    {id:'email',label:'Customer email',configured:providerReady(),state:providerReady()?'configured_requires_delivery_test':'needs_credentials',action:'Configure authorized SMTP or SendGrid sender; test a real inbox'},
    {id:'dejavoo',label:'Dejavoo payments',configured:!!(process.env.DEJAVOO_SPIN_AUTH_KEY&&process.env.DEJAVOO_SPIN_REGISTER_ID),state:'external_terminal_manual_ledger',action:'Processor-approved adapter and terminal certification required before app-controlled charging'},
    {id:'docusign',label:'DocuSign',configured:!!(process.env.DOCUSIGN_ACCESS_TOKEN&&process.env.DOCUSIGN_ACCOUNT_ID),state:process.env.DOCUSIGN_ENABLE_SEND==='true'?'enabled_requires_live_acceptance':'prepared_documents_only',action:'Configure standalone app credentials and approve authorization wording'},
    {id:'supplier',label:'Supplier purchasing',configured:false,state:'reviewed_manifests_only',action:'Documented dealer API access and sandbox order receipts required; no automatic purchases'},
    {id:'google',label:'Google Calendar',configured:!!(process.env.GOOGLE_CALENDAR_CLIENT_ID&&process.env.GOOGLE_CALENDAR_CLIENT_SECRET),state:'owner_oauth_required',action:'Authorize the shop calendar; local changes require remote update/cancel adapter acceptance'},
    {id:'epson',label:'Epson printer and drawer',configured:!!process.env.EPSON_PRINTER_IP,state:'hardware_test_required',action:'Configure the exact Epson model/network and test physical print/drawer'},
    {id:'ios',label:'Native owner/technician apps',configured:false,state:'source_present_signing_required',action:'Build and sign with Xcode on macOS; mobile web is available now'}
  ];
}

export function shopManagementRoutes({db,currentUser,json,readBody,mailProvider,calendarChange,preferencesSigningKey=process.env.EMAIL_PREFERENCES_SIGNING_KEY||process.env.OWNERTRACKER_SESSION_SECRET||''}){
  installShopManagement(db);
  return async function route(req,res,p,url){
    const preference=p.match(/^\/email-preferences\/([^/]+)$/);
    if(preference){
      const respond=(status,value)=>{json(res,status,value,{'cache-control':'no-store','referrer-policy':'no-referrer'});return true;};
      try{
        const customer=preferenceCustomer(db,preference[1],preferencesSigningKey);
        if(req.method==='GET'){
          const consent=db.prepare('SELECT marketing_email FROM customer_contact_consents WHERE customer_id=?').get(customer.id);
          res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});
          res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences</title><link rel="stylesheet" href="/styles.css"></head><body><main class="login-card" style="max-width:560px;margin:40px auto"><h1>Marketing email preferences</h1><p>${consent?.marketing_email?'You can stop marketing emails from the shop.':'Marketing emails are currently stopped for this customer.'}</p><p>Service-related email permission is separate and will remain unchanged.</p><form id="marketingOptOut"><button class="btn primary">Stop marketing emails</button></form><p id="preferenceResult" role="status"></p></main><script type="module" src="/shop-preferences.js"></script></body></html>`);return true;
        }
        if(req.method==='POST'){
          const d=await readBody(req);if(d.confirmUnsubscribe!==true)fail(400,'Explicit unsubscribe confirmation required');
          tx(db,()=>{const old=db.prepare('SELECT * FROM customer_contact_consents WHERE customer_id=?').get(customer.id);if(old&&old.marketing_email){db.prepare("UPDATE customer_contact_consents SET marketing_email=0,source='Customer marketing opt-out link',recorded_by=0,recorded_at=CURRENT_TIMESTAMP WHERE customer_id=?").run(customer.id);db.prepare('INSERT INTO contact_consent_events(customer_id,service_email,marketing_email,source,actor_id,actor_username) VALUES(?,?,?,?,?,?)').run(customer.id,old.service_email,0,'Customer marketing opt-out link',0,'customer');}db.prepare("UPDATE customer_message_outbox SET status='consent_required' WHERE customer_id=? AND category='marketing' AND status IN ('queued','waiting_provider','retry_wait')").run(customer.id);});
          return respond(200,{ok:true,notice:'Marketing emails are stopped. Service email permission is unchanged.'});
        }
        return respond(405,{error:'Method not allowed'});
      }catch(error){return respond(error.status||400,{error:error.status===404?'Email preference link not found':text(error.message,200)});}
    }
    if(!p.startsWith('/api/management/'))return false;
    const respond=(status,body)=>{json(res,status,body);return true;};
    const user=currentUser(req);if(!user)return respond(401,{error:'Login required'});
    if(!staff.has(user.role))return respond(403,{error:'Shop management staff permission required'});
    const body=()=>readBody(req);
    const manager=()=>{if(!managers.has(user.role))fail(403,'Manager/owner permission required');};
    try{
      if(p==='/api/management/overview'&&req.method==='GET')return respond(200,{
        policy:db.prepare('SELECT * FROM shop_management_policy WHERE id=1').get(),
        advisors:db.prepare("SELECT id,username,display_name,role FROM users WHERE active=1 AND role IN ('owner','manager','advisor','service_writer') ORDER BY username").all(),
        workOrders:db.prepare("SELECT w.id,w.ref_number,w.customer_name,w.service_advisor_id,u.display_name advisor_name FROM work_orders w LEFT JOIN users u ON u.id=w.service_advisor_id WHERE w.stage NOT IN ('Closed','Picked Up','Declined') ORDER BY w.id DESC LIMIT 200").all(),
        purchaseRequests:db.prepare('SELECT * FROM purchase_approval_requests ORDER BY id DESC LIMIT 100').all(),
        catalog:db.prepare('SELECT c.*,COALESCE((SELECT SUM(quantity_delta) FROM inventory_adjustments i WHERE i.item_sku=c.sku),0) on_hand FROM stock_catalog c ORDER BY c.sku').all(),
        receiving:db.prepare('SELECT l.*,o.supplier_reference,o.supplier_name FROM receiving_order_lines l JOIN receiving_orders o ON o.id=l.order_id ORDER BY l.id DESC LIMIT 300').all(),
        outbox:db.prepare('SELECT id,customer_id,category,recipient,subject,status,attempts,next_attempt_at,last_error,created_at FROM customer_message_outbox ORDER BY id DESC LIMIT 100').all(),
        consent:db.prepare('SELECT c.*,u.name customer_name FROM customer_contact_consents c JOIN customers u ON u.id=c.customer_id ORDER BY u.name').all(),
        appointments:db.prepare('SELECT * FROM shop_appointments ORDER BY starts_at DESC LIMIT 100').all(),
        integrations:integrationInventory(),permissions:{manage:managers.has(user.role),purchase:purchasers.has(user.role)}
      });
      if(p==='/api/management/policy'&&req.method==='PATCH'){
        manager();const d=await body(),advisor=integer(d.advisorPurchaseLimitCents,'Advisor ceiling',0),parts=integer(d.partsPurchaseLimitCents,'Parts ceiling',0),independent=integer(d.independentApprovalCents,'Independent approval threshold',1);
        db.prepare('UPDATE shop_management_policy SET advisor_purchase_limit_cents=?,parts_purchase_limit_cents=?,independent_approval_cents=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=1').run(advisor,parts,independent,user.id);audit(db,user,'Purchasing policy changed',{advisor,parts,independent});return respond(200,{ok:true});
      }
      const advisorRoute=p.match(/^\/api\/management\/work-orders\/(\d+)\/advisor$/);
      if(advisorRoute&&req.method==='POST'){
        manager();const d=await body(),id=integer(advisorRoute[1],'Work order ID'),advisor=integer(d.advisorId,'Advisor ID');
        if(!db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role IN ('owner','manager','advisor','service_writer')").get(advisor))fail(400,'An active advisor/service writer/manager is required');
        if(!db.prepare('UPDATE work_orders SET service_advisor_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(advisor,id).changes)fail(404,'Work order not found');
        audit(db,user,'Advisor responsibility assigned',{advisorId:advisor},id);return respond(200,{ok:true});
      }
      if(p==='/api/management/purchase-requests'&&req.method==='POST'){
        if(!purchasers.has(user.role))fail(403,'Purchasing permission required');const d=await body(),total=integer(d.totalCents,'Total cents',0),ids=normalizedWorkOrders(db,d.workOrderIds||[]),context=text(d.context||'purchase',80),reason=text(d.reason,500),key=keyOf(d);checkAdvisor(db,user,ids);
        if(reason.length<5||!['purchase','inventory_adjustment','stock_restock'].includes(context))fail(400,'A reason and supported approval context are required');
        const binding=purchaseTarget(d.target,context),fingerprint=hash({requester:user.id,total,ids,context,reason,targetSha256:binding.digest});
        const row=tx(db,()=>{const old=db.prepare('SELECT * FROM purchase_approval_requests WHERE idempotency_key=?').get(key);if(old){if(old.fingerprint!==fingerprint)fail(409,'Request key reused with different details');return {...old,duplicate:true};}const r=db.prepare('INSERT INTO purchase_approval_requests(requester_id,requester_username,total_cents,work_order_ids,context,reason,idempotency_key,fingerprint,target_json,target_sha256) VALUES(?,?,?,?,?,?,?,?,?,?)').run(user.id,user.username,total,JSON.stringify(ids),context,reason,key,fingerprint,binding.serialized,binding.digest);audit(db,user,'Independent purchase approval requested',{id:Number(r.lastInsertRowid),total,ids,context,targetSha256:binding.digest});return db.prepare('SELECT * FROM purchase_approval_requests WHERE id=?').get(Number(r.lastInsertRowid));});
        return respond(row.duplicate?200:201,{request:row});
      }
      const decision=p.match(/^\/api\/management\/purchase-requests\/(\d+)\/decision$/);
      if(decision&&req.method==='POST'){
        manager();const d=await body(),reason=text(d.reason,500);if(!['approve','reject'].includes(d.decision)||reason.length<5)fail(400,'Decision and reason required');
        return respond(200,tx(db,()=>{const row=db.prepare('SELECT * FROM purchase_approval_requests WHERE id=?').get(Number(decision[1]));if(!row)fail(404,'Request not found');if(row.requester_id===user.id)fail(403,'The requester cannot approve or reject their own request');if(row.status!=='pending')fail(409,'Request already decided');db.prepare('UPDATE purchase_approval_requests SET status=?,approved_by=?,approver_username=?,decision_reason=?,decided_at=CURRENT_TIMESTAMP WHERE id=?').run(d.decision==='approve'?'approved':'rejected',user.id,user.username,reason,row.id);audit(db,user,'Purchase approval decision',{id:row.id,decision:d.decision,reason});return {ok:true};}));
      }
      if(p==='/api/management/catalog'&&req.method==='POST'){
        manager();const d=await body(),sku=text(d.sku,100),barcode=text(d.barcode,120)||null,description=text(d.description,300),bin=text(d.bin,100),reorder=integer(d.reorderLevel||0,'Reorder level',0,100000);
        if(!sku||!description)fail(400,'SKU and description are required');db.prepare('INSERT INTO stock_catalog(sku,barcode,description,bin_location,reorder_level) VALUES(?,?,?,?,?)').run(sku,barcode,description,bin,reorder);audit(db,user,'Stock catalog item created',{sku,barcode});return respond(201,{sku});
      }
      if(p==='/api/management/catalog/lookup'&&req.method==='GET'){
        const q=text(url.searchParams.get('code'),120);const item=db.prepare('SELECT c.*,COALESCE((SELECT SUM(quantity_delta) FROM inventory_adjustments i WHERE i.item_sku=c.sku),0) on_hand FROM stock_catalog c WHERE c.sku=? OR c.barcode=?').get(q,q);return item?respond(200,{item}):respond(404,{error:'SKU/barcode not found'});
      }
      if(p==='/api/management/receiving-orders'&&req.method==='POST'){
        manager();const d=await body(),reference=text(d.supplierReference,180),supplier=text(d.supplierName,180);if(reference.length<3||!supplier||!Array.isArray(d.lines)||!d.lines.length||d.lines.length>100)fail(400,'Supplier reference, name and 1–100 lines are required');
        const normalized=d.lines.map(l=>({sku:text(l.sku,100),quantity:integer(l.quantity,'Ordered quantity',1,100000)}));if(new Set(normalized.map(l=>l.sku)).size!==normalized.length)fail(400,'Duplicate SKU lines are not allowed');
        return respond(201,tx(db,()=>{for(const l of normalized)if(!db.prepare('SELECT sku FROM stock_catalog WHERE sku=?').get(l.sku))fail(400,'Create each catalog SKU before receiving');const r=db.prepare('INSERT INTO receiving_orders(supplier_reference,supplier_name,created_by) VALUES(?,?,?)').run(reference,supplier,user.id);const id=Number(r.lastInsertRowid);for(const l of normalized)db.prepare('INSERT INTO receiving_order_lines(order_id,sku,ordered_quantity) VALUES(?,?,?)').run(id,l.sku,l.quantity);audit(db,user,'Supplier receiving record created',{id,reference,supplier});return {id,notice:'Records an existing supplier order; no supplier purchase was placed'};}));
      }
      const receive=p.match(/^\/api\/management\/receiving-lines\/(\d+)$/);
      if(receive&&req.method==='POST'){if(!purchasers.has(user.role))fail(403,'Receiving permission required');return respond(201,receiveStock(db,user,Number(receive[1]),await body()));}
      const consentRoute=p.match(/^\/api\/management\/customers\/(\d+)\/consent$/);
      if(consentRoute&&req.method==='POST')return respond(200,{consent:recordContactConsent(db,user,Number(consentRoute[1]),await body())});
      if(p==='/api/management/messages'&&req.method==='POST'){const row=enqueueCustomerMessage(db,user,await body());return respond(row.duplicate?200:201,{message:row,notice:'Queued/prepared only; this does not claim delivery'});}
      if(p==='/api/management/messages/process'&&req.method==='POST'){manager();const d=await body();if(d.confirmSend!==true)fail(400,'Explicit send confirmation required');return respond(200,await dispatchDueOutbox(db,user,{...(mailProvider?{mailProvider,providerConfigured:true}:{})}));}
      const send=p.match(/^\/api\/management\/messages\/(\d+)\/send$/);
      if(send&&req.method==='POST'){manager();const d=await body();if(d.confirmSend!==true)fail(400,'Explicit send confirmation required');return respond(200,await dispatchOutboxMessage(db,user,Number(send[1]),{...(mailProvider?{mailProvider,providerConfigured:true}:{})}));}
      const queue=p.match(/^\/api\/management\/messages\/(\d+)\/queue$/);
      if(queue&&req.method==='POST'){
        manager();const d=await body();if(d.confirmQueue!==true)fail(400,'Explicit queue confirmation required');
        const row=db.prepare('SELECT * FROM customer_message_outbox WHERE id=?').get(Number(queue[1]));if(!row)fail(404,'Message not found');if(row.status!=='draft')fail(409,'Only a draft may be queued');
        const consent=db.prepare('SELECT * FROM customer_contact_consents WHERE customer_id=?').get(row.customer_id),permitted=consent?.[row.category==='marketing'?'marketing_email':'service_email']===1;
        db.prepare('UPDATE customer_message_outbox SET status=? WHERE id=?').run(permitted?'queued':'consent_required',row.id);audit(db,user,'Draft customer email queued',{messageId:row.id});return respond(200,{ok:true,status:permitted?'queued':'consent_required'});
      }
      const retry=p.match(/^\/api\/management\/messages\/(\d+)\/retry$/);
      if(retry&&req.method==='POST'){
        manager();const d=await body();if(d.acknowledgePossibleDuplicate!==true||text(d.reason).length<5)fail(400,'Review provider history, acknowledge possible duplicate and provide reason');
        const row=db.prepare('SELECT * FROM customer_message_outbox WHERE id=?').get(Number(retry[1]));if(!row)fail(404,'Message not found');if(!['provider_failed','delivery_unknown','sending','retry_wait'].includes(row.status))fail(409,'Only failed/uncertain attempts can be reviewed for retry');
        if(row.status==='sending'&&row.sending_started_at&&Date.parse(row.sending_started_at)>Date.now()-300000)fail(409,'The provider attempt may still be active; wait at least five minutes before reviewing an interrupted attempt');
        db.prepare("UPDATE customer_message_outbox SET status='queued',next_attempt_at=NULL,last_error='' WHERE id=?").run(row.id);audit(db,user,'Uncertain email retry explicitly authorized',{messageId:row.id,reason:text(d.reason)});return respond(200,{ok:true,notice:'Queued for another attempt; no email sent by this action'});
      }
      const appt=p.match(/^\/api\/management\/appointments\/(\d+)$/);
      const syncAppt=p.match(/^\/api\/management\/appointments\/(\d+)\/sync$/);
      if(syncAppt&&req.method==='POST'){
        if(user.role==='parts')fail(403,'Scheduling permission required');const d=await body();if(d.confirmSync!==true)fail(400,'Explicit calendar sync confirmation required');
        const appointment=db.prepare('SELECT * FROM shop_appointments WHERE id=?').get(Number(syncAppt[1]));if(!appointment)fail(404,'Appointment not found');
        if(!calendarChange)fail(503,'Google Calendar update/cancel adapter is not configured; local changes remain saved');
        try{const result=await calendarChange(appointment);audit(db,user,'Calendar change sync attempted',{appointmentId:appointment.id,status:result.status||'provider_accepted'});return respond(200,{...result,notice:'Provider adapter returned its current sync status'});}
        catch{db.prepare("UPDATE shop_appointments SET sync_error='Remote calendar update failed; retry after checking connection' WHERE id=?").run(appointment.id);return respond(503,{error:'Remote calendar update failed; local appointment is retained'});}
      }
      if(appt&&req.method==='PATCH'){
        if(user.role==='parts')fail(403,'Scheduling permission required');const d=await body(),id=Number(appt[1]),reason=text(d.reason,500);if(reason.length<5)fail(400,'Reason required for schedule changes');if(d.status!==undefined&&!['scheduled','cancelled'].includes(d.status))fail(400,'Appointment status must be scheduled or cancelled');
        const result=tx(db,()=>{const old=db.prepare('SELECT * FROM shop_appointments WHERE id=?').get(id);if(!old)fail(404,'Appointment not found');if(integer(d.expectedRevision,'Expected revision')!==old.management_revision)fail(409,'Appointment changed; reload before editing');if(old.status==='cancelled')fail(409,'Cancelled appointments cannot be rescheduled');
          const status=d.status==='cancelled'?'cancelled':'scheduled',start=Date.parse(d.startsAt||old.starts_at),end=Date.parse(d.endsAt||old.ends_at),title=text(d.title||old.title,150);if(!title||!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>86400000)fail(400,'Valid start, end and title required');
          const sync=old.google_event_id?(status==='cancelled'?'cancel_pending':'update_pending'):'local_only';
          db.prepare('UPDATE shop_appointments SET starts_at=?,ends_at=?,title=?,status=?,management_revision=management_revision+1,sync_status=?,sync_error=? WHERE id=?').run(new Date(start).toISOString(),new Date(end).toISOString(),title,status,sync,old.google_event_id?'Remote calendar update requires successful provider adapter':'',id);
          const after=db.prepare('SELECT * FROM shop_appointments WHERE id=?').get(id);db.prepare('INSERT INTO appointment_change_events(appointment_id,before_json,after_json,reason,actor_id,actor_username) VALUES(?,?,?,?,?,?)').run(id,JSON.stringify(old),JSON.stringify(after),reason,user.id,user.username);audit(db,user,'Appointment changed',{id,status,reason});return {appointment:after,calendarSync:sync};
        });
        if(calendarChange&&result.appointment.google_event_id){try{const external=await calendarChange(result.appointment);return respond(200,{...result,calendarSync:external.status||'provider_accepted'});}catch{return respond(200,{...result,calendarSync:'error',notice:'Saved locally; remote calendar update failed and needs retry'});}}
        return respond(200,result);
      }
      return respond(404,{error:'Unknown shop management route'});
    }catch(error){return respond(error.status||(/UNIQUE constraint/.test(error.message)?409:400),{error:text(error.message,400)});}
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {openDb} from '../src/db.mjs';
import {extendDatabase} from '../src/pos-extension.mjs';
import {installShopOps} from '../src/shop-ops.mjs';
import {installShopManagement,shopManagementRoutes,assertPurchaseAuthorized,recordContactConsent,enqueueCustomerMessage,dispatchOutboxMessage,dispatchDueOutbox,receiveStock,marketingPreferenceToken} from '../src/shop-management.mjs';

function fixture(){
  const db=openDb(':memory:');extendDatabase(db);installShopOps(db);installShopManagement(db);
  const users={};for(const role of ['owner','manager','advisor','service_writer','parts','technician','viewer']){const id=Number(db.prepare('INSERT INTO users(username,password_hash,salt,role) VALUES(?,?,?,?)').run(role,'not-a-password','test',role).lastInsertRowid);users[role]={id,username:role,role};}
  const customer=Number(db.prepare("INSERT INTO customers(name,email) VALUES('Shop QA','qa@example.test')").run().lastInsertRowid);
  const wo=Number(db.prepare("INSERT INTO work_orders(source,customer_id,ref_number,customer_name) VALUES('manual',?,'WO-MANAGEMENT','Shop QA')").run(customer).lastInsertRowid);
  const preferencesSigningKey='test-email-preferences-secret-longer-than-32';
  const routes=shopManagementRoutes({db,currentUser:req=>req.user,json:(_res,status,body)=>{_res.status=status;_res.body=body;},readBody:async req=>req.body,preferencesSigningKey});
  async function call(path,method='GET',body={},user=users.owner,status=200){const res={writeHead(status){this.status=status;},end(body){this.body=body;}},url=new URL('http://local'+path);assert.equal(await routes({method,body,user},res,url.pathname,url),true);assert.equal(res.status,status,JSON.stringify(res.body));return res.body;}
  return {db,users,customer,wo,call,preferencesSigningKey};
}
const rejection=(fn,status)=>assert.throws(fn,error=>error.status===status);

test('management routes enforce staff access and independent purchasing approval is bound, single-use and rollback-safe',async()=>{
  const f=fixture();try{
    await f.call('/api/management/overview','GET',{},null,401);
    await f.call('/api/management/overview','GET',{},f.users.technician,403);
    rejection(()=>assertPurchaseAuthorized(f.db,f.users.owner,100000),403);
    const target={kind:'repair',vendorId:1,cartId:4,lines:[{sku:'WSM-01',qty:1,unitCost:1000,workOrderId:f.wo}]};
    const payload={target,totalCents:100000,workOrderIds:[f.wo],context:'purchase',reason:'Reviewed supplier manifest',idempotencyKey:'purchase-request-one'};
    const request=(await f.call('/api/management/purchase-requests','POST',payload,f.users.owner,201)).request;
    assert.equal((await f.call('/api/management/purchase-requests','POST',payload)).request.duplicate,true);
    await f.call(`/api/management/purchase-requests/${request.id}/decision`,'POST',{decision:'approve',reason:'I checked all lines'},f.users.owner,403);
    await f.call(`/api/management/purchase-requests/${request.id}/decision`,'POST',{decision:'approve',reason:'I checked all lines'},f.users.manager);
    rejection(()=>assertPurchaseAuthorized(f.db,f.users.owner,100001,[f.wo],request.id),403);
    rejection(()=>assertPurchaseAuthorized(f.db,f.users.owner,100000,[],request.id),403);
    rejection(()=>assertPurchaseAuthorized(f.db,f.users.owner,100000,[f.wo],request.id,'purchase',{...target,vendorId:2}),403);
    rejection(()=>assertPurchaseAuthorized(f.db,f.users.owner,100000,[f.wo],request.id,'purchase',{...target,lines:[{...target.lines[0],sku:'DIFFERENT-SKU'}]}),403);
    f.db.exec('BEGIN IMMEDIATE');assert.equal(assertPurchaseAuthorized(f.db,f.users.owner,100000,[f.wo],request.id,'purchase',target).independentApproval,true);f.db.exec('ROLLBACK');
    assert.equal(f.db.prepare('SELECT status FROM purchase_approval_requests WHERE id=?').get(request.id).status,'approved');
    assertPurchaseAuthorized(f.db,f.users.owner,100000,[f.wo],request.id,'purchase',target);
    rejection(()=>assertPurchaseAuthorized(f.db,f.users.owner,100000,[f.wo],request.id,'purchase',target),403);
    assert.throws(()=>f.db.prepare('UPDATE purchase_approval_requests SET total_cents=1 WHERE id=?').run(request.id),/cannot be changed/);
    assert.throws(()=>f.db.prepare('DELETE FROM purchase_approval_requests WHERE id=?').run(request.id),/cannot be deleted/);
  }finally{f.db.close();}
});

test('advisor ownership and role purchase ceilings cover repair and retail-only manifests',async()=>{
  const f=fixture();try{
    rejection(()=>assertPurchaseAuthorized(f.db,f.users.advisor,100,[f.wo]),403);
    await f.call(`/api/management/work-orders/${f.wo}/advisor`,'POST',{advisorId:f.users.advisor.id});
    assert.equal(assertPurchaseAuthorized(f.db,f.users.advisor,50000,[f.wo]).authorized,true);
    rejection(()=>assertPurchaseAuthorized(f.db,f.users.advisor,50001,[f.wo]),403);
    assert.equal(assertPurchaseAuthorized(f.db,f.users.advisor,1000,[]).authorized,true);
    rejection(()=>assertPurchaseAuthorized(f.db,f.users.parts,50001,[]),403);
    const request=(await f.call('/api/management/purchase-requests','POST',{target:{kind:'retail',vendorId:1,cartId:1,lines:[{sku:'WSM-02',qty:1,unitCostCents:60000}]},totalCents:60000,workOrderIds:[],reason:'Retail manifest over employee limit',idempotencyKey:'retail-approval-key'},f.users.advisor,201)).request;
    await f.call(`/api/management/purchase-requests/${request.id}/decision`,'POST',{decision:'approve',reason:'Exact invoice and supplier verified'},f.users.owner);
    assert.equal(assertPurchaseAuthorized(f.db,f.users.advisor,60000,[],request.id,'purchase',{kind:'retail',vendorId:1,cartId:1,lines:[{sku:'WSM-02',qty:1,unitCostCents:60000}]}).approvalId,request.id);
    await f.call('/api/management/policy','PATCH',{advisorPurchaseLimitCents:1,partsPurchaseLimitCents:1,independentApprovalCents:2},f.users.parts,403);
  }finally{f.db.close();}
});

test('barcode catalog and physical partial receiving/returns update stock once and cap quantities',async()=>{
  const f=fixture();try{
    await f.call('/api/management/catalog','POST',{sku:'BELT-01',barcode:'012345678901',description:'Drive belt',bin:'A-1',reorderLevel:2},f.users.owner,201);
    const lookup=await f.call('/api/management/catalog/lookup?code=012345678901','GET');
    assert.equal(lookup.item.sku,'BELT-01');assert.equal(lookup.item.bin_location,'A-1');
    await f.call('/api/management/catalog/lookup?code=not-found','GET',{},f.users.owner,404);
  }finally{f.db.close();}
});

test('partial supplier receipts, idempotency and returns preserve the physical stock ledger',async()=>{
  const f=fixture();try{
    await f.call('/api/management/catalog','POST',{sku:'BELT-01',barcode:'012345678901',description:'Drive belt',bin:'A-1'},f.users.owner,201);
    const po=await f.call('/api/management/receiving-orders','POST',{supplierName:'Test Dealer',supplierReference:'PO-REAL-123',lines:[{sku:'BELT-01',quantity:5}]},f.users.owner,201);
    const line=f.db.prepare('SELECT * FROM receiving_order_lines WHERE order_id=?').get(po.id);
    const receipt={operation:'receive',quantity:2,reference:'PACKING-01',idempotencyKey:'receiving-first-key'};
    receiveStock(f.db,f.users.parts,line.id,receipt);
    assert.equal(receiveStock(f.db,f.users.parts,line.id,receipt).duplicate,true);
    assert.equal(f.db.prepare('SELECT SUM(quantity_delta) n FROM inventory_adjustments').get().n,2);
    rejection(()=>receiveStock(f.db,f.users.parts,line.id,{...receipt,quantity:3}),409);
    rejection(()=>receiveStock(f.db,f.users.parts,line.id,{...receipt,quantity:4,idempotencyKey:'receiving-over-key'}),409);
    rejection(()=>receiveStock(f.db,f.users.parts,line.id,{operation:'return',quantity:1,reference:'RETURN-001',reason:'Wrong supplied belt',idempotencyKey:'supplier-return-key'}),403);
    receiveStock(f.db,f.users.owner,line.id,{operation:'return',quantity:1,reference:'RETURN-001',reason:'Wrong supplied belt',idempotencyKey:'supplier-return-key'});
    rejection(()=>receiveStock(f.db,f.users.owner,line.id,{operation:'return',quantity:2,reference:'RETURN-002',reason:'Exceeds available stock',idempotencyKey:'supplier-return-over'}),409);
    assert.equal(f.db.prepare('SELECT SUM(quantity_delta) n FROM inventory_adjustments').get().n,1);
    assert.equal(f.db.prepare('SELECT status FROM receiving_orders WHERE id=?').get(po.id).status,'partially_received');
    assert.throws(()=>f.db.prepare('DELETE FROM stock_operations').run(),/immutable/);
  }finally{f.db.close();}
});

test('separate affirmative consent blocks sends and missing provider never claims delivery',async()=>{
  const f=fixture();try{
    rejection(()=>recordContactConsent(f.db,f.users.owner,f.customer,{serviceEmail:'true',marketingEmail:false,source:'Written intake form'}),400);
    recordContactConsent(f.db,f.users.owner,f.customer,{serviceEmail:true,marketingEmail:false,source:'Written intake form'});
    const service=enqueueCustomerMessage(f.db,f.users.owner,{customerId:f.customer,category:'service',subject:'Ready for pickup',message:'Your unit is ready',idempotencyKey:'service-message-key'});
    const marketing=enqueueCustomerMessage(f.db,f.users.owner,{customerId:f.customer,category:'marketing',subject:'Season reminder',message:'Prepare for summer',idempotencyKey:'marketing-message-key'});
    assert.equal(marketing.status,'consent_required');
    let calls=0;
    assert.equal((await dispatchOutboxMessage(f.db,f.users.owner,marketing.id,{providerConfigured:true,mailProvider:async()=>{calls++;return {status:'provider_accepted'};}})).status,'consent_required');
    assert.equal(calls,0);
    assert.equal((await dispatchOutboxMessage(f.db,f.users.owner,service.id,{providerConfigured:false})).status,'waiting_provider');
    assert.equal(f.db.prepare('SELECT attempts FROM customer_message_outbox WHERE id=?').get(service.id).attempts,0);
    recordContactConsent(f.db,f.users.owner,f.customer,{serviceEmail:false,marketingEmail:false,source:'Customer withdrew email permission'});
    assert.equal((await dispatchOutboxMessage(f.db,f.users.owner,service.id,{providerConfigured:true,mailProvider:async()=>{calls++;return {status:'provider_accepted'};}})).status,'consent_required');
    assert.equal(calls,0);
    assert.throws(()=>f.db.prepare('DELETE FROM contact_consent_events').run(),/immutable/);
  }finally{f.db.close();}
});

test('durable email retry records definitive failure, enforces delay and never resends accepted messages',async()=>{
  const f=fixture();try{
    recordContactConsent(f.db,f.users.owner,f.customer,{serviceEmail:true,marketingEmail:false,source:'Signed consent form'});
    const message=enqueueCustomerMessage(f.db,f.users.owner,{customerId:f.customer,category:'service',subject:'Invoice ready',message:'Please review',idempotencyKey:'retry-message-key'});
    let calls=0;const provider=async()=>++calls===1?{status:'provider_failed',error:'Provider HTTP 503',retryable:true}:{status:'provider_accepted',reference:'PROVIDER-123'};
    const start=new Date('2026-10-25T15:00:00Z');
    const failed=await dispatchOutboxMessage(f.db,f.users.owner,message.id,{providerConfigured:true,mailProvider:provider,now:()=>start});
    assert.equal(failed.status,'retry_wait');
    await assert.rejects(dispatchOutboxMessage(f.db,f.users.owner,message.id,{providerConfigured:true,mailProvider:provider,now:()=>start}),error=>error.status===409);
    const accepted=await dispatchOutboxMessage(f.db,f.users.owner,message.id,{providerConfigured:true,mailProvider:provider,now:()=>new Date(start.getTime()+61000)});
    assert.equal(accepted.status,'provider_accepted');assert.equal(calls,2);
    await dispatchOutboxMessage(f.db,f.users.owner,message.id,{providerConfigured:true,mailProvider:provider});assert.equal(calls,2);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notification_attempts WHERE message_id=?').get(message.id).n,2);
    const duplicate=enqueueCustomerMessage(f.db,f.users.owner,{customerId:f.customer,category:'service',subject:'Invoice ready',message:'Please review',idempotencyKey:'retry-message-key'});assert.equal(duplicate.duplicate,true);
    rejection(()=>enqueueCustomerMessage(f.db,f.users.owner,{customerId:f.customer,category:'service',subject:'Changed',message:'Please review',idempotencyKey:'retry-message-key'}),409);
  }finally{f.db.close();}
});

test('ambiguous email outcome is retained for manual review instead of unsafe automatic repeat',async()=>{
  const f=fixture();try{
    recordContactConsent(f.db,f.users.owner,f.customer,{serviceEmail:true,marketingEmail:false,source:'Signed intake consent'});
    const message=enqueueCustomerMessage(f.db,f.users.owner,{customerId:f.customer,category:'service',subject:'Repair update',message:'We are diagnosing',idempotencyKey:crypto.randomUUID()});
    const result=await dispatchOutboxMessage(f.db,f.users.owner,message.id,{providerConfigured:true,mailProvider:async()=>{throw Error('Connection lost');}});
    assert.equal(result.status,'delivery_unknown');
    await assert.rejects(dispatchOutboxMessage(f.db,f.users.owner,message.id,{providerConfigured:true,mailProvider:async()=>({status:'provider_accepted'})}),error=>error.status===409);
    await f.call(`/api/management/messages/${message.id}/retry`,'POST',{reason:'Provider history reviewed; no acceptance',acknowledgePossibleDuplicate:true});
    assert.equal(f.db.prepare('SELECT status FROM customer_message_outbox WHERE id=?').get(message.id).status,'queued');
  }finally{f.db.close();}
});

test('scheduled email queue skips future messages and batches only due consented messages',async()=>{
  const f=fixture();try{
    recordContactConsent(f.db,f.users.owner,f.customer,{serviceEmail:true,marketingEmail:false,source:'Signed intake form'});
    const future=enqueueCustomerMessage(f.db,f.users.owner,{customerId:f.customer,category:'service',subject:'Service reminder',message:'Scheduled maintenance due',sendAfter:'2030-01-01T12:00:00Z',idempotencyKey:'future-reminder-key'});
    const due=enqueueCustomerMessage(f.db,f.users.owner,{customerId:f.customer,category:'service',subject:'Repair ready',message:'Current status update',idempotencyKey:'due-message-key'});
    const sent=[];const result=await dispatchDueOutbox(f.db,f.users.owner,{providerConfigured:true,mailProvider:async message=>{sent.push(message.id);return {status:'provider_accepted'};},now:()=>new Date('2026-10-25T15:00:00Z')});
    assert.deepEqual(sent,[due.id]);assert.equal(result.results[0].status,'provider_accepted');assert.equal(f.db.prepare('SELECT status FROM customer_message_outbox WHERE id=?').get(future.id).status,'queued');
    rejection(()=>enqueueCustomerMessage(f.db,f.users.owner,{customerId:f.customer,category:'service',subject:'Invalid schedule',message:'Test',sendAfter:'not-a-date',idempotencyKey:'invalid-schedule-key'}),400);
  }finally{f.db.close();}
});

test('signed customer marketing opt-out is scoped, explicit, idempotent and keeps service consent',async()=>{
  const f=fixture();try{
    recordContactConsent(f.db,f.users.owner,f.customer,{serviceEmail:true,marketingEmail:true,source:'Separate written marketing opt-in'});
    const pending=enqueueCustomerMessage(f.db,f.users.owner,{customerId:f.customer,category:'marketing',subject:'Season reminder',message:'Prepare your unit',idempotencyKey:'marketing-optout-pending'});
    const token=marketingPreferenceToken(f.customer,f.preferencesSigningKey);
    await f.call('/email-preferences/'+token,'POST',{confirmUnsubscribe:false},null,400);
    await f.call('/email-preferences/'+token.slice(0,-1)+'X','POST',{confirmUnsubscribe:true},null,404);
    await f.call('/email-preferences/'+token,'POST',{confirmUnsubscribe:true},null);
    const consent=f.db.prepare('SELECT * FROM customer_contact_consents WHERE customer_id=?').get(f.customer);
    assert.equal(consent.service_email,1);assert.equal(consent.marketing_email,0);
    assert.equal(f.db.prepare('SELECT status FROM customer_message_outbox WHERE id=?').get(pending.id).status,'consent_required');
    const count=f.db.prepare('SELECT COUNT(*) n FROM contact_consent_events').get().n;
    await f.call('/email-preferences/'+token,'POST',{confirmUnsubscribe:true},null);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM contact_consent_events').get().n,count);
  }finally{f.db.close();}
});

test('local appointment edits detect stale revisions, retain audit and truthfully flag unsynced Google changes',async()=>{
  const f=fixture();try{
    const id=Number(f.db.prepare("INSERT INTO shop_appointments(title,starts_at,ends_at,created_by,google_event_id,sync_status) VALUES('Dropoff','2026-10-26T16:00:00Z','2026-10-26T17:00:00Z',?,'event-123','synced')").run(f.users.owner.id).lastInsertRowid);
    const changed=await f.call(`/api/management/appointments/${id}`,'PATCH',{startsAt:'2026-10-26T17:00:00Z',endsAt:'2026-10-26T18:00:00Z',reason:'Customer requested later time',expectedRevision:1});
    assert.equal(changed.calendarSync,'update_pending');assert.equal(changed.appointment.management_revision,2);
    await f.call(`/api/management/appointments/${id}`,'PATCH',{reason:'Stale staff request',expectedRevision:1,status:'cancelled'},f.users.owner,409);
    const cancel=await f.call(`/api/management/appointments/${id}`,'PATCH',{reason:'Customer cancelled service',expectedRevision:2,status:'cancelled'});assert.equal(cancel.calendarSync,'cancel_pending');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointment_change_events WHERE appointment_id=?').get(id).n,2);
    await f.call(`/api/management/appointments/${id}`,'PATCH',{reason:'Attempt to revive cancelled booking',expectedRevision:3},f.users.owner,409);
  }finally{f.db.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {openDb,ensureAdmin} from '../src/db.mjs';
import {extendDatabase} from '../src/pos-extension.mjs';
import {authorizationRoutes,hasCurrentAuthorization,readRetainedAuthorizationDocument} from '../src/authorizations.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ot-authorizations-'));
  const db=openDb(path.join(root,'test.sqlite'));extendDatabase(db);
  ensureAdmin(db,'owner','Owner-test-password-2026!');
  const owner=db.prepare("SELECT * FROM users WHERE username='owner'").get();
  const uploads=path.join(root,'uploads');fs.mkdirSync(uploads);
  db.exec(`INSERT INTO customers(id,name,email,phone,address_line1,city,state,postal_code,billing_same_as_service)
    VALUES(1,'Original Customer','customer@example.test','555-0000','100 Original Road','Phoenix','AZ','85001',1);
    INSERT INTO vehicles(id,customer_id,year,make,model,hin) VALUES(1,1,'2024','Yamaha','VX','TEST-HIN');
    INSERT INTO work_orders(id,source,ref_number,customer_id,vehicle_id,customer_name,unit_label,serial,complaint,authorized_work,estimate_total,parts_total,labor_total,tax_rate_bps,tax_total_cents)
      VALUES(1,'manual','WO-AUTH',1,1,'Original Customer','2024 Yamaha VX','TEST-HIN','Inspect pump','Replace wear ring',109.10,100,0,910,910);
    INSERT INTO work_order_lines(id,work_order_id,line_type,item_ref,description,qty,rate,amount,taxable)
      VALUES(1,1,'part','RING-1','Original wear ring',1,100,100,1);`);
  let clock=Date.parse('2026-10-25T10:00:00Z');
  const route=authorizationRoutes({db,currentUser:req=>req.user,json:(res,status,value,headers)=>{res.writeHead(status,headers);res.end(JSON.stringify(value));},readBody:async req=>req.body||{},publicBaseUrl:'https://shop.example.test',shopName:'AZ Jet Ski',uploadDir:uploads,now:()=>clock});
  async function request(url,method='GET',body,user=owner) {
    const response={status:null,headers:{},body:null};
    response.handled=await route({method,body,user},{writeHead(status,headers){response.status=status;response.headers=headers;},end(value){response.bytes=Buffer.isBuffer(value)?value:null;response.body=Buffer.isBuffer(value)?value.toString('latin1'):String(value);}},url);
    response.json=()=>JSON.parse(response.body);
    return response;
  }
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  return {db,owner,uploads,request,setClock:value=>clock=value,root};
}
const requestApproval=async f=>{
  const response=await f.request('/api/work-orders/1/request-approval','POST',{authorizedDescription:'Replace wear ring'});
  assert.equal(response.status,200,response.body);
  return response.json();
};
const tokenPath=response=>new URL(response.approvalUrl).pathname;
const signPayload={choice:'Approve Repairs',signerName:'Customer Legal Name',agree:true};

test('request freezes exact customer, unit, itemized amount and terms, with immutable archived records',async t=>{
  const f=fixture(t),created=await requestApproval(f);
  assert.equal(created.deliveryStatus,'not_sent');
  const row=f.db.prepare('SELECT * FROM approvals WHERE id=?').get(created.approvalId);
  const snapshot=JSON.parse(row.snapshot_json);
  assert.equal(snapshot.estimateCents,10910);assert.equal(snapshot.taxCents,910);
  assert.equal(snapshot.customer.name,'Original Customer');assert.equal(snapshot.unit.serial,'TEST-HIN');
  assert.equal(snapshot.items[0].description,'Original wear ring');assert.equal(snapshot.addresses.billing.line1,'100 Original Road');
  assert.ok(snapshot.terms.length>=3);
  assert.equal(crypto.createHash('sha256').update(row.snapshot_json).digest('hex'),created.snapshotSha256);
  assert.throws(()=>f.db.prepare('UPDATE approvals SET authorized_description=? WHERE id=?').run('Changed',row.id),/immutable/);
  assert.throws(()=>f.db.prepare('DELETE FROM approvals WHERE id=?').run(row.id),/cannot be deleted/);
  const view=await f.request(tokenPath(created),'GET',undefined,null);
  assert.equal(view.status,200);assert.match(view.body,/\$109\.10/);assert.match(view.body,/Original wear ring/);
  assert.equal(view.headers['cache-control'],'no-store');
});

test('typed customer decision creates retained PDF, permanent consent hash and correctly limited repair permission',async t=>{
  const f=fixture(t),created=await requestApproval(f);
  const signed=await f.request(tokenPath(created),'POST',signPayload,null);
  assert.equal(signed.status,200,signed.body);
  assert.equal(hasCurrentAuthorization(f.db,1),true);
  const row=f.db.prepare('SELECT * FROM approvals WHERE id=?').get(created.approvalId);
  assert.equal(row.choice,'Approve Repairs');assert.equal(row.signer_name,signPayload.signerName);
  const record=JSON.parse(row.signed_record_json);assert.equal(record.electronicConsent,true);
  const download=await f.request(`/api/work-orders/1/authorizations/${row.id}/document`);
  assert.equal(download.status,200);assert.match(download.body,/^%PDF/);
  assert.match(download.body,/Customer Legal Name/);assert.match(download.body,/109.10/);
  assert.equal(crypto.createHash('sha256').update(download.bytes).digest('hex'),row.document_sha256);
  assert.throws(()=>f.db.prepare('UPDATE approvals SET signer_name=? WHERE id=?').run('Other signer',row.id),/cannot be rewritten/);
  assert.throws(()=>f.db.prepare('UPDATE authorization_events SET actor=? WHERE approval_id=?').run('Other',row.id),/immutable/);
  assert.equal((await f.request(tokenPath(created),'POST',signPayload,null)).status,409);
  f.db.prepare('UPDATE work_orders SET estimate_total=120 WHERE id=1').run();
  assert.equal(hasCurrentAuthorization(f.db,1),false);
  const retained=readRetainedAuthorizationDocument(f.db,row.id,1,f.uploads);
  assert.equal(retained.sha256,row.document_sha256);
  assert.throws(()=>readRetainedAuthorizationDocument(f.db,row.id,99,f.uploads),/not found/);
});

test('stale work scope cannot be signed and a supplemental request supersedes rather than rewrites its predecessor',async t=>{
  const f=fixture(t),first=await requestApproval(f);
  f.db.prepare("UPDATE work_order_lines SET description='Different work',amount=150 WHERE id=1").run();
  f.db.prepare('UPDATE work_orders SET estimate_total=163.65 WHERE id=1').run();
  assert.equal((await f.request(tokenPath(first),'POST',signPayload,null)).status,409);
  const stale=await f.request(tokenPath(first),'GET',undefined,null);
  assert.match(stale.body,/cannot be signed/);assert.doesNotMatch(stale.body,/<form/);
  const secondResponse=await f.request('/api/work-orders/1/authorizations','POST',{description:'Additional pump repairs',previousApprovalId:first.approvalId});
  assert.equal(secondResponse.status,200,secondResponse.body);
  const second=secondResponse.json();assert.equal(second.previousApprovalId,first.approvalId);
  assert.equal((await f.request(tokenPath(first),'GET',undefined,null)).status,410);
  assert.equal((await f.request(tokenPath(second),'POST',signPayload,null)).status,200);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM approvals').get().n,2);
});

test('diagnostic-only and decline decisions never grant repair purchasing authorization',async t=>{
  for(const choice of ['Diagnostics/Teardown Only','Decline Repairs']) {
    const f=fixture(t),created=await requestApproval(f);
    assert.equal((await f.request(tokenPath(created),'POST',{...signPayload,choice},null)).status,200);
    assert.equal(hasCurrentAuthorization(f.db,1),false);
    assert.equal(f.db.prepare('SELECT stage FROM work_orders WHERE id=1').get().stage,choice==='Decline Repairs'?'Declined':'Diagnosing');
  }
});

test('staff permissions, strict consent, expiry and revocation protect signing without deleting retained evidence',async t=>{
  const f=fixture(t);
  assert.equal((await f.request('/api/work-orders/1/authorizations','GET',undefined,null)).status,401);
  assert.equal((await f.request('/api/work-orders/1/request-approval','POST',{}, {...f.owner,role:'technician'})).status,403);
  const created=await requestApproval(f);
  assert.equal((await f.request(tokenPath(created),'POST',{...signPayload,agree:'false'},null)).status,400);
  assert.equal((await f.request(tokenPath(created),'POST',signPayload,null)).status,200);
  assert.equal((await f.request(`/api/work-orders/1/authorizations/${created.approvalId}/revoke`,'POST',{reason:'Wrong recipient requested cancellation'})).status,200);
  assert.equal((await f.request(tokenPath(created),'GET',undefined,null)).status,410);
  assert.equal((await f.request(`/api/work-orders/1/authorizations/${created.approvalId}/document`)).status,200);
  const fresh=await requestApproval(f);
  f.setClock(Date.parse('2026-12-30T10:00:00Z'));
  assert.equal((await f.request(tokenPath(fresh),'POST',signPayload,null)).status,410);
});

test('only selected customer-visible work-order media is archived and image tampering is detected',async t=>{
  const f=fixture(t),image=Buffer.from('original-photo-bytes');
  fs.writeFileSync(path.join(f.uploads,'photo.png'),image);
  f.db.prepare("INSERT INTO media(id,work_order_id,scope,original_name,stored_name,mime_type,size_bytes,caption,customer_visible) VALUES(1,1,'progress','photo.png','photo.png','image/png',?,'Inspection photo',1)").run(image.length);
  fs.writeFileSync(path.join(f.uploads,'private.png'),image);
  f.db.prepare("INSERT INTO media(id,work_order_id,scope,original_name,stored_name,mime_type,size_bytes,caption,customer_visible) VALUES(2,1,'progress','private.png','private.png','image/png',?,'Private technician photo',0)").run(image.length);
  assert.equal((await f.request('/api/work-orders/1/request-approval','POST',{mediaIds:[2]})).status,409);
  const result=await f.request('/api/work-orders/1/request-approval','POST',{mediaIds:[1]});
  assert.equal(result.status,200,result.body);const created=result.json(),publicPath=tokenPath(created);
  fs.writeFileSync(path.join(f.uploads,'photo.png'),'changed-original');
  const served=await f.request(publicPath+'/media/1','GET',undefined,null);
  assert.equal(served.status,200);assert.deepEqual(served.bytes,image);
  assert.equal((await f.request(publicPath+'/media/2','GET',undefined,null)).status,404);
  const snapshot=JSON.parse(f.db.prepare('SELECT snapshot_json FROM approvals WHERE id=?').get(created.approvalId).snapshot_json);
  fs.writeFileSync(path.join(f.uploads,snapshot.media[0].name),'changed-archive');
  assert.equal((await f.request(publicPath+'/media/1','GET',undefined,null)).status,409);
  assert.equal((await f.request(publicPath,'POST',signPayload,null)).status,409);
});

test('stored PDF tampering and failed storage do not create misleading signed approval records',async t=>{
  const f=fixture(t),created=await requestApproval(f);
  assert.equal((await f.request(tokenPath(created),'POST',signPayload,null)).status,200);
  const row=f.db.prepare('SELECT * FROM approvals WHERE id=?').get(created.approvalId);
  fs.writeFileSync(path.join(f.uploads,row.document_name),'tampered-pdf');
  assert.equal((await f.request(`/api/work-orders/1/authorizations/${row.id}/document`)).status,409);
  const newer=await requestApproval(f);
  const oldStage=f.db.prepare('SELECT stage FROM work_orders WHERE id=1').get().stage;
  const held=f.uploads+'-held';fs.renameSync(f.uploads,held);fs.writeFileSync(f.uploads,'not a directory');
  const failed=await f.request(tokenPath(newer),'POST',signPayload,null);
  assert.equal(failed.status,400);
  assert.equal(f.db.prepare('SELECT status FROM approvals WHERE id=?').get(newer.approvalId).status,'sent');
  assert.equal(f.db.prepare('SELECT stage FROM work_orders WHERE id=1').get().stage,oldStage);
});

test('legacy approvals are disclosed without inventing signatures, while history is staff-only',async t=>{
  const f=fixture(t),token=crypto.randomBytes(32).toString('base64url');
  f.db.prepare("INSERT INTO approvals(work_order_id,token_hash,status,choice,signer_name) VALUES(1,?,'completed','Approve Repairs','Historical signer')").run(crypto.createHash('sha256').update(token).digest('hex'));
  assert.equal((await f.request('/approval/'+token,'GET',undefined,null)).status,409);
  assert.equal(hasCurrentAuthorization(f.db,1),false);
  const history=await f.request('/api/work-orders/1/authorizations');
  assert.equal(history.status,200);assert.equal(history.json().authorizations[0].legacy,true);
  assert.equal(history.json().authorizations[0].snapshot,null);
  assert.doesNotMatch(history.body,/token_hash/);
});

test('revised full totals are explicit and signed predecessor facts remain unchanged',async t=>{
  const f=fixture(t),first=await requestApproval(f);
  await f.request(tokenPath(first),'POST',signPayload,null);
  const original=f.db.prepare('SELECT signed_record_json,document_sha256 FROM approvals WHERE id=?').get(first.approvalId);
  f.db.prepare('UPDATE work_orders SET estimate_total=120 WHERE id=1').run();
  const response=await f.request('/api/work-orders/1/request-approval','POST',{authorizedDescription:'Replace wear ring and perform final test',previousApprovalId:first.approvalId});
  assert.equal(response.status,200,response.body);
  const second=response.json(),page=await f.request(tokenPath(second),'GET',undefined,null);
  assert.match(page.body,/revised full work-order total/);assert.match(page.body,/not an amount to add/);
  assert.equal((await f.request(tokenPath(second),'POST',signPayload,null)).status,200);
  const retained=f.db.prepare('SELECT signed_record_json,document_sha256 FROM approvals WHERE id=?').get(first.approvalId);
  assert.deepEqual(retained,original);
  assert.equal((await f.request(`/api/work-orders/1/authorizations/${first.approvalId}/document`)).status,200);
});

test('exact Unicode signature and scope survive UTF-8 export, and concurrent revocation preserves the first reason',async t=>{
  const f=fixture(t),created=await requestApproval(f),signerName='José 王美玲';
  assert.equal((await f.request(tokenPath(created),'POST',{...signPayload,signerName},null)).status,200);
  const exported=await f.request(`/api/work-orders/1/authorizations/${created.approvalId}/record`);
  assert.equal(exported.status,200);
  assert.equal(JSON.parse(exported.bytes.toString('utf8')).signature.signerName,signerName);
  assert.match(exported.headers['content-type'],/utf-8/);
  const firstReason='First owner revocation reason',secondReason='Second owner simultaneous reason';
  const responses=await Promise.all([
    f.request(`/api/work-orders/1/authorizations/${created.approvalId}/revoke`,'POST',{reason:firstReason}),
    f.request(`/api/work-orders/1/authorizations/${created.approvalId}/revoke`,'POST',{reason:secondReason})
  ]);
  assert.equal(responses[0].status,200);assert.equal(responses[1].json().alreadyRevoked,true);
  assert.equal(f.db.prepare('SELECT revocation_reason FROM approvals WHERE id=?').get(created.approvalId).revocation_reason,firstReason);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM authorization_events WHERE approval_id=? AND action='Authorization revoked'").get(created.approvalId).n,1);
});

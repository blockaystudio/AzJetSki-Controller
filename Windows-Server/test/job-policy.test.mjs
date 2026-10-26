import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openDb} from '../src/db.mjs';
import {extendDatabase,posRoutes} from '../src/pos-extension.mjs';
import {installShopOps} from '../src/shop-ops.mjs';
import {createCustomerAccess,installCustomerAccess} from '../src/customer-access.mjs';
import {assertJobStageChange} from '../src/job-policy.mjs';
import {authorizationRoutes} from '../src/authorizations.mjs';

function fixture(t) {
  const db=openDb(':memory:');extendDatabase(db);installShopOps(db);
  db.exec("INSERT INTO users(id,username,password_hash,salt,role) VALUES(1,'owner','unused','unused','owner'); INSERT INTO customers(id,name) VALUES(1,'Alice'),(2,'Bob'); INSERT INTO vehicles(id,customer_id,make,model) VALUES(1,1,'Yamaha','VX'),(2,2,'Sea-Doo','Spark'); INSERT INTO work_orders(id,customer_id,vehicle_id,customer_name,unit_label) VALUES(1,1,1,'Alice','Yamaha VX')");
  const owner={id:1,username:'owner',role:'owner'};
  const access=createCustomerAccess({db,currentUser:()=>owner,json:()=>{},readBody:async req=>req.body,publicBaseUrl:'https://example.test'});
  const route=posRoutes({db,currentUser:()=>owner,json:(res,status,payload)=>Object.assign(res,{status,payload}),readBody:async req=>req.body});
  const row=()=>db.prepare('SELECT * FROM work_orders WHERE id=1').get();
  const request=async(body)=>{const res={};await route({method:'PATCH',headers:{},body:{expectedRevision:row().revision,...body}},res,'/api/pos/work-orders/1',new URL('http://test/api/pos/work-orders/1'));return res;};
  t.after(()=>db.close());return {db,owner,access,row,request,route};
}

test('untouched intake identity correction is atomic and retains old and new identities',async t=>{
  const f=fixture(t),result=await f.request({customer_id:2,vehicle_id:2});
  assert.equal(result.status,200,JSON.stringify(result.payload));
  assert.equal(f.row().customer_name,'Bob');assert.equal(f.row().vehicle_id,2);
  const audit=f.db.prepare("SELECT detail FROM audit_log WHERE work_order_id=1 AND action='Job identity corrected'").get();
  assert.ok(audit);assert.match(audit.detail,/Alice/);assert.match(audit.detail,/Bob/);
});

test('identity reassignment is denied after access, document, payment, custody or work history',async t=>{
  const seeds=[
    f=>f.access.createLink(1),
    f=>f.db.prepare("INSERT INTO approvals(work_order_id,token_hash) VALUES(1,'approval')").run(),
    f=>{f.db.exec('CREATE TABLE ot_invoices(id INTEGER PRIMARY KEY,work_order_id INTEGER)');f.db.exec('INSERT INTO ot_invoices VALUES(1,1)');},
    f=>f.db.prepare("INSERT INTO pos_payments(work_order_id,method,amount_cents,idempotency_key,verified_by,status) VALUES(1,'zelle',100,'pending-original',1,'pending')").run(),
    f=>f.db.prepare("INSERT INTO unit_custody(vehicle_id,work_order_id,status) VALUES(1,1,'in_lot')").run(),
    f=>f.db.prepare("INSERT INTO notes(work_order_id,body,author) VALUES(1,'Work history','owner')").run(),
    f=>f.db.prepare("INSERT INTO work_order_lines(work_order_id,description) VALUES(1,'Quoted repair')").run(),
    f=>f.db.prepare("INSERT INTO audit_log(work_order_id,actor,action,detail) VALUES(1,'owner','Work order updated',?)").run(JSON.stringify({stage:'Diagnosing'}))
  ];
  for(const seed of seeds){const f=fixture(t);seed(f);const before=f.row(),audits=f.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n;
    const rejected=await f.request({customer_id:2,vehicle_id:2,complaint:'Must not persist'});
    assert.equal(rejected.status,409,JSON.stringify(rejected.payload));assert.deepEqual(f.row(),before);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n,audits);
  }
});

test('directory corrections preserve protected job snapshots and allow later same-identity job edits',async t=>{
  const f=fixture(t),token=new URL(f.access.createLink(1)).pathname.split('/').pop(),before=f.row();
  for(const [table,endpoint,body] of [['customers','customers',{name:'Alice Corrected',phone:'555-0123'}],['vehicles','vehicles',{model:'Corrected Model'}]]){
    const res={},url=`/api/pos/${endpoint}/1`,revision=f.db.prepare(`SELECT revision FROM ${table} WHERE id=1`).get().revision;
    await f.route({method:'PATCH',headers:{},body:{...body,expectedRevision:revision}},res,url,new URL('http://test'+url));assert.equal(res.status,200,JSON.stringify(res.payload));
  }
  assert.equal(f.db.prepare('SELECT name FROM customers WHERE id=1').get().name,'Alice Corrected');
  assert.equal(f.db.prepare('SELECT model FROM vehicles WHERE id=1').get().model,'Corrected Model');
  assert.equal(f.row().customer_name,before.customer_name);assert.equal(f.row().unit_label,before.unit_label);assert.equal(f.row().model,before.model);
  assert.equal(f.row().phone,'555-0123');assert.ok(f.access.record(token));
  const audits=f.db.prepare("SELECT detail FROM audit_log WHERE action IN ('Customer profile updated','Vehicle profile updated')").all();assert.equal(audits.length,2);for(const entry of audits)assert.deepEqual(JSON.parse(entry.detail).preservedJobIds,[1]);
  const edited=await f.request({customer_id:1,vehicle_id:1,complaint:'Updated symptom'});assert.equal(edited.status,200,JSON.stringify(edited.payload));assert.equal(f.row().complaint,'Updated symptom');
});

test('portal identity binding and transactional revocation fail closed for alternate writers and rollback',t=>{
  const f=fixture(t),token=new URL(f.access.createLink(1,{scope:'documents'})).pathname.split('/').pop();
  assert.ok(f.access.record(token));
  f.db.exec('BEGIN');f.db.exec("UPDATE work_orders SET customer_id=2,vehicle_id=2,customer_name='Bob',unit_label='Sea-Doo Spark' WHERE id=1");
  assert.equal(f.access.record(token),null);f.db.exec('ROLLBACK');assert.ok(f.access.record(token),'rollback restores identity and link together');
  f.db.exec("UPDATE work_orders SET customer_id=2,vehicle_id=2,customer_name='Bob',unit_label='Sea-Doo Spark' WHERE id=1");
  assert.equal(f.access.record(token),null);
  f.db.exec('UPDATE customer_portal_tokens SET active=1,revoked_at=NULL');
  assert.equal(f.access.record(token),null,'identity mismatch stays denied even if active is restored');
  f.db.exec("INSERT INTO customer_portal_tokens(work_order_id,token_hash) VALUES(1,'legacy')");installCustomerAccess(f.db);
  assert.equal(f.db.prepare("SELECT active FROM customer_portal_tokens WHERE token_hash='legacy'").get().active,0);
});

test('terminal stages require custody checkout while diagnosis remains available',()=>{
  for(const next of ['Picked Up','Closed'])assert.throws(()=>assertJobStageChange({stage:'Ready'},next),error=>error.status===409&&/checkout/.test(error.message));
  assert.doesNotThrow(()=>assertJobStageChange({stage:'Intake'},'Diagnosing'));
  assert.throws(()=>assertJobStageChange({stage:'Picked Up'},'Ready'),error=>error.status===409);
});

test('both authorization POST aliases enforce current revisions in strict mode',async t=>{
  const f=fixture(t),directory=fs.mkdtempSync(path.join(os.tmpdir(),'job-policy-auth-'));
  const prior=process.env.REQUIRE_EDIT_REVISION;process.env.REQUIRE_EDIT_REVISION='true';
  t.after(()=>{if(prior===undefined)delete process.env.REQUIRE_EDIT_REVISION;else process.env.REQUIRE_EDIT_REVISION=prior;fs.rmSync(directory,{recursive:true,force:true});});
  const route=authorizationRoutes({db:f.db,currentUser:()=>f.owner,json:(res,status,payload)=>Object.assign(res,{status,payload}),readBody:async req=>req.body,uploadDir:directory});
  for(const alias of ['request-approval','authorizations']){
    for(const [extra,status] of [[{},428],[{expectedRevision:f.row().revision+1},409]]){
      const res={};await route({method:'POST',headers:{},body:{description:'Inspect pump',...extra}},res,`/api/work-orders/1/${alias}`);assert.equal(res.status,status,JSON.stringify(res.payload));
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM approvals').get().n,0);
    }
  }
  const res={};await route({method:'POST',headers:{},body:{description:'Inspect pump',expectedRevision:f.row().revision}},res,'/api/work-orders/1/authorizations');assert.equal(res.status,200,JSON.stringify(res.payload));
  f.db.exec("UPDATE work_orders SET stage='Picked Up' WHERE id=1");
  const signing={};await route({method:'POST',headers:{},body:{choice:'Diagnostics/Teardown Only',signerName:'Alice',agree:true}},signing,new URL(res.payload.approvalUrl,'https://example.test').pathname);assert.equal(signing.status,409);assert.equal(f.row().stage,'Picked Up');
  const replacement={};await route({method:'POST',headers:{},body:{description:'Inspect pump',expectedRevision:f.row().revision}},replacement,'/api/work-orders/1/authorizations');assert.equal(replacement.status,409);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM approvals').get().n,1);
});

async function serverFixture(t,mode) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'job-policy-http-')),source=fileURLToPath(new URL('../',import.meta.url));
  for(const directory of ['src','public','scripts'])fs.cpSync(path.join(source,directory),path.join(root,directory),{recursive:true});
  fs.copyFileSync(path.join(source,'package.json'),path.join(root,'package.json'));
  const socket=net.createServer();await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const env={};for(const name of ['PATH','HOME','TEMP','TMP','TMPDIR','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT'])if(process.env[name]!==undefined)env[name]=process.env[name];
  const bridge=crypto.randomBytes(32).toString('hex');
  Object.assign(env,{HOST:'127.0.0.1',PORT:String(port),OWNERTRACKER_DB:path.join(root,'data/test.sqlite'),OWNERTRACKER_ADMIN_USER:'owner',OWNERTRACKER_ADMIN_PASSWORD:'Job-policy-Test-2026!',OWNERTRACKER_SESSION_SECRET:crypto.randomBytes(32).toString('hex'),DESKTOP_AGENT_TOKEN:crypto.randomBytes(32).toString('hex'),QBPOS_BRIDGE_TOKEN:bridge,PUBLIC_BASE_URL:`http://127.0.0.1:${port}`,REQUIRE_EDIT_REVISION:'true',AUTO_BUILD_PROCUREMENT:'false',AUTO_SUPPLIER_LOOKUP:'false',NODE_ENV:'test'});
  if(mode)env.QBPOS_IMPORT_MODE=mode;
  const child=spawn(process.execPath,[path.join(root,'src/server.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});let logs='';for(const pipe of [child.stdout,child.stderr])pipe.on('data',bytes=>logs=(logs+bytes).slice(-6000));
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;let ready=false;
  for(let i=0;i<300;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,30));}assert.ok(ready,logs);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'Job-policy-Test-2026!'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const request=async(url,method='GET',body,headers={})=>{const response=await fetch(base+url,{method,headers:{cookie,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
  return {request,bridge};
}

test('actual strict HTTP stage aliases reject terminal writes without partial updates, and import defaults off',{timeout:20000},async t=>{
  const f=await serverFixture(t),customerResponse=await f.request('/api/pos/customers','POST',{name:'Fictional Customer',address_line1:'100 Fictional St',city:'Phoenix',state:'AZ',postal_code:'85001'});
  assert.equal(customerResponse.status,201,JSON.stringify(customerResponse.value));const customer=customerResponse.value.customer;
  const vehicle=(await f.request('/api/pos/vehicles','POST',{customer_id:customer.id,make:'Yamaha',model:'VX'})).value.vehicle;
  const created=await f.request('/api/pos/work-orders','POST',{customer_id:customer.id,vehicle_id:vehicle.id,complaint:'Inspect pump'});assert.equal(created.status,201,JSON.stringify(created.value));
  const id=created.value.id,get=async()=>(await f.request(`/api/work-orders/${id}`)).value.workOrder;
  let job=await get();
  for(const stage of ['Picked Up','Closed'])for(const [url,method,body] of [[`/api/work-orders/${id}`,'PATCH',{}],[`/api/pos/work-orders/${id}`,'PATCH',{}],[`/api/work-orders/${id}/updates`,'POST',{title:'Must not persist'}]]){
    const rejected=await f.request(url,method,{...body,stage,expectedRevision:job.revision});assert.equal(rejected.status,409,JSON.stringify(rejected.value));assert.deepEqual(await get(),job);
  }
  const diagnosis=await f.request(`/api/work-orders/${id}`,'PATCH',{stage:'Diagnosing',expectedRevision:job.revision});assert.equal(diagnosis.status,200,JSON.stringify(diagnosis.value));assert.equal((await get()).stage,'Diagnosing');
  for(const alias of ['request-approval','authorizations'])assert.equal((await f.request(`/api/work-orders/${id}/${alias}`,'POST',{description:'Diagnose pump'})).status,428);
  const disabled=await f.request('/api/integrations/qbpos/work-orders/bulk','POST',{workOrders:[]},{authorization:`Bearer ${f.bridge}`});assert.equal(disabled.status,409);assert.match(disabled.value.error,/disabled/);
});

test('explicit QuickBooks migration inserts once, rejects replacement and rolls back each invalid item',{timeout:20000},async t=>{
  const f=await serverFixture(t,'insert-only'),url='/api/integrations/qbpos/work-orders/bulk',headers={authorization:`Bearer ${f.bridge}`};
  const input={externalId:'MIGRATION-1',customerName:'Migration Fixture',estimateTotal:100,paidTotal:20,balance:80,lines:[{lineType:'labor',description:'Diagnostic',qty:1,rate:100,amount:100}]};
  const first=await f.request(url,'POST',{workOrders:[input]},headers);assert.equal(first.status,200);assert.equal(first.value.created,1);
  const replay=await f.request(url,'POST',{workOrders:[input]},headers);assert.equal(replay.value.duplicates,1);assert.equal(replay.value.created,0);
  const replacement=await f.request(url,'POST',{workOrders:[{...input,customerName:'Must not replace'}]},headers);assert.match(replacement.value.errors[0].error,/insert-only/);
  const invalid=await f.request(url,'POST',{workOrders:[{...input,externalId:'INVALID-ROW',lines:[{...input.lines[0],cost:'invalid'}]}]},headers);assert.equal(invalid.value.created,0);assert.equal(invalid.value.errors.length,1);
  const rows=(await f.request('/api/work-orders')).value.workOrders;assert.equal(rows.length,1);assert.equal(rows[0].customer_name,'Migration Fixture');assert.equal(rows[0].balance,80);
  const id=rows[0].id,get=async()=>(await f.request(`/api/work-orders/${id}`)).value.workOrder,job=await get();
  for(const alias of [`/api/work-orders/${id}`,`/api/pos/work-orders/${id}`])for(const field of ['estimate_total','paid_total','balance','parts_total','labor_total','subtotal_cents','tax_total_cents','tax_rate_bps']){
    const rejected=await f.request(alias,'PATCH',{[field]:100,complaint:'Must not persist',expectedRevision:job.revision});
    assert.equal(rejected.status,409,JSON.stringify(rejected.value));assert.match(rejected.value.error,/migration reconciliation/);assert.deepEqual(await get(),job);
  }
  const add=await f.request(`/api/pos/work-orders/${id}/lines`,'POST',{line_type:'labor',description:'Must not add',qty:1,rate:100,expectedRevision:job.revision});assert.equal(add.status,409);assert.deepEqual(await get(),job);
  for(const method of ['PATCH','DELETE']){
    const rejected=await f.request(`/api/pos/lines/${job.lines[0].id}`,method,{description:'Must not change',expectedRevision:job.lines[0].revision});assert.equal(rejected.status,409,JSON.stringify(rejected.value));assert.deepEqual(await get(),job);
  }
  for(const alias of [`/api/work-orders/${id}`,`/api/pos/work-orders/${id}`]){
    const current=await get(),edited=await f.request(alias,'PATCH',{complaint:'Updated diagnostic symptom',expectedRevision:current.revision});assert.equal(edited.status,200,JSON.stringify(edited.value));
    const after=await get();assert.equal(after.estimate_total,100);assert.equal(after.paid_total,20);assert.equal(after.balance,80);assert.equal(after.complaint,'Updated diagnostic symptom');
  }
});

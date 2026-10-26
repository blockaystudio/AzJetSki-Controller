import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {openDb} from '../src/db.mjs';
import {extendDatabase} from '../src/pos-extension.mjs';
import {checkoutRoutes,installCheckout} from '../src/payment-docs.mjs';
import {accountBalance} from '../src/accounting.mjs';

function fixture(t,{notify=async()=>({status:'queued'})}={}){
  const db=openDb(':memory:');extendDatabase(db);t.after(()=>db.close());
  const owner={id:Number(db.prepare("INSERT INTO users(username,password_hash,salt,role) VALUES('invoice-owner','test','test','owner')").run().lastInsertRowid),username:'invoice-owner',role:'owner'};
  const customer=Number(db.prepare("INSERT INTO customers(name,email) VALUES('Invoice customer','invoice@example.test')").run().lastInsertRowid);
  const id=Number(db.prepare("INSERT INTO work_orders(source,customer_id,ref_number,customer_name,email,complaint,estimate_total,balance) VALUES('manual',?,'WO-INVOICE','Invoice customer','invoice@example.test','Inspect pump',100,100)").run(customer).lastInsertRowid);
  const line=Number(db.prepare("INSERT INTO work_order_lines(work_order_id,line_type,item_ref,description,qty,rate,amount,taxable) VALUES(?,'part','PUMP','Pump',1,100,100,0)").run(id).lastInsertRowid);
  const route=checkoutRoutes({db,currentUser:req=>req.user===undefined?owner:req.user,json:(res,status,body)=>Object.assign(res,{status,body}),readBody:async req=>{await req.beforeBody?.();return req.body;},publicBaseUrl:'https://shop.example.test',notify});
  const revision=()=>db.prepare('SELECT revision FROM work_orders WHERE id=?').get(id).revision;
  async function request(suffix='invoices',body,options={}){
    const url=suffix.startsWith('/')?suffix:`/api/pos/work-orders/${id}/${suffix}`,res={writeHead(status,headers){Object.assign(this,{status,headers});},end(body){this.body=body;}};
    await route({method:body===undefined?'GET':'POST',headers:{},body,...options},res,url,new URL(url,'https://shop.example.test'));return res;
  }
  const input=(extra={})=>({idempotencyKey:crypto.randomUUID(),expectedRevision:revision(),...extra});
  return {db,id,line,revision,request,input};
}

test('both repair invoice aliases require explicit current revision even with legacy mode disabled',async t=>{
  const before=process.env.REQUIRE_EDIT_REVISION;process.env.REQUIRE_EDIT_REVISION='false';t.after(()=>{if(before===undefined)delete process.env.REQUIRE_EDIT_REVISION;else process.env.REQUIRE_EDIT_REVISION=before;});
  const f=fixture(t);
  for(const suffix of ['invoice','invoices']){
    assert.equal((await f.request(suffix,{})).status,400);
    assert.equal((await f.request(suffix,{idempotencyKey:crypto.randomUUID()})).status,428);
    assert.equal((await f.request(suffix,f.input({expectedRevision:f.revision()+1}))).status,409);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ot_invoices').get().n,0);
  assert.equal((await f.request('invoices',f.input(),{user:null})).status,403);
});

test('invoice exact retry retains one document, link and queued message after revision or balance changes',async t=>{
  let queued=0;const f=fixture(t,{notify:async()=>{queued++;return {status:'queued'};}}),input=f.input({sendEmail:true,email:'invoice@example.test'});
  const first=await f.request('invoices',input);assert.equal(first.status,201);assert.equal(queued,1);
  f.db.prepare('UPDATE work_orders SET estimate_total=150,balance=150 WHERE id=?').run(f.id);
  const retry=await f.request('invoice',input);assert.equal(retry.status,200);assert.equal(retry.body.duplicate,true);
  assert.deepEqual({...retry.body,duplicate:undefined},{...first.body,duplicate:undefined});assert.equal(queued,1);
  for(const change of [{email:'different@example.test'},{sendEmail:false},{expectedRevision:f.revision()},{documentKind:'revised_invoice',supersedesInvoiceId:first.body.id}])assert.equal((await f.request('invoices',{...input,...change})).status,409);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ot_invoices').get().n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ot_invoice_deliveries').get().n,1);
});

test('simultaneous exact retries reserve one invoice before an asynchronous notification returns',async t=>{
  let finish,entered;const started=new Promise(resolve=>entered=resolve),wait=new Promise(resolve=>finish=resolve);
  let queued=0;const f=fixture(t,{notify:async()=>{queued++;entered();await wait;return {status:'queued'};}}),input=f.input({sendEmail:true});
  const original=f.request('invoices',input);await started;
  const duplicate=await f.request('invoices',input);assert.equal(duplicate.status,200);assert.equal(duplicate.body.deliveryStatus,'pending');assert.equal(queued,1);
  finish();const first=await original;assert.equal(first.status,201);assert.equal(first.body.link,duplicate.body.link);
  const complete=await f.request('invoices',input);assert.equal(complete.body.deliveryStatus,'queued');assert.equal(queued,1);
});

test('a revision is an explicit replacement with immutable history and no additional account debt',async t=>{
  const f=fixture(t),first=await f.request('invoices',f.input()),before=f.db.prepare('SELECT snapshot_json FROM ot_invoices WHERE id=?').get(first.body.id).snapshot_json;
  const balance=accountBalance(f.db,'repair',f.id);
  assert.equal((await f.request('invoices',f.input())).status,409,'a new key cannot silently issue a second original invoice');
  assert.equal((await f.request('invoices',f.input({documentKind:'revised_invoice',supersedesInvoiceId:999}))).status,409);
  f.db.prepare("UPDATE work_order_lines SET description='Reviewed replacement pump' WHERE id=?").run(f.line);
  const second=await f.request('invoices',f.input({documentKind:'revised_invoice',supersedesInvoiceId:first.body.id}));assert.equal(second.status,201);
  assert.equal(second.body.supersedesInvoiceId,first.body.id);assert.equal(second.body.documentKind,'revised_invoice');
  assert.deepEqual(accountBalance(f.db,'repair',f.id),balance);
  const retained=f.db.prepare('SELECT * FROM ot_invoices WHERE id=?').get(first.body.id);assert.equal(retained.snapshot_json,before);assert.equal(retained.superseded_by,second.body.id);
  assert.equal(JSON.parse(f.db.prepare('SELECT snapshot_json FROM ot_invoices WHERE id=?').get(second.body.id).snapshot_json).items[0].id,f.line);
  assert.throws(()=>f.db.prepare("UPDATE ot_invoices SET snapshot_json='{}' WHERE id=?").run(first.body.id),/immutable/);
  assert.throws(()=>f.db.prepare('DELETE FROM ot_invoices WHERE id=?').run(first.body.id),/history/);
  const history=await f.request(new URL(first.body.link).pathname);assert.match(history.body,/Historical document: replaced/);assert.match(history.body,/does not create an additional charge/);
  const oldPayment=await f.request(`/api/billing/invoices/${first.body.id}/payment-requests`,{requestKey:crypto.randomUUID(),method:'dejavoo_p1_terminal',amount:'10'});assert.equal(oldPayment.status,409);
  installCheckout(f.db);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ot_invoices').get().n,2,'migration preserves history');
});

test('invoice audit failure rolls back document, revision, replacement and retry reservation',async t=>{
  const f=fixture(t),first=await f.request('invoices',f.input()),version=f.revision();
  f.db.exec("CREATE TRIGGER fail_invoice_audit BEFORE INSERT ON audit_log WHEN NEW.action='Invoice issued' BEGIN SELECT RAISE(ABORT,'Injected audit failure'); END;");
  const next=await f.request('invoices',f.input({documentKind:'revised_invoice',supersedesInvoiceId:first.body.id}));assert.equal(next.status,400);
  assert.equal(f.revision(),version);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ot_invoices').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ot_invoice_issues').get().n,1);
  assert.equal(f.db.prepare('SELECT superseded_by FROM ot_invoices WHERE id=?').get(first.body.id).superseded_by,null);
});

test('DocuSign completion retains stale signed evidence without changing current scope or stage',async t=>{
  const f=fixture(t),directory=fs.mkdtempSync(path.join(os.tmpdir(),'ot-signature-')),oldDirectory=process.cwd(),oldFetch=globalThis.fetch;
  const variables=['DOCUSIGN_ENABLE_SEND','DOCUSIGN_BASE_URL','DOCUSIGN_ACCOUNT_ID','DOCUSIGN_ACCESS_TOKEN'],env=Object.fromEntries(variables.map(key=>[key,process.env[key]]));
  t.after(()=>{process.chdir(oldDirectory);globalThis.fetch=oldFetch;for(const key of variables)if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];fs.rmSync(directory,{recursive:true,force:true});});
  process.chdir(directory);process.env.DOCUSIGN_ENABLE_SEND='false';process.env.DOCUSIGN_BASE_URL='https://docusign.example.test';process.env.DOCUSIGN_ACCOUNT_ID='test-account';process.env.DOCUSIGN_ACCESS_TOKEN='test-token';
  const prepared=await f.request('docusign/send',{expectedRevision:f.revision(),description:'Original pump repair',confirmSend:true});assert.equal(prepared.status,202);
  f.db.prepare("UPDATE ot_signature_packets SET envelope_id='mock-envelope',status='sent' WHERE id=?").run(prepared.body.packetId);
  globalThis.fetch=async url=>String(url).endsWith('/documents/combined')?{ok:true,arrayBuffer:async()=>Buffer.from('%PDF-1.4\nmock retained signature')}:{ok:true,json:async()=>({status:'completed'})};
  f.db.prepare("UPDATE work_orders SET complaint='Different repair now required',authorized_work='New reviewed scope',stage='Awaiting Approval' WHERE id=?").run(f.id);
  const before=f.db.prepare('SELECT * FROM work_orders WHERE id=?').get(f.id);
  const synced=await f.request('docusign/sync',{});assert.equal(synced.status,200);assert.equal(synced.body.completed,true);assert.equal(synced.body.authorizationApplied,false);
  assert.deepEqual(f.db.prepare('SELECT * FROM work_orders WHERE id=?').get(f.id),before);
  const packet=f.db.prepare('SELECT * FROM ot_signature_packets WHERE id=?').get(prepared.body.packetId);assert.equal(packet.status,'completed');assert.ok(fs.existsSync(path.join(directory,'data/uploads',packet.signed_pdf_name)));
  assert.match(synced.body.notice,/historical scope/);
});

test('DocuSign current-scope completion applies once and cannot reopen terminal work orders',async t=>{
  const f=fixture(t),directory=fs.mkdtempSync(path.join(os.tmpdir(),'ot-signature-current-')),oldDirectory=process.cwd(),oldFetch=globalThis.fetch;
  const variables=['DOCUSIGN_ENABLE_SEND','DOCUSIGN_BASE_URL','DOCUSIGN_ACCOUNT_ID','DOCUSIGN_ACCESS_TOKEN'],env=Object.fromEntries(variables.map(key=>[key,process.env[key]]));
  t.after(()=>{process.chdir(oldDirectory);globalThis.fetch=oldFetch;for(const key of variables)if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];fs.rmSync(directory,{recursive:true,force:true});});
  process.chdir(directory);process.env.DOCUSIGN_ENABLE_SEND='false';process.env.DOCUSIGN_BASE_URL='https://docusign.example.test';process.env.DOCUSIGN_ACCOUNT_ID='test-account';process.env.DOCUSIGN_ACCESS_TOKEN='test-token';
  globalThis.fetch=async url=>String(url).endsWith('/documents/combined')?{ok:true,arrayBuffer:async()=>Buffer.from('%PDF-1.4\nmock retained signature')}:{ok:true,json:async()=>({status:'completed'})};
  f.db.prepare("UPDATE work_orders SET stage='Awaiting Approval' WHERE id=?").run(f.id);
  const prepared=await f.request('docusign/send',{expectedRevision:f.revision(),description:'Approved pump repair',confirmSend:true});assert.equal(prepared.status,202);
  f.db.prepare("UPDATE ot_signature_packets SET envelope_id='mock-current',status='sent' WHERE id=?").run(prepared.body.packetId);
  const completed=await f.request('docusign/sync',{});assert.equal(completed.body.authorizationApplied,true);
  let row=f.db.prepare('SELECT * FROM work_orders WHERE id=?').get(f.id);assert.equal(row.stage,'In Progress');assert.equal(row.authorized_work,'Approved pump repair');
  f.db.prepare("UPDATE work_orders SET stage='Closed' WHERE id=?").run(f.id);row=f.db.prepare('SELECT * FROM work_orders WHERE id=?').get(f.id);
  assert.equal((await f.request('docusign/sync',{})).status,200);assert.deepEqual(f.db.prepare('SELECT * FROM work_orders WHERE id=?').get(f.id),row);
  const next=await f.request('docusign/send',{expectedRevision:f.revision(),description:'New document after close',confirmSend:true});assert.equal(next.status,202);
  f.db.prepare("UPDATE ot_signature_packets SET envelope_id='mock-terminal',status='sent' WHERE id=?").run(next.body.packetId);
  assert.equal((await f.request('docusign/sync',{})).body.authorizationApplied,false);assert.equal(f.db.prepare('SELECT stage FROM work_orders WHERE id=?').get(f.id).stage,'Closed');
});

test('late DocuSign completion cannot override a later decline, readiness, or native authorization of equal scope',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ot-signature-decision-')),oldDirectory=process.cwd(),oldFetch=globalThis.fetch;
  const variables=['DOCUSIGN_ENABLE_SEND','DOCUSIGN_BASE_URL','DOCUSIGN_ACCOUNT_ID','DOCUSIGN_ACCESS_TOKEN'],env=Object.fromEntries(variables.map(key=>[key,process.env[key]]));
  t.after(()=>{process.chdir(oldDirectory);globalThis.fetch=oldFetch;for(const key of variables)if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];fs.rmSync(directory,{recursive:true,force:true});});
  process.chdir(directory);process.env.DOCUSIGN_ENABLE_SEND='false';process.env.DOCUSIGN_BASE_URL='https://docusign.example.test';process.env.DOCUSIGN_ACCOUNT_ID='test-account';process.env.DOCUSIGN_ACCESS_TOKEN='test-token';
  for(const scenario of ['declined','ready','new-native-request','native-decision']){
    const f=fixture(t);f.db.prepare("UPDATE work_orders SET stage='Awaiting Approval' WHERE id=?").run(f.id);
    if(scenario==='native-decision')f.db.prepare("INSERT INTO approvals(work_order_id,token_hash,authorized_description) VALUES(?,'native-first','Inspect pump')").run(f.id);
    const prepared=await f.request('docusign/send',{expectedRevision:f.revision(),description:'Inspect pump',confirmSend:true});assert.equal(prepared.status,202);
    f.db.prepare("UPDATE ot_signature_packets SET envelope_id='mock-old',status='sent' WHERE id=?").run(prepared.body.packetId);
    // Make the newer decision while the provider response is in flight.
    globalThis.fetch=async url=>{
      if(String(url).endsWith('/documents/combined')){
        if(scenario==='declined'||scenario==='ready')f.db.prepare('UPDATE work_orders SET stage=? WHERE id=?').run(scenario==='declined'?'Declined':'Ready',f.id);
        if(scenario==='new-native-request')f.db.prepare("INSERT INTO approvals(work_order_id,token_hash,authorized_description) VALUES(?,'native-later','Inspect pump')").run(f.id);
        if(scenario==='native-decision')f.db.prepare("UPDATE approvals SET status='completed',choice='Decline Repairs' WHERE work_order_id=?").run(f.id);
        return {ok:true,arrayBuffer:async()=>Buffer.from('%PDF-1.4\nmock historical evidence')};
      }
      return {ok:true,json:async()=>({status:'completed'})};
    };
    const completed=await f.request('docusign/sync',{});assert.equal(completed.status,200);assert.equal(completed.body.authorizationApplied,false,scenario);
    const row=f.db.prepare('SELECT stage,authorized_work FROM work_orders WHERE id=?').get(f.id);assert.equal(row.stage,scenario==='declined'?'Declined':scenario==='ready'?'Ready':'Awaiting Approval');assert.notEqual(row.authorized_work,'Inspect pump');
  }
});

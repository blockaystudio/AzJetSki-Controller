import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {openDb} from '../src/db.mjs';
import {extendDatabase} from '../src/pos-extension.mjs';
import {checkoutRoutes} from '../src/payment-docs.mjs';
import {createAccessSecurity} from '../src/access-security.mjs';
import {installAccounting,createCredit,accountBalance} from '../src/accounting.mjs';
import {recordPayment} from '../src/finance-controls.mjs';

function fixture(t){
 const db=openDb(':memory:');extendDatabase(db);t.after(()=>db.close());
 const json=(res,status,body,headers={})=>Object.assign(res,{status,body,headers:{...res.headers,...headers}});
 const sessionSecret='fictional-invoice-document-session-secret',sessions=new Map();
 const access=createAccessSecurity({db,json,readBody:async req=>req.body||{},publicBaseUrl:'https://shop.example.test',sessionSecret});
 const cookie=role=>{
  if(!role)return '';
  if(!sessions.has(role)){
   const id=Number(db.prepare('INSERT INTO users(username,password_hash,salt,role,active) VALUES(?,?,?,?,1)').run(`document-${role}`,'unused','unused',role).lastInsertRowid);
   const token=crypto.randomBytes(24).toString('base64url');
   db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(crypto.createHmac('sha256',sessionSecret).update(token).digest('hex'),id,new Date(Date.now()+3600000).toISOString());
   sessions.set(role,`ot_session=${token}`);
  }
  return sessions.get(role);
 };
 const customer=Number(db.prepare("INSERT INTO customers(name,email,address_line1,city,state,postal_code) VALUES('Original Customer','original@example.test','100 Original Way','Phoenix','AZ','85001')").run().lastInsertRowid);
 const id=Number(db.prepare("INSERT INTO work_orders(source,customer_id,ref_number,customer_name,email,phone,unit_label,estimate_total,balance,tax_rate_bps,tax_total_cents) VALUES('manual',?,'WO-ORIGINAL','Original Customer','original@example.test','555-0100','2024 Test Jet',109.10,109.10,910,910)").run(customer).lastInsertRowid);
 const line=Number(db.prepare("INSERT INTO work_order_lines(work_order_id,line_type,item_ref,description,qty,rate,amount,taxable) VALUES(?,'part','ORIGINAL-SKU','Original pump assembly',1,100,100,1)").run(id).lastInsertRowid);
 const route=checkoutRoutes({db,currentUser:req=>access.sessionUser(req),json,readBody:async req=>req.body||{},publicBaseUrl:'https://shop.example.test',shopName:'Fictional Test Shop'});
 async function request(path,options={}){
  const {role='owner',body,method=body===undefined?'GET':'POST',headers={}}=options;
  const req={method,body,headers:{host:'shop.example.test',cookie:cookie(role),...headers},socket:{remoteAddress:'127.0.0.1'}};
  const res={headers:{},setHeader(name,value){this.headers[name]=value;},writeHead(status,headers){Object.assign(this,{status,headers:{...this.headers,...headers}});},end(body){this.body=String(body);}};
  if(access.middleware(req,res)){res.handled=true;return res;}
  res.handled=await route(req,res,new URL(path,'https://shop.example.test').pathname,new URL(path,'https://shop.example.test'));return res;
 }
 const issue=extra=>request(`/api/pos/work-orders/${id}/invoices`,{body:{idempotencyKey:crypto.randomUUID(),expectedRevision:db.prepare('SELECT revision FROM work_orders WHERE id=?').get(id).revision,...extra}});
 const document=(invoice,options)=>request(`/api/billing/invoices/${invoice}/document`,options);
 cookie('owner');
 return {db,id,line,customer,request,issue,document};
}

test('retained invoice documents use invoice-history staff permissions and real sessions',async t=>{
 const f=fixture(t),invoice=await f.issue();assert.equal(invoice.status,201);
 for(const role of [null,'technician','parts','viewer']){
  assert.equal((await f.document(invoice.body.id,{role})).status,403);
  assert.equal((await f.document(999999,{role})).status,403,'authorization must precede invoice lookup');
 }
 for(const role of ['owner','manager','service_writer','advisor']){
  const result=await f.document(invoice.body.id,{role});assert.equal(result.status,200);
  assert.equal(result.headers['cache-control'],'private, no-store');
  assert.match(result.headers['content-security-policy'],/default-src 'none'.*frame-ancestors 'none'/);
  assert.equal(result.headers['cross-origin-resource-policy'],'same-origin');
 }
 const token=new URL(invoice.body.link).pathname.split('/').pop();
 const bypass=await f.document(invoice.body.id,{role:null,headers:{authorization:`Bearer ${token}`,origin:'https://shop.example.test','x-forwarded-for':'127.0.0.1'}});
 assert.equal(bypass.status,403,'a customer bearer or trusted-looking headers never grant staff permission');
 assert.equal((await f.request(`/api/billing/invoices/${invoice.body.id}/document?token=${token}`,{role:null})).status,403);
 f.db.prepare("UPDATE users SET active=0 WHERE role='owner'").run();
 assert.equal((await f.document(invoice.body.id)).status,403,'disabled staff cannot reuse a prior session');
});

test('old and revised documents retain separate identities, addresses, lines, taxes and amounts',async t=>{
 const f=fixture(t),first=await f.issue();assert.equal(first.status,201);
 const retained=f.db.prepare('SELECT snapshot_json FROM ot_invoices WHERE id=?').get(first.body.id).snapshot_json;
 f.db.prepare("UPDATE customers SET name='Changed Customer',email='changed@example.test',address_line1='200 Changed Road',city='Mesa',postal_code='85201' WHERE id=?").run(f.customer);
 f.db.prepare("UPDATE work_orders SET customer_name='Changed Customer',email='changed@example.test',phone='555-0200',ref_number='WO-CHANGED',unit_label='2025 Changed Jet',estimate_total=218.20,balance=218.20,tax_total_cents=1820 WHERE id=?").run(f.id);
 f.db.prepare("UPDATE work_order_lines SET description='Changed pump assembly',item_ref='CHANGED-SKU',rate=200,amount=200 WHERE id=?").run(f.line);
 const second=await f.issue({documentKind:'revised_invoice',supersedesInvoiceId:first.body.id});assert.equal(second.status,201);
 const before=f.db.prepare('SELECT total_changes() n').get().n;
 const old=await f.document(first.body.id),current=await f.document(second.body.id);
 assert.equal(old.status,200);assert.equal(current.status,200);
 for(const value of ['Original Customer','original@example.test','555-0100','100 Original Way','WO-ORIGINAL','2024 Test Jet','Original pump assembly','ORIGINAL-SKU'])assert.ok(old.body.includes(value),value);
 assert.match(old.body,/Superseded invoice/);assert.match(old.body,/Sales tax at issue \(9\.10%\)<\/th><td>\$9\.10/);
 assert.match(old.body,/Invoice amount at issue<\/th><td>\$109\.10/);
 assert.doesNotMatch(old.body,/Changed Customer|changed@example.test|200 Changed Road|Changed pump|CHANGED-SKU|\$218\.20|Current work.order account|Currently due/);
 for(const value of ['Changed Customer','changed@example.test','555-0200','200 Changed Road','WO-CHANGED','2025 Changed Jet','Changed pump assembly','CHANGED-SKU'])assert.ok(current.body.includes(value),value);
 assert.match(current.body,/This revised snapshot replaces invoice #/);assert.match(current.body,/Sales tax at issue \(9\.10%\)<\/th><td>\$18\.20/);
 assert.match(current.body,/Invoice amount at issue<\/th><td>\$218\.20/);assert.doesNotMatch(current.body,/Superseded invoice/);
 assert.equal(f.db.prepare('SELECT snapshot_json FROM ot_invoices WHERE id=?').get(first.body.id).snapshot_json,retained);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before,'reading either snapshot must not mutate history');
});

test('cancelled and expired superseded snapshots remain readable without current account lookups or token reissue',async t=>{
 const f=fixture(t),first=await f.issue(),second=await f.issue({documentKind:'revised_invoice',supersedesInvoiceId:first.body.id});
 assert.equal(second.status,201);
 f.db.prepare("UPDATE ot_invoices SET voided_at='2026-10-25 12:00:00',valid_until='2000-01-01' WHERE id=?").run(first.body.id);
 f.db.prepare("UPDATE work_orders SET customer_name='Later Customer',estimate_total=999,balance=999,stage='Cancelled' WHERE id=?").run(f.id);
 // Retained document views must not depend on the live payment ledger.
 f.db.exec('DROP TABLE pos_payments');
 const before=f.db.prepare('SELECT total_changes() n').get().n,result=await f.document(first.body.id);
 assert.equal(result.status,200);assert.match(result.body,/Cancelled invoice/);assert.match(result.body,/Superseded invoice/);
 assert.match(result.body,/2026-10-25 12:00:00/);assert.match(result.body,/Original Customer/);assert.match(result.body,/\$109\.10/);
 assert.doesNotMatch(result.body,/Later Customer|\$999\.00|\/invoice\/|token_hash|Pay securely|payment-requests/);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 for(const issued of [first,second])assert.ok(!result.body.includes(new URL(issued.body.link).pathname.split('/').pop()));
});

test('issued payment and credit amounts do not change when later refunds change the live account',async t=>{
 const f=fixture(t);installAccounting(f.db);const owner=f.db.prepare("SELECT * FROM users WHERE role='owner'").get();
 const payment=recordPayment(f.db,'repair',f.id,owner,{method:'cash',amount:'25.00',verified:true,idempotencyKey:'invoice-doc-cash-payment'},()=>({}));
 const first=await f.issue();assert.equal(first.status,201);
 createCredit(f.db,'repair',f.id,owner,{invoiceId:first.body.id,subtotalCents:1000,taxCents:0,reason:'Fictional approved courtesy credit',idempotencyKey:'invoice-doc-retained-credit'});
 const revised=await f.issue({documentKind:'revised_invoice',supersedesInvoiceId:first.body.id});assert.equal(revised.status,201);
 recordPayment(f.db,'repair',f.id,owner,{method:'cash',direction:'refund',amount:'10.00',verified:true,reference:'fictional returned cash',originalPaymentId:payment.id,reason:'Fictional partial refund',idempotencyKey:'invoice-doc-cash-refund'},()=>({}));
 assert.equal(accountBalance(f.db,'repair',f.id).dueCents,8410);
 const before=f.db.prepare('SELECT total_changes() n').get().n,original=await f.document(first.body.id),later=await f.document(revised.body.id);
 assert.match(original.body,/Retained credits at issue<\/th><td>\$0\.00/);assert.match(original.body,/Invoice amount at issue<\/th><td>\$84\.10/);
 assert.match(later.body,/Retained credits at issue<\/th><td>\$10\.00/);assert.match(later.body,/Net confirmed payments at issue<\/th><td>\$25\.00/);
 assert.match(later.body,/Adjusted account charge at issue<\/th><td>\$99\.10/);assert.match(later.body,/Invoice amount at issue<\/th><td>\$74\.10/);
 assert.doesNotMatch(later.body,/\$84\.10|fictional returned cash|Fictional partial refund/);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
});

test('documents validate IDs, reject mutations and do not bypass origin protection',async t=>{
 const f=fixture(t),invoice=await f.issue();
 for(const id of [0,999999,'9007199254740992'])assert.equal((await f.document(id)).status,404);
 for(const method of ['POST','PUT','DELETE','HEAD'])assert.equal((await f.document(invoice.body.id,{method})).status,405);
 assert.equal((await f.document(invoice.body.id,{method:'POST',headers:{origin:'https://attacker.example.test'}})).status,403);
 assert.equal((await f.request('/api/unrelated')).handled,false);
});

test('untrusted retained fields are escaped and customer links and private metadata stay absent',async t=>{
 const f=fixture(t),payload='<img src=x onerror=alert(1)>';
 f.db.prepare('UPDATE work_orders SET customer_name=?,unit_label=? WHERE id=?').run(payload,payload,f.id);
 f.db.prepare('UPDATE work_order_lines SET description=?,item_ref=? WHERE id=?').run(payload,payload,f.line);
 f.db.prepare('UPDATE customers SET address_line1=? WHERE id=?').run(payload,f.customer);
 const invoice=await f.issue(),result=await f.document(invoice.body.id),token=new URL(invoice.body.link).pathname.split('/').pop();
 assert.equal(result.status,200);assert.match(result.body,/&lt;img src=x onerror=alert\(1\)&gt;/);
 assert.doesNotMatch(result.body,/<img src=x|token_hash|response_json|idempotencyKey|\/invoice\//);
 assert.ok(!result.body.includes(token));assert.ok(!result.body.includes(f.db.prepare('SELECT token_hash FROM ot_invoices').get().token_hash));
 assert.match(result.body,/id="print"/);assert.match(result.headers['content-security-policy'],/script-src 'nonce-/);
});

test('incomplete legacy snapshots disclose missing fields and corrupt snapshots fail closed',async t=>{
 const f=fixture(t),legacy={refNumber:'LEGACY-WO',estimateCents:2500,items:[{description:'Retained legacy part',qty:1,rate:25,amount:25}]};
 const insert=snapshot=>Number(f.db.prepare("INSERT INTO ot_invoices(work_order_id,number,token_hash,amount_cents,valid_until,recipient_name,snapshot_json) VALUES(?,?,?,?,?,?,?)").run(f.id,`LEGACY-${crypto.randomUUID()}`,crypto.randomUUID(),2500,'2000-01-01','Retained Legacy Customer',snapshot).lastInsertRowid);
 const id=insert(JSON.stringify(legacy)),before=f.db.prepare('SELECT total_changes() n').get().n,result=await f.document(id);
 assert.equal(result.status,200);assert.match(result.body,/Retained Legacy Customer/);assert.match(result.body,/Not retained in issued snapshot/);
 assert.match(result.body,/Sales tax at issue<\/th><td>Not retained in issued snapshot/);
 assert.doesNotMatch(result.body,/Original Customer|100 Original Way|Original pump assembly/);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before,'GET cannot fill missing legacy snapshot fields from live records');
 for(const value of ['not-json','[]','{}',JSON.stringify({...legacy,estimateCents:'2500'}),JSON.stringify({...legacy,items:[{description:'bad',qty:1,rate:null,amount:25}]})]){
  const broken=await f.document(insert(value));assert.equal(broken.status,409);assert.match(broken.body.error,/Retained invoice snapshot is unavailable or invalid/);
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {openDb} from '../src/db.mjs';
import {extendDatabase,posRoutes} from '../src/pos-extension.mjs';
import {installShopOps} from '../src/shop-ops.mjs';
import {installCheckout} from '../src/payment-docs.mjs';
import {installAccounting,createCredit} from '../src/accounting.mjs';
import {applyOrderTax,priceLines,repairFinancialFields} from '../src/tax.mjs';

function fixture(t,{taxable=false}={}){
  const db=openDb(':memory:');t.after(()=>db.close());
  extendDatabase(db);installShopOps(db);installCheckout(db);installAccounting(db);
  const owner={id:Number(db.prepare("INSERT INTO users(username,password_hash,salt,role) VALUES('line-owner','unused','unused','owner')").run().lastInsertRowid),username:'line-owner',role:'owner'};
  const order=Number(db.prepare("INSERT INTO work_orders(source,ref_number,tax_rate_bps) VALUES('manual','LINE-FINANCE',910)").run().lastInsertRowid);
  const route=posRoutes({db,currentUser:()=>owner,readBody:async req=>req.body,json:(res,status,body)=>Object.assign(res,{status,body})});
  const call=async(path,method,body={},revision)=>{
    const isLine=/\/api\/pos\/lines\//.test(path),table=isLine?'work_order_lines':'work_orders',id=Number(path.match(/\/(\d+)(?:\/lines)?$/)[1]);
    const version=revision??db.prepare(`SELECT revision FROM ${table} WHERE id=?`).get(id)?.revision;
    const res={},req={method,body,headers:{'if-match':String(version)}};
    assert.equal(await route(req,res,path,new URL(path,'http://fixture.test')),true);
    return res;
  };
  const add=(body={},revision)=>call(`/api/pos/work-orders/${order}/lines`,'POST',{line_type:'part',item_ref:'TEST-PART',description:'Original part',qty:1,rate:100,taxable,...body},revision);
  const edit=(id,body,revision)=>call(`/api/pos/lines/${id}`,'PATCH',body,revision);
  const remove=id=>call(`/api/pos/lines/${id}`,'DELETE');
  const payment=(amountCents,extra={})=>Number(db.prepare(`INSERT INTO pos_payments(work_order_id,method,direction,amount_cents,idempotency_key,status,verified_by,voided_at) VALUES(?,'cash',?,?,?,?,?,?)`).run(order,extra.direction??'payment',amountCents,crypto.randomUUID(),extra.status??'confirmed',owner.id,extra.voidedAt??null).lastInsertRowid);
  const credit=(subtotalCents,taxCents=0)=>{
    const row=db.prepare('SELECT estimate_total,tax_total_cents FROM work_orders WHERE id=?').get(order);
    const invoice=Number(db.prepare(`INSERT INTO ot_invoices(work_order_id,number,token_hash,amount_cents,valid_until,recipient_name,snapshot_json,created_by) VALUES(?,?,?,?, '2099-01-01','Fixture customer',?,?)`).run(order,crypto.randomUUID(),crypto.randomUUID(),Math.round(row.estimate_total*100),JSON.stringify({estimateCents:Math.round(row.estimate_total*100),taxCents:row.tax_total_cents}),owner.id).lastInsertRowid);
    return createCredit(db,'repair',order,owner,{invoiceId:invoice,subtotalCents,taxCents,reason:'Unused repair charges',idempotencyKey:crypto.randomUUID()});
  };
  return {db,owner,order,add,edit,remove,payment,credit,call};
}

// Includes every row and sequence, so failed writes cannot hide changed parts,
// balances, audit records, tax history, revisions, or consumed IDs.
function snapshot(db){
  return JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()]));
}

test('credit-conflicting line edit and deletion reject with no database mutation',async t=>{
  const f=fixture(t),added=await f.add();assert.equal(added.status,201);
  f.credit(8000);
  const before=snapshot(f.db);
  const edit=await f.edit(added.body.id,{rate:50,description:'Changed part'});
  assert.equal(edit.status,409);assert.match(edit.body.error,/credit/);
  assert.equal(snapshot(f.db),before);
  const removed=await f.remove(added.body.id);assert.equal(removed.status,409);
  assert.equal(snapshot(f.db),before);
  assert.equal((await f.edit(added.body.id,{rate:85})).status,200);
  const order=f.db.prepare('SELECT estimate_total,balance,parts_total FROM work_orders WHERE id=?').get(f.order);
  assert.deepEqual({...order},{estimate_total:85,balance:5,parts_total:85});
  assert.equal(f.db.prepare('SELECT sell_price FROM part_requirements WHERE work_order_id=?').get(f.order).sell_price,85);
});

test('converting an existing credited estimate to lines rejects before inserting a line or part',async t=>{
  const f=fixture(t);
  f.db.prepare('UPDATE work_orders SET estimate_total=100,subtotal_cents=10000,balance=100 WHERE id=?').run(f.order);
  f.credit(8000);
  const before=snapshot(f.db),res=await f.add({rate:50});
  assert.equal(res.status,409);assert.equal(snapshot(f.db),before);
});

test('fully paid taxable invoice permits description edits and zero-value add/delete',async t=>{
  const f=fixture(t,{taxable:true}),added=await f.add();assert.equal(added.status,201);
  f.payment(10910);applyOrderTax(f.db,f.order,'fixture');
  const res=await f.edit(added.body.id,{description:'Clarified part description'});assert.equal(res.status,200,JSON.stringify(res.body));
  const order=f.db.prepare('SELECT subtotal_cents,tax_total_cents,estimate_total,paid_total,balance FROM work_orders WHERE id=?').get(f.order);
  assert.deepEqual({...order},{subtotal_cents:10000,tax_total_cents:910,estimate_total:109.1,paid_total:109.1,balance:0});
  assert.equal(f.db.prepare('SELECT description FROM part_requirements WHERE work_order_id=?').get(f.order).description,'Clarified part description');
  const zero=await f.add({line_type:'service',description:'Courtesy check',rate:0});assert.equal(zero.status,201,JSON.stringify(zero.body));
  assert.equal((await f.remove(zero.body.id)).status,200);
  const before=snapshot(f.db);
  assert.equal((await f.edit(added.body.id,{rate:99.99})).status,409);
  assert.equal((await f.remove(added.body.id)).status,409);
  assert.equal(snapshot(f.db),before);
});

test('payments, refunds and voids use the same cents ledger during repricing',async t=>{
  const f=fixture(t,{taxable:true}),added=await f.add();
  f.payment(10910);f.payment(1091,{direction:'refund'});
  // Represents a retained voided row from a migrated ledger, never available funds.
  f.payment(50000,{voidedAt:'2026-01-01 00:00:00'});
  f.payment(30000,{status:'pending',voidedAt:'2026-01-01 00:00:00'});
  f.payment(30000,{status:'pending'});
  const res=await f.edit(added.body.id,{rate:90});assert.equal(res.status,200,JSON.stringify(res.body));
  const row=f.db.prepare('SELECT estimate_total,paid_total,balance FROM work_orders WHERE id=?').get(f.order);
  assert.deepEqual({...row},{estimate_total:98.19,paid_total:98.19,balance:0});
});

test('paid taxable invoices with retained credits keep their effective balance on description edits',async t=>{
  const f=fixture(t,{taxable:true}),added=await f.add();
  f.credit(8000);f.payment(2910);
  const res=await f.edit(added.body.id,{description:'Clarified credited part'});
  assert.equal(res.status,200,JSON.stringify(res.body));
  const row=f.db.prepare('SELECT estimate_total,paid_total,balance FROM work_orders WHERE id=?').get(f.order);
  assert.deepEqual({...row},{estimate_total:109.1,paid_total:29.1,balance:0});
});

test('repricing protects retained credit tax and subtotal allocations as well as their total',async t=>{
  const f=fixture(t,{taxable:true}),added=await f.add();
  assert.equal((await f.add({line_type:'labor',description:'Labor',taxable:false})).status,201);
  f.credit(0,910);
  const before=snapshot(f.db),res=await f.edit(added.body.id,{taxable:false});
  assert.equal(res.status,409);assert.match(res.body.error,/tax.*credit/);
  assert.equal(snapshot(f.db),before);
});

for(const operation of ['POST','PATCH','DELETE'])test(`${operation} rolls back line, parts, totals, tax history and revisions if audit fails`,async t=>{
  const f=fixture(t,{taxable:true}),added=await f.add();assert.equal(added.status,201);
  f.db.exec("CREATE TRIGGER fail_line_audit BEFORE INSERT ON audit_log WHEN NEW.action IN ('Added sale line','Edited sale line','Deleted uncommitted sale line') BEGIN SELECT RAISE(ABORT,'Injected sale audit failure'); END");
  const before=snapshot(f.db);
  const execute=()=>operation==='POST'?f.add({description:'Additional part',rate:12.34}):operation==='PATCH'?f.edit(added.body.id,{description:'Replacement labor',line_type:'labor',rate:123.45}):f.remove(added.body.id);
  const res=await execute();assert.equal(res.status,500,JSON.stringify(res.body));assert.equal(snapshot(f.db),before);
  f.db.exec('DROP TRIGGER fail_line_audit');
  assert.equal((await execute()).status,operation==='POST'?201:200,'failed operation leaves the connection and edit version reusable');
});

test('tax-history write failure also rolls back line and linked part edits',async t=>{
  const f=fixture(t),added=await f.add();
  f.db.exec("CREATE TRIGGER fail_line_tax BEFORE INSERT ON ot_tax_events BEGIN SELECT RAISE(ABORT,'Injected tax history failure'); END");
  const before=snapshot(f.db),res=await f.edit(added.body.id,{description:'Replacement',rate:50});
  assert.equal(res.status,500);assert.equal(snapshot(f.db),before);
});

test('invalid line numbers reject before mutating any record',async t=>{
  const f=fixture(t),added=await f.add(),before=snapshot(f.db);
  for(const change of [{qty:0},{qty:10001},{qty:'not-a-number'},{rate:-1},{rate:Infinity},{rate:'not-a-price'},{cost:-1},{rate:1000001}]){
    const res=await f.edit(added.body.id,change);assert.equal(res.status,400,JSON.stringify(change));assert.equal(snapshot(f.db),before);
  }
  assert.equal((await f.add({qty:0})).status,400);assert.equal(snapshot(f.db),before);
});

test('imported balances reject every line mutation and financial field without losing legacy payments',async t=>{
  const f=fixture(t),added=await f.add();assert.equal(added.status,201);
  f.db.prepare("UPDATE work_orders SET source='qbpos',estimate_total=100,paid_total=50,balance=50 WHERE id=?").run(f.order);
  const before=snapshot(f.db);
  for(const execute of [()=>f.add({line_type:'labor',description:'Additional labor'}),()=>f.edit(added.body.id,{rate:150}),()=>f.edit(added.body.id,{description:'Description-only still recalculates'}),()=>f.remove(added.body.id),...repairFinancialFields.map(key=>()=>f.call(`/api/pos/work-orders/${f.order}`,'PATCH',{[key]:100,complaint:'Must not persist'}))]){
    const res=await execute();assert.equal(res.status,409,JSON.stringify(res.body));assert.match(res.body.error,/migration reconciliation/);assert.equal(snapshot(f.db),before);
  }
  assert.throws(()=>applyOrderTax(f.db,f.order,'alternate-writer'),error=>error.status===409);assert.equal(snapshot(f.db),before);
  const edited=await f.call(`/api/pos/work-orders/${f.order}`,'PATCH',{complaint:'Updated diagnostic symptom',next_action:'Inspect pump'});assert.equal(edited.status,200);
  const row=f.db.prepare('SELECT estimate_total,paid_total,balance,complaint FROM work_orders WHERE id=?').get(f.order);
  assert.deepEqual({...row},{estimate_total:100,paid_total:50,balance:50,complaint:'Updated diagnostic symptom'});
});

test('unitemized imported estimates also reject new lines and direct amount replacement',async t=>{
  const f=fixture(t);
  f.db.prepare("UPDATE work_orders SET source='qbpos',estimate_total=100,paid_total=50,balance=50 WHERE id=?").run(f.order);
  const before=snapshot(f.db);
  assert.equal((await f.add({line_type:'labor',description:'Attempt local itemization'})).status,409);
  assert.equal((await f.call(`/api/pos/work-orders/${f.order}`,'PATCH',{estimate_total:100})).status,409);
  assert.equal(snapshot(f.db),before);
});

test('pricing sums per-line integer cents and rejects nonfinite amounts',()=>{
  assert.deepEqual(priceLines([{amount:0.1,taxable:1},{amount:0.2,taxable:1}],910),{subtotal_cents:30,taxable_cents:30,tax_cents:3,total_cents:33,rate_bps:910});
  assert.throws(()=>priceLines([{amount:NaN,taxable:1}],910),error=>error.status===400);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {openDb} from '../src/db.mjs';
import {extendDatabase} from '../src/pos-extension.mjs';
import {checkoutRoutes} from '../src/payment-docs.mjs';
import {applyOrderTax} from '../src/tax.mjs';
import {hasPurchaseBacking} from '../src/purchase-policy.mjs';

function fixture(t) {
  const db=openDb(':memory:');t.after(()=>db.close());extendDatabase(db);
  const user={id:Number(db.prepare("INSERT INTO users(username,password_hash,salt,role) VALUES('invoice-owner','test','test','owner')").run().lastInsertRowid),username:'invoice-owner',role:'owner'};
  const customerId=Number(db.prepare("INSERT INTO customers(name,email) VALUES('Original customer','original@example.test')").run().lastInsertRowid);
  const workOrderId=Number(db.prepare(`INSERT INTO work_orders(source,customer_id,ref_number,customer_name,email,phone,unit_label,tax_rate_bps)
    VALUES('manual',?,'WO-ORIGINAL','Original customer','original@example.test','555-0100','Original unit',910)`).run(customerId).lastInsertRowid);
  const lineId=Number(db.prepare(`INSERT INTO work_order_lines(work_order_id,line_type,item_ref,description,qty,rate,amount,taxable)
    VALUES(?,'part','IMPELLER-ONE','Pump impeller',1,100,100,1)`).run(workOrderId).lastInsertRowid);
  applyOrderTax(db,workOrderId,'fixture');
  const queued=[];
  const route=checkoutRoutes({db,currentUser:()=>user,json:(res,status,body)=>Object.assign(res,{status,body}),
    readBody:async req=>{await req.waitForBody?.();return req.body;},publicBaseUrl:'https://shop.example.test',
    notify:async(event,work,extra)=>{queued.push({event,work,extra});return {status:'queued'};}});
  async function issue(body={},waitForBody) {
    const path=`/api/pos/work-orders/${workOrderId}/invoices`,res={};
    body={idempotencyKey:crypto.randomUUID(),expectedRevision:db.prepare('SELECT revision FROM work_orders WHERE id=?').get(workOrderId).revision,...body};
    assert.equal(await route({method:'POST',headers:{},body,waitForBody},res,path,new URL(path,'https://shop.example.test')),true);
    return res;
  }
  const retained=id=>db.prepare('SELECT * FROM ot_invoices WHERE id=?').get(id);
  return {db,customerId,workOrderId,lineId,queued,issue,retained};
}

test('a freshly issued taxable repair invoice backs its exact lines and rejects later taxability changes',async t=>{
  const f=fixture(t);
  assert.equal(hasPurchaseBacking(f.db,f.workOrderId),false,'an unsigned legacy approval schema is not purchase authorization');
  assert.equal(hasPurchaseBacking(f.db,999999),false);
  const result=await f.issue();assert.equal(result.status,201);
  const snapshot=JSON.parse(f.retained(result.body.id).snapshot_json);
  assert.equal(snapshot.items[0].taxable,1);
  assert.equal(snapshot.taxCents,910);
  assert.equal(snapshot.estimateCents,10910);
  assert.equal(hasPurchaseBacking(f.db,f.workOrderId),true,'invoice snapshot must preserve the taxable part flag');
  f.db.prepare('UPDATE work_order_lines SET taxable=0 WHERE id=?').run(f.lineId);
  assert.equal(hasPurchaseBacking(f.db,f.workOrderId),false,'equal gross totals do not authorize a different taxable line');
  assert.equal(JSON.parse(f.retained(result.body.id).snapshot_json).items[0].taxable,1,'historical invoice remains unchanged');
  f.db.prepare('UPDATE work_order_lines SET taxable=1 WHERE id=?').run(f.lineId);
  assert.equal(hasPurchaseBacking(f.db,f.workOrderId),true);
  f.db.prepare('UPDATE ot_invoices SET voided_at=CURRENT_TIMESTAMP WHERE id=?').run(result.body.id);
  assert.equal(hasPurchaseBacking(f.db,f.workOrderId),false,'a voided invoice cannot authorize purchasing');
});

test('invoice issuance rejects a body-time revision race, then snapshots the reviewed current state',async t=>{
  const f=fixture(t);
  let enterBody,releaseBody;
  const entered=new Promise(resolve=>enterBody=resolve),released=new Promise(resolve=>releaseBody=resolve);
  const pending=f.issue({},async()=>{enterBody();await released;});
  await entered;
  // Another desk finishes its changes while this HTTP request body is pending.
  // The original reviewed revision must be rejected after that asynchronous boundary.
  f.db.prepare(`UPDATE work_orders SET ref_number='WO-UPDATED',customer_name='Updated customer',email='updated@example.test',
    phone='555-0199',unit_label='Updated unit',tax_rate_bps=1000 WHERE id=?`).run(f.workOrderId);
  f.db.prepare("UPDATE work_order_lines SET description='Updated pump impeller',qty=2,rate=125,amount=250 WHERE id=?").run(f.lineId);
  applyOrderTax(f.db,f.workOrderId,'second-desk');
  releaseBody();
  const stale=await pending;assert.equal(stale.status,409);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ot_invoices').get().n,0);
  const result=await f.issue();assert.equal(result.status,201);
  const invoice=f.retained(result.body.id),snapshot=JSON.parse(invoice.snapshot_json);
  assert.equal(invoice.recipient_name,'Updated customer');
  assert.equal(invoice.recipient_email,'updated@example.test');
  assert.equal(invoice.recipient_phone,'555-0199');
  assert.equal(snapshot.refNumber,'WO-UPDATED');
  assert.equal(snapshot.unit,'Updated unit');
  assert.equal(snapshot.taxRateBps,1000);
  assert.equal(snapshot.taxCents,2500);
  assert.equal(snapshot.estimateCents,27500);
  assert.equal(snapshot.balanceCents,27500);
  assert.equal(snapshot.items[0].description,'Updated pump impeller');
  assert.equal(snapshot.items[0].qty,2);
  assert.equal(snapshot.items[0].amount,250);
  assert.equal(hasPurchaseBacking(f.db,f.workOrderId),true);
});

test('an invoice recipient override cannot silently queue its link to the old customer email',async t=>{
  const f=fixture(t);
  const result=await f.issue({email:'corrected@example.test',sendEmail:true});
  assert.equal(result.status,201);
  assert.equal(result.body.deliveryStatus,'not_sent_recipient_review_required');
  assert.equal(f.queued.length,0);
  assert.equal(f.retained(result.body.id).recipient_email,'corrected@example.test');
  assert.equal(f.db.prepare('SELECT status FROM ot_invoice_deliveries WHERE invoice_id=?').get(result.body.id).status,'not_sent_recipient_review_required');
  const matchingRecipient=fixture(t);
  const unchanged=await matchingRecipient.issue({email:'original@example.test',sendEmail:true});
  assert.equal(unchanged.status,201);assert.equal(unchanged.body.deliveryStatus,'queued');
  assert.equal(matchingRecipient.queued.length,1);assert.equal(matchingRecipient.queued[0].event,'invoice_issued');
});

test('a revised invoice replaces purchase backing while preserving its historical snapshot',async t=>{
  const f=fixture(t),first=await f.issue();assert.equal(first.status,201);
  f.db.prepare("UPDATE work_order_lines SET description='Revised impeller specification' WHERE id=?").run(f.lineId);
  const revised=await f.issue({documentKind:'revised_invoice',supersedesInvoiceId:first.body.id});assert.equal(revised.status,201);
  assert.equal(hasPurchaseBacking(f.db,f.workOrderId),true);
  f.db.prepare("UPDATE work_order_lines SET description='Pump impeller' WHERE id=?").run(f.lineId);
  assert.equal(hasPurchaseBacking(f.db,f.workOrderId),false,'a superseded invoice cannot authorize reverted work');
  assert.match(f.retained(first.body.id).snapshot_json,/Pump impeller/);
});

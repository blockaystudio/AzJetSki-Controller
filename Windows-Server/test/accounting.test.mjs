import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {openDb} from '../src/db.mjs';
import {extendDatabase,posRoutes} from '../src/pos-extension.mjs';
import {installShopOps,shopOpsRoutes} from '../src/shop-ops.mjs';
import {installCheckout,checkoutRoutes} from '../src/payment-docs.mjs';
import {receiptRoutes} from '../src/receipts.mjs';
import {installAccounting,effectiveAccountTotal,accountBalance,createCredit,cancelInvoice,receiveCustomerReturn,businessDayRange,dailyCloseReport,recordDailyClose,dailyCloseCSV,accountingRoutes} from '../src/accounting.mjs';

function fixture(){
  const db=openDb(':memory:');extendDatabase(db);installShopOps(db);installCheckout(db);installAccounting(db);
  const users={};for(const role of ['owner','manager','advisor','service_writer','technician','parts','viewer']){const id=Number(db.prepare('INSERT INTO users(username,password_hash,salt,role) VALUES(?,?,?,?)').run(role,'test','test',role).lastInsertRowid);users[role]={id,username:role,role};}
  const customer=Number(db.prepare("INSERT INTO customers(name) VALUES('Accounting customer')").run().lastInsertRowid);
  const repair=Number(db.prepare("INSERT INTO work_orders(source,ref_number,estimate_total,subtotal_cents,tax_total_cents,balance) VALUES('manual','WO-ACCOUNT',100,9000,1000,100)").run().lastInsertRowid);
  const repairInvoice=Number(db.prepare(`INSERT INTO ot_invoices(work_order_id,number,token_hash,amount_cents,valid_until,recipient_name,snapshot_json,created_by) VALUES(?,'INV-ACCOUNT',?,10000,'2099-01-01','Accounting customer',?,?)`).run(repair,crypto.randomUUID(),JSON.stringify({estimateCents:10000,taxCents:1000,items:[{description:'Original repair',qty:1,rate:90,amount:90}]}),users.owner.id).lastInsertRowid);
  const retail=Number(db.prepare(`INSERT INTO retail_special_orders(customer_id,invoice_number,invoice_issued_at,subtotal_cents,tax_cents,total_cents) VALUES(?,'PART-ACCOUNT',CURRENT_TIMESTAMP,10000,2000,12000)`).run(customer).lastInsertRowid);
  db.prepare("INSERT INTO retail_special_lines(retail_order_id,description,quantity,unit_price_cents,status) VALUES(?,'Returned part',3,3333,'verified')").run(retail);
  const credit=(scope='repair',overrides={},user=users.owner)=>createCredit(db,scope,scope==='repair'?repair:retail,user,{invoiceId:scope==='repair'?repairInvoice:retail,subtotalCents:900,taxCents:100,reason:'Returned unused charge',idempotencyKey:crypto.randomUUID(),...overrides});
  const payment=(scope='repair',overrides={})=>{
    const table=scope==='repair'?'pos_payments':'retail_payments',parent=scope==='repair'?'work_order_id':'retail_order_id',actor=scope==='repair'?'verified_by':'recorded_by';
    const row={method:'cash',direction:'payment',amount:10000,status:'confirmed',reference:'',createdAt:'2026-10-25 10:00:00',...overrides};
    return Number(db.prepare(`INSERT INTO ${table}(${parent},method,direction,amount_cents,status,reference,idempotency_key,${actor},created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(scope==='repair'?repair:retail,row.method,row.direction,row.amount,row.status,row.reference,crypto.randomUUID(),users.owner.id,row.createdAt).lastInsertRowid);
  };
  return {db,users,customer,repair,repairInvoice,retail,credit,payment};
}
const rejects=(fn,status)=>assert.throws(fn,error=>error.status===status);

test('credits retain immutable source/tax/actor snapshots and exact retries; ordinary roles cannot credit',t=>{
  const f=fixture();t.after(()=>f.db.close());
  for(const role of ['advisor','service_writer','technician','parts','viewer'])rejects(()=>f.credit('repair',{},f.users[role]),403);
  rejects(()=>f.credit('repair',{reason:''}),400);rejects(()=>f.credit('repair',{subtotalCents:0,taxCents:0}),400);rejects(()=>f.credit('repair',{taxCents:1001}),409);
  const before=f.db.prepare('SELECT snapshot_json FROM ot_invoices WHERE id=?').get(f.repairInvoice).snapshot_json;
  const input={subtotalCents:4500,taxCents:500,idempotencyKey:'credit-request-one'};
  const credit=f.credit('repair',input,f.users.manager);
  assert.equal(credit.total_cents,5000);assert.equal(credit.actor_role,'manager');
  assert.equal(f.credit('repair',input,f.users.manager).duplicate,true);
  rejects(()=>f.credit('repair',{...input,subtotalCents:4501}),409);
  assert.equal(f.db.prepare('SELECT snapshot_json FROM ot_invoices WHERE id=?').get(f.repairInvoice).snapshot_json,before);
  f.db.prepare("UPDATE users SET username='renamed',role='viewer' WHERE id=?").run(f.users.manager.id);
  assert.equal(f.db.prepare('SELECT actor_username FROM accounting_credits WHERE id=?').get(credit.id).actor_username,'manager');
  assert.throws(()=>f.db.prepare('UPDATE accounting_credits SET reason=? WHERE id=?').run('edited',credit.id),/immutable/);
  assert.throws(()=>f.db.prepare('DELETE FROM accounting_credits WHERE id=?').run(credit.id),/immutable/);
  f.credit('repair',{subtotalCents:4500,taxCents:500});
  rejects(()=>f.credit('repair'),409);
  installAccounting(f.db);assert.equal(effectiveAccountTotal(f.db,'repair',f.repair,10000),0);
  rejects(()=>effectiveAccountTotal(f.db,'repair',f.repair,9999),409);
});

test('crediting a paid invoice creates refund due without transferring money or rewriting payments',t=>{
  const f=fixture();t.after(()=>f.db.close());
  f.payment();const count=f.db.prepare('SELECT COUNT(*) n FROM pos_payments').get().n;
  f.credit('repair',{subtotalCents:4500,taxCents:500});
  assert.deepEqual(accountBalance(f.db,'repair',f.repair),{rawTotalCents:10000,creditCents:5000,effectiveTotalCents:5000,netPaidCents:10000,pendingCents:0,dueCents:0,refundDueCents:5000});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pos_payments').get().n,count);
  assert.equal(f.db.prepare('SELECT balance FROM work_orders WHERE id=?').get(f.repair).balance,0);
  f.payment('repair',{direction:'refund',amount:2000,reference:'REFUND-ONE'});
  assert.equal(accountBalance(f.db,'repair',f.repair).refundDueCents,3000);
  f.payment('repair',{direction:'refund',amount:3000,reference:'REFUND-TWO'});
  assert.equal(accountBalance(f.db,'repair',f.repair).dueCents,0);
});

test('reissued repair invoices cannot bypass account-wide charge and tax credit allocations',t=>{
  const f=fixture();t.after(()=>f.db.close());
  const original=f.db.prepare('SELECT * FROM ot_invoices WHERE id=?').get(f.repairInvoice);
  const second=Number(f.db.prepare(`INSERT INTO ot_invoices(work_order_id,number,token_hash,amount_cents,valid_until,recipient_name,snapshot_json,created_by) VALUES(?,'INV-REISSUED',?,10000,'2099-01-01','Accounting customer',?,?)`).run(f.repair,crypto.randomUUID(),original.snapshot_json,f.users.owner.id).lastInsertRowid);
  f.credit('repair',{subtotalCents:9000,taxCents:0});
  rejects(()=>f.credit('repair',{invoiceId:second,subtotalCents:1000,taxCents:0}),409);
  f.credit('repair',{invoiceId:second,subtotalCents:0,taxCents:1000});
  assert.equal(accountBalance(f.db,'repair',f.repair).effectiveTotalCents,0);
  const report=dailyCloseReport(f.db,new Intl.DateTimeFormat('en-CA',{timeZone:'America/Phoenix',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
  assert.equal(report.taxReviewRequired,true);
});

test('unpaid cancellation creates full credit and voids an invoice, blocking revival of cancelled retail lines',t=>{
  const f=fixture();t.after(()=>f.db.close());
  const input={invoiceId:f.repairInvoice,reason:'Customer cancelled all work',idempotencyKey:'cancel-repair-request'};
  const cancelled=cancelInvoice(f.db,'repair',f.repair,f.users.owner,input);
  assert.equal(cancelled.total_cents,10000);assert.equal(accountBalance(f.db,'repair',f.repair).effectiveTotalCents,0);
  assert.ok(f.db.prepare('SELECT voided_at FROM ot_invoices WHERE id=?').get(f.repairInvoice).voided_at);
  assert.equal(cancelInvoice(f.db,'repair',f.repair,f.users.owner,input).duplicate,true);
  rejects(()=>cancelInvoice(f.db,'repair',f.repair,f.users.owner,{...input,reason:'Changed cancellation'}),409);
  const retail=cancelInvoice(f.db,'retail',f.retail,f.users.manager,{reason:'Special order cancelled before source',idempotencyKey:'cancel-retail-request'});
  assert.equal(retail.total_cents,12000);assert.equal(accountBalance(f.db,'retail',f.retail).dueCents,0);
  assert.throws(()=>f.db.prepare("UPDATE retail_special_lines SET status='verified' WHERE retail_order_id=?").run(f.retail),/Cancelled invoice/);
});

test('cancellation refuses paid/pending accounts and supplier progress before any credit is written',t=>{
  const f=fixture();t.after(()=>f.db.close());
  f.payment('repair',{method:'zelle',status:'pending',amount:1000});
  rejects(()=>cancelInvoice(f.db,'repair',f.repair,f.users.owner,{invoiceId:f.repairInvoice,reason:'Attempt unsafe cancellation',idempotencyKey:crypto.randomUUID()}),409);
  f.db.prepare("UPDATE retail_special_lines SET status='queued' WHERE retail_order_id=?").run(f.retail);
  rejects(()=>cancelInvoice(f.db,'retail',f.retail,f.users.owner,{reason:'Attempt unsafe cancellation',idempotencyKey:crypto.randomUUID()}),409);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM accounting_credits').get().n,0);
});

test('physical returns link credited invoice/original sale, cap quantities, and distinguish damaged from resellable stock',t=>{
  const f=fixture();t.after(()=>f.db.close());
  const credit=f.credit('retail',{subtotalCents:10000,taxCents:2000});
  const sale=Number(f.db.prepare("INSERT INTO inventory_adjustments(item_sku,quantity_delta,reason,reference_type,reference_id,actor_id) VALUES('SKU-ONE',-3,'sold','invoice','PART-ACCOUNT',?)").run(f.users.owner.id).lastInsertRowid);
  const input={saleAdjustmentId:sale,creditNoteId:credit.id,quantity:2,disposition:'resellable',received:true,reason:'Two unused units received',idempotencyKey:'physical-return-request'};
  rejects(()=>receiveCustomerReturn(f.db,'retail',f.retail,f.users.advisor,input),403);
  rejects(()=>receiveCustomerReturn(f.db,'retail',f.retail,f.users.owner,{...input,received:'true'}),400);
  const returned=receiveCustomerReturn(f.db,'retail',f.retail,f.users.owner,input);
  assert.equal(returned.sku,'SKU-ONE');assert.equal(receiveCustomerReturn(f.db,'retail',f.retail,f.users.owner,input).duplicate,true);
  assert.equal(f.db.prepare('SELECT reference_id FROM inventory_adjustments WHERE id=?').get(returned.inventory_adjustment_id).reference_id,String(returned.id));
  assert.equal(f.db.prepare("SELECT SUM(quantity_delta) n FROM inventory_adjustments WHERE reason='return'").get().n,2);
  receiveCustomerReturn(f.db,'retail',f.retail,f.users.owner,{...input,quantity:1,disposition:'damaged',idempotencyKey:'damaged-return-request'});
  assert.equal(f.db.prepare("SELECT SUM(quantity_delta) n FROM inventory_adjustments WHERE reason='return'").get().n,2);
  rejects(()=>receiveCustomerReturn(f.db,'retail',f.retail,f.users.owner,{...input,quantity:1,idempotencyKey:'excess-return-request'}),409);
  assert.throws(()=>f.db.prepare('DELETE FROM accounting_returns WHERE id=?').run(returned.id),/immutable/);
});

test('daily close uses Phoenix boundaries and bank confirmation date; pending/void entries never count as funds',t=>{
  const f=fixture();t.after(()=>f.db.close());
  assert.equal(businessDayRange('2026-10-25').startsAt,'2026-10-25T07:00:00.000Z');
  rejects(()=>businessDayRange('2026-02-30'),400);rejects(()=>businessDayRange('25/10/2026'),400);
  f.payment('repair',{amount:1000,createdAt:'2026-10-25 06:59:59'});
  f.payment('repair',{amount:10000,createdAt:'2026-10-25 07:00:00'});
  f.payment('repair',{direction:'refund',amount:1000,createdAt:'2026-10-26 06:59:59'});
  f.payment('retail',{method:'zelle',status:'pending',amount:2000,createdAt:'2026-10-25 10:00:00'});
  const bank=f.payment('retail',{method:'zelle',reference:'BANK-LATE',amount:3000,createdAt:'2026-10-24 15:00:00'});
  f.db.prepare(`INSERT INTO finance_events(scope,entity_id,payment_id,operation,operation_key,request_fingerprint,actor_id,actor_username,actor_role,detail_json,created_at)
    VALUES('retail',?,?,'confirm','confirm-late','test',?,'owner','owner','{}','2026-10-25 08:00:00')`).run(f.retail,bank,f.users.owner.id);
  const report=dailyCloseReport(f.db,'2026-10-25');
  assert.equal(report.methods.cash.netCents,9000);assert.equal(report.methods.zelle.netCents,3000);
  assert.equal(report.entries.filter(row=>row.excluded).length,1);
  assert.match(report.basis,/not processor settlement/);
  const csv=dailyCloseCSV({...report,entries:[{scope:'repair',entityId:1,id:1,effective_at:'2026-10-25',method:'cash',direction:'payment',status:'confirmed',amount_cents:100,reference:'=HYPERLINK("bad")',exclusion:''}]});
  assert.match(csv,/'=HYPERLINK/);assert.doesNotMatch(csv,/"=HYPERLINK/);
});

test('daily close signoff is immutable, tracks discrepancies, supports refund-only external days and exact retry',t=>{
  const f=fixture();t.after(()=>f.db.close());
  f.payment('repair',{amount:10000});f.payment('retail',{method:'card_dejavoo',direction:'refund',reference:'CARD-REFUND',amount:3000});
  const input={cashCountedCents:15000,openingFloatCents:5000,cashPaidOutCents:0,cardVerifiedCents:-3000,zelleVerifiedCents:0,externalTotalsVerified:true,notes:'Matched cash and terminal reports',idempotencyKey:'close-report-request'};
  rejects(()=>recordDailyClose(f.db,'2026-10-25',f.users.advisor,input),403);
  rejects(()=>recordDailyClose(f.db,'2026-10-25',f.users.owner,{...input,cashCountedCents:14900,notes:''}),400);
  const close=recordDailyClose(f.db,'2026-10-25',f.users.owner,input);
  assert.equal(close.cash_difference_cents,0);assert.equal(close.card_difference_cents,0);
  assert.equal(recordDailyClose(f.db,'2026-10-25',f.users.owner,input).duplicate,true);
  rejects(()=>recordDailyClose(f.db,'2026-10-25',f.users.owner,{...input,notes:'Changed details'}),409);
  assert.throws(()=>f.db.prepare('UPDATE accounting_closes SET notes=? WHERE id=?').run('rewrite',close.id),/immutable/);
  assert.equal(JSON.parse(close.snapshot_json).methods.cash.netCents,10000);
});

test('accounting routes authenticate and expose credit/refund-due and no-store report exports',async t=>{
  const f=fixture();t.after(()=>f.db.close());let user=f.users.owner;
  const route=accountingRoutes({db:f.db,currentUser:()=>user,readBody:async req=>req.body,json:(res,status,body,headers)=>Object.assign(res,{status,body,headers})});
  async function call(path,method='GET',body={}){const res={writeHead(status,headers){Object.assign(this,{status,headers});},end(body){this.body=body;}};const url=new URL(path,'http://local.test');assert.equal(await route({method,body},res,url.pathname,url),true);return res;}
  user=null;assert.equal((await call('/api/accounting/daily-close?date=2026-10-25')).status,401);
  user=f.users.owner;const view=await call(`/api/accounting/accounts/repair/${f.repair}`);assert.equal(view.status,200);assert.equal(view.body.balance.dueCents,10000);
  const csv=await call('/api/accounting/daily-close?date=2026-10-25&format=csv');assert.equal(csv.status,200);assert.match(csv.headers['content-type'],/text\/csv/);assert.equal(csv.headers['cache-control'],'no-store');
});

test('shared payment and custody routes honor credits and allow partial refunds of an overpaid account',async t=>{
  const f=fixture();t.after(()=>f.db.close());
  const vehicle=Number(f.db.prepare("INSERT INTO vehicles(customer_id,make,model) VALUES(?,'Yamaha','VX')").run(f.customer).lastInsertRowid);
  f.db.prepare("UPDATE work_orders SET customer_id=?,vehicle_id=?,stage='Ready' WHERE id=?").run(f.customer,vehicle,f.repair);
  f.db.prepare("INSERT INTO unit_custody(vehicle_id,work_order_id,status,checked_in_at) VALUES(?,?,'in_lot',CURRENT_TIMESTAMP)").run(vehicle,f.repair);
  const props={db:f.db,currentUser:()=>f.users.owner,readBody:async req=>req.body,json:(res,status,body)=>Object.assign(res,{status,body})};
  const handlers=[posRoutes(props),shopOpsRoutes(props)];
  async function call(path,method='GET',body={}){const req={method,body,headers:{}},res={},url=new URL(path,'http://local.test');for(const handler of handlers)if(await handler(req,res,url.pathname,url))return res;throw Error('No handler');}
  const path=`/api/pos/work-orders/${f.repair}/payments`;
  const bypass=await call('/api/shop/inventory-adjustments','POST',{sku:'UNLINKED',quantityDelta:1,reason:'return',referenceType:'manual',referenceId:'NO-CREDIT'});
  assert.equal(bypass.status,409);assert.match(bypass.body.error,/original stock sale and credit note/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM inventory_adjustments WHERE item_sku='UNLINKED'").get().n,0);
  const paid=await call(path,'POST',{method:'cash',amount:'100',verified:true,idempotencyKey:crypto.randomUUID()});assert.equal(paid.status,201);
  f.credit('repair',{subtotalCents:4500,taxCents:500});
  const refund={method:'cash',direction:'refund',originalPaymentId:paid.body.id,reason:'Customer returned cancelled work',verified:true};
  let reply=await call(path,'POST',{...refund,amount:'20',reference:'OVERPAID-PARTIAL-1',idempotencyKey:crypto.randomUUID()});assert.equal(reply.status,201);assert.equal(reply.body.totals.refundDue,30);
  const denied=await call(path,'POST',{method:'cash',amount:'1',verified:true,idempotencyKey:crypto.randomUUID()});assert.equal(denied.status,409);
  let queue=await call('/api/shop/queues');assert.equal(queue.body.readyForPickup.length,0);assert.equal(queue.body.paymentPending[0].refundDue,30);
  reply=await call(`/api/shop/vehicles/${vehicle}/check-out`,'POST',{});assert.equal(reply.status,409);
  reply=await call(path,'POST',{...refund,amount:'30',reference:'OVERPAID-PARTIAL-2',idempotencyKey:crypto.randomUUID()});assert.equal(reply.status,201);assert.equal(reply.body.totals.balance,0);assert.equal(reply.body.totals.refundDue,0);
  queue=await call('/api/shop/queues');assert.equal(queue.body.readyForPickup.length,1);
  reply=await call(`/api/shop/vehicles/${vehicle}/check-out`,'POST',{});assert.equal(reply.status,200);
});

test('a failed audit write rolls the entire credit and repaired balance back',t=>{
  const f=fixture();t.after(()=>f.db.close());
  f.db.exec("CREATE TRIGGER reject_credit_audit BEFORE INSERT ON audit_log WHEN NEW.action='Credit note issued' BEGIN SELECT RAISE(ABORT,'Injected audit failure'); END;");
  assert.throws(()=>f.credit(),/Injected audit failure/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM accounting_credits').get().n,0);
  assert.equal(f.db.prepare('SELECT balance FROM work_orders WHERE id=?').get(f.repair).balance,100);
});

test('a later invoice preserves credits at issue separately from raw lines and payments',async t=>{
  const f=fixture();t.after(()=>f.db.close());
  f.credit('repair',{subtotalCents:900,taxCents:100});
  const props={db:f.db,currentUser:()=>f.users.owner,readBody:async req=>req.body,json:(res,status,body)=>Object.assign(res,{status,body}),publicBaseUrl:'https://shop.example.test'};
  const checkout=checkoutRoutes(props),res={},path=`/api/pos/work-orders/${f.repair}/invoices`;
  await checkout({method:'POST',body:{}},res,path,new URL(path,'https://shop.example.test'));
  assert.equal(res.status,201);
  const snapshot=JSON.parse(f.db.prepare('SELECT snapshot_json FROM ot_invoices WHERE id=?').get(res.body.id).snapshot_json);
  assert.equal(snapshot.estimateCents,10000);assert.equal(snapshot.creditCents,1000);assert.equal(snapshot.effectiveCents,9000);assert.equal(snapshot.balanceCents,9000);
  const receipt=receiptRoutes(props),printed={writeHead(status,headers){Object.assign(this,{status,headers});},end(body){this.body=String(body);}};
  await receipt({method:'GET'},printed,`/api/receipts/repair/${f.repair}`);
  assert.equal(printed.status,200);
  assert.match(printed.body,/Retained credits at issue/);assert.match(printed.body,/Adjusted invoice charge at issue/);
});

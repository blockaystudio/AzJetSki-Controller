import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {openDb} from '../src/db.mjs';
import {extendDatabase} from '../src/pos-extension.mjs';
import {installShopOps} from '../src/shop-ops.mjs';
import {installShopManagement,recordContactConsent} from '../src/shop-management.mjs';
import {shopDashboardReport,shopReportsRoutes} from '../src/shop-reports.mjs';

function fixture(){
  const db=openDb(':memory:');extendDatabase(db);installShopOps(db);installShopManagement(db);
  const users={};for(const role of ['owner','manager','advisor','parts','service_writer','technician','viewer']){const id=Number(db.prepare('INSERT INTO users(username,password_hash,salt,role,display_name) VALUES(?,?,?,?,?)').run(role,'test','test',role,role+' person').lastInsertRowid);users[role]={id,username:role,role};}
  const customer=Number(db.prepare("INSERT INTO customers(name,email) VALUES('Report customer','report@example.test')").run().lastInsertRowid);
  const wo=Number(db.prepare("INSERT INTO work_orders(source,customer_id,customer_name,ref_number,estimate_total,balance,date_opened,created_at,service_advisor_id) VALUES('manual',?,'Report customer','REPORT-1',600,600,'2026-10-20','2026-10-20 12:00:00',?)").run(customer,users.advisor.id).lastInsertRowid);
  const retail=Number(db.prepare("INSERT INTO retail_special_orders(customer_id,invoice_number,invoice_issued_at,total_cents) VALUES(?,'RETAIL-RPT','2026-10-25 12:00:00',12000)").run(customer).lastInsertRowid);
  const payment=(scope,{method='cash',direction='payment',amount=10000,status='confirmed',date='2026-10-25 12:00:00',voidedAt=null}={})=>{
    const table=scope==='repair'?'pos_payments':'retail_payments',parent=scope==='repair'?'work_order_id':'retail_order_id',actor=scope==='repair'?'verified_by':'recorded_by';
    return Number(db.prepare(`INSERT INTO ${table}(${parent},method,direction,amount_cents,status,reference,idempotency_key,${actor},created_at,voided_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(scope==='repair'?wo:retail,method,direction,amount,status,crypto.randomUUID(),crypto.randomUUID(),users.owner.id,date,voidedAt).lastInsertRowid);
  };
  const clock=()=>new Date('2026-10-25T20:00:00Z');
  const routes=shopReportsRoutes({db,currentUser:req=>req.user,json:(res,status,body,headers)=>{res.status=status;res.body=body;res.headers=headers;},readBody:async req=>req.body,now:clock});
  async function call(path,method='GET',body={},user=users.owner,status=200){const res={},url=new URL('http://shop'+path);assert.equal(await routes({method,body,user},res,url.pathname,url),true);assert.equal(res.status,status,JSON.stringify(res.body));return res;}
  return {db,users,customer,wo,retail,payment,clock,call};
}

test('Phoenix reporting bounds include confirmations on their bank verification date and exclude pending/voided funds',()=>{
  const f=fixture();try{
    f.payment('repair',{amount:99999,date:'2026-10-25 06:59:59'});
    f.payment('repair',{amount:10000,date:'2026-10-25 07:00:00'});
    f.payment('repair',{direction:'refund',amount:2000,date:'2026-10-25 10:00:00'});
    const bank=f.payment('repair',{method:'zelle',amount:5000,date:'2026-10-24 10:00:00'});
    f.db.prepare(`INSERT INTO finance_events(scope,entity_id,payment_id,operation,operation_key,request_fingerprint,actor_id,actor_username,actor_role,detail_json,created_at) VALUES('repair',?,?,'confirm',?,'test',?,'owner','owner','{}','2026-10-25 15:00:00')`).run(f.wo,bank,'confirm:'+bank,f.users.owner.id);
    f.payment('repair',{method:'zelle',amount:3000,status:'pending'});
    f.payment('repair',{method:'zelle',amount:4000,status:'pending',voidedAt:'2026-10-25 13:00:00'});
    f.payment('retail',{method:'card_dejavoo',amount:5000,date:'2026-10-26 06:59:59'});
    f.payment('retail',{method:'card_dejavoo',amount:9000,date:'2026-10-26 07:00:00'});
    const report=shopDashboardReport(f.db,{from:'2026-10-25',to:'2026-10-25',now:f.clock()});
    assert.equal(report.startsAt,'2026-10-25T07:00:00.000Z');assert.equal(report.endsAt,'2026-10-26T07:00:00.000Z');
    assert.equal(report.cashflow.receivedCents,20000);assert.equal(report.cashflow.refundCents,2000);assert.equal(report.cashflow.netConfirmedReceiptsCents,18000);
    assert.equal(report.cashflow.pendingCents,3000);assert.equal(report.cashflow.voidedCents,4000);
    assert.equal(report.cashflow.methods.zelle.receivedCents,5000);assert.equal(report.cashflow.scopes.retail.netCents,5000);
    assert.match(report.cashflow.basis,/not recognized sales revenue/);
  }finally{f.db.close();}
});

test('retail spread excludes unknown costs and repair cost ambiguity instead of fabricating profit',()=>{
  const f=fixture();try{
    f.db.prepare("INSERT INTO retail_special_lines(retail_order_id,description,quantity,unit_price_cents,unit_cost_cents) VALUES(?,'Known cost',2,5000,3000)").run(f.retail);
    f.db.prepare("INSERT INTO retail_special_lines(retail_order_id,description,quantity,unit_price_cents,unit_cost_cents) VALUES(?,'Unknown cost',1,2000,0)").run(f.retail);
    f.db.prepare("INSERT INTO work_order_lines(work_order_id,line_type,qty,amount,cost) VALUES(?,'part',1,90,0)").run(f.wo);
    const spread=shopDashboardReport(f.db,{from:'2026-10-25',to:'2026-10-25',now:f.clock()}).partsSpread;
    assert.equal(spread.knownCostLineSpreadCents,4000);assert.equal(spread.knownCostLineCount,1);assert.equal(spread.missingCostLineCount,1);
    assert.match(spread.basis,/not realized gross profit/);assert.match(spread.basis,/Repair cost fields/);
  }finally{f.db.close();}
});

test('operational watchlists distinguish missing ready timestamps, overdue promises and known dated cycle times',()=>{
  const f=fixture();try{
    f.db.prepare("UPDATE work_orders SET stage='Awaiting Approval',promised_date='2026-10-23' WHERE id=?").run(f.wo);
    f.db.prepare("INSERT INTO approvals(work_order_id,token_hash,created_at) VALUES(?,'report-approval','2026-10-21 12:00:00')").run(f.wo);
    const ready=Number(f.db.prepare("INSERT INTO work_orders(source,customer_id,customer_name,stage,ref_number,balance,date_opened) VALUES('manual',?,'Report customer','Ready','READY-RPT',25,'2026-10-20')").run(f.customer).lastInsertRowid);
    f.db.prepare("INSERT INTO work_orders(source,customer_id,customer_name,stage,date_opened,date_closed,service_advisor_id) VALUES('manual',?,'Report customer','Closed','2026-10-20','2026-10-24',?)").run(f.customer,f.users.advisor.id);
    f.db.prepare("INSERT INTO work_orders(source,customer_id,stage,date_opened) VALUES('manual',?,'Closed','2026-10-01')").run(f.customer);
    const report=shopDashboardReport(f.db,{from:'2026-10-01',to:'2026-10-25',now:f.clock()});
    assert.equal(report.queues.counts.quotes,1);assert.equal(report.queues.counts.ready,1);assert.equal(report.queues.counts.overdue,1);
    assert.equal(report.queues.readyForPickup.find(row=>row.id===ready).ageDays,null);
    assert.equal(report.workOrders.averageCompletedCycleDays,4);assert.equal(report.workOrders.completed,1);assert.equal(report.workOrders.completedMissingDates,1);
    assert.equal(report.workOrders.advisors.find(a=>a.advisorId===f.users.advisor.id).completed,1);
  }finally{f.db.close();}
});

test('reports are owner/manager only, reject invalid ranges, and do not disclose customer records to ordinary roles',async()=>{
  const f=fixture();try{
    await f.call('/api/reports/dashboard','GET',{},null,401);
    for(const role of ['advisor','parts','service_writer','technician','viewer']){const res=await f.call('/api/reports/dashboard','GET',{},f.users[role],403);assert.deepEqual(Object.keys(res.body),['error']);}
    const report=await f.call('/api/reports/dashboard?from=2026-10-01&to=2026-10-25','GET',{},f.users.manager);assert.equal(report.headers['cache-control'],'no-store');
    await f.call('/api/reports/dashboard?from=2026-10-30&to=2026-10-01','GET',{},f.users.owner,400);
    await f.call('/api/reports/dashboard?from=2026-02-30&to=2026-10-25','GET',{},f.users.owner,400);
    await f.call('/api/reports/dashboard?from=2020-01-01&to=2026-10-25','GET',{},f.users.owner,400);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_message_outbox').get().n,0);
  }finally{f.db.close();}
});

test('retention uses latest completed service, consent and future booking, and generates stable service drafts without sending',async()=>{
  const f=fixture();try{
    f.db.prepare("UPDATE work_orders SET stage='Closed',date_opened='2026-08-01',date_closed='2026-09-01' WHERE id=?").run(f.wo);
    let report=shopDashboardReport(f.db,{from:'2026-10-01',to:'2026-10-25',now:f.clock()});
    assert.equal(report.retentionCandidates[0].draftEligible,false);
    await f.call('/api/reports/retention-drafts','POST',{customerIds:[f.customer],confirmDrafts:true});
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_message_outbox').get().n,0);
    recordContactConsent(f.db,f.users.owner,f.customer,{serviceEmail:true,marketingEmail:false,source:'Signed service follow-up consent'});
    const first=await f.call('/api/reports/retention-drafts','POST',{customerIds:[f.customer],confirmDrafts:true});
    assert.equal(first.body.results[0].status,'draft');assert.match(first.body.notice,/no email was sent/);
    const repeated=await f.call('/api/reports/retention-drafts','POST',{customerIds:[f.customer],confirmDrafts:true});assert.equal(repeated.body.results[0].duplicate,true);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_message_outbox').get().n,1);
    assert.equal(f.db.prepare('SELECT attempts FROM customer_message_outbox').get().attempts,0);
    f.db.prepare("INSERT INTO shop_appointments(customer_id,title,starts_at,ends_at,created_by) VALUES(?,'Already booked','2026-10-30T15:00:00Z','2026-10-30T16:00:00Z',?)").run(f.customer,f.users.owner.id);
    report=shopDashboardReport(f.db,{now:f.clock()});assert.equal(report.retentionCandidates.length,0);
  }finally{f.db.close();}
});

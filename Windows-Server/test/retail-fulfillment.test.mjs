import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {openDb} from '../src/db.mjs';
import {extendDatabase} from '../src/pos-extension.mjs';
import {installShopOps,shopOpsRoutes} from '../src/shop-ops.mjs';
import {installShopManagement,receiveStock} from '../src/shop-management.mjs';
import {installAccounting,createCredit,receiveCustomerReturn,cancelInvoice} from '../src/accounting.mjs';
import {captureRetailReceiptSnapshot} from '../src/receipts.mjs';
import {recordPayment} from '../src/finance-controls.mjs';
import {installEditRevisions,editRevisionTarget} from '../src/edit-revisions.mjs';

function fixture(t){
 const db=openDb(':memory:');extendDatabase(db);installShopOps(db);installShopManagement(db);installAccounting(db);installEditRevisions(db);t.after(()=>db.close());
 const users={};for(const role of ['owner','manager','advisor','parts','service_writer','technician','viewer']){const id=Number(db.prepare('INSERT INTO users(username,password_hash,salt,role) VALUES(?,?,?,?)').run(`receiving-${role}`,'test','test',role).lastInsertRowid);users[role]={id,username:`receiving-${role}`,role};}
 const customer=Number(db.prepare("INSERT INTO customers(name) VALUES('Fictional supplier customer')").run().lastInsertRowid);
 const vendor=Number(db.prepare("INSERT INTO vendors(code,name,order_threshold,enabled) VALUES('SUPPLIER-TEST','Fictional supplier',0,1)").run().lastInsertRowid);
 function newOrder({quantity=2,sku='CANONICAL-SKU',vendorSku='DEALER-SKU',status='ordered',supplier=true,issued=true}={}){
  const order=Number(db.prepare('INSERT INTO retail_special_orders(customer_id,invoice_number,invoice_issued_at,status,subtotal_cents,total_cents,tax_bps) VALUES(?,?,?, ?,?,?,0)').run(customer,`PART-RECEIVE-${crypto.randomUUID()}`,issued?'2026-10-26 10:00:00':null,issued?'invoiced':'draft',quantity*1000,quantity*1000).lastInsertRowid);
  const line=Number(db.prepare('INSERT INTO retail_special_lines(retail_order_id,requested_sku,vendor_sku,description,vendor_id,quantity,unit_cost_cents,unit_price_cents,taxable,status) VALUES(?,?,?,?,?,?,500,1000,0,?)').run(order,sku,vendorSku,'Retained supplier part',supplier?vendor:null,quantity,status).lastInsertRowid);
  if(issued)captureRetailReceiptSnapshot(db,order);
  return {order,line};
 }
 const {order,line}=newOrder();
 const route=shopOpsRoutes({db,currentUser:req=>req.user,json:(res,status,body)=>Object.assign(res,{status,body}),readBody:async req=>req.body});
 async function call(path,body,expected=200,{role='owner',method=body===undefined?'GET':'POST'}={}){
  const url=new URL(path,'http://fixture.test'),res={},headers={},target=editRevisionTarget(method,url.pathname,body||{});
  if(target){const revision=db.prepare(`SELECT revision FROM ${target.table} WHERE id=?`).get(target.id);if(revision)headers['if-match']=String(revision.revision);}
  assert.equal(await route({method,body,user:users[role]||null,headers},res,url.pathname,url),true);
  assert.equal(res.status,expected,JSON.stringify(res.body));return res.body;
 }
 const read=async(id=order)=>(await call(`/api/shop/retail-orders/${id}`)).order;
 const receive=(extra={},expected=201,options={})=>call(`/api/shop/retail-orders/${extra.order??order}/lines/${extra.line??line}/receive`,{quantity:1,sku:'CANONICAL-SKU',supplierReference:'PACKING-1/ALLOCATION-1',idempotencyKey:'supplier-partial-receipt-one',...extra},expected,options);
 const status=(value,expected=200,extra={})=>call(`/api/shop/retail-orders/${extra.order??order}/lines/${extra.line??line}/status`,{status:value,supplierReference:'EXTERNAL-ORDER-1',...extra},expected);
 const pay=(id=order,amount='20.00')=>recordPayment(db,'retail',id,users.owner,{method:'cash',amount,verified:true,idempotencyKey:crypto.randomUUID()},()=>({}));
 const onHand=sku=>db.prepare('SELECT COALESCE(SUM(quantity_delta),0) n FROM inventory_adjustments WHERE item_sku=?').get(sku||'CANONICAL-SKU').n;
 const counts=()=>({movements:db.prepare('SELECT COUNT(*) n FROM inventory_adjustments').get().n,receipts:db.prepare('SELECT COUNT(*) n FROM retail_supplier_receipts').get().n});
 return {db,users,customer,vendor,order,line,newOrder,call,read,receive,status,pay,onHand,counts};
}

test('partial supplier receiving reserves exact invoice quantities atomically without adding freely available stock',async t=>{
 const f=fixture(t),first=await f.receive();assert.equal(first.status,'partially_received');
 let order=await f.read();assert.equal(order.lines[0].status,'partially_received');
 assert.equal(order.lines[0].fulfillment.receivedQuantity,1);assert.equal(order.lines[0].fulfillment.fulfilledQuantity,1);assert.equal(order.lines[0].fulfillment.remainingQuantity,1);assert.equal(f.onHand(),0);
 const movement=f.db.prepare('SELECT * FROM inventory_adjustments WHERE id=?').get(first.saleAdjustmentId);
 assert.equal(movement.invoice_scope,'retail');assert.equal(movement.invoice_entity_id,f.order);assert.equal(movement.invoice_line_id,f.line);assert.equal(movement.item_sku,'CANONICAL-SKU');assert.equal(movement.reference_id,order.invoice_number);assert.equal(movement.quantity_delta,-1);
 await f.status('received',409);await f.status('picked_up',409);
 f.pay();await f.status('picked_up',409); // A paid balance cannot bypass partial physical receipt.
 const second=await f.receive({supplierReference:'PACKING-2/ALLOCATION-1',idempotencyKey:'supplier-partial-receipt-two'});
 assert.equal(second.fulfillment.fulfilledQuantity,2);assert.equal(second.fulfillment.remainingQuantity,0);
 order=await f.read();assert.equal(order.lines[0].status,'received');assert.equal(order.status,'ready_for_pickup');assert.equal(f.onHand(),0);
 assert.equal((await f.call('/api/shop/queues')).retailReadyForPickup.length,1);
 await f.status('picked_up');assert.equal((await f.read()).status,'picked_up');assert.equal(f.onHand(),0);assert.deepEqual(f.counts(),{movements:4,receipts:2});
 const replay=await f.receive({},200);assert.deepEqual(replay,{...first,duplicate:true});
 await f.receive({idempotencyKey:'extra-parts-after-pickup',supplierReference:'PACKING-3'},409);
 assert.deepEqual(f.counts(),{movements:4,receipts:2});
 assert.throws(()=>f.db.prepare('UPDATE retail_supplier_receipts SET quantity=99 WHERE id=?').run(first.id),/immutable/);
});

test('receiving enforces staff permission, invoice ownership, retained SKU, positive quantities and exact request identity',async t=>{
 const f=fixture(t);
 for(const role of ['service_writer','technician','viewer','none'])await f.receive({},role==='none'?401:403,{role});
 await f.receive({quantity:0},400);await f.receive({quantity:0.5},400);await f.receive({quantity:3},409);await f.receive({sku:'DEALER-SKU'},409);await f.receive({line:9999},404);
 const other=f.newOrder();await f.receive({order:other.order,line:f.line},404);
 const first=await f.receive({},201,{role:'parts'});assert.equal(f.onHand(),0);
 for(const change of [{quantity:2},{sku:'OTHER'},{supplierReference:'DIFFERENT-PACKING'},{order:other.order,line:other.line}])await f.receive(change,409);
 assert.deepEqual(f.counts(),{movements:2,receipts:1});
 const replay=await f.receive({},200,{role:'manager'});assert.equal(replay.saleAdjustmentId,first.saleAdjustmentId);
 await f.receive({idempotencyKey:'different-key-same-document'},409);
 const before=f.counts();await f.receive({quantity:2,supplierReference:'PACKING-OVER',idempotencyKey:'over-remaining-quantity'},409);assert.deepEqual(f.counts(),before);
});

test('packing allocation references prevent generic/dedicated double receipts while distinct split allocations work',async t=>{
 const f=fixture(t);f.db.prepare("INSERT INTO stock_catalog(sku,description) VALUES('CANONICAL-SKU','Fictional catalog item')").run();
 const po=Number(f.db.prepare('INSERT INTO receiving_orders(supplier_reference,supplier_name,created_by) VALUES(?,?,?)').run('GENERIC-PO','Fictional supplier',f.users.owner.id).lastInsertRowid);
 const poLine=Number(f.db.prepare("INSERT INTO receiving_order_lines(order_id,sku,ordered_quantity) VALUES(?,'CANONICAL-SKU',5)").run(po).lastInsertRowid);
 receiveStock(f.db,f.users.owner,poLine,{quantity:1,reference:'GENERIC-PACKING',idempotencyKey:'generic-receipt-request'});
 assert.equal((await f.read()).lines[0].fulfillment.fulfilledQuantity,0);
 await f.receive({supplierReference:'GENERIC-PACKING',idempotencyKey:'duplicate-generic-packing'},409);
 await f.receive({supplierReference:'SHIPMENT-1/INVOICE-A',idempotencyKey:'shipment-allocation-A'});
 const second=f.newOrder({quantity:1});
 await f.receive({order:second.order,line:second.line,supplierReference:'SHIPMENT-1/INVOICE-A',idempotencyKey:'duplicate-allocation-reference'},409);
 await f.receive({order:second.order,line:second.line,supplierReference:'SHIPMENT-1/INVOICE-B',idempotencyKey:'shipment-allocation-B'});
 assert.equal(f.onHand(),1,'reserved receipts cannot increase unrelated general inventory');
 assert.throws(()=>receiveStock(f.db,f.users.owner,poLine,{quantity:1,reference:'SHIPMENT-1/INVOICE-B',idempotencyKey:'generic-duplicates-allocation'}),error=>error.status===409);
});

test('cancelled/draft invoices and historical status-only fulfillment cannot receive or release invented quantities',async t=>{
 const f=fixture(t);
 const draft=f.newOrder({issued:false});await f.receive({order:draft.order,line:draft.line,idempotencyKey:'draft-receipt-request'},409);
 f.db.prepare("UPDATE retail_special_orders SET invoice_voided_at='2026-10-26',status='cancelled' WHERE id=?").run(f.order);
 await f.receive({},409);await f.status('picked_up',409);
 const legacy=f.newOrder({status:'received'}),snapshot=f.db.prepare('SELECT receipt_snapshot_json FROM retail_special_orders WHERE id=?').get(legacy.order).receipt_snapshot_json;
 installShopOps(f.db);const historical=await f.read(legacy.order);assert.equal(historical.lines[0].fulfillment.requiresReconciliation,true);assert.match(historical.lines[0].fulfillment.reconciliationReason,/historical status/);
 await f.receive({order:legacy.order,line:legacy.line,idempotencyKey:'legacy-status-receive'},409);f.pay(legacy.order);await f.status('picked_up',409,{order:legacy.order,line:legacy.line});
 assert.equal(f.db.prepare('SELECT receipt_snapshot_json FROM retail_special_orders WHERE id=?').get(legacy.order).receipt_snapshot_json,snapshot);
 assert.deepEqual(f.counts(),{movements:0,receipts:0});
});

test('supplier receiving original sale supports scoped returns and pre-pickup returns hold the original release quantity',async t=>{
 const f=fixture(t),received=await f.receive({quantity:2});
 const credit=createCredit(f.db,'retail',f.order,f.users.owner,{invoiceId:f.order,subtotalCents:1000,taxCents:0,reason:'One unused customer part returned',idempotencyKey:'supplier-return-credit'});
 const other=f.newOrder({quantity:1}),wrongCredit=createCredit(f.db,'retail',other.order,f.users.owner,{invoiceId:other.order,subtotalCents:1000,taxCents:0,reason:'Different customer invoice credit',idempotencyKey:'unrelated-return-credit'});
 const input={received:true,quantity:1,saleAdjustmentId:received.saleAdjustmentId,creditNoteId:credit.id,reason:'Unused customer part physically received',disposition:'resellable',idempotencyKey:'supplier-customer-return'};
 assert.throws(()=>receiveCustomerReturn(f.db,'retail',other.order,f.users.owner,{...input,creditNoteId:wrongCredit.id}),error=>error.status===409);
 for(const disposition of ['resellable','damaged'])assert.throws(()=>receiveCustomerReturn(f.db,'retail',f.order,f.users.owner,{...input,disposition,idempotencyKey:'supplier-partial-receipt-one'}),error=>error.status===409);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM accounting_returns').get().n,0);
 const returned=receiveCustomerReturn(f.db,'retail',f.order,f.users.owner,input);assert.equal(returned.sku,'CANONICAL-SKU');assert.equal(f.onHand(),1);
 assert.equal(receiveCustomerReturn(f.db,'retail',f.order,f.users.owner,input).duplicate,true);assert.equal(f.onHand(),1);
 f.pay(f.order,'10.00');const line=(await f.read()).lines[0];assert.equal(line.fulfillment.returnedQuantity,1);assert.equal(line.fulfillment.requiresReconciliation,true);assert.match(line.fulfillment.reconciliationReason,/returned before pickup/);
 const rejected=await f.status('picked_up',409);assert.match(rejected.error,/returned before pickup/);
 await f.receive({idempotencyKey:'no-replacement-quantity',supplierReference:'NEW-SHIPMENT'},409);
});

test('post-pickup returns never restore invoice allocation or allow another pickup or receipt',async t=>{
 const f=fixture(t),received=await f.receive({quantity:2});f.pay();await f.status('picked_up');
 const credit=createCredit(f.db,'retail',f.order,f.users.owner,{invoiceId:f.order,subtotalCents:1000,taxCents:0,reason:'Customer returned one sold part',idempotencyKey:'post-pickup-credit'});
 receiveCustomerReturn(f.db,'retail',f.order,f.users.owner,{received:true,quantity:1,saleAdjustmentId:received.saleAdjustmentId,creditNoteId:credit.id,reason:'Customer brought unused part back',disposition:'resellable',idempotencyKey:'post-pickup-return'});
 const state=(await f.read()).lines[0].fulfillment;assert.equal(state.fulfilledQuantity,2);assert.equal(state.returnedQuantity,1);assert.equal(state.remainingQuantity,0);
 await f.status('picked_up',409);await f.receive({idempotencyKey:'post-pickup-new-receipt',supplierReference:'NEW-SHIPMENT'},409);assert.equal(f.onHand(),1);
});

test('completed or already queued invoice lines cannot re-enter supplier verification or purchasing',async t=>{
 const f=fixture(t);await f.receive({quantity:2});f.pay();await f.status('picked_up');
 await f.call(`/api/shop/retail-orders/${f.order}/lines/${f.line}/verify`,{available:true,fitment:true},409);
 f.db.prepare("UPDATE retail_special_lines SET status='verified' WHERE id=?").run(f.line);
 assert.equal((await f.call('/api/shop/retail-carts')).carts.find(row=>row.id===f.vendor).items.length,0);
 await f.call(`/api/shop/retail-carts/${f.vendor}/queue`,{confirmText:'ORDER SUPPLIER-TEST',lines:[{id:f.line,sku:'DEALER-SKU',quantity:2,unitCostCents:500,confirmed:true}]},409);
 const queued=f.newOrder({status:'queued'});await f.call(`/api/shop/retail-orders/${queued.order}/lines/${queued.line}/verify`,{available:true,fitment:true},409);
 f.db.prepare('INSERT INTO retail_purchase_commands(command_uuid,vendor_id,snapshot_json,snapshot_sha256) VALUES(?,?,?,?)').run('retained-purchase-command',f.vendor,JSON.stringify({lines:[{lineId:queued.line}]}),'fictional-digest');
 f.db.prepare("UPDATE retail_special_lines SET status='verified' WHERE id=?").run(queued.line);
 await f.call(`/api/shop/retail-orders/${queued.order}/lines/${queued.line}/verify`,{available:true,fitment:true},409);
 assert.equal((await f.call('/api/shop/retail-carts')).carts.find(row=>row.id===f.vendor).items.length,0);
});

test('receiving and pickup audit failures roll back quantities, statuses and every stock movement',async t=>{
 const f=fixture(t);f.db.exec("CREATE TRIGGER fail_supplier_receiving BEFORE INSERT ON audit_log WHEN NEW.action='Retail supplier parts physically received' BEGIN SELECT RAISE(ABORT,'Injected supplier receiving audit failure'); END;");
 await f.receive({quantity:2},400);assert.deepEqual(f.counts(),{movements:0,receipts:0});assert.equal((await f.read()).lines[0].status,'ordered');assert.equal((await f.read()).status,'invoiced');
 f.db.exec('DROP TRIGGER fail_supplier_receiving');await f.receive({quantity:2});f.pay();
 f.db.exec("CREATE TRIGGER fail_supplier_pickup BEFORE INSERT ON audit_log WHEN NEW.action='Retail line fulfilled' BEGIN SELECT RAISE(ABORT,'Injected supplier pickup audit failure'); END;");
 await f.status('picked_up',400);assert.equal((await f.read()).lines[0].status,'received');assert.equal((await f.read()).status,'ready_for_pickup');assert.equal(f.onHand(),0);assert.deepEqual(f.counts(),{movements:2,receipts:1});
});

test('a partial supplier receipt blocks unpaid cancellation without changing charges or retained stock',async t=>{
 const f=fixture(t);await f.receive();const before=f.counts();
 assert.throws(()=>cancelInvoice(f.db,'retail',f.order,f.users.owner,{reason:'Customer changed order after receiving',idempotencyKey:'cancel-after-partial-receipt'}),error=>error.status===409);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM accounting_credits').get().n,0);assert.deepEqual(f.counts(),before);
 assert.equal((await f.read()).lines[0].status,'partially_received');assert.equal((await f.read()).invoice_voided_at,null);
});

test('invoice-linked stock allocation can fulfill supplier or on-hand lines without another receipt or pickup stock issue',async t=>{
 const f=fixture(t),stock=f.newOrder({supplier:false,status:'needs_source'});
 await f.call('/api/shop/inventory-adjustments',{sku:'CANONICAL-SKU',quantityDelta:5,reason:'cycle_count',referenceType:'count',referenceId:'FICTIONAL-COUNT',idempotencyKey:'opening-stock-count'},201);
 for(const row of [{order:f.order,line:f.line},stock]){
  const invoice=await f.read(row.order);
  await f.call('/api/shop/inventory-adjustments',{sku:'CANONICAL-SKU',quantityDelta:-2,reason:'sold',referenceType:'invoice',referenceId:invoice.invoice_number,invoiceScope:'retail',invoiceLineId:row.line,idempotencyKey:`exact-issue-${row.order}`},201);
  const state=(await f.read(row.order)).lines[0].fulfillment;assert.equal(state.fulfilledQuantity,2);assert.equal(state.receivedQuantity,0);assert.equal(state.remainingQuantity,0);assert.equal(state.requiresReconciliation,false);
  f.pay(row.order);await f.status('picked_up',200,row);
 }
 assert.equal(f.onHand(),1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM retail_supplier_receipts').get().n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM inventory_adjustments WHERE reason='sold'").get().n,2);
});

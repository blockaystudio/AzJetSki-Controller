import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {openDb} from '../src/db.mjs';
import {extendDatabase} from '../src/pos-extension.mjs';
import {installShopOps,shopOpsRoutes} from '../src/shop-ops.mjs';
import {installShopManagement,receiveStock} from '../src/shop-management.mjs';
import {installCheckout} from '../src/payment-docs.mjs';
import {installAccounting,createCredit,receiveCustomerReturn} from '../src/accounting.mjs';
import {captureRetailReceiptSnapshot} from '../src/receipts.mjs';
import {shopDashboardReport} from '../src/shop-reports.mjs';
import {installEditRevisions,editRevisionTarget} from '../src/edit-revisions.mjs';

function fixture(t){
  const db=openDb(':memory:');extendDatabase(db);installShopOps(db);installShopManagement(db);installCheckout(db);installAccounting(db);installEditRevisions(db);t.after(()=>db.close());
  const owner={id:Number(db.prepare("INSERT INTO users(username,password_hash,salt,role) VALUES('stock-owner','test','test','owner')").run().lastInsertRowid),username:'stock-owner',role:'owner'};
  const parts={id:Number(db.prepare("INSERT INTO users(username,password_hash,salt,role) VALUES('stock-parts','test','test','parts')").run().lastInsertRowid),username:'stock-parts',role:'parts'};
  const customer=Number(db.prepare("INSERT INTO customers(name,email) VALUES('Stock customer','stock@example.test')").run().lastInsertRowid);
  const vehicle=Number(db.prepare("INSERT INTO vehicles(customer_id,make,model) VALUES(?,'Test','Unit')").run(customer).lastInsertRowid);
  const repair=Number(db.prepare("INSERT INTO work_orders(source,customer_id,vehicle_id,ref_number,customer_name,stage,estimate_total,balance,date_opened) VALUES('manual',?,?,'STOCK-REPAIR','Stock customer','Ready',10,10,datetime('now','-3 days'))").run(customer,vehicle).lastInsertRowid);
  const repairLine=Number(db.prepare("INSERT INTO work_order_lines(work_order_id,line_type,item_ref,description,qty,rate,amount) VALUES(?,'part','BELT-1','Repair drive belt',2,5,10)").run(repair).lastInsertRowid);
  const repairSnapshot=JSON.stringify({estimateCents:1000,taxCents:0,items:[{id:repairLine,line_type:'part',item_ref:'BELT-1',description:'Repair drive belt',qty:2,rate:5,amount:10}]});
  const repairInvoice=Number(db.prepare("INSERT INTO ot_invoices(work_order_id,number,token_hash,amount_cents,valid_until,recipient_name,snapshot_json) VALUES(?,'INV-STOCK',?,1000,'2099-01-01','Stock customer',?)").run(repair,crypto.randomUUID(),repairSnapshot).lastInsertRowid);
  const retail=Number(db.prepare("INSERT INTO retail_special_orders(customer_id,invoice_number,invoice_issued_at,subtotal_cents,total_cents,status) VALUES(?,'PART-STOCK',CURRENT_TIMESTAMP,1000,1000,'invoiced')").run(customer).lastInsertRowid);
  const retailLine=Number(db.prepare("INSERT INTO retail_special_lines(retail_order_id,requested_sku,description,quantity,unit_price_cents) VALUES(?,'BELT-1','Counter drive belt',2,500)").run(retail).lastInsertRowid);
  captureRetailReceiptSnapshot(db,retail);
  db.prepare("INSERT INTO stock_catalog(sku,description) VALUES('BELT-1','Drive belt')").run();
  const po=Number(db.prepare("INSERT INTO receiving_orders(supplier_reference,supplier_name,created_by) VALUES('PO-STOCK','Dealer',?)").run(owner.id).lastInsertRowid);
  const receivingLine=Number(db.prepare("INSERT INTO receiving_order_lines(order_id,sku,ordered_quantity) VALUES(?,'BELT-1',10)").run(po).lastInsertRowid);
  const route=shopOpsRoutes({db,currentUser:req=>req.user,json:(res,status,body)=>{res.status=status;res.body=body;},readBody:async req=>req.body});
  async function call(path,body={},status=200,user=owner,method='POST'){
    const url=new URL('http://test'+path),res={},target=editRevisionTarget(method,url.pathname,body),headers={};if(target){const row=db.prepare(`SELECT revision FROM ${target.table} WHERE id=?`).get(target.id);if(row)headers['if-match']=String(row.revision);}assert.equal(await route({method,body,user,headers},res,url.pathname,url),true);assert.equal(res.status,status,JSON.stringify(res.body));return res.body;
  }
  const adjust=(body,status=201,user=owner)=>call('/api/shop/inventory-adjustments',body,status,user);
  const receive=(overrides={},status=201)=>adjust({sku:'BELT-1',quantityDelta:10,reason:'received',referenceType:'supplier_order',referenceId:'PACKING-STOCK',receivingLineId:receivingLine,idempotencyKey:'stock-receipt-key',...overrides},status);
  const sale=(scope,overrides={},status=201)=>adjust({sku:'BELT-1',quantityDelta:-1,reason:'sold',referenceType:'invoice',referenceId:scope==='repair'?'INV-STOCK':'PART-STOCK',invoiceScope:scope,invoiceLineId:scope==='repair'?repairLine:retailLine,idempotencyKey:crypto.randomUUID(),...overrides},status);
  const onHand=()=>db.prepare("SELECT COALESCE(SUM(quantity_delta),0) n FROM inventory_adjustments WHERE item_sku='BELT-1'").get().n;
  return {db,owner,parts,customer,vehicle,repair,repairLine,repairInvoice,repairSnapshot,retail,retailLine,receivingLine,call,adjust,receive,sale,onHand};
}

test('legacy receiving endpoint shares one exact idempotent movement with Management and rejects unlinked/duplicate documents',async t=>{
  const f=fixture(t);
  await f.receive({idempotencyKey:undefined},400);
  await f.receive({receivingLineId:undefined},409);
  await f.receive({sku:'UNRELATED-SKU'},409);
  assert.equal(f.onHand(),0);
  const first=await f.receive({quantityDelta:3});
  const retry=await f.receive({quantityDelta:3},200);
  assert.equal(retry.id,first.id);assert.equal(retry.inventoryAdjustmentId,first.inventoryAdjustmentId);assert.equal(retry.duplicate,true);
  const alias=receiveStock(f.db,f.owner,f.receivingLine,{quantity:3,reference:'PACKING-STOCK',idempotencyKey:'stock-receipt-key'});
  assert.equal(alias.duplicate,true);assert.equal(alias.inventoryAdjustmentId,first.inventoryAdjustmentId);assert.equal(f.onHand(),3);
  await f.receive({quantityDelta:2},409);
  await f.receive({quantityDelta:3,idempotencyKey:'different-key-same-receipt'},409);
  await f.receive({quantityDelta:8,referenceId:'PACKING-EXCESS',idempotencyKey:'receipt-exceeds-po'},409);
  assert.equal(f.db.prepare('SELECT received_quantity FROM receiving_order_lines').get().received_quantity,3);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stock_operations').get().n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM inventory_adjustments').get().n,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='Stock physically received'").get().n,1);
});

test('both repair and counter stock issues require exact invoice lines, cap cumulative quantity, and replay after state changes',async t=>{
  const f=fixture(t);await f.receive();
  for(const scope of ['repair','retail']){
    const before=f.onHand();
    await f.sale(scope,{sku:'UNRELATED-SKU'},409);
    await f.sale(scope,{invoiceLineId:9999},409);
    await f.sale(scope,{invoiceScope:scope==='repair'?'retail':'repair'},409);
    await f.sale(scope,{invoiceLineId:undefined},400);
    await f.sale(scope,{quantityDelta:-3},409);
    assert.equal(f.onHand(),before);
    const key=`${scope}-sale-once-key`,first=await f.sale(scope,{idempotencyKey:key});
    const again=await f.sale(scope,{idempotencyKey:key},200);assert.equal(again.id,first.id);assert.equal(again.duplicate,true);
    await f.sale(scope,{idempotencyKey:key,quantityDelta:-2},409);
    await f.sale(scope);
    await f.sale(scope,{},409);
    assert.equal(f.onHand(),before-2);
    if(scope==='repair'){
      f.db.prepare('UPDATE ot_invoices SET voided_at=CURRENT_TIMESTAMP WHERE id=?').run(f.repairInvoice);
      assert.equal((await f.sale(scope,{idempotencyKey:key},200)).id,first.id);
      f.db.prepare("INSERT INTO ot_invoices(work_order_id,number,token_hash,amount_cents,valid_until,recipient_name,snapshot_json) VALUES(?,'INV-REISSUED-STOCK',?,1000,'2099-01-01','Stock customer',?)").run(f.repair,crypto.randomUUID(),f.repairSnapshot);
      await f.sale(scope,{referenceId:'INV-REISSUED-STOCK'},409);
    }
  }
  assert.equal(f.db.prepare('SELECT status FROM retail_special_lines WHERE id=?').get(f.retailLine).status,'received');
  assert.equal(f.db.prepare('SELECT status FROM retail_special_orders WHERE id=?').get(f.retail).status,'ready_for_pickup');
  const selection=await f.call('/api/shop/inventory-invoice-lines?scope=retail&invoice=PART-STOCK',{},200,f.parts,'GET');
  assert.equal(selection.lines[0].remainingQuantity,0);assert.equal(selection.lines[0].issuedQuantity,2);
  await f.call(`/api/shop/retail-orders/${f.retail}/lines/${f.retailLine}/status`,{status:'picked_up'},409);
  f.db.prepare("INSERT INTO retail_payments(retail_order_id,method,direction,amount_cents,status,idempotency_key,recorded_by) VALUES(?,'cash','payment',1000,'confirmed','retail-final-cash',?)").run(f.retail,f.owner.id);
  await f.call(`/api/shop/retail-orders/${f.retail}/lines/${f.retailLine}/status`,{status:'picked_up'});
  assert.equal(f.onHand(),6);
});

test('stock limits and global operation keys roll back counts, sales and supplier returns without side effects',async t=>{
  const f=fixture(t);await f.receive({quantityDelta:1});
  await f.sale('retail',{quantityDelta:-2},409);assert.equal(f.onHand(),1);
  await f.adjust({sku:'BELT-1',quantityDelta:-1,reason:'damage',referenceType:'damage_report',referenceId:'DAMAGE-1',idempotencyKey:'damage-forbidden-role'},403,f.parts);
  await f.adjust({sku:'BELT-1',quantityDelta:1,reason:'damage',referenceType:'damage_report',referenceId:'DAMAGE-1',idempotencyKey:'damage-positive-key'},409);
  await f.sale('repair',{idempotencyKey:'stock-receipt-key'},409);
  const damage={sku:'BELT-1',quantityDelta:-1,reason:'damage',referenceType:'damage_report',referenceId:'DAMAGE-1',idempotencyKey:'damage-exact-key'};
  const first=await f.adjust(damage);assert.equal((await f.adjust(damage,200)).id,first.id);assert.equal(f.onHand(),0);
  assert.throws(()=>receiveStock(f.db,f.owner,f.receivingLine,{quantity:1,reference:'PACKING-SECOND',idempotencyKey:'damage-exact-key'}),error=>error.status===409);
  assert.throws(()=>receiveStock(f.db,f.owner,f.receivingLine,{operation:'return',quantity:1,reference:'SUPPLIER-RETURN',reason:'Wrong part sent',idempotencyKey:'supplier-return-negative'}),error=>error.status===409);
  assert.equal(f.db.prepare('SELECT received_quantity,returned_quantity FROM receiving_order_lines').get().received_quantity,1);
  assert.equal(f.db.prepare('SELECT returned_quantity FROM receiving_order_lines').get().returned_quantity,0);
  assert.throws(()=>f.db.prepare('DELETE FROM inventory_adjustments WHERE id=?').run(first.id),/immutable/);
});

test('superseded invoices reject new issues and revised quantities share the underlying repair line allocation',async t=>{
  const f=fixture(t);await f.receive();
  const key='before-revision-sale',first=await f.sale('repair',{idempotencyKey:key});
  const revisedSnapshot=JSON.parse(f.repairSnapshot);revisedSnapshot.items[0].qty=1;
  const revision=Number(f.db.prepare("INSERT INTO ot_invoices(work_order_id,number,token_hash,amount_cents,valid_until,recipient_name,snapshot_json,supersedes_invoice_id,document_kind) VALUES(?,'INV-STOCK-REVISION',?,500,'2099-01-01','Stock customer',?,?,'revised_invoice')").run(f.repair,crypto.randomUUID(),JSON.stringify(revisedSnapshot),f.repairInvoice).lastInsertRowid);
  f.db.prepare('UPDATE ot_invoices SET superseded_by=? WHERE id=?').run(revision,f.repairInvoice);
  await f.sale('repair',{},409);
  await f.sale('repair',{referenceId:'INV-STOCK-REVISION'},409);
  assert.equal((await f.sale('repair',{idempotencyKey:key},200)).id,first.id);
  await f.call('/api/shop/inventory-invoice-lines?scope=repair&invoice=INV-STOCK',{},409,f.owner,'GET');
  assert.equal(f.onHand(),9);
});

test('unattributed historical issues and receipts cannot be issued again through new ledgers',async t=>{
  const f=fixture(t);
  f.db.prepare("INSERT INTO inventory_adjustments(item_sku,quantity_delta,reason,reference_type,reference_id,actor_id) VALUES('BELT-1',5,'received','supplier_order','LEGACY-RECEIPT',?)").run(f.owner.id);
  await f.receive({quantityDelta:5,referenceId:'LEGACY-RECEIPT'},409);
  f.db.prepare("INSERT INTO inventory_adjustments(item_sku,quantity_delta,reason,reference_type,reference_id,actor_id) VALUES('BELT-1',-1,'sold','invoice','INV-STOCK',?)").run(f.owner.id);
  await f.sale('repair',{},409);
  assert.equal(f.onHand(),4);
  f.db.prepare("INSERT INTO ot_invoices(work_order_id,number,token_hash,amount_cents,valid_until,recipient_name,snapshot_json) VALUES(?,'INV-WITHOUT-LINE-ID',?,1000,'2099-01-01','Stock customer',?)").run(f.repair,crypto.randomUUID(),JSON.stringify({items:[{line_type:'part',item_ref:'BELT-1',qty:2}]}));
  await f.sale('repair',{referenceId:'INV-WITHOUT-LINE-ID'},409);
});

test('customer return restocks exactly once and never restores the original invoice quantity for a second sale',async t=>{
  const f=fixture(t);await f.receive();
  const sale=await f.sale('retail',{quantityDelta:-2});
  const credit=createCredit(f.db,'retail',f.retail,f.owner,{invoiceId:f.retail,subtotalCents:1000,taxCents:0,reason:'Customer returned drive belts',idempotencyKey:'customer-stock-credit'});
  const input={received:true,quantity:1,saleAdjustmentId:sale.id,creditNoteId:credit.id,reason:'Unused belt physically returned',disposition:'resellable',idempotencyKey:'customer-return-stock'};
  assert.throws(()=>receiveCustomerReturn(f.db,'retail',f.retail,f.owner,{...input,disposition:'damaged',idempotencyKey:sale.idempotency_key}),error=>error.status===409);
  const result=receiveCustomerReturn(f.db,'retail',f.retail,f.owner,input);
  assert.equal(receiveCustomerReturn(f.db,'retail',f.retail,f.owner,input).duplicate,true);assert.equal(f.onHand(),9);
  await f.sale('retail',{},409);
  await f.adjust({sku:'BELT-1',quantityDelta:1,reason:'cycle_count',referenceType:'count',referenceId:'COUNT-1',idempotencyKey:input.idempotencyKey},409);
  assert.equal(f.db.prepare('SELECT idempotency_key FROM inventory_adjustments WHERE id=?').get(result.inventory_adjustment_id).idempotency_key,input.idempotencyKey);
});

test('failed audit writes roll stock, receiving counters and retail fulfillment back together',async t=>{
  const f=fixture(t);
  f.db.exec("CREATE TRIGGER fail_stock_audit BEFORE INSERT ON audit_log WHEN NEW.action='Stock physically received' BEGIN SELECT RAISE(ABORT,'Test receiving rollback'); END;");
  await f.receive({},400);
  assert.equal(f.onHand(),0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stock_operations').get().n,0);assert.equal(f.db.prepare('SELECT received_quantity FROM receiving_order_lines').get().received_quantity,0);
  f.db.exec('DROP TRIGGER fail_stock_audit');
  await f.receive();
  f.db.exec("CREATE TRIGGER fail_stock_audit BEFORE INSERT ON audit_log WHEN NEW.action='Inventory adjustment' BEGIN SELECT RAISE(ABORT,'Test sale rollback'); END;");
  await f.sale('retail',{quantityDelta:-2},400);
  assert.equal(f.onHand(),10);assert.equal(f.db.prepare('SELECT status FROM retail_special_lines WHERE id=?').get(f.retailLine).status,'needs_source');assert.equal(f.db.prepare('SELECT status FROM retail_special_orders WHERE id=?').get(f.retail).status,'invoiced');
});

test('official vehicle pickup records completion with custody atomically and appears in cycle reporting',async t=>{
  const f=fixture(t);
  const historical=Number(f.db.prepare("INSERT INTO work_orders(source,ref_number,stage) VALUES('manual','HISTORICAL-CLOSED','Closed')").run().lastInsertRowid);
  installShopOps(f.db);
  assert.equal(f.db.prepare('SELECT date_closed FROM work_orders WHERE id=?').get(historical).date_closed,null);
  await f.call(`/api/shop/vehicles/${f.vehicle}/check-in`,{workOrderId:f.repair});
  await f.call(`/api/shop/vehicles/${f.vehicle}/check-out`,{},409);
  assert.equal(f.db.prepare('SELECT date_closed FROM work_orders WHERE id=?').get(f.repair).date_closed,null);
  f.db.prepare("INSERT INTO pos_payments(work_order_id,method,direction,amount_cents,status,idempotency_key,verified_by) VALUES(?,'cash','payment',1000,'confirmed','repair-pickup-cash',?)").run(f.repair,f.owner.id);
  f.db.exec("CREATE TRIGGER fail_pickup_audit BEFORE INSERT ON audit_log WHEN NEW.action='Vehicle checked out' BEGIN SELECT RAISE(ABORT,'Test atomic rollback'); END;");
  await f.call(`/api/shop/vehicles/${f.vehicle}/check-out`,{},400);
  assert.equal(f.db.prepare('SELECT stage,date_closed FROM work_orders WHERE id=?').get(f.repair).stage,'Ready');
  assert.equal(f.db.prepare('SELECT date_closed FROM work_orders WHERE id=?').get(f.repair).date_closed,null);
  assert.equal(f.db.prepare('SELECT status FROM unit_custody WHERE vehicle_id=?').get(f.vehicle).status,'in_lot');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM custody_events WHERE action='check_out'").get().n,0);
  f.db.exec('DROP TRIGGER fail_pickup_audit');
  await f.call(`/api/shop/vehicles/${f.vehicle}/check-out`);
  const result=f.db.prepare('SELECT stage,date_closed FROM work_orders WHERE id=?').get(f.repair);
  assert.equal(result.stage,'Picked Up');assert.ok(result.date_closed);
  assert.equal(f.db.prepare('SELECT checked_out_at FROM unit_custody WHERE vehicle_id=?').get(f.vehicle).checked_out_at,result.date_closed);
  await f.call(`/api/shop/vehicles/${f.vehicle}/check-out`,{},409);
  assert.equal(f.db.prepare('SELECT date_closed FROM work_orders WHERE id=?').get(f.repair).date_closed,result.date_closed);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Phoenix',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const report=shopDashboardReport(f.db,{from:today,to:today});
  assert.equal(report.workOrders.completed,1);assert.equal(report.workOrders.completedMissingDates,1);assert.ok(report.workOrders.averageCompletedCycleDays>=2.9);
});

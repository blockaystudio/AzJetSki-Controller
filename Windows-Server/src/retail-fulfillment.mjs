import crypto from 'node:crypto';
import {appendStockMovement,stockRequestKey,retailLineFulfillment,syncRetailFulfillment} from './inventory-movements.mjs';

const fail=(status,message)=>{const error=new Error(message);error.status=status;throw error;};
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=(value,label,max)=>{const result=String(value??'').trim();if(!result||result.length>max)fail(400,`${label} is required and must be at most ${max} characters`);return result;};

// Supplier parts belong to the customer immediately on physical receipt. Record
// a positive receipt and an equal invoice-linked sale in one write transaction:
// reserved parts never inflate freely available stock and pickup never issues a
// second sale. Each partial shipment/allocation has its own retained identity.
export function receiveRetailParts(db,user,orderId,lineId,input){
  if(!user||!['owner','manager','advisor','parts'].includes(user.role))fail(403,'Retail receiving permission required');
  const key=stockRequestKey(input),quantity=Number(input.quantity),sku=text(input.sku,'Exact invoice SKU',100),reference=text(input.supplierReference,'Packing / allocation reference',180);
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>100000)fail(400,'Received quantity must be a positive integer within 100000');
  const normalized={orderId,lineId,quantity,sku,supplierReference:reference},fingerprint=digest(normalized);
  db.exec('BEGIN IMMEDIATE');
  try{
    const prior=db.prepare('SELECT * FROM retail_supplier_receipts WHERE idempotency_key=?').get(key);
    if(prior){if(prior.request_fingerprint!==fingerprint)fail(409,'Receiving key was used with different invoice, line, SKU, quantity or reference');db.exec('COMMIT');return {...JSON.parse(prior.response_json),duplicate:true};}
    for(const table of ['inventory_adjustments','stock_operations','accounting_returns']){
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)&&db.prepare(`SELECT 1 FROM ${table} WHERE idempotency_key=?`).get(key))fail(409,'Receiving key already belongs to another stock operation');
    }
    const order=db.prepare('SELECT * FROM retail_special_orders WHERE id=?').get(orderId),line=db.prepare('SELECT * FROM retail_special_lines WHERE id=? AND retail_order_id=?').get(lineId,orderId);
    if(!order||!line)fail(404,'Retail invoice line not found on this order');
    if(!order.invoice_issued_at||order.invoice_voided_at||order.status==='cancelled')fail(409,'Receive only against an active issued retail invoice');
    if(!line.vendor_id)fail(409,'Use an invoice-linked on-hand stock issue for this counter-sale line');
    const state=retailLineFulfillment(db,order,line);
    if(state.requiresReconciliation)fail(409,state.reconciliationReason||'Historical receiving or fulfillment lacks exact invoice-line stock records; reconcile the original documents before receiving or pickup');
    if(!['ordered','backordered','shipped','partially_received'].includes(line.status))fail(409,'Record the confirmed supplier order before receiving; completed or cancelled lines cannot receive again');
    if(sku!==state.sku)fail(409,'Received SKU must match the exact retained invoice line SKU');
    if(quantity>state.remainingQuantity)fail(409,'Received quantity exceeds the invoice line remaining unfulfilled quantity');
    if(db.prepare("SELECT 1 FROM inventory_adjustments WHERE item_sku=? AND reason='received' AND reference_type='supplier_order' AND reference_id=? LIMIT 1").get(sku,reference))fail(409,'This packing/allocation reference and SKU were already received. Reconcile the recorded receipt, or use a distinct documented allocation reference for another customer invoice.');
    const identity=digest({key}),received=appendStockMovement(db,user,{sku,quantityDelta:quantity,reason:'received',referenceType:'supplier_order',referenceId:reference,invoiceScope:'retail',invoiceEntityId:orderId,invoiceLineId:lineId,idempotencyKey:`retail-receive-${identity}`,source:'retail_supplier_receipt',details:normalized});
    const sold=appendStockMovement(db,user,{sku,quantityDelta:-quantity,reason:'sold',referenceType:'invoice',referenceId:order.invoice_number,invoiceScope:'retail',invoiceEntityId:orderId,invoiceLineId:lineId,idempotencyKey:`retail-allocate-${identity}`,source:'retail_supplier_receipt',details:normalized});
    const id=db.prepare('SELECT COALESCE(MAX(id),0)+1 id FROM retail_supplier_receipts').get().id;
    const fulfillment={...state,receivedQuantity:state.receivedQuantity+quantity,fulfilledQuantity:state.fulfilledQuantity+quantity,remainingQuantity:state.remainingQuantity-quantity};
    const response={id,invoiceId:orderId,invoiceLineId:lineId,invoiceNumber:order.invoice_number,sku,quantity,supplierReference:reference,receivedMovementId:received.id,saleAdjustmentId:sold.id,status:fulfillment.remainingQuantity?'partially_received':'received',fulfillment};
    db.prepare(`INSERT INTO retail_supplier_receipts(id,retail_order_id,invoice_line_id,invoice_number,sku,quantity,supplier_reference,received_movement_id,sale_adjustment_id,actor_id,actor_username,actor_role,idempotency_key,request_fingerprint,response_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,orderId,lineId,order.invoice_number,sku,quantity,reference,received.id,sold.id,user.id,user.username,user.role,key,fingerprint,JSON.stringify(response));
    syncRetailFulfillment(db,orderId);
    db.prepare('INSERT INTO audit_log(actor,action,detail) VALUES(?,?,?)').run(user.username,'Retail supplier parts physically received',JSON.stringify({receiptId:id,invoiceId:orderId,invoiceLineId:lineId,sku,quantity,supplierReference:reference,receivedMovementId:received.id,saleAdjustmentId:sold.id}));
    db.exec('COMMIT');return response;
  }catch(error){db.exec('ROLLBACK');throw error;}
}

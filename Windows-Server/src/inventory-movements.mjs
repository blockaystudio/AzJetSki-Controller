import crypto from 'node:crypto';

const fail=(status,message)=>{const error=new Error(message);error.status=status;throw error;};
const has=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const text=(value,label,max=180)=>{const result=String(value??'').trim();if(!result||result.length>max)fail(400,`${label} is required and must be at most ${max} characters`);return result;};
export const stockRequestKey=input=>{const key=text(input.idempotencyKey??input.idempotency_key,'Idempotency key',140);if(key.length<8)fail(400,'An idempotency key of at least eight characters is required');return key;};
const integer=(value,label)=>{const result=Number(value);if(!Number.isSafeInteger(result)||result<1)fail(400,`${label} must be a positive integer`);return result;};

export function installInventoryMovements(db){
  const columns=new Set(db.prepare('PRAGMA table_info(inventory_adjustments)').all().map(row=>row.name));
  for(const [name,type] of [['idempotency_key','TEXT'],['request_fingerprint','TEXT'],['invoice_scope','TEXT'],['invoice_entity_id','INTEGER'],['invoice_line_id','INTEGER'],['receiving_line_id','INTEGER']]){
    if(!columns.has(name))db.exec(`ALTER TABLE inventory_adjustments ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS inventory_adjustment_request_key ON inventory_adjustments(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS inventory_adjustment_invoice_line ON inventory_adjustments(invoice_scope,invoice_entity_id,invoice_line_id);
    CREATE TRIGGER IF NOT EXISTS inventory_adjustments_no_update BEFORE UPDATE ON inventory_adjustments BEGIN SELECT RAISE(ABORT,'Stock movements are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS inventory_adjustments_no_delete BEFORE DELETE ON inventory_adjustments BEGIN SELECT RAISE(ABORT,'Stock movements are immutable'); END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS retail_supplier_receipts(
    id INTEGER PRIMARY KEY,retail_order_id INTEGER NOT NULL,invoice_line_id INTEGER NOT NULL,
    invoice_number TEXT NOT NULL,sku TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>0),
    supplier_reference TEXT NOT NULL,received_movement_id INTEGER NOT NULL REFERENCES inventory_adjustments(id),
    sale_adjustment_id INTEGER NOT NULL REFERENCES inventory_adjustments(id),actor_id INTEGER NOT NULL,
    actor_username TEXT NOT NULL,actor_role TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,
    request_fingerprint TEXT NOT NULL,response_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS retail_supplier_receipt_line ON retail_supplier_receipts(retail_order_id,invoice_line_id);
    CREATE TRIGGER IF NOT EXISTS retail_supplier_receipts_no_update BEFORE UPDATE ON retail_supplier_receipts BEGIN SELECT RAISE(ABORT,'Retail receiving history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS retail_supplier_receipts_no_delete BEFORE DELETE ON retail_supplier_receipts BEGIN SELECT RAISE(ABORT,'Retail receiving history is immutable'); END;`);
}

function normalizedMovement(input){
  const quantityDelta=Number(input.quantityDelta);
  if(!Number.isSafeInteger(quantityDelta)||quantityDelta===0||Math.abs(quantityDelta)>100000)fail(400,'Signed stock quantity must be a nonzero integer within 100000');
  return {sku:text(input.sku,'SKU',100),quantityDelta,reason:text(input.reason,'Stock reason',40),referenceType:text(input.referenceType,'Reference type',40),referenceId:text(input.referenceId,'Documented reference'),
    invoiceScope:input.invoiceScope??null,invoiceEntityId:input.invoiceEntityId??null,invoiceLineId:input.invoiceLineId??null,receivingLineId:input.receivingLineId??null,
    source:input.source??'adjustment',details:input.details??null};
}
const fingerprint=input=>crypto.createHash('sha256').update(JSON.stringify(normalizedMovement(input))).digest('hex');
export function priorStockMovement(db,input){
  const key=stockRequestKey(input),prior=db.prepare('SELECT * FROM inventory_adjustments WHERE idempotency_key=?').get(key);
  if(prior){if(prior.request_fingerprint!==fingerprint(input))fail(409,'Stock key reused with different details');return {...prior,duplicate:true};}
  for(const table of ['stock_operations','accounting_returns','retail_supplier_receipts'])if(has(db,table)&&db.prepare(`SELECT 1 FROM ${table} WHERE idempotency_key=?`).get(key))fail(409,'Stock key already belongs to another recorded operation');
  return null;
}

// Call inside the caller's BEGIN IMMEDIATE transaction: quantity checks, parent
// state, movement, and audit must commit or roll back together.
export function appendStockMovement(db,user,input){
  const prior=priorStockMovement(db,input);if(prior)return prior;
  const data=normalizedMovement(input),key=stockRequestKey(input);
  const available=db.prepare('SELECT COALESCE(SUM(quantity_delta),0) quantity FROM inventory_adjustments WHERE item_sku=?').get(data.sku).quantity;
  if(data.quantityDelta<0&&available+data.quantityDelta<0)fail(409,'Inventory cannot go negative; investigate missing stock first');
  if(data.receivingLineId&&db.prepare('SELECT 1 FROM inventory_adjustments WHERE item_sku=? AND reason=? AND reference_type=? AND reference_id=?').get(data.sku,data.reason,data.referenceType,data.referenceId))fail(409,'This supplier document and SKU already have a stock movement; reconcile it before receiving again');
  const row=db.prepare(`INSERT INTO inventory_adjustments(item_sku,quantity_delta,reason,reference_type,reference_id,actor_id,idempotency_key,request_fingerprint,invoice_scope,invoice_entity_id,invoice_line_id,receiving_line_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(data.sku,data.quantityDelta,data.reason,data.referenceType,data.referenceId,user.id,key,fingerprint(input),data.invoiceScope,data.invoiceEntityId,data.invoiceLineId,data.receivingLineId);
  return db.prepare('SELECT * FROM inventory_adjustments WHERE id=?').get(Number(row.lastInsertRowid));
}

export function inventoryInvoiceLines(db,scope,number){
  if(!['repair','retail'].includes(scope))fail(400,'Choose repair or retail invoice scope');
  number=text(number,'Invoice number',100);
  const invoice=scope==='repair'?db.prepare('SELECT * FROM ot_invoices WHERE number=? AND voided_at IS NULL').get(number):db.prepare('SELECT * FROM retail_special_orders WHERE invoice_number=? AND invoice_issued_at IS NOT NULL').get(number);
  if(!invoice||invoice.invoice_voided_at||invoice.status==='cancelled')fail(409,'Inventory sale requires an active issued invoice');
  if(invoice.superseded_by)fail(409,'Use the current revised invoice for new stock issues');
  let snapshot;try{snapshot=JSON.parse(scope==='repair'?invoice.snapshot_json:invoice.receipt_snapshot_json);}catch{fail(409,'Invoice has no retained stock line details; review it before issuing stock');}
  if(!Array.isArray(snapshot?.items))fail(409,'Invoice has no retained stock line details; review it before issuing stock');
  const entityId=scope==='repair'?invoice.work_order_id:invoice.id;
  const lines=snapshot.items.filter(item=>scope!=='repair'||item.line_type==='part').map(item=>{
    const sku=String(scope==='repair'?item.item_ref:(item.requested_sku||item.vendor_sku)||'').trim(),quantity=Number(scope==='repair'?item.qty:item.quantity),id=Number(item.id);
    if(!sku)return null;
    if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(quantity)||quantity<1)fail(409,'This invoice predates retained stock line IDs or has noninteger quantities; review before issuing stock');
    // Old movements have no exact line attribution; do not guess which line or
    // reissued invoice they fulfilled and allow the same parts to leave twice.
    const legacy=scope==='repair'?db.prepare(`SELECT 1 FROM inventory_adjustments a JOIN ot_invoices i ON i.number=a.reference_id WHERE i.work_order_id=? AND a.reason='sold' AND a.reference_type='invoice' AND a.item_sku=? AND a.invoice_line_id IS NULL LIMIT 1`).get(entityId,sku):db.prepare("SELECT 1 FROM inventory_adjustments WHERE reference_type='invoice' AND reference_id=? AND item_sku=? AND reason='sold' AND invoice_line_id IS NULL LIMIT 1").get(number,sku);
    const issuedQuantity=-db.prepare("SELECT COALESCE(SUM(quantity_delta),0) quantity FROM inventory_adjustments WHERE invoice_scope=? AND invoice_entity_id=? AND invoice_line_id=? AND reason='sold'").get(scope,entityId,id).quantity;
    return {id,sku,description:item.description||'',quantity,issuedQuantity,remainingQuantity:legacy?0:Math.max(0,quantity-issuedQuantity),requiresReconciliation:!!legacy};
  }).filter(Boolean);
  return {invoice:{scope,id:invoice.id,entityId,number},lines};
}

// Quantities come from retained invoice lines and exact stock allocations, never
// from a status label or a generic supplier receipt for the same SKU.
export function retailLineFulfillment(db,order,line){
  if(typeof order==='number')order=db.prepare('SELECT * FROM retail_special_orders WHERE id=?').get(order);
  const empty={sku:String(line.requested_sku||line.vendor_sku||'').trim(),orderedQuantity:Number(line.quantity),receivedQuantity:0,fulfilledQuantity:0,returnedQuantity:0,remainingQuantity:Number(line.quantity),requiresReconciliation:false,reconciliationReason:''};
  if(!order?.invoice_issued_at)return empty;
  let item;try{item=JSON.parse(order.receipt_snapshot_json).items.find(item=>Number(item.id)===Number(line.id));}catch{}
  const sku=String(item?.requested_sku||item?.vendor_sku||'').trim(),quantity=Number(item?.quantity);
  if(!item||!sku||!Number.isSafeInteger(quantity)||quantity<1)return {...empty,requiresReconciliation:true,reconciliationReason:'The issued invoice lacks exact retained line and SKU quantities. Review the original invoice and stock records.'};
  const movements=db.prepare("SELECT * FROM inventory_adjustments WHERE reason='sold' AND reference_type='invoice' AND reference_id=? AND (invoice_line_id=? OR (invoice_line_id IS NULL AND item_sku=?))").all(order.invoice_number,line.id,sku);
  const exact=movements.filter(row=>row.invoice_scope==='retail'&&row.invoice_entity_id===order.id&&row.invoice_line_id===line.id&&row.item_sku===sku&&row.quantity_delta<0);
  const fulfilledQuantity=Math.max(0,-exact.reduce((total,row)=>total+row.quantity_delta,0));
  const receivedQuantity=db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM retail_supplier_receipts WHERE retail_order_id=? AND invoice_line_id=? AND sku=?').get(order.id,line.id,sku).n;
  const returnedQuantity=has(db,'accounting_returns')?db.prepare("SELECT COALESCE(SUM(r.quantity),0) n FROM accounting_returns r JOIN inventory_adjustments a ON a.id=r.sale_adjustment_id WHERE r.scope='retail' AND r.entity_id=? AND a.invoice_scope='retail' AND a.invoice_entity_id=? AND a.invoice_line_id=? AND a.item_sku=?").get(order.id,order.id,line.id,sku).n:0;
  // Original issues continue to cap reallocation after a return. A return before
  // pickup needs a reviewed release plan; do not silently hand out the original
  // full quantity after some reserved parts have returned to general stock.
  const reconciliationReason=returnedQuantity>0&&line.status!=='picked_up'?'Parts were returned before pickup. Review the remaining customer release quantity; do not release the original full quantity.':
    sku!==empty.sku||quantity!==Number(line.quantity)?'The current line differs from the retained invoice SKU or quantity. Review the original documents.':
    movements.length!==exact.length?'Historical stock issues lack exact invoice-line attribution. Reconcile the original stock records.':
    fulfilledQuantity>quantity||receivedQuantity>fulfilledQuantity?'Recorded receipt and stock allocation quantities disagree. Reconcile the retained records.':
    ['received','picked_up'].includes(line.status)&&fulfilledQuantity!==quantity?'This historical status has no complete invoice-linked stock allocation. Reconcile receiving before pickup.':'';
  return {sku,orderedQuantity:quantity,receivedQuantity,fulfilledQuantity,returnedQuantity,remainingQuantity:Math.max(0,quantity-fulfilledQuantity),requiresReconciliation:!!reconciliationReason,reconciliationReason};
}

export function syncRetailFulfillment(db,id){
  const order=db.prepare('SELECT * FROM retail_special_orders WHERE id=?').get(id);
  if(!order?.invoice_issued_at||order.invoice_voided_at||order.status==='cancelled')return;
  const rows=db.prepare('SELECT * FROM retail_special_lines WHERE retail_order_id=? ORDER BY id').all(id);
  for(const line of rows){
    const state=retailLineFulfillment(db,order,line);
    if(state.requiresReconciliation||line.status==='picked_up')continue;
    const status=state.fulfilledQuantity===state.orderedQuantity?'received':state.fulfilledQuantity>0?'partially_received':null;
    if(status&&status!==line.status){db.prepare('UPDATE retail_special_lines SET status=? WHERE id=?').run(status,line.id);line.status=status;}
  }
  const states=rows.map(line=>retailLineFulfillment(db,order,line));
  if(rows.length&&states.every(state=>!state.requiresReconciliation&&state.fulfilledQuantity===state.orderedQuantity)){
    const status=rows.every(line=>line.status==='picked_up')?'picked_up':'ready_for_pickup';
    if(order.status!==status)db.prepare('UPDATE retail_special_orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,id);
  }
}

export function recordInventoryAdjustment(db,user,input){
  const reason=text(input.reason,'Stock reason',40),delta=Number(input.quantityDelta),key=stockRequestKey(input);
  if(!['sold','damage','cycle_count'].includes(reason))fail(409,'Use the documented supplier receiving or Accounting return operation');
  if(['damage','cycle_count'].includes(reason)&&!['owner','manager'].includes(user.role))fail(403,'Owner or manager permission required for stock write-offs and counts');
  if(reason==='damage'&&delta>=0)fail(409,'Damage must remove stock');
  const scope=reason==='sold'?input.invoiceScope:null,lineId=reason==='sold'?integer(input.invoiceLineId,'Invoice line ID'):null;
  db.exec('BEGIN IMMEDIATE');
  try{
    let linked;
    // Exact retries remain successful even if the invoice has since been voided
    // or the remaining stock has changed. Compare the retained request first.
    const existing=db.prepare('SELECT * FROM inventory_adjustments WHERE idempotency_key=?').get(key);
    const movement={...input,reason,idempotencyKey:key,invoiceScope:scope,invoiceEntityId:existing?.invoice_entity_id??null,invoiceLineId:lineId,receivingLineId:null,source:'adjustment',details:null};
    if(existing){const prior=priorStockMovement(db,movement);db.exec('COMMIT');return prior;}
    if(reason==='sold'){
      if(input.referenceType!=='invoice'||delta>=0)fail(409,'Stock sales require negative quantity against an issued invoice');
      linked=inventoryInvoiceLines(db,scope,input.referenceId);
      const line=linked.lines.find(row=>row.id===lineId);
      if(!line||line.sku!==String(input.sku??'').trim())fail(409,'Stock sale must match the exact invoice line and SKU');
      if(line.requiresReconciliation)fail(409,'Unattributed historical sales must be reconciled before more stock is issued');
      if(-delta>line.remainingQuantity)fail(409,'Stock sale exceeds the invoice line remaining quantity');
      movement.invoiceEntityId=linked.invoice.entityId;
      if(scope==='retail'){
        const order=db.prepare('SELECT * FROM retail_special_orders WHERE id=?').get(linked.invoice.entityId),retailLine=db.prepare('SELECT * FROM retail_special_lines WHERE id=? AND retail_order_id=?').get(lineId,order.id);
        if(!retailLine||retailLineFulfillment(db,order,retailLine).requiresReconciliation)fail(409,'Historical retail fulfillment needs reconciliation before another stock allocation');
        if(retailLine.status==='picked_up'||retailLine.status==='cancelled')fail(409,'This retail line cannot receive another stock allocation');
      }
    }
    const result=appendStockMovement(db,user,movement);
    if(scope==='retail')syncRetailFulfillment(db,linked.invoice.entityId);
    db.prepare('INSERT INTO audit_log(work_order_id,actor,action,detail) VALUES(?,?,?,?)').run(scope==='repair'?linked.invoice.entityId:null,user.username,'Inventory adjustment',JSON.stringify({id:result.id,sku:result.item_sku,quantityDelta:result.quantity_delta,reason,reference:result.reference_id,lineId}));
    db.exec('COMMIT');return result;
  }catch(error){db.exec('ROLLBACK');throw error;}
}

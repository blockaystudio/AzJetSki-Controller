// Shop accounting documents and reconciliation. No operation transfers money.
import crypto from 'node:crypto';
import {appendStockMovement} from './inventory-movements.mjs';

const tables = {repair:{payments:'pos_payments',parent:'work_order_id'},retail:{payments:'retail_payments',parent:'retail_order_id'}};
const text=(value,max=600)=>String(value??'').trim().slice(0,max);
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const has=(db,table)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const fail=(status,message)=>{const error=new Error(message);error.status=status;throw error;};
const scopeValue=scope=>{if(!Object.hasOwn(tables,scope))fail(400,'Choose repair or retail');return scope;};
const cents=(value,label='Amount')=>{if(!Number.isSafeInteger(value)||value<0||value>100000000)fail(400,`${label} must be a nonnegative integer number of cents`);return value;};
const signedCents=(value,label)=>{if(!Number.isSafeInteger(value)||Math.abs(value)>100000000)fail(400,`${label} must be an integer number of cents within the supported range`);return value;};
const authorize=user=>{if(!user)fail(401,'Login required');if(!['owner','manager'].includes(user.role))fail(403,'Owner or manager authorization required');};
const readable=user=>{if(!user)fail(401,'Login required');if(!['owner','manager','advisor','service_writer'].includes(user.role))fail(403,'Accounting access restricted');};
const keyValue=value=>{const key=text(value,140);if(key.length<8)fail(400,'A unique idempotency key of at least eight characters is required');return key;};
const reasonValue=value=>{const reason=text(value);if(reason.length<5)fail(400,'A reason of at least five characters is required');return reason;};
function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
function audit(db,user,action,detail,repairId=null){if(has(db,'audit_log'))db.prepare('INSERT INTO audit_log(work_order_id,actor,action,detail) VALUES(?,?,?,?)').run(repairId,user.username,action,JSON.stringify(detail));}

export function installAccounting(db){
  db.exec(`CREATE TABLE IF NOT EXISTS accounting_credits(
    id INTEGER PRIMARY KEY AUTOINCREMENT,number TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL CHECK(scope IN ('repair','retail')),entity_id INTEGER NOT NULL,
    invoice_id INTEGER NOT NULL,invoice_number TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('credit','cancellation')),
    subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents>=0),tax_cents INTEGER NOT NULL CHECK(tax_cents>=0),
    total_cents INTEGER NOT NULL CHECK(total_cents>0 AND total_cents=subtotal_cents+tax_cents),
    reason TEXT NOT NULL,actor_id INTEGER NOT NULL,actor_username TEXT NOT NULL,actor_role TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,request_fingerprint TEXT NOT NULL,snapshot_json TEXT NOT NULL,snapshot_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(scope,idempotency_key));
    CREATE INDEX IF NOT EXISTS accounting_credit_entity ON accounting_credits(scope,entity_id);
    CREATE TABLE IF NOT EXISTS accounting_returns(
      id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,entity_id INTEGER NOT NULL,
      credit_id INTEGER NOT NULL REFERENCES accounting_credits(id),sale_adjustment_id INTEGER NOT NULL,
      sku TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>0),disposition TEXT NOT NULL CHECK(disposition IN ('resellable','damaged')),
      inventory_adjustment_id INTEGER,reason TEXT NOT NULL,actor_id INTEGER NOT NULL,actor_username TEXT NOT NULL,actor_role TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,request_fingerprint TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS accounting_closes(
      id INTEGER PRIMARY KEY AUTOINCREMENT,business_date TEXT NOT NULL,revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,snapshot_sha256 TEXT NOT NULL,cash_counted_cents INTEGER NOT NULL,
      opening_float_cents INTEGER NOT NULL,cash_paid_out_cents INTEGER NOT NULL,card_verified_cents INTEGER NOT NULL,zelle_verified_cents INTEGER NOT NULL,
      cash_difference_cents INTEGER NOT NULL,card_difference_cents INTEGER NOT NULL,zelle_difference_cents INTEGER NOT NULL,
      notes TEXT NOT NULL,actor_id INTEGER NOT NULL,actor_username TEXT NOT NULL,actor_role TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,request_fingerprint TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(business_date,revision));`);
  for(const table of ['accounting_credits','accounting_returns','accounting_closes'])db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Accounting history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Accounting history is immutable'); END;`);
  if(has(db,'retail_special_orders')&&!db.prepare('PRAGMA table_info(retail_special_orders)').all().some(row=>row.name==='invoice_voided_at'))db.exec('ALTER TABLE retail_special_orders ADD COLUMN invoice_voided_at TEXT');
  if(has(db,'retail_special_lines'))db.exec(`CREATE TRIGGER IF NOT EXISTS accounting_no_cancelled_retail_update BEFORE UPDATE ON retail_special_lines
    WHEN EXISTS(SELECT 1 FROM retail_special_orders WHERE id=OLD.retail_order_id AND invoice_voided_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'Cancelled invoice lines cannot be changed'); END;
    CREATE TRIGGER IF NOT EXISTS accounting_no_cancelled_retail_insert BEFORE INSERT ON retail_special_lines
    WHEN EXISTS(SELECT 1 FROM retail_special_orders WHERE id=NEW.retail_order_id AND invoice_voided_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'Cancelled invoice cannot receive new lines'); END;`);
}

export function effectiveAccountTotal(db,scope,id,rawCents){
  scopeValue(scope);cents(rawCents,'Account total');
  const credited=has(db,'accounting_credits')?db.prepare('SELECT COALESCE(SUM(total_cents),0) n FROM accounting_credits WHERE scope=? AND entity_id=?').get(scope,id).n:0;
  if(credited>rawCents)fail(409,'Account total is below its retained credit notes; reconcile the invoice before editing');
  return rawCents-credited;
}

function rawAccount(db,scope,id){
  scopeValue(scope);
  const row=scope==='repair'?db.prepare("SELECT * FROM work_orders WHERE id=? AND source='manual'").get(id):db.prepare('SELECT * FROM retail_special_orders WHERE id=?').get(id);
  if(!row)fail(404,'Account not found');
  return {row,total:scope==='repair'?Math.round(Number(row.estimate_total)*100):row.total_cents};
}
export function accountBalance(db,scope,id,rawCents=undefined){
  scopeValue(scope);const raw=rawCents??rawAccount(db,scope,id).total;
  const effective=effectiveAccountTotal(db,scope,id,raw),{payments,parent}=tables[scope];
  const paymentColumns=new Set(db.prepare(`PRAGMA table_info(${payments})`).all().map(row=>row.name));
  const voidClause=paymentColumns.has('voided_at')?'AND voided_at IS NULL':'';
  const values=db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='confirmed' THEN CASE WHEN direction='payment' THEN amount_cents ELSE -amount_cents END ELSE 0 END),0) net,
    COALESCE(SUM(CASE WHEN status='pending' AND direction='payment' THEN amount_cents ELSE 0 END),0) pending FROM ${payments} WHERE ${parent}=? ${voidClause}`).get(id);
  return {rawTotalCents:raw,creditCents:raw-effective,effectiveTotalCents:effective,netPaidCents:values.net,pendingCents:values.pending,dueCents:Math.max(0,effective-values.net),refundDueCents:Math.max(0,values.net-effective)};
}
function invoice(db,scope,id,invoiceId){
  if(scope==='repair'){
    if(!Number.isSafeInteger(invoiceId)||invoiceId<1)fail(400,'Choose an issued repair invoice');
    const row=db.prepare('SELECT * FROM ot_invoices WHERE id=? AND work_order_id=?').get(invoiceId,id);
    if(!row)fail(404,'Invoice not found on this work order');
    let snapshot;try{snapshot=JSON.parse(row.snapshot_json);}catch{fail(409,'Invoice snapshot is invalid; review before crediting');}
    const total=cents(snapshot.estimateCents,'Snapshot total'),tax=cents(snapshot.taxCents??0,'Snapshot tax');
    if(tax>total)fail(409,'Invoice tax snapshot exceeds its total');
    return {id:row.id,number:row.number,customerName:row.recipient_name,issuedAt:row.issued_at,total,tax,subtotal:total-tax,voided:row.voided_at,supersededBy:row.superseded_by??null,snapshot};
  }
  const row=db.prepare('SELECT * FROM retail_special_orders WHERE id=?').get(id);
  if(!row?.invoice_issued_at)fail(409,'Issue the retail invoice before crediting it');
  if(invoiceId!==undefined&&Number(invoiceId)!==id)fail(409,'Retail invoice does not belong to this order');
  const snapshot=row.receipt_snapshot_json?JSON.parse(row.receipt_snapshot_json):{legacy:true,invoiceNumber:row.invoice_number,totalCents:row.total_cents,taxCents:row.tax_cents};
  return {id,number:row.invoice_number,customerName:snapshot.customerName||'',issuedAt:row.invoice_issued_at,total:cents(row.total_cents),tax:cents(row.tax_cents),subtotal:cents(row.subtotal_cents),voided:row.invoice_voided_at,snapshot};
}
function creditRow(db,id){return db.prepare('SELECT * FROM accounting_credits WHERE id=?').get(id);}
function createCreditInside(db,scope,id,user,input,kind='credit'){
  const key=keyValue(input.idempotencyKey??input.idempotency_key),reason=reasonValue(input.reason);
  const normalized={scope,id,kind,invoiceId:scope==='repair'?Number(input.invoiceId):id,subtotalCents:cents(input.subtotalCents,'Credit subtotal'),taxCents:cents(input.taxCents,'Credit tax'),reason};
  if(normalized.subtotalCents+normalized.taxCents<=0)fail(400,'Credit must be greater than zero');
  const fingerprint=hash(normalized),prior=db.prepare('SELECT * FROM accounting_credits WHERE scope=? AND idempotency_key=?').get(scope,key);
  if(prior){if(prior.request_fingerprint!==fingerprint)fail(409,'Idempotency key was used with different credit details');return {...prior,duplicate:true};}
  const source=invoice(db,scope,id,normalized.invoiceId);if(source.voided)fail(409,'Invoice is already cancelled');
  const used=db.prepare('SELECT COALESCE(SUM(subtotal_cents),0) subtotal,COALESCE(SUM(tax_cents),0) tax FROM accounting_credits WHERE scope=? AND invoice_id=?').get(scope,source.id);
  if(used.subtotal+normalized.subtotalCents>source.subtotal||used.tax+normalized.taxCents>source.tax)fail(409,'Credit exceeds the remaining invoice subtotal or tax');
  const balance=accountBalance(db,scope,id),total=normalized.subtotalCents+normalized.taxCents;
  if(total>balance.effectiveTotalCents)fail(409,'Credit exceeds the remaining account charge');
  const rawTax=scope==='repair'?Number(rawAccount(db,scope,id).row.tax_total_cents||0):rawAccount(db,scope,id).row.tax_cents;
  const accountUsed=db.prepare('SELECT COALESCE(SUM(subtotal_cents),0) subtotal,COALESCE(SUM(tax_cents),0) tax FROM accounting_credits WHERE scope=? AND entity_id=?').get(scope,id);
  if(accountUsed.tax+normalized.taxCents>rawTax)fail(409,'Credit tax exceeds the account tax currently recorded');
  if(accountUsed.subtotal+normalized.subtotalCents>balance.rawTotalCents-rawTax)fail(409,'Credit charges exceed the account subtotal currently recorded');
  const number=`CR-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
  const snapshot={document:'credit_note',number,sourceInvoice:{id:source.id,number:source.number,customerName:source.customerName,issuedAt:source.issuedAt,snapshot:source.snapshot},...normalized,totalCents:total,actor:{id:user.id,username:user.username,role:user.role},createdAt:new Date().toISOString()};
  const raw=JSON.stringify(snapshot);
  const result=db.prepare(`INSERT INTO accounting_credits(number,scope,entity_id,invoice_id,invoice_number,kind,subtotal_cents,tax_cents,total_cents,reason,actor_id,actor_username,actor_role,idempotency_key,request_fingerprint,snapshot_json,snapshot_sha256)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(number,scope,id,source.id,source.number,kind,normalized.subtotalCents,normalized.taxCents,total,reason,user.id,user.username,user.role,key,fingerprint,raw,crypto.createHash('sha256').update(raw).digest('hex'));
  if(scope==='repair'){
    const next=accountBalance(db,scope,id);
    db.prepare('UPDATE work_orders SET paid_total=?,balance=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(next.netPaidCents/100,next.dueCents/100,id);
  }
  audit(db,user,'Credit note issued',{number,scope,entityId:id,invoiceId:source.id,totalCents:total,taxCents:normalized.taxCents,reason},scope==='repair'?id:null);
  return creditRow(db,Number(result.lastInsertRowid));
}
export function createCredit(db,scope,id,user,input){authorize(user);scopeValue(scope);return transaction(db,()=>createCreditInside(db,scope,id,user,input));}

function noPurchases(db,scope,id){
  if(scope==='repair'){
    if(has(db,'procurement_cart_lines')&&db.prepare(`SELECT 1 FROM procurement_cart_lines l JOIN procurement_carts c ON c.id=l.cart_id WHERE l.work_order_id=? AND c.status NOT IN ('draft','cancelled') LIMIT 1`).get(id))fail(409,'Review and cancel supplier purchasing before cancelling this invoice');
    if(has(db,'purchase_commands')&&db.prepare(`SELECT 1 FROM purchase_commands c JOIN procurement_cart_lines l ON l.cart_id=c.cart_id WHERE l.work_order_id=? LIMIT 1`).get(id))fail(409,'A desktop purchasing manifest exists; reconcile it before cancellation');
  }else{
    if(db.prepare("SELECT 1 FROM retail_special_lines WHERE retail_order_id=? AND status NOT IN ('needs_source','verified','cancelled') LIMIT 1").get(id))fail(409,'Supplier/pickup progress must be reconciled before cancellation');
    if(has(db,'retail_purchase_commands'))for(const command of db.prepare('SELECT snapshot_json FROM retail_purchase_commands').all()){
      let snapshot;try{snapshot=JSON.parse(command.snapshot_json);}catch{fail(409,'Review an unreadable purchasing manifest before cancellation');}
      if(snapshot.lines?.some(line=>Number(line.orderId)===id))fail(409,'A supplier manifest exists; reconcile it before cancellation');
    }
  }
}
export function cancelInvoice(db,scope,id,user,input){
  authorize(user);scopeValue(scope);
  return transaction(db,()=>{
    const reason=reasonValue(input.reason),key=keyValue(input.idempotencyKey??input.idempotency_key);
    const prior=db.prepare("SELECT * FROM accounting_credits WHERE scope=? AND idempotency_key=?").get(scope,key);
    if(prior){const saved=JSON.parse(prior.snapshot_json);if(prior.kind!=='cancellation'||prior.entity_id!==id||saved.reason!==reason||(scope==='repair'&&saved.invoiceId!==Number(input.invoiceId)))fail(409,'Idempotency key was used with different cancellation details');return {...prior,duplicate:true};}
    const source=invoice(db,scope,id,scope==='repair'?Number(input.invoiceId):id),balance=accountBalance(db,scope,id);
    if(source.supersededBy)fail(409,'Historical invoice has been superseded; cancel the current revised invoice');
    const {payments,parent}=tables[scope];
    if(balance.netPaidCents!==0||balance.pendingCents!==0||db.prepare(`SELECT 1 FROM ${payments} WHERE ${parent}=? AND status='confirmed' LIMIT 1`).get(id))fail(409,'Cancellation requires an unpaid account with no confirmed payment history or pending entries; issue a credit and refund instead');
    if(source.total!==balance.rawTotalCents)fail(409,'Current total differs from the issued invoice; use a reviewed credit note');
    if(scope==='repair'){
      // Prior revisions retain their invoice/credit/stock references. Only the
      // current document can cancel the account, including on legacy schemas.
      const active=db.prepare('SELECT * FROM ot_invoices WHERE work_order_id=? AND voided_at IS NULL').all(id).filter(row=>row.superseded_by==null);
      if(active.length!==1||active[0].id!==source.id)fail(409,'Reconcile multiple active invoices before cancellation');
    }
    noPurchases(db,scope,id);
    const used=db.prepare('SELECT COALESCE(SUM(subtotal_cents),0) subtotal,COALESCE(SUM(tax_cents),0) tax FROM accounting_credits WHERE scope=? AND entity_id=?').get(scope,id);
    const row=createCreditInside(db,scope,id,user,{...input,reason,invoiceId:source.id,subtotalCents:source.subtotal-used.subtotal,taxCents:source.tax-used.tax},'cancellation');
    if(scope==='repair')db.prepare('UPDATE ot_invoices SET voided_at=CURRENT_TIMESTAMP WHERE id=? AND voided_at IS NULL').run(source.id);
    else{
      db.prepare("UPDATE retail_special_lines SET status='cancelled' WHERE retail_order_id=?").run(id);
      db.prepare("UPDATE retail_special_orders SET invoice_voided_at=CURRENT_TIMESTAMP,status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    }
    audit(db,user,'Unpaid invoice cancelled',{scope,entityId:id,invoiceId:source.id,creditId:row.id,reason},scope==='repair'?id:null);
    return row;
  });
}

export function receiveCustomerReturn(db,scope,id,user,input){
  authorize(user);scopeValue(scope);
  const quantity=Number(input.quantity),saleId=Number(input.saleAdjustmentId),creditId=Number(input.creditNoteId),reason=reasonValue(input.reason),key=keyValue(input.idempotencyKey??input.idempotency_key),disposition=text(input.disposition);
  if(input.received!==true||!Number.isSafeInteger(quantity)||quantity<=0||!Number.isSafeInteger(saleId)||!Number.isSafeInteger(creditId)||!['resellable','damaged'].includes(disposition))fail(400,'Confirm actual receipt, positive integer quantity, original sale, credit note and stock disposition');
  const normalized={scope,id,quantity,saleId,creditId,reason,disposition},fingerprint=hash(normalized);
  return transaction(db,()=>{
    const prior=db.prepare('SELECT * FROM accounting_returns WHERE idempotency_key=?').get(key);
    if(prior){if(prior.request_fingerprint!==fingerprint)fail(409,'Idempotency key was used with different return details');return {...prior,duplicate:true};}
    if(db.prepare('SELECT 1 FROM inventory_adjustments WHERE idempotency_key=?').get(key))fail(409,'Stock key already belongs to another recorded operation');
    const credit=db.prepare('SELECT * FROM accounting_credits WHERE id=? AND scope=? AND entity_id=?').get(creditId,scope,id);
    if(!credit)fail(409,'Select a credit note on this account');
    const sale=db.prepare("SELECT * FROM inventory_adjustments WHERE id=? AND reason='sold' AND quantity_delta<0 AND reference_type='invoice'").get(saleId);
    if(!sale||sale.reference_id!==credit.invoice_number)fail(409,'Original stock sale must reference the credited invoice');
    const returned=db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM accounting_returns WHERE sale_adjustment_id=?').get(saleId).n;
    if(returned+quantity>-sale.quantity_delta)fail(409,'Return quantity exceeds the original stock sale remaining unreturned quantity');
    // Reserve the retained return ID under the same write transaction so its stock
    // movement can be captured in the immutable row without a later history edit.
    const returnId=db.prepare('SELECT COALESCE(MAX(id),0)+1 id FROM accounting_returns').get().id;
    const stockId=disposition==='resellable'?appendStockMovement(db,user,{sku:sale.item_sku,quantityDelta:quantity,reason:'return',referenceType:'customer_return',referenceId:String(returnId),idempotencyKey:key,source:'customer_return',details:normalized}).id:null;
    db.prepare(`INSERT INTO accounting_returns(id,scope,entity_id,credit_id,sale_adjustment_id,sku,quantity,disposition,inventory_adjustment_id,reason,actor_id,actor_username,actor_role,idempotency_key,request_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(returnId,scope,id,credit.id,sale.id,sale.item_sku,quantity,disposition,stockId,reason,user.id,user.username,user.role,key,fingerprint);
    audit(db,user,'Customer returned stock received',{returnId,scope,entityId:id,creditId:credit.id,saleId,sku:sale.item_sku,quantity,disposition},scope==='repair'?id:null);
    return db.prepare('SELECT * FROM accounting_returns WHERE id=?').get(returnId);
  });
}

export function businessDayRange(date){
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))fail(400,'Date must be YYYY-MM-DD in Phoenix time');
  const start=new Date(`${date}T07:00:00.000Z`);
  if(!Number.isFinite(start.getTime())||start.toISOString().slice(0,10)!==date)fail(400,'Invalid business date');
  return {date,timeZone:'America/Phoenix',startsAt:start.toISOString(),endsAt:new Date(start.getTime()+86400000).toISOString()};
}
function dateExpression(db,table,scope){
  if(!has(db,'finance_events'))return 'p.created_at';
  return `COALESCE((SELECT MIN(e.created_at) FROM finance_events e WHERE e.scope='${scope}' AND e.payment_id=p.id AND e.operation='confirm'),p.created_at)`;
}
export function dailyCloseReport(db,date){
  const range=businessDayRange(date),entries=[];
  for(const [scope,{payments,parent}]of Object.entries(tables)){
    if(!has(db,payments))continue;
    const columns=db.prepare(`PRAGMA table_info(${payments})`).all().map(row=>row.name),time=dateExpression(db,payments,scope);
    const rows=db.prepare(`SELECT p.*,${time} effective_at FROM ${payments} p WHERE datetime(${time})>=datetime(?) AND datetime(${time})<datetime(?) ORDER BY p.id`).all(range.startsAt,range.endsAt);
    for(const row of rows)entries.push({...row,scope,entityId:row[parent],excluded:!!row.voided_at||row.status!=='confirmed',exclusion:row.voided_at?'voided':row.status!=='confirmed'?'pending':''});
  }
  const methods={cash:{receivedCents:0,refundCents:0,netCents:0,count:0},card_dejavoo:{receivedCents:0,refundCents:0,netCents:0,count:0},zelle:{receivedCents:0,refundCents:0,netCents:0,count:0}};
  for(const row of entries){if(row.excluded||!methods[row.method])continue;const method=methods[row.method];method.count++;if(row.direction==='refund')method.refundCents+=row.amount_cents;else method.receivedCents+=row.amount_cents;method.netCents=method.receivedCents-method.refundCents;}
  const credits=has(db,'accounting_credits')?db.prepare('SELECT id,number,scope,entity_id,invoice_number,subtotal_cents,tax_cents,total_cents,created_at FROM accounting_credits WHERE datetime(created_at)>=datetime(?) AND datetime(created_at)<datetime(?) ORDER BY id').all(range.startsAt,range.endsAt):[];
  const invoiceReview=[];
  if(has(db,'ot_invoices'))for(const row of db.prepare('SELECT * FROM ot_invoices WHERE datetime(issued_at)>=datetime(?) AND datetime(issued_at)<datetime(?) ORDER BY id').all(range.startsAt,range.endsAt)){
    let snapshot={};try{snapshot=JSON.parse(row.snapshot_json);}catch{}
    const count=db.prepare('SELECT COUNT(*) n FROM ot_invoices WHERE work_order_id=?').get(row.work_order_id).n;
    invoiceReview.push({scope:'repair',entityId:row.work_order_id,invoiceNumber:row.number,totalCents:snapshot.estimateCents??null,taxCents:snapshot.taxCents??null,voided:!!row.voided_at,requiresReview:count>1||!Number.isSafeInteger(snapshot.estimateCents),note:count>1?'Multiple issued documents exist for this work order; do not sum them as separate sales.':''});
  }
  if(has(db,'retail_special_orders'))for(const row of db.prepare('SELECT * FROM retail_special_orders WHERE invoice_issued_at IS NOT NULL AND datetime(invoice_issued_at)>=datetime(?) AND datetime(invoice_issued_at)<datetime(?) ORDER BY id').all(range.startsAt,range.endsAt))invoiceReview.push({scope:'retail',entityId:row.id,invoiceNumber:row.invoice_number,totalCents:row.total_cents,taxCents:row.tax_cents,voided:!!row.invoice_voided_at,requiresReview:false,note:''});
  const priorCloses=has(db,'accounting_closes')?db.prepare('SELECT id,business_date,revision,cash_difference_cents,card_difference_cents,zelle_difference_cents,actor_username,created_at,snapshot_sha256 FROM accounting_closes WHERE business_date=? ORDER BY revision').all(date):[];
  return {...range,basis:'Confirmed receipts/refunds on recording or bank-confirmation date. Deposits count once. Card/Zelle are staff-verified ledger references, not processor settlement. Invoice tax snapshots are review documents, not a recognized tax-liability calculation.',methods,entries,credits,invoiceReview,creditedTaxCents:credits.reduce((sum,row)=>sum+row.tax_cents,0),taxReviewRequired:invoiceReview.some(row=>row.requiresReview),priorCloses};
}
export function recordDailyClose(db,date,user,input){
  authorize(user);const key=keyValue(input.idempotencyKey??input.idempotency_key),notes=text(input.notes,2000);
  const normalized={date,cashCountedCents:cents(input.cashCountedCents,'Cash counted'),openingFloatCents:cents(input.openingFloatCents??0,'Opening float'),cashPaidOutCents:cents(input.cashPaidOutCents??0,'Cash paid out'),cardVerifiedCents:signedCents(input.cardVerifiedCents,'Card net verified'),zelleVerifiedCents:signedCents(input.zelleVerifiedCents,'Zelle net verified'),notes};
  if(input.externalTotalsVerified!==true)fail(400,'Verify the external terminal and bank totals before closing');
  const fingerprint=hash(normalized);
  return transaction(db,()=>{
    const prior=db.prepare('SELECT * FROM accounting_closes WHERE idempotency_key=?').get(key);
    if(prior){if(prior.request_fingerprint!==fingerprint)fail(409,'Idempotency key was used with different close details');return {...prior,duplicate:true};}
    const report=dailyCloseReport(db,date);
    if(report.taxReviewRequired&&input.taxReviewAcknowledged!==true)fail(409,'Review the flagged invoice tax snapshots and acknowledge their limitations');
    const expectedCash=normalized.openingFloatCents+report.methods.cash.netCents-normalized.cashPaidOutCents;
    const cashDifference=normalized.cashCountedCents-expectedCash,cardDifference=normalized.cardVerifiedCents-report.methods.card_dejavoo.netCents,zelleDifference=normalized.zelleVerifiedCents-report.methods.zelle.netCents;
    if((cashDifference||cardDifference||zelleDifference)&&notes.length<5)fail(400,'Explain cash, terminal or bank discrepancies in the close notes');
    const revision=report.priorCloses.length+1;
    // Remove prior close history from the signed snapshot to avoid recursive growth.
    const {priorCloses,...snapshot}=report;const raw=JSON.stringify({...snapshot,counted:normalized,differences:{cashDifference,cardDifference,zelleDifference},actor:{id:user.id,username:user.username,role:user.role}});
    const result=db.prepare(`INSERT INTO accounting_closes(business_date,revision,snapshot_json,snapshot_sha256,cash_counted_cents,opening_float_cents,cash_paid_out_cents,card_verified_cents,zelle_verified_cents,cash_difference_cents,card_difference_cents,zelle_difference_cents,notes,actor_id,actor_username,actor_role,idempotency_key,request_fingerprint)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(date,revision,raw,crypto.createHash('sha256').update(raw).digest('hex'),normalized.cashCountedCents,normalized.openingFloatCents,normalized.cashPaidOutCents,normalized.cardVerifiedCents,normalized.zelleVerifiedCents,cashDifference,cardDifference,zelleDifference,notes,user.id,user.username,user.role,key,fingerprint);
    audit(db,user,'Daily financial close recorded',{date,revision,cashDifference,cardDifference,zelleDifference});
    return db.prepare('SELECT * FROM accounting_closes WHERE id=?').get(Number(result.lastInsertRowid));
  });
}
const csvCell=value=>{const raw=String(value??'');return `"${(/^\s*[=+@-]/.test(raw)?"'"+raw:raw).replaceAll('"','""')}"`;};
export function dailyCloseCSV(report){
  const rows=[['business_date','scope','entity_id','payment_id','effective_at','method','direction','status','amount_cents','reference','excluded'],...report.entries.map(row=>[report.date,row.scope,row.entityId,row.id,row.effective_at,row.method,row.direction,row.status,row.amount_cents,row.reference,row.exclusion])];
  return rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}

export function accountingRoutes({db,currentUser,json,readBody}){
  installAccounting(db);
  return async(req,res,p,url)=>{
    if(!p.startsWith('/api/accounting/'))return false;
    const send=(status,body)=>{json(res,status,body,{'cache-control':'no-store'});return true;};
    try{
      const user=currentUser(req);readable(user);
      const account=p.match(/^\/api\/accounting\/accounts\/(repair|retail)\/(\d+)(?:\/(credits|void|returns))?$/);
      if(account){
        const scope=account[1],id=Number(account[2]),op=account[3];
        if(!op&&req.method==='GET'){
          const raw=rawAccount(db,scope,id),credits=db.prepare('SELECT * FROM accounting_credits WHERE scope=? AND entity_id=? ORDER BY id').all(scope,id),returns=db.prepare('SELECT * FROM accounting_returns WHERE scope=? AND entity_id=? ORDER BY id').all(scope,id);
          const invoices=scope==='repair'?db.prepare('SELECT id,number,issued_at,voided_at,snapshot_json FROM ot_invoices WHERE work_order_id=? ORDER BY id').all(id):[{id,number:raw.row.invoice_number,issued_at:raw.row.invoice_issued_at,voided_at:raw.row.invoice_voided_at}];
          const numbers=invoices.map(row=>row.number);const stockSales=numbers.length&&has(db,'inventory_adjustments')?db.prepare(`SELECT * FROM inventory_adjustments WHERE reason='sold' AND reference_type='invoice' AND reference_id IN (${numbers.map(()=>'?').join(',')})`).all(...numbers):[];
          return send(200,{scope,id,balance:accountBalance(db,scope,id),credits,returns,invoices,stockSales,canAuthorize:['owner','manager'].includes(user.role)});
        }
        if(req.method==='POST'&&op){
          const body=await readBody(req);const result=op==='credits'?createCredit(db,scope,id,user,body):op==='void'?cancelInvoice(db,scope,id,user,body):receiveCustomerReturn(db,scope,id,user,body);
          return send(result.duplicate?200:201,{...result,balance:accountBalance(db,scope,id)});
        }
        return send(405,{error:'Method not allowed'});
      }
      if(p==='/api/accounting/daily-close'){
        const date=url.searchParams.get('date')||new Intl.DateTimeFormat('en-CA',{timeZone:'America/Phoenix',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
        if(req.method==='GET'){
          const report=dailyCloseReport(db,date);
          if(url.searchParams.get('format')==='csv'){res.writeHead(200,{'content-type':'text/csv; charset=utf-8','cache-control':'no-store','content-disposition':`attachment; filename="ownertracker-close-${date}.csv"`});res.end(dailyCloseCSV(report));return true;}
          return send(200,report);
        }
        if(req.method==='POST'){const body=await readBody(req);const result=recordDailyClose(db,body.date??date,user,body);return send(result.duplicate?200:201,result);}
      }
      const close=p.match(/^\/api\/accounting\/daily-close\/(\d+)$/);
      if(close&&req.method==='GET'){const row=db.prepare('SELECT * FROM accounting_closes WHERE id=?').get(Number(close[1]));return row?send(200,{...row,snapshot:JSON.parse(row.snapshot_json)}):send(404,{error:'Close not found'});}
      const document=p.match(/^\/api\/accounting\/credits\/(\d+)\/document$/);
      if(document&&req.method==='GET'){
        const row=creditRow(db,Number(document[1]));if(!row)return send(404,{error:'Credit note not found'});
        const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
        const money=value=>(value/100).toLocaleString('en-US',{style:'currency',currency:'USD'});
        const snapshot=JSON.parse(row.snapshot_json),source=snapshot.sourceInvoice.snapshot;
        const name=snapshot.sourceInvoice.customerName||source.customerName||source.recipientName||'';
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"});
        res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(row.number)}</title><style>body{font:16px system-ui;max-width:760px;margin:40px auto;padding:16px}table{width:100%;border-collapse:collapse}td,th{padding:10px;text-align:left;border-bottom:1px solid #ddd}small{overflow-wrap:anywhere}</style></head><body><h1>Credit note ${escape(row.number)}</h1><p>Original invoice: ${escape(row.invoice_number)}<br>${escape(name)}<br>Issued ${escape(row.created_at)}</p><p>${escape(row.reason)}</p><table><tr><th>Credited charges</th><td>${money(row.subtotal_cents)}</td></tr><tr><th>Credited tax</th><td>${money(row.tax_cents)}</td></tr><tr><th>Total credit</th><td>${money(row.total_cents)}</td></tr></table><p>This corrects the invoice charge. It does not transfer funds. Any money returned is recorded separately in the payment ledger.</p><p><small>Document integrity SHA-256: ${escape(row.snapshot_sha256)}</small></p><p>Use your browser's Print command to save or print this retained credit note.</p></body></html>`);return true;
      }
      return send(404,{error:'Accounting route not found'});
    }catch(error){return send(error.status||400,{error:error.message});}
  };
}

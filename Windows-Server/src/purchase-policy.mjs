import {hasCurrentAuthorization} from './authorizations.mjs';
const hasTable=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const normalized=items=>(items||[]).map(line=>({type:line.line_type||'',sku:line.item_ref||'',description:line.description||'',qty:Number(line.qty),rate:Number(line.rate),amount:Number(line.amount),taxable:Number(line.taxable??0)}));
export function hasPurchaseBacking(db,id){
 const job=db.prepare('SELECT * FROM work_orders WHERE id=?').get(id);if(!job)return false;
 if(hasTable(db,'accounting_credits')&&db.prepare("SELECT id FROM accounting_credits WHERE scope='repair' AND entity_id=? AND kind='cancellation' LIMIT 1").get(id))return false;
 const current=normalized(db.prepare('SELECT * FROM work_order_lines WHERE work_order_id=? ORDER BY id').all(id));
 if(hasTable(db,'ot_invoices'))for(const invoice of db.prepare('SELECT snapshot_json FROM ot_invoices WHERE work_order_id=? AND voided_at IS NULL ORDER BY id DESC').all(id)){
  try{const snapshot=JSON.parse(invoice.snapshot_json);if(snapshot.estimateCents===Math.round(job.estimate_total*100)&&JSON.stringify(normalized(snapshot.items))===JSON.stringify(current))return true;}catch{}
 }
 const retained=db.prepare('PRAGMA table_info(approvals)').all().some(column=>column.name==='snapshot_json');
 return retained&&hasCurrentAuthorization(db,id);
}

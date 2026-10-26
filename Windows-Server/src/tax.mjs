import {accountBalance} from './accounting.mjs';
// Owner Tracker tax engine. Monetary amounts are integer cents, the tax rate is basis points.
// Shop configuration: 9.10% as requested; accountant must certify taxable categories before go-live.
const round = n => Math.round(Number(n)*100);
const dollar = c => Math.round(c)/100;
export function installTax(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS ot_shop_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS ot_tax_events(id INTEGER PRIMARY KEY AUTOINCREMENT,work_order_id INTEGER,rate_bps INTEGER,subtotal_cents INTEGER,taxable_cents INTEGER,tax_cents INTEGER,actor TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
 const settings=db.prepare("SELECT value FROM ot_shop_settings WHERE key='tax_rate_bps'").get();
 if(!settings)db.prepare("INSERT INTO ot_shop_settings(key,value) VALUES('tax_rate_bps','910')").run();
 const add=(table,col)=>{const name=col.split(' ')[0];if(!db.prepare(`PRAGMA table_info(${table})`).all().some(x=>x.name===name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`)};
 add('work_orders','tax_rate_bps INTEGER NOT NULL DEFAULT 0');
 add('work_orders','tax_total_cents INTEGER NOT NULL DEFAULT 0');
 add('work_orders','subtotal_cents INTEGER NOT NULL DEFAULT 0');
 add('work_order_lines','taxable INTEGER NOT NULL DEFAULT 0');
}
export function shopTaxBps(db){const bps=Number(db.prepare("SELECT value FROM ot_shop_settings WHERE key='tax_rate_bps'").get()?.value??'910');return Number.isInteger(bps)&&bps>=0&&bps<=2500?bps:910}
export function setShopTaxBps(db,bps){if(!Number.isInteger(bps)||bps<0||bps>2500)throw Error('Tax rate must be between 0% and 25%');db.prepare("INSERT INTO ot_shop_settings(key,value) VALUES('tax_rate_bps',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").run(String(bps));return bps;}
export const defaultTaxable=type => type==='part'||type==='other';
export const repairFinancialFields=Object.freeze(['estimate_total','parts_total','labor_total','paid_total','balance','subtotal_cents','tax_total_cents','tax_rate_bps']);
export function assertManualRepairAccount(db,id){
 const row=db.prepare('SELECT id,source,estimate_total FROM work_orders WHERE id=?').get(id);
 if(!row)throw Object.assign(Error('Work order not found'),{status:404});
 if(row.source!=='manual')throw Object.assign(Error('Imported work-order finances require reviewed migration reconciliation before editing'),{status:409});
 return row;
}
export function priceLines(lines,bps){
 if(!Number.isInteger(bps)||bps<0||bps>2500)throw Object.assign(Error('Invalid work-order tax rate'),{status:400});
 let subtotal=0,taxable=0;
 for(const line of lines){
  const amount=round(line.amount);
  if(!Number.isSafeInteger(amount)||amount<0)throw Object.assign(Error('Invalid work-order amount'),{status:400});
  subtotal+=amount;if(Number(line.taxable)===1)taxable+=amount;
 }
 const tax=Math.round(taxable*bps/10000),total=subtotal+tax;
 if(!Number.isSafeInteger(total)||total>100000000)throw Object.assign(Error('Work-order total must be at most $1,000,000'),{status:400});
 return {subtotal_cents:subtotal,taxable_cents:taxable,tax_cents:tax,total_cents:total,rate_bps:bps};
}
export function calcOrderTax(db,id,overrideLines=null){const w=db.prepare('SELECT id,tax_rate_bps FROM work_orders WHERE id=?').get(id);if(!w)throw Error('Work order not found');const lines=overrideLines||db.prepare('SELECT amount,taxable FROM work_order_lines WHERE work_order_id=?').all(id);return priceLines(lines,w.tax_rate_bps);}
// Validate the complete proposed invoice before changing its lines or linked parts.
// Both this guard and persistence use the shared credit/payment ledger in cents.
export function validateOrderTax(db,id,overrideLines=null){
 assertManualRepairAccount(db,id);
 const pricing=calcOrderTax(db,id,overrideLines),account=accountBalance(db,'repair',id,pricing.total_cents);
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='accounting_credits'").get()){
  const credits=db.prepare("SELECT COALESCE(SUM(subtotal_cents),0) subtotal,COALESCE(SUM(tax_cents),0) tax FROM accounting_credits WHERE scope='repair' AND entity_id=?").get(id);
  if(credits.subtotal>pricing.subtotal_cents||credits.tax>pricing.tax_cents)throw Object.assign(Error('Edited invoice subtotal or tax is below its retained credit notes'),{status:409});
 }
 if(account.refundDueCents>0)throw Object.assign(Error('Edited invoice total after credits cannot be below already-confirmed payments'),{status:409});
 return {pricing,account};
}
export function applyOrderTax(db,id,actor='system'){
 const {pricing:p,account}=validateOrderTax(db,id);
 db.prepare('UPDATE work_orders SET subtotal_cents=?,tax_total_cents=?,estimate_total=?,paid_total=?,balance=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(p.subtotal_cents,p.tax_cents,dollar(p.total_cents),dollar(account.netPaidCents),dollar(account.dueCents),id);
 db.prepare('INSERT INTO ot_tax_events(work_order_id,rate_bps,subtotal_cents,taxable_cents,tax_cents,actor) VALUES(?,?,?,?,?,?)').run(id,p.rate_bps,p.subtotal_cents,p.taxable_cents,p.tax_cents,actor);
 return p;
}

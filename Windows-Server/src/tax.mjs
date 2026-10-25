import {effectiveAccountTotal} from './accounting.mjs';
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
export function priceLines(lines,bps){let subtotal=0,taxable=0;for(const line of lines){const amount=round(line.amount);if(amount<0)throw Error('Negative work-order amount');subtotal+=amount;if(Number(line.taxable)===1)taxable+=amount;}const tax=Math.round(taxable*bps/10000);return {subtotal_cents:subtotal,taxable_cents:taxable,tax_cents:tax,total_cents:subtotal+tax,rate_bps:bps};}
export function calcOrderTax(db,id,overrideLines=null){const w=db.prepare('SELECT id,tax_rate_bps FROM work_orders WHERE id=?').get(id);if(!w)throw Error('Work order not found');const lines=overrideLines||db.prepare('SELECT amount,taxable FROM work_order_lines WHERE work_order_id=?').all(id);return priceLines(lines,w.tax_rate_bps);}
export function applyOrderTax(db,id,actor='system'){
 const p=calcOrderTax(db,id);const paid=db.prepare("SELECT COALESCE(SUM(CASE WHEN status='confirmed' THEN CASE WHEN direction='payment' THEN amount_cents ELSE -amount_cents END ELSE 0 END),0) AS paid FROM pos_payments WHERE work_order_id=?").get(id)?.paid||0;
 const effectiveTotal=effectiveAccountTotal(db,'repair',id,p.total_cents);
 if(effectiveTotal<paid)throw Error('Edited invoice total after credits cannot be below already-confirmed payments');
 db.prepare('UPDATE work_orders SET subtotal_cents=?,tax_total_cents=?,estimate_total=?,paid_total=?,balance=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(p.subtotal_cents,p.tax_cents,dollar(p.total_cents),dollar(paid),dollar(effectiveTotal-paid),id);
 db.prepare('INSERT INTO ot_tax_events(work_order_id,rate_bps,subtotal_cents,taxable_cents,tax_cents,actor) VALUES(?,?,?,?,?,?)').run(id,p.rate_bps,p.subtotal_cents,p.taxable_cents,p.tax_cents,actor);
 return p;
}

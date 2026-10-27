import {makePurchaseTarget} from '../public/purchase-target.js';
import {hasPurchaseBacking} from './purchase-policy.mjs';
import {assertPurchaseAuthorized} from './shop-management.mjs';
// Owner Tracker POS extensions: local first-party customer/vehicle records,
// manual work orders, technician parts, immutable purchase review commands.
// No supplier credentials are stored here; order execution is intentionally disabled.
import crypto from 'node:crypto';
import {accountBalance} from './accounting.mjs';
import {installEditRevisions,requireEditRevision} from './edit-revisions.mjs';
import {installTax,shopTaxBps,defaultTaxable,applyOrderTax,validateOrderTax,assertManualRepairAccount,repairFinancialFields} from './tax.mjs';
import {installFinancialControls,recordPayment,confirmPayment,voidPayment,financialEvents,paymentRows,canAuthorizeFinance} from './finance-controls.mjs';
import {assertJobIdentityChange,assertJobStageChange,jobIdentityFields} from './job-policy.mjs';

export function extendDatabase(db) {
  installTax(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT DEFAULT '',
      email TEXT DEFAULT '', address TEXT DEFAULT '', notes TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id),
      category TEXT DEFAULT 'PWC', year TEXT DEFAULT '', make TEXT DEFAULT '',
      model TEXT DEFAULT '', vin TEXT DEFAULT '', hin TEXT DEFAULT '',
      hours REAL DEFAULT 0, mileage REAL DEFAULT 0, color TEXT DEFAULT '',
      notes TEXT DEFAULT '', archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_vehicles_customer ON vehicles(customer_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_vin ON vehicles(vin) WHERE vin<>'' AND archived=0;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_hin ON vehicles(hin) WHERE hin<>'' AND archived=0;
    CREATE TABLE IF NOT EXISTS pos_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE RESTRICT,
      method TEXT NOT NULL CHECK(method IN ('cash','card_dejavoo','zelle')),
      direction TEXT NOT NULL DEFAULT 'payment' CHECK(direction IN ('payment','refund')),
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      reference TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','pending')),
      verified_by INTEGER NOT NULL REFERENCES users(id),
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pos_payments_wo ON pos_payments(work_order_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_payment_external_reference ON pos_payments(method, reference)
      WHERE method IN ('card_dejavoo','zelle') AND reference<>'' AND status='confirmed' AND direction='payment';
    CREATE TABLE IF NOT EXISTS purchase_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT, command_uuid TEXT NOT NULL UNIQUE,
      cart_id INTEGER NOT NULL REFERENCES procurement_carts(id),
      reviewed_by INTEGER NOT NULL REFERENCES users(id),
      snapshot_json TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      agent_message TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      claimed_at TEXT, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_purchase_cmd_status ON purchase_commands(status, id);
  `);
  installFinancialControls(db,'repair');
  // Add structured addresses without destroying legacy single-line address values.
  const addressDefs = [
    "address_line1 TEXT NOT NULL DEFAULT ''", "address_line2 TEXT NOT NULL DEFAULT ''",
    "city TEXT NOT NULL DEFAULT ''", "state TEXT NOT NULL DEFAULT ''",
    "postal_code TEXT NOT NULL DEFAULT ''", 'billing_same_as_service INTEGER NOT NULL DEFAULT 1',
    "billing_address_line1 TEXT NOT NULL DEFAULT ''", "billing_address_line2 TEXT NOT NULL DEFAULT ''",
    "billing_city TEXT NOT NULL DEFAULT ''", "billing_state TEXT NOT NULL DEFAULT ''",
    "billing_postal_code TEXT NOT NULL DEFAULT ''"
  ];
  const current = new Set(db.prepare('PRAGMA table_info(customers)').all().map(x=>x.name));
  for(const definition of addressDefs){if(!current.has(definition.split(' ')[0]))db.exec(`ALTER TABLE customers ADD COLUMN ${definition}`)}
  db.prepare("UPDATE customers SET address_line1=address WHERE address_line1='' AND address<>''").run();
  for (const [table, col] of [['work_orders','customer_id INTEGER REFERENCES customers(id)'],['work_orders','vehicle_id INTEGER REFERENCES vehicles(id)']]) {
    const existing=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name));
    if(!existing.has(col.split(' ')[0]))db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
  }
  installEditRevisions(db);
}

const asText=(v,max=4000)=>String(v??'').trim().slice(0,max);
const num=v=>{const x=Number(v);return Number.isFinite(x)?x:0;};
const cents=v=>{ if(typeof v==='string'&&!/^\d+(?:\.\d{1,2})?$/.test(v.trim()))throw new Error('Amount must have at most two decimal places'); const n=Number(v); if(!Number.isFinite(n)||n<=0||n>1000000)throw new Error('Amount must be positive and at most $1,000,000');return Math.round(n*100); };
function syncBalance(db,id){const x=assertManualRepairAccount(db,id);const t=accountBalance(db,'repair',id,Math.round(x.estimate_total*100));db.prepare('UPDATE work_orders SET paid_total=?,balance=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(t.netPaidCents/100,t.dueCents/100,id);return {paid:t.netPaidCents/100,balance:t.dueCents/100,pending:t.pendingCents/100,total:t.effectiveTotalCents/100,originalTotal:t.rawTotalCents/100,credits:t.creditCents/100,refundDue:t.refundDueCents/100};}

const isOwner=u=>u&&['owner','manager'].includes(u.role);
const directoryRead=u=>u&&['owner','manager','service_writer','advisor','parts'].includes(u.role);
const customerEdit=u=>u&&['owner','manager','service_writer','advisor'].includes(u.role);
const techEdit=u=>u&&['owner','manager','service_writer','advisor','technician','parts'].includes(u.role);
const validStages=new Set(['Intake','Diagnosing','Awaiting Approval','Parts Ordered','In Progress','Quality Check','Ready','Picked Up','Closed','Declined']);
const customerCols=['name','phone','email','address','notes','address_line1','address_line2','city','state','postal_code','billing_same_as_service','billing_address_line1','billing_address_line2','billing_city','billing_state','billing_postal_code'];
const addressCols=['address_line1','address_line2','city','state','postal_code'];
function normalizedCustomer(body,existing={}){
 const b={...body};
 if(Object.hasOwn(b,'address')&&!Object.hasOwn(b,'address_line1')) b.address_line1=b.address;
 if(Object.hasOwn(b,'address_line1')) b.address=asText(b.address_line1,240);
 if(Object.hasOwn(b,'billing_same_as_service'))b.billing_same_as_service=(b.billing_same_as_service===true||b.billing_same_as_service==='true'||b.billing_same_as_service==='on'||b.billing_same_as_service===1)?1:0;
 for(const col of [...addressCols,'billing_address_line1','billing_address_line2','billing_city','billing_state','billing_postal_code']){
   if(Object.hasOwn(b,col)&&asText(b[col],col.includes('line')?240:60).length>240)throw Error('Address field too long');
 }
 const combined={...existing,...b};
 // Existing records without an address can be updated; new records must capture an address.
 if(!existing.id){
   if(!['address_line1','city','state','postal_code'].every(k=>asText(combined[k])))throw Error('Street address, city, state and ZIP/postal code are required');
 }
 if(Object.hasOwn(b,'postal_code')&&b.postal_code&& !/^[a-z0-9][a-z0-9 -]{2,11}$/i.test(String(b.postal_code).trim()))throw Error('Invalid ZIP/postal code');
 if(Object.hasOwn(b,'state')&&b.state&&!/^[a-z][a-z .-]{1,30}$/i.test(String(b.state).trim()))throw Error('Invalid state or province');
 if(Number(combined.billing_same_as_service)===0&&!['billing_address_line1','billing_city','billing_state','billing_postal_code'].every(k=>asText(combined[k])))throw Error('A separate billing address requires street, city, state and ZIP/postal code');
 return b;
}

const vehicleCols=['category','year','make','model','vin','hin','hours','mileage','color','notes'];
const orderCols=['ref_number','complaint','authorized_work','stage','priority','promised_date','next_action','estimate_total','assigned_user_id'];
function updateCols(db,table,id,body,cols) {
  const entries=cols.filter(k=>Object.hasOwn(body,k)).map(k=>[k,k==='billing_same_as_service'?Number(body[k]):['hours','mileage','estimate_total','paid_total','assigned_user_id'].includes(k)?(body[k]===null?null:num(body[k])):asText(body[k])]);
  if(!entries.length)throw new Error('No editable fields');
  db.prepare(`UPDATE ${table} SET ${entries.map(([k])=>`${k}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...entries.map(x=>x[1]),id);
}
function woMeta(db,customerId,vehicleId){
  const customer=db.prepare('SELECT * FROM customers WHERE id=? AND archived=0').get(customerId);
  if(!customer)throw new Error('Customer not found');
  const vehicle=db.prepare('SELECT * FROM vehicles WHERE id=? AND customer_id=? AND archived=0').get(vehicleId,customerId);
  if(!vehicle)throw new Error('Vehicle must belong to the selected customer');
  return {customer,vehicle,label:[vehicle.year,vehicle.make,vehicle.model].filter(Boolean).join(' ')||vehicle.category};
}
function audit(db,id,u,action,detail){db.prepare('INSERT INTO audit_log(work_order_id,actor,action,detail) VALUES(?,?,?,?)').run(id||null,u.username,action,JSON.stringify(detail).slice(0,6000));}
function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
function identitySnapshot(row){return Object.fromEntries(jobIdentityFields.map(key=>[key,row[key]??null]));}
function preserveJobIdentity(db,old,changes){try{assertJobIdentityChange(db,old,changes);return false;}catch(error){if(error.status===409)return true;throw error;}}
function saleLine(body,old={}){
  const line={line_type:asText(body.line_type??old.line_type??'part'),item_ref:asText(body.item_ref??old.item_ref),description:asText(body.description??old.description),qty:Number(body.qty??old.qty??1),rate:Number(body.rate??old.rate??0),cost:Number(body.cost??old.cost??0)};
  if(!['part','labor','service','other'].includes(line.line_type)||!line.description||!Number.isFinite(line.qty)||line.qty<=0||line.qty>10000||!Number.isFinite(line.rate)||line.rate<0||!Number.isFinite(line.cost)||line.cost<0)throw Object.assign(Error('Invalid sale line quantity, price, cost or description'),{status:400});
  line.amount=Math.round(line.qty*line.rate*100)/100;
  line.taxable=body.taxable===undefined?(old.line_type===line.line_type?old.taxable:Number(defaultTaxable(line.line_type))):Number(body.taxable===true||body.taxable===1||body.taxable==='on'||body.taxable==='true');
  return line;
}
function updateLineParts(db,workOrderId,id,line){
  if(line?.line_type==='part'){
    db.prepare(`INSERT INTO part_requirements(work_order_id,source,source_key,item_ref,description,qty_needed,sell_price,status) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(work_order_id,source_key) DO UPDATE SET item_ref=excluded.item_ref,description=excluded.description,qty_needed=excluded.qty_needed,sell_price=excluded.sell_price`).run(workOrderId,'pos',`pos-line-${id}`,line.item_ref,line.description,line.qty,line.amount,'needs_source');
  }else db.prepare('DELETE FROM part_requirements WHERE work_order_id=? AND source_key=?').run(workOrderId,`pos-line-${id}`);
}
function updateLineTotals(db,id,actor){
  db.prepare(`UPDATE work_orders SET parts_total=(SELECT COALESCE(SUM(ROUND(amount*100)),0)/100.0 FROM work_order_lines WHERE work_order_id=? AND line_type='part'),labor_total=(SELECT COALESCE(SUM(ROUND(amount*100)),0)/100.0 FROM work_order_lines WHERE work_order_id=? AND line_type='labor'),updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(id,id,id);
  applyOrderTax(db,id,actor);
}
function fullCustomer(db,id){const c=db.prepare('SELECT * FROM customers WHERE id=?').get(id);if(!c)return null;if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_customer_links'").get())c.legacy_customer_id=db.prepare('SELECT external_id FROM legacy_customer_links WHERE customer_id=?').get(id)?.external_id||null;c.vehicles=db.prepare('SELECT * FROM vehicles WHERE customer_id=? AND archived=0 ORDER BY id DESC').all(id);c.workOrders=db.prepare('SELECT id,ref_number,stage,estimate_total,vehicle_id,created_at FROM work_orders WHERE customer_id=? ORDER BY id DESC').all(id);return c;}

export function posRoutes({db, currentUser, json, readBody, requireBridge, bridgeToken, auditLog}){
  extendDatabase(db);
  return async function handle(req,res,p,url){
    if(!p.startsWith('/api/'))return false;
    const respond=(status,v)=>{json(res,status,v);return true;};
    const u=currentUser(req), deny=(permission='read')=>respond(u?403:401,{error:u?'Permission denied':'Unauthorized',permission});
    const requireRole=(pred)=>!!u&&pred(u);
    const body=async()=>await readBody(req);
    try {
      if(p==='/api/pos/customers'&&req.method==='GET'){
        if(!requireRole(directoryRead))return deny('customer_read');
        const q=asText(url.searchParams.get('q'),150), like=`%${q}%`;
        return respond(200,{customers:db.prepare("SELECT c.*, (SELECT COUNT(*) FROM vehicles v WHERE v.customer_id=c.id AND v.archived=0) vehicle_count FROM customers c WHERE c.archived=0 AND (c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.city LIKE ? OR c.postal_code LIKE ?) ORDER BY c.name LIMIT 500").all(like,like,like,like,like)});
      }
      if(p==='/api/pos/customers'&&req.method==='POST'){
        if(!requireRole(customerEdit))return deny('customer_edit');
        const b=normalizedCustomer(await body());if(!asText(b.name))return respond(400,{error:'Customer name required'});
        const r=db.prepare(`INSERT INTO customers(${customerCols.join(',')}) VALUES(${customerCols.map(()=>'?').join(',')})`).run(...customerCols.map(k=>k==='billing_same_as_service'?(b[k]??1):asText(b[k])));
        return respond(201,{customer:fullCustomer(db,Number(r.lastInsertRowid))});
      }
      const cm=p.match(/^\/api\/pos\/customers\/(\d+)$/);
      if(cm&&req.method==='GET'){if(!requireRole(directoryRead))return deny('customer_read');const x=fullCustomer(db,Number(cm[1]));return x?respond(200,{customer:x}):respond(404,{error:'Not found'});}
      if(cm&&req.method==='PATCH'){
        if(!requireRole(customerEdit))return deny('customer_edit');const id=Number(cm[1]),input=await body();
        transaction(db,()=>{
          requireEditRevision(db,req,p,input);const old=fullCustomer(db,id),b=normalizedCustomer(input,old);
          if(Object.hasOwn(b,'name')&&!asText(b.name))throw Object.assign(Error('Customer name required'),{status:400});
          updateCols(db,'customers',id,b,customerCols);const edited=db.prepare('SELECT * FROM customers WHERE id=?').get(id),preservedJobIds=[];
          for(const job of db.prepare("SELECT * FROM work_orders WHERE customer_id=? AND source='manual' AND stage NOT IN ('Closed','Picked Up','Declined')").all(id)){
            const preserve=preserveJobIdentity(db,job,{customer_name:edited.name});if(preserve)preservedJobIds.push(job.id);
            db.prepare('UPDATE work_orders SET customer_name=?,phone=?,email=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(preserve?job.customer_name:edited.name,edited.phone,edited.email,job.id);
          }
          audit(db,null,u,'Customer profile updated',{customerId:id,changedFields:Object.keys(b),preservedJobIds});
        });
        return respond(200,{customer:fullCustomer(db,id)});
      }
      if(p==='/api/pos/vehicles'&&req.method==='GET'){
        if(!requireRole(directoryRead))return deny('vehicle_read');const cid=Number(url.searchParams.get('customerId')||0);
        return respond(200,{vehicles:cid?db.prepare('SELECT * FROM vehicles WHERE customer_id=? AND archived=0 ORDER BY id DESC').all(cid):db.prepare('SELECT v.*, c.name customer_name FROM vehicles v JOIN customers c ON c.id=v.customer_id WHERE v.archived=0 ORDER BY v.id DESC LIMIT 500').all()});
      }
      if(p==='/api/pos/vehicles'&&req.method==='POST'){
        if(!requireRole(customerEdit))return deny('customer_edit');const b=await body(),id=num(b.customer_id);
        if(!db.prepare('SELECT id FROM customers WHERE id=? AND archived=0').get(id))return respond(400,{error:'Valid customer required'});
        const r=db.prepare(`INSERT INTO vehicles(customer_id,${vehicleCols.join(',')}) VALUES(?,${vehicleCols.map(()=>'?').join(',')})`).run(id,...vehicleCols.map(k=>['hours','mileage'].includes(k)?num(b[k]):asText(b[k])));
        return respond(201,{vehicle:db.prepare('SELECT * FROM vehicles WHERE id=?').get(Number(r.lastInsertRowid))});
      }
      const vm=p.match(/^\/api\/pos\/vehicles\/(\d+)$/);
      if(vm&&req.method==='PATCH'){
        if(!requireRole(customerEdit))return deny('customer_edit');const id=Number(vm[1]),b=await body();
        transaction(db,()=>{
          requireEditRevision(db,req,p,b);const old=db.prepare('SELECT * FROM vehicles WHERE id=? AND archived=0').get(id);
          if(!old)throw Object.assign(Error('Vehicle not found'),{status:404});
          if(Object.hasOwn(b,'customer_id')&&Number(b.customer_id)!==old.customer_id){
            if(db.prepare('SELECT COUNT(*) n FROM work_orders WHERE vehicle_id=?').get(id).n)throw Object.assign(Error('Cannot transfer a vehicle with work orders; preserve history'),{status:409});
            if(!db.prepare('SELECT id FROM customers WHERE id=? AND archived=0').get(Number(b.customer_id)))throw Object.assign(Error('Customer not found'),{status:400});
            db.prepare('UPDATE vehicles SET customer_id=? WHERE id=?').run(Number(b.customer_id),id);
          }
          const preservedJobIds=[];
          if(vehicleCols.some(k=>Object.hasOwn(b,k))){
            updateCols(db,'vehicles',id,b,vehicleCols);const v=db.prepare('SELECT * FROM vehicles WHERE id=?').get(id),changes={year:v.year,make:v.make,model:v.model,unit_label:[v.year,v.make,v.model].filter(Boolean).join(' ')||v.category,serial:v.vin||v.hin};
            for(const job of db.prepare("SELECT * FROM work_orders WHERE vehicle_id=? AND source='manual' AND stage NOT IN ('Closed','Picked Up','Declined')").all(id)){
              if(preserveJobIdentity(db,job,changes)){preservedJobIds.push(job.id);continue;}
              db.prepare('UPDATE work_orders SET year=?,make=?,model=?,unit_label=?,serial=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(changes.year,changes.make,changes.model,changes.unit_label,changes.serial,job.id);
            }
          }
          audit(db,null,u,'Vehicle profile updated',{vehicleId:id,changedFields:Object.keys(b),preservedJobIds});
        });
        return respond(200,{vehicle:db.prepare('SELECT * FROM vehicles WHERE id=?').get(id)});
      }
      if(p==='/api/pos/work-orders'&&req.method==='POST'){
        if(!requireRole(customerEdit))return deny('create_order');const b=await body();
        const {customer,vehicle,label}=woMeta(db,num(b.customer_id),num(b.vehicle_id));
        const stage=asText(b.stage)||'Intake';if(!validStages.has(stage))return respond(400,{error:'Invalid stage'});assertJobStageChange(null,stage);
        const ref=asText(b.ref_number,100)||`OT-${Date.now()}`;
        const r=db.prepare(`INSERT INTO work_orders(source,ref_number,customer_id,vehicle_id,customer_name,phone,email,unit_label,year,make,model,serial,complaint,authorized_work,stage,estimate_total,paid_total,balance,date_opened,priority,tax_rate_bps) VALUES('manual',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,date('now'),?,?)`).run(ref,customer.id,vehicle.id,customer.name,customer.phone,customer.email,label,vehicle.year,vehicle.make,vehicle.model,vehicle.vin||vehicle.hin,asText(b.complaint),asText(b.authorized_work),stage,num(b.estimate_total),0,num(b.estimate_total),asText(b.priority)||'normal',shopTaxBps(db));
        const id=Number(r.lastInsertRowid);db.prepare("UPDATE unit_custody SET work_order_id=? WHERE vehicle_id=? AND status='in_lot'").run(id,vehicle.id);audit(db,id,u,'Created work order',{ref,customerId:customer.id,vehicleId:vehicle.id});return respond(201,{id,ref_number:ref});
      }
      const wom=p.match(/^\/api\/pos\/work-orders\/(\d+)$/);
      if(wom&&req.method==='PATCH'){
        if(!requireRole(customerEdit))return deny('work_order_edit');const id=Number(wom[1]),b=await body();
        transaction(db,()=>{
          requireEditRevision(db,req,p,b);const old=db.prepare('SELECT * FROM work_orders WHERE id=?').get(id);
          if(repairFinancialFields.some(key=>Object.hasOwn(b,key)))assertManualRepairAccount(db,id);
          if(Object.hasOwn(b,'stage')&&!validStages.has(b.stage))throw Object.assign(Error('Invalid stage'),{status:400});assertJobStageChange(old,b.stage);
          if(Object.hasOwn(b,'paid_total'))throw Object.assign(Error('Payments must be recorded through payment ledger, not edited on work order'),{status:400});
          if(repairFinancialFields.some(key=>key!=='estimate_total'&&Object.hasOwn(b,key)))throw Object.assign(Error('Calculated totals must be changed through sale lines and the payment ledger'),{status:400});
          if(Object.hasOwn(b,'estimate_total')){
            if(db.prepare('SELECT COUNT(*) n FROM work_order_lines WHERE work_order_id=?').get(id).n>0)throw Object.assign(Error('Itemized work-order total is calculated from sales lines and tax. Edit individual sale lines instead.'),{status:409});
            const account=accountBalance(db,'repair',id,Math.round(Number(b.estimate_total)*100));
            if(account.refundDueCents>0)throw Object.assign(Error('Invoice total after credits cannot be less than confirmed payments; refund first'),{status:409});
          }
          let identityChanged=false;
          if((Object.hasOwn(b,'customer_id')&&num(b.customer_id)!==Number(old.customer_id))||(Object.hasOwn(b,'vehicle_id')&&num(b.vehicle_id)!==Number(old.vehicle_id))){
            const m=woMeta(db,num(b.customer_id??old.customer_id),num(b.vehicle_id??old.vehicle_id));
            const changes={customer_id:m.customer.id,vehicle_id:m.vehicle.id,customer_name:m.customer.name,unit_label:m.label,year:m.vehicle.year,make:m.vehicle.make,model:m.vehicle.model,serial:m.vehicle.vin||m.vehicle.hin};
            identityChanged=assertJobIdentityChange(db,old,changes);
            db.prepare('UPDATE work_orders SET customer_id=?,vehicle_id=?,customer_name=?,phone=?,email=?,unit_label=?,year=?,make=?,model=?,serial=? WHERE id=?').run(m.customer.id,m.vehicle.id,m.customer.name,m.customer.phone,m.customer.email,m.label,m.vehicle.year,m.vehicle.make,m.vehicle.model,m.vehicle.vin||m.vehicle.hin,id);
          }
          if(orderCols.some(k=>Object.hasOwn(b,k)))updateCols(db,'work_orders',id,b,orderCols);
          if(Object.hasOwn(b,'estimate_total'))syncBalance(db,id);
          audit(db,id,u,identityChanged?'Job identity corrected':'Edited work order',identityChanged?{changes:b,before:identitySnapshot(old),after:identitySnapshot(db.prepare('SELECT * FROM work_orders WHERE id=?').get(id))}:b);
        });
        return respond(200,{ok:true,id});
      }
      const linesM=p.match(/^\/api\/pos\/work-orders\/(\d+)\/lines$/);
      if(linesM&&req.method==='POST'){
        if(!requireRole(customerEdit))return deny('work_order_lines');const id=Number(linesM[1]),b=await body();
        const lineId=transaction(db,()=>{
          requireEditRevision(db,req,p,b);
          const line=saleLine(b),lines=db.prepare('SELECT amount,taxable FROM work_order_lines WHERE work_order_id=?').all(id);
          validateOrderTax(db,id,[...lines,line]);
          const r=db.prepare('INSERT INTO work_order_lines(work_order_id,line_type,item_ref,description,qty,rate,amount,cost,taxable) VALUES(?,?,?,?,?,?,?,?,?)').run(id,line.line_type,line.item_ref,line.description,line.qty,line.rate,line.amount,line.cost,line.taxable);
          const insertedId=Number(r.lastInsertRowid);updateLineParts(db,id,insertedId,line);
          updateLineTotals(db,id,u.username);audit(db,id,u,'Added sale line',b);return insertedId;
        });
        return respond(201,{ok:true,id:lineId});
      }

      // Sale lines can be edited until procurement/order receiving begins.
      const lineM=p.match(/^\/api\/pos\/lines\/(\d+)$/);
      if(lineM&&['PATCH','DELETE'].includes(req.method)){
        if(!requireRole(customerEdit))return deny('work_order_lines');
        const id=Number(lineM[1]),b=await body();
        const workOrderId=transaction(db,()=>{
          requireEditRevision(db,req,p,b);
          const old=db.prepare('SELECT * FROM work_order_lines WHERE id=?').get(id);
          const pr=db.prepare('SELECT * FROM part_requirements WHERE work_order_id=? AND source_key=?').get(old.work_order_id,`pos-line-${id}`);
          if(pr&&(pr.qty_ordered>0||pr.qty_received>0||db.prepare('SELECT COUNT(*) n FROM procurement_cart_lines WHERE part_requirement_id=?').get(pr.id).n>0))throw Object.assign(Error('Part is already in a supplier cart or ordered; reverse procurement before editing'),{status:409});
          const line=req.method==='DELETE'?null:saleLine(b,old),remaining=db.prepare('SELECT amount,taxable FROM work_order_lines WHERE work_order_id=? AND id<>?').all(old.work_order_id,id);
          validateOrderTax(db,old.work_order_id,line?[...remaining,line]:remaining);
          updateLineParts(db,old.work_order_id,id,line);
          if(line){
            db.prepare('UPDATE work_order_lines SET line_type=?,item_ref=?,description=?,qty=?,rate=?,amount=?,cost=?,taxable=? WHERE id=?').run(line.line_type,line.item_ref,line.description,line.qty,line.rate,line.amount,line.cost,line.taxable,id);
          }else db.prepare('DELETE FROM work_order_lines WHERE id=?').run(id);
          updateLineTotals(db,old.work_order_id,u.username);
          audit(db,old.work_order_id,u,line?'Edited sale line':'Deleted uncommitted sale line',line?{id,b}:{id,old});
          return old.work_order_id;
        });
        return respond(200,{ok:true,workOrderId});
      }
      // POS records transactions only. Dejavoo processes cards on its own terminal;
      // this endpoint NEVER handles card numbers and does not charge the terminal.
      if(p==='/api/pos/payments'&&req.method==='GET'){
        if(!requireRole(customerEdit))return deny('payment_read');
        const payments=db.prepare(`SELECT p.id,p.work_order_id,p.method,p.direction,p.amount_cents,p.reference,p.status,p.notes,p.created_at,p.voided_at,p.void_reason,p.actor_username,p.actor_role,p.reason,p.original_payment_id,w.ref_number,w.customer_name FROM pos_payments p JOIN work_orders w ON w.id=p.work_order_id ORDER BY p.id DESC LIMIT 1000`).all();
        const summary=db.prepare(`SELECT method,status,direction,COUNT(*) count,COALESCE(SUM(amount_cents),0) amount_cents FROM pos_payments WHERE voided_at IS NULL GROUP BY method,status,direction`).all();
        return respond(200,{payments,summary,notice:'Card transactions occur on the external Dejavoo terminal; this ledger only records references and verified funds.'});
      }
      const paymentsM=p.match(/^\/api\/pos\/work-orders\/(\d+)\/payments$/);
      if(paymentsM&&req.method==='GET'){
        if(!requireRole(customerEdit))return deny('payment_read');const id=Number(paymentsM[1]);
        if(!db.prepare("SELECT id FROM work_orders WHERE id=? AND source='manual'").get(id))return respond(404,{error:'Manual work order not found; legacy imported balances require a migration reconciliation'});
        return respond(200,{payments:paymentRows(db,'repair',id),totals:syncBalance(db,id),financialEvents:financialEvents(db,'repair',id),canRefund:canAuthorizeFinance(u),canVoid:canAuthorizeFinance(u)});
      }
      if(paymentsM&&req.method==='POST'){
        if(!requireRole(customerEdit))return deny('payment_record');
        const id=Number(paymentsM[1]),b=await body();
        const result=recordPayment(db,'repair',id,u,b,()=>syncBalance(db,id));
        return respond(result.duplicate?200:201,result);
      }
      const confirmM=p.match(/^\/api\/pos\/payments\/(\d+)\/confirm$/);
      if(confirmM&&req.method==='POST'){
        if(!requireRole(customerEdit))return deny('payment_record');
        const result=confirmPayment(db,'repair',Number(confirmM[1]),u,await body(),id=>syncBalance(db,id));
        return respond(200,result);
      }
      const voidM=p.match(/^\/api\/pos\/payments\/(\d+)\/void$/);
      if(voidM&&req.method==='POST'){
        if(!requireRole(customerEdit))return deny('payment_void');
        return respond(200,voidPayment(db,'repair',Number(voidM[1]),u,await body(),id=>syncBalance(db,id)));
      }
      const partM=p.match(/^\/api\/work-orders\/(\d+)\/parts$/);
      if(partM&&req.method==='POST'){
        if(!requireRole(techEdit))return deny('part_request');const id=Number(partM[1]),b=await body();
        const assigned=db.prepare('SELECT assigned_user_id FROM work_orders WHERE id=?').get(id);
        if(!assigned)return respond(404,{error:'Work order not found'});
        if(u.role==='technician'&&Number(assigned.assigned_user_id)!==Number(u.id))return respond(403,{error:'Not assigned to this work order'});
        const desc=asText(b.description,800),qty=num(b.qty_needed||b.qty||1),sku=asText(b.item_ref,120);
        if(!desc||qty<=0||qty>10000)return respond(400,{error:'Part description and valid quantity required'});
        const r=db.prepare('INSERT INTO part_requirements(work_order_id,source,source_key,item_ref,description,qty_needed,status,notes) VALUES(?,?,?,?,?,?,?,?)').run(id,'technician',`tech-${crypto.randomUUID()}`,sku,desc,qty,'needs_source',asText(b.notes));
        audit(db,id,u,'Requested part',{description:desc,quantity:qty,sku});return respond(201,{partId:Number(r.lastInsertRowid),status:'needs_source'});
      }
      if(p==='/api/pos/parts-board'&&req.method==='GET'){
        if(!requireRole(directoryRead))return deny('parts_read');return respond(200,{parts:db.prepare(`SELECT p.*,w.ref_number,w.customer_name,COALESCE(v.name,'Unassigned') vendor_name FROM part_requirements p JOIN work_orders w ON w.id=p.work_order_id LEFT JOIN vendors v ON v.id=p.preferred_vendor_id WHERE p.active=1 AND (p.qty_needed-p.qty_on_hand-p.qty_received)>0 ORDER BY p.id DESC LIMIT 500`).all()});
      }
      // Cart review only: exact cart membership, SKUs, quantity, price, stock are verified against the supplied snapshot.
      const review=p.match(/^\/api\/procurement\/carts\/(\d+)\/review$/);
      if(review&&req.method==='POST'){
        if(!u||!['owner','manager','advisor','parts'].includes(u.role))return deny('purchase_review');const id=Number(review[1]),b=await body();
        const cart=db.prepare('SELECT pc.*,v.name vendor_name,v.code vendor_code FROM procurement_carts pc JOIN vendors v ON v.id=pc.vendor_id WHERE pc.id=?').get(id);
        if(!cart)return respond(404,{error:'Cart missing'});
        if(cart.status!=='ready_to_submit')return respond(409,{error:'Cart must be ready to submit'});
        if(Number(cart.total)+0.00001<Number(cart.threshold_snapshot))return respond(409,{error:'Below minimum supplier threshold'});
        const lines=db.prepare('SELECT * FROM procurement_cart_lines WHERE cart_id=? ORDER BY id').all(id);
        if(!lines.length)return respond(409,{error:'Empty cart'});
        const agreed=Array.isArray(b.lines)?b.lines:[];
        if(agreed.length!==lines.length)return respond(409,{error:'Every cart line must be individually reviewed'});
        const snapshot=[];
        for(const line of lines){
          const checked=agreed.find(x=>Number(x.id)===line.id);
          if(!checked||checked.confirmed!==true||checked.vendor_sku!==line.vendor_sku||num(checked.qty)!==line.qty||Math.abs(num(checked.unit_cost)-line.unit_cost)>.001)
            return respond(409,{error:`Cart line ${line.id} changed or not confirmed`});
          if(String(line.vendor_sku).startsWith('DEMO-'))return respond(409,{error:'Demo/sample parts cannot be queued for purchasing'});
          if(!line.vendor_sku||line.qty<=0||line.unit_cost<=0||line.available_qty<line.qty)return respond(409,{error:`Supplier SKU, price or stock unverified for ${line.description}`});
          const pReq=db.prepare('SELECT qty_needed,qty_on_hand,qty_ordered,qty_received,description,item_ref FROM part_requirements WHERE id=? AND active=1').get(line.part_requirement_id);
          if(!pReq || line.qty>pReq.qty_needed-pReq.qty_on_hand-pReq.qty_ordered-pReq.qty_received+.00001)return respond(409,{error:`Quantity mismatch or duplicate purchasing risk: ${line.description}`});
          // Inventory accountability: require an issued invoice or signed approval before queueing supplier work.
          // Legacy regression fixtures can explicitly test the old mode using ALLOW_UNINVOICED_TEST_CARTS=true.
          if(process.env.ALLOW_UNINVOICED_TEST_CARTS!=='true'){
            if(!hasPurchaseBacking(db,line.work_order_id))return respond(409,{error:`Part ${line.description} needs an invoice or retained approval matching the current work and estimate`});
          }
          const vehicle=db.prepare('SELECT unit_label,year,make,model,serial,ref_number FROM work_orders WHERE id=?').get(line.work_order_id)||{};
          snapshot.push({lineId:line.id,partRequirementId:line.part_requirement_id,workOrderId:line.work_order_id,workOrder:vehicle.ref_number,vehicle:vehicle.unit_label,requestedPartNumber:pReq.item_ref,sku:line.vendor_sku,description:line.description,qty:line.qty,unitCost:line.unit_cost});
        }
        const total=Math.round(snapshot.reduce((a,x)=>a+x.qty*x.unitCost,0)*100)/100;
        if(Math.abs(total-num(cart.total))>.02)return respond(409,{error:'Cart total has changed; refresh before confirmation'});
        if(b.confirmText!==`ORDER ${cart.vendor_code}`)return respond(400,{error:`Type ORDER ${cart.vendor_code} to confirm`});
        const payload={vendor:cart.vendor_code,cartId:id,lines:snapshot,total,reviewedBy:u.username,reviewedAt:new Date().toISOString()};
        const raw=JSON.stringify(payload),sha=crypto.createHash('sha256').update(raw).digest('hex'),uuid=crypto.randomUUID();
        db.exec('BEGIN');try{
          const recent=db.prepare("SELECT id FROM purchase_commands WHERE cart_id=? AND status IN ('queued','claimed','needs_connector')").get(id);
          if(recent){db.exec('ROLLBACK');return respond(409,{error:'This cart already has a pending desktop command'});}
          assertPurchaseAuthorized(db,u,Math.round(total*100),[...new Set(snapshot.map(line=>line.workOrderId))],b.purchaseApprovalId,'purchase',makePurchaseTarget('repair',cart.vendor_id,id,lines));
          db.prepare('INSERT INTO purchase_commands(command_uuid,cart_id,reviewed_by,snapshot_json,snapshot_sha256) VALUES(?,?,?,?,?)').run(uuid,id,u.id,raw,sha);
          db.prepare("UPDATE procurement_carts SET status='manual_action_required',integration_result='Reviewed; awaiting desktop execution connector',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
          audit(db,null,u,'Purchase command queued',{cartId:id,uuid,total});db.exec('COMMIT');
        }catch(e){db.exec('ROLLBACK');throw e;}
        return respond(202,{queued:true,commandId:uuid,status:'queued',vendor:cart.vendor_code,total,requiresDesktopConnector:true});
      }
      if(p==='/api/desktop-agent/commands'&&req.method==='GET'){
        const supplied=req.headers.authorization||'';
        if(!bridgeToken||supplied!==`Bearer ${bridgeToken}`)return respond(401,{error:'Invalid desktop agent token'});
        const rows=db.prepare("SELECT command_uuid,snapshot_json,snapshot_sha256,status FROM purchase_commands WHERE status='queued' ORDER BY id LIMIT 10").all();
        return respond(200,{commands:rows.map(x=>({id:x.command_uuid,...JSON.parse(x.snapshot_json),sha256:x.snapshot_sha256,status:x.status}))});
      }
      const ack=p.match(/^\/api\/desktop-agent\/commands\/([a-f0-9-]+)\/ack$/);
      if(ack&&req.method==='POST'){
        const supplied=req.headers.authorization||'';if(!bridgeToken||supplied!==`Bearer ${bridgeToken}`)return respond(401,{error:'Invalid desktop agent token'});
        const b=await body(),status=asText(b.status);
        if(!['needs_connector','failed'].includes(status))return respond(400,{error:'Cannot claim a supplier order was placed without a verified integration receipt'});
        const cmd=db.prepare('SELECT * FROM purchase_commands WHERE command_uuid=?').get(ack[1]);if(!cmd)return respond(404,{error:'Command not found'});
        if(cmd.status!=='queued')return respond(409,{error:'Command already processed'});
        db.prepare('UPDATE purchase_commands SET status=?,agent_message=?,finished_at=CURRENT_TIMESTAMP WHERE command_uuid=?').run(status,asText(b.message,3000),ack[1]);
        return respond(200,{ok:true,status});
      }
      if(p==='/api/pos/purchase-commands'&&req.method==='GET'){
        if(!u||!['owner','manager','advisor','parts'].includes(u.role))return deny('purchase_review');
        return respond(200,{commands:db.prepare('SELECT id,command_uuid,cart_id,status,agent_message,created_at,finished_at FROM purchase_commands ORDER BY id DESC LIMIT 100').all()});
      }
    }catch(e){
      if(e.status)return respond(e.status,{error:e.message,...(e.currentRevision?{currentRevision:e.currentRevision,expectedRevision:e.expectedRevision,record:e.record}:{})});
      if(String(e).includes('UNIQUE constraint'))return respond(409,{error:'Duplicate identifier, external receipt, or VIN/HIN'});
      if(/not found|must belong|No editable|Street address|billing address|ZIP\/postal|Invalid state|Address field/.test(String(e.message)))return respond(400,{error:e.message});
      return respond(500,{error:'Operation failed',detail:process.env.NODE_ENV==='production'?undefined:String(e.message||e)});
    }
    return false;
  }
}

// Owner Tracker POS extensions: local first-party customer/vehicle records,
// manual work orders, technician parts, immutable purchase review commands.
// No supplier credentials are stored here; order execution is intentionally disabled.
import crypto from 'node:crypto';
import {installTax,shopTaxBps,defaultTaxable,applyOrderTax,calcOrderTax} from './tax.mjs';

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
}

const asText=(v,max=4000)=>String(v??'').trim().slice(0,max);
const num=v=>{const x=Number(v);return Number.isFinite(x)?x:0;};
const cents=v=>{ if(typeof v==='string'&&!/^\d+(?:\.\d{1,2})?$/.test(v.trim()))throw new Error('Amount must have at most two decimal places'); const n=Number(v); if(!Number.isFinite(n)||n<=0||n>1000000)throw new Error('Amount must be positive and at most $1,000,000');return Math.round(n*100); };
function paymentTotals(db, id){const sums=db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='confirmed' THEN CASE WHEN direction='payment' THEN amount_cents ELSE -amount_cents END ELSE 0 END),0) confirmed_cents,COALESCE(SUM(CASE WHEN status='pending' AND direction='payment' THEN amount_cents ELSE 0 END),0) pending_cents FROM pos_payments WHERE work_order_id=?`).get(id);return sums;}
function syncBalance(db,id){const x=db.prepare('SELECT estimate_total FROM work_orders WHERE id=?').get(id),t=paymentTotals(db,id);if(!x)throw new Error('Work order not found');db.prepare('UPDATE work_orders SET paid_total=?,balance=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(t.confirmed_cents/100,Math.round(Math.max(0,Math.round(x.estimate_total*100)-t.confirmed_cents))/100,id);return {paid:t.confirmed_cents/100,balance:Math.round(Math.max(0,Math.round(x.estimate_total*100)-t.confirmed_cents))/100,pending:t.pending_cents/100};}

const isOwner=u=>u&&['owner','manager'].includes(u.role);
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
function fullCustomer(db,id){const c=db.prepare('SELECT * FROM customers WHERE id=?').get(id);if(!c)return null;c.vehicles=db.prepare('SELECT * FROM vehicles WHERE customer_id=? AND archived=0 ORDER BY id DESC').all(id);c.workOrders=db.prepare('SELECT id,ref_number,stage,estimate_total,vehicle_id,created_at FROM work_orders WHERE customer_id=? ORDER BY id DESC').all(id);return c;}

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
        if(!u)return deny();
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
      if(cm&&req.method==='GET'){if(!u)return deny();const x=fullCustomer(db,Number(cm[1]));return x?respond(200,{customer:x}):respond(404,{error:'Not found'});}
      if(cm&&req.method==='PATCH'){
        if(!requireRole(customerEdit))return deny('customer_edit');const id=Number(cm[1]),old=fullCustomer(db,id);
        if(!old)return respond(404,{error:'Not found'});
        const b=normalizedCustomer(await body(),old);
        if(Object.hasOwn(b,'name')&&!asText(b.name))return respond(400,{error:'Customer name required'});
        updateCols(db,'customers',id,b,customerCols);const edited=db.prepare('SELECT * FROM customers WHERE id=?').get(id);
        db.prepare('INSERT INTO audit_log(work_order_id,actor,action,detail) VALUES(?,?,?,?)').run(null,u.username,'Customer profile updated',JSON.stringify({customerId:id,changedFields:Object.keys(b)}));db.prepare("UPDATE work_orders SET customer_name=?,phone=?,email=?,updated_at=CURRENT_TIMESTAMP WHERE customer_id=? AND source='manual' AND stage NOT IN ('Closed','Picked Up','Declined')").run(edited.name,edited.phone,edited.email,id);return respond(200,{customer:fullCustomer(db,id)});
      }
      if(p==='/api/pos/vehicles'&&req.method==='GET'){
        if(!u)return deny();const cid=Number(url.searchParams.get('customerId')||0);
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
        if(!requireRole(customerEdit))return deny('customer_edit');const id=Number(vm[1]),b=await body(),old=db.prepare('SELECT * FROM vehicles WHERE id=? AND archived=0').get(id);
        if(!old)return respond(404,{error:'Vehicle not found'});
        if(Object.hasOwn(b,'customer_id')&&Number(b.customer_id)!==old.customer_id){
          if(db.prepare('SELECT COUNT(*) n FROM work_orders WHERE vehicle_id=?').get(id).n) return respond(409,{error:'Cannot transfer a vehicle with work orders; preserve history'});
          if(!db.prepare('SELECT id FROM customers WHERE id=? AND archived=0').get(Number(b.customer_id)))return respond(400,{error:'Customer not found'});
          db.prepare('UPDATE vehicles SET customer_id=? WHERE id=?').run(Number(b.customer_id),id);
        }
        if(vehicleCols.some(k=>Object.hasOwn(b,k))){updateCols(db,'vehicles',id,b,vehicleCols);const v=db.prepare('SELECT * FROM vehicles WHERE id=?').get(id);db.prepare("UPDATE work_orders SET year=?,make=?,model=?,unit_label=?,serial=?,updated_at=CURRENT_TIMESTAMP WHERE vehicle_id=? AND source='manual' AND stage NOT IN ('Closed','Picked Up','Declined')").run(v.year,v.make,v.model,[v.year,v.make,v.model].filter(Boolean).join(' '),v.vin||v.hin,id)}
        return respond(200,{vehicle:db.prepare('SELECT * FROM vehicles WHERE id=?').get(id)});
      }
      if(p==='/api/pos/work-orders'&&req.method==='POST'){
        if(!requireRole(customerEdit))return deny('create_order');const b=await body();
        const {customer,vehicle,label}=woMeta(db,num(b.customer_id),num(b.vehicle_id));
        const stage=asText(b.stage)||'Intake';if(!validStages.has(stage))return respond(400,{error:'Invalid stage'});
        const ref=asText(b.ref_number,100)||`OT-${Date.now()}`;
        const r=db.prepare(`INSERT INTO work_orders(source,ref_number,customer_id,vehicle_id,customer_name,phone,email,unit_label,year,make,model,serial,complaint,authorized_work,stage,estimate_total,paid_total,balance,date_opened,priority,tax_rate_bps) VALUES('manual',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,date('now'),?,?)`).run(ref,customer.id,vehicle.id,customer.name,customer.phone,customer.email,label,vehicle.year,vehicle.make,vehicle.model,vehicle.vin||vehicle.hin,asText(b.complaint),asText(b.authorized_work),stage,num(b.estimate_total),0,num(b.estimate_total),asText(b.priority)||'normal',shopTaxBps(db));
        const id=Number(r.lastInsertRowid);db.prepare("UPDATE unit_custody SET work_order_id=? WHERE vehicle_id=? AND status='in_lot'").run(id,vehicle.id);audit(db,id,u,'Created work order',{ref,customerId:customer.id,vehicleId:vehicle.id});return respond(201,{id,ref_number:ref});
      }
      const wom=p.match(/^\/api\/pos\/work-orders\/(\d+)$/);
      if(wom&&req.method==='PATCH'){
        if(!requireRole(customerEdit))return deny('work_order_edit');const id=Number(wom[1]),b=await body();
        const old=db.prepare('SELECT * FROM work_orders WHERE id=?').get(id);if(!old)return respond(404,{error:'Work order not found'});
        if(b.stage&&!validStages.has(b.stage))return respond(400,{error:'Invalid stage'});if(Object.hasOwn(b,'paid_total'))return respond(400,{error:'Payments must be recorded through payment ledger, not edited on work order'});if(Object.hasOwn(b,'estimate_total')&&Math.round(num(b.estimate_total)*100)<paymentTotals(db,id).confirmed_cents)return respond(409,{error:'Invoice total cannot be less than confirmed payments; refund first'});
        if(Object.hasOwn(b,'customer_id')||Object.hasOwn(b,'vehicle_id')){
          const m=woMeta(db,num(b.customer_id??old.customer_id),num(b.vehicle_id??old.vehicle_id));
          db.prepare('UPDATE work_orders SET customer_id=?,vehicle_id=?,customer_name=?,phone=?,email=?,unit_label=?,year=?,make=?,model=?,serial=? WHERE id=?').run(m.customer.id,m.vehicle.id,m.customer.name,m.customer.phone,m.customer.email,m.label,m.vehicle.year,m.vehicle.make,m.vehicle.model,m.vehicle.vin||m.vehicle.hin,id);
        }
        if(Object.hasOwn(b,'estimate_total')&&db.prepare('SELECT COUNT(*) n FROM work_order_lines WHERE work_order_id=?').get(id).n>0)return respond(409,{error:'Itemized work-order total is calculated from sales lines and tax. Edit individual sale lines instead.'});
        if(orderCols.some(k=>Object.hasOwn(b,k)))updateCols(db,'work_orders',id,b,orderCols);
        if(Object.hasOwn(b,'estimate_total'))syncBalance(db,id);
        audit(db,id,u,'Edited work order',b);return respond(200,{ok:true,id});
      }
      const linesM=p.match(/^\/api\/pos\/work-orders\/(\d+)\/lines$/);
      if(linesM&&req.method==='POST'){
        if(!requireRole(customerEdit))return deny('work_order_lines');const id=Number(linesM[1]),b=await body();
        if(!db.prepare('SELECT id FROM work_orders WHERE id=?').get(id))return respond(404,{error:'Not found'});
        const type=asText(b.line_type)||'part';if(!['part','labor','service','other'].includes(type))return respond(400,{error:'Invalid type'});
        if(!asText(b.description))return respond(400,{error:'Description required'});
        const qty=num(b.qty)||1,rate=num(b.rate),amount=Math.round(qty*rate*100)/100;if(qty<=0||qty>10000||rate<0||!Number.isFinite(amount))return respond(400,{error:'Invalid quantity or price'});const existingSum=db.prepare('SELECT COALESCE(SUM(amount),0) n FROM work_order_lines WHERE work_order_id=?').get(id).n;if(Math.round((existingSum+amount)*100)<paymentTotals(db,id).confirmed_cents)return respond(409,{error:'Sale lines total cannot be below confirmed payments'});
        const r=db.prepare('INSERT INTO work_order_lines(work_order_id,line_type,item_ref,description,qty,rate,amount,cost,taxable) VALUES(?,?,?,?,?,?,?,?,?)').run(id,type,asText(b.item_ref),asText(b.description),qty,rate,amount,num(b.cost),b.taxable===undefined?Number(defaultTaxable(type)):Number(b.taxable===true||b.taxable==='on'||b.taxable==='true'));
        if(type==='part'){
          db.prepare('INSERT INTO part_requirements(work_order_id,source,source_key,item_ref,description,qty_needed,sell_price,status) VALUES(?,?,?,?,?,?,?,?)').run(id,'pos',`pos-line-${r.lastInsertRowid}`,asText(b.item_ref),asText(b.description),qty,amount,'needs_source');
        }
        db.prepare(`UPDATE work_orders SET parts_total=(SELECT COALESCE(SUM(amount),0) FROM work_order_lines WHERE work_order_id=? AND line_type='part'),labor_total=(SELECT COALESCE(SUM(amount),0) FROM work_order_lines WHERE work_order_id=? AND line_type='labor'),updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(id,id,id);
        applyOrderTax(db,id,u.username);audit(db,id,u,'Added sale line',b);return respond(201,{ok:true,id:Number(r.lastInsertRowid)});
      }

      // Sale lines can be edited until procurement/order receiving begins.
      const lineM=p.match(/^\/api\/pos\/lines\/(\d+)$/);
      if(lineM&&['PATCH','DELETE'].includes(req.method)){
        if(!requireRole(customerEdit))return deny('work_order_lines');
        const id=Number(lineM[1]),old=db.prepare('SELECT * FROM work_order_lines WHERE id=?').get(id);
        if(!old)return respond(404,{error:'Sale line not found'});
        const pr=db.prepare('SELECT * FROM part_requirements WHERE work_order_id=? AND source_key=?').get(old.work_order_id,`pos-line-${id}`);
        if(pr&&(pr.qty_ordered>0||pr.qty_received>0||db.prepare('SELECT COUNT(*) n FROM procurement_cart_lines WHERE part_requirement_id=?').get(pr.id).n>0))return respond(409,{error:'Part is already in a supplier cart or ordered; reverse procurement before editing'});
        if(req.method==='DELETE'){
          db.prepare('DELETE FROM part_requirements WHERE work_order_id=? AND source_key=?').run(old.work_order_id,`pos-line-${id}`);
          const linesTotal=db.prepare('SELECT COALESCE(SUM(amount),0) n FROM work_order_lines WHERE work_order_id=?').get(old.work_order_id).n;if(Math.round((linesTotal-old.amount)*100)<paymentTotals(db,old.work_order_id).confirmed_cents)return respond(409,{error:'Removing line would leave invoice below confirmed payments'});db.prepare('DELETE FROM work_order_lines WHERE id=?').run(id);
          audit(db,old.work_order_id,u,'Deleted uncommitted sale line',{id,old});
        }else{
          const b=await body();const type=asText(b.line_type??old.line_type),desc=asText(b.description??old.description),item=asText(b.item_ref??old.item_ref),qty=num(b.qty??old.qty),rate=num(b.rate??old.rate),cost=num(b.cost??old.cost);
          if(!['part','labor','service','other'].includes(type)||!desc||qty<=0)return respond(400,{error:'Invalid sale line'});
          const amount=Math.round(qty*rate*100)/100;const linesTotal=db.prepare('SELECT COALESCE(SUM(amount),0) n FROM work_order_lines WHERE work_order_id=?').get(old.work_order_id).n;if(Math.round((linesTotal-old.amount+amount)*100)<paymentTotals(db,old.work_order_id).confirmed_cents)return respond(409,{error:'Edited lines would leave invoice below confirmed payments'});
          db.prepare('UPDATE work_order_lines SET line_type=?,item_ref=?,description=?,qty=?,rate=?,amount=?,cost=?,taxable=? WHERE id=?').run(type,item,desc,qty,rate,amount,cost,b.taxable===undefined?(old.line_type===type?old.taxable:Number(defaultTaxable(type))):Number(b.taxable===true||b.taxable==='on'||b.taxable==='true'),id);
          if(type==='part'){
            db.prepare(`INSERT INTO part_requirements(work_order_id,source,source_key,item_ref,description,qty_needed,sell_price,status) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(work_order_id,source_key) DO UPDATE SET item_ref=excluded.item_ref,description=excluded.description,qty_needed=excluded.qty_needed,sell_price=excluded.sell_price`).run(old.work_order_id,'pos',`pos-line-${id}`,item,desc,qty,amount,'needs_source');
          } else if(pr)db.prepare('DELETE FROM part_requirements WHERE id=?').run(pr.id);
          audit(db,old.work_order_id,u,'Edited sale line',{id,b});
        }
        db.prepare(`UPDATE work_orders SET parts_total=(SELECT COALESCE(SUM(amount),0) FROM work_order_lines WHERE work_order_id=? AND line_type='part'),labor_total=(SELECT COALESCE(SUM(amount),0) FROM work_order_lines WHERE work_order_id=? AND line_type='labor'),updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(old.work_order_id,old.work_order_id,old.work_order_id);
        applyOrderTax(db,old.work_order_id,u.username);
        return respond(200,{ok:true,workOrderId:old.work_order_id});
      }
      // POS records transactions only. Dejavoo processes cards on its own terminal;
      // this endpoint NEVER handles card numbers and does not charge the terminal.
      if(p==='/api/pos/payments'&&req.method==='GET'){
        if(!requireRole(customerEdit))return deny('payment_read');
        const payments=db.prepare(`SELECT p.id,p.work_order_id,p.method,p.direction,p.amount_cents,p.reference,p.status,p.notes,p.created_at,w.ref_number,w.customer_name FROM pos_payments p JOIN work_orders w ON w.id=p.work_order_id ORDER BY p.id DESC LIMIT 1000`).all();
        const summary=db.prepare(`SELECT method,status,direction,COUNT(*) count,COALESCE(SUM(amount_cents),0) amount_cents FROM pos_payments GROUP BY method,status,direction`).all();
        return respond(200,{payments,summary,notice:'Card transactions occur on the external Dejavoo terminal; this ledger only records references and verified funds.'});
      }
      const paymentsM=p.match(/^\/api\/pos\/work-orders\/(\d+)\/payments$/);
      if(paymentsM&&req.method==='GET'){
        if(!u)return deny();const id=Number(paymentsM[1]);
        if(!db.prepare("SELECT id FROM work_orders WHERE id=? AND source='manual'").get(id))return respond(404,{error:'Manual work order not found; legacy imported balances require a migration reconciliation'});
        return respond(200,{payments:db.prepare('SELECT id,work_order_id,method,direction,amount_cents,reference,status,notes,verified_by,created_at FROM pos_payments WHERE work_order_id=? ORDER BY id').all(id),totals:syncBalance(db,id)});
      }
      if(paymentsM&&req.method==='POST'){
        if(!requireRole(customerEdit))return deny('payment_record');
        const id=Number(paymentsM[1]),b=await body(),method=asText(b.method,24),direction=asText(b.direction)||'payment',key=asText(b.idempotency_key,120),ref=asText(b.reference,160),status=asText(b.status)||'confirmed';
        if(!['cash','card_dejavoo','zelle'].includes(method)||!['payment','refund'].includes(direction)||!['confirmed','pending'].includes(status))return respond(400,{error:'Invalid payment method, direction or status'});
        if(!key||key.length<8)return respond(400,{error:'Unique idempotency key required'});
        // Do not trust a Zelle screenshot or a card-terminal request as money received.
        if(method==='card_dejavoo'&&(!ref||status!=='confirmed'||b.verified!==true))return respond(400,{error:'Record card only after Dejavoo APPROVED and enter receipt/transaction reference'});
        if(method==='zelle'&&status==='confirmed'&&(!ref||b.verified!==true))return respond(400,{error:'Verify Zelle funds in receiving account and enter bank reference'});
        if(method==='cash'&&status==='confirmed'&&b.verified!==true)return respond(400,{error:'Confirm cash received and counted'});
        if(direction==='refund'&&(status!=='confirmed'||!ref||b.verified!==true))return respond(400,{error:'Refund must already be completed externally, with reference'});
        let amount;try{amount=cents(b.amount);}catch(e){return respond(400,{error:e.message});}
        const old=db.prepare('SELECT id,work_order_id FROM pos_payments WHERE idempotency_key=?').get(key);
        if(old)return old.work_order_id===id?respond(200,{duplicate:true,id:old.id,totals:syncBalance(db,id)}):respond(409,{error:'Idempotency key used on another work order'});
        const wo=db.prepare("SELECT id,estimate_total FROM work_orders WHERE id=? AND source='manual'").get(id);if(!wo)return respond(404,{error:'Work order not found'});
        const t=paymentTotals(db,id),newNet=t.confirmed_cents+(status==='confirmed'?(direction==='payment'?amount:-amount):0);
        if(newNet<0)return respond(409,{error:'Refund exceeds net payments received'});
        if(direction==='refund'){
          const methodNet=db.prepare(`SELECT COALESCE(SUM(CASE WHEN direction='payment' THEN amount_cents ELSE -amount_cents END),0) net FROM pos_payments WHERE work_order_id=? AND method=? AND status='confirmed'`).get(id,method).net;
          if(amount>methodNet)return respond(409,{error:'Refund exceeds confirmed payments received via this method'});
        }
        if(newNet>Math.round(wo.estimate_total*100))return respond(409,{error:'Confirmed payment exceeds work order total; verify invoice or use adjustment workflow'});
        db.exec('BEGIN');try{
          const r=db.prepare('INSERT INTO pos_payments(work_order_id,method,direction,amount_cents,reference,idempotency_key,status,verified_by,notes) VALUES(?,?,?,?,?,?,?,?,?)').run(id,method,direction,amount,ref,key,status,u.id,asText(b.notes,500));
          const totals=syncBalance(db,id);audit(db,id,u,`Recorded ${direction} (${status})`,{method,amount:amount/100,reference:ref});db.exec('COMMIT');return respond(201,{id:Number(r.lastInsertRowid),totals,status});
        }catch(e){db.exec('ROLLBACK');throw e;}
      }
      const confirmPayment=p.match(/^\/api\/pos\/payments\/(\d+)\/confirm$/);
      if(confirmPayment&&req.method==='POST'){
        if(!requireRole(customerEdit))return deny('payment_record');const id=Number(confirmPayment[1]),b=await body(),pay=db.prepare('SELECT * FROM pos_payments WHERE id=?').get(id);
        if(!pay)return respond(404,{error:'Payment missing'});if(pay.status==='confirmed')return respond(200,{alreadyConfirmed:true,totals:syncBalance(db,pay.work_order_id)});
        if(pay.method!=='zelle'||b.verified!==true||!asText(b.reference))return respond(400,{error:'Confirm funds arrived in Zelle receiving bank and provide reference'});
        const t=paymentTotals(db,pay.work_order_id),wo=db.prepare('SELECT estimate_total FROM work_orders WHERE id=?').get(pay.work_order_id);
        if(t.confirmed_cents+pay.amount_cents>Math.round(wo.estimate_total*100))return respond(409,{error:'Confirmation exceeds invoice balance'});
        db.exec('BEGIN');try{db.prepare("UPDATE pos_payments SET status='confirmed',reference=?,verified_by=? WHERE id=? AND status='pending'").run(asText(b.reference),u.id,id);const totals=syncBalance(db,pay.work_order_id);audit(db,pay.work_order_id,u,'Verified pending Zelle',{paymentId:id});db.exec('COMMIT');return respond(200,{ok:true,totals});}catch(e){db.exec('ROLLBACK');throw e;}
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
        if(!u)return deny();return respond(200,{parts:db.prepare(`SELECT p.*,w.ref_number,w.customer_name,COALESCE(v.name,'Unassigned') vendor_name FROM part_requirements p JOIN work_orders w ON w.id=p.work_order_id LEFT JOIN vendors v ON v.id=p.preferred_vendor_id WHERE p.active=1 AND (p.qty_needed-p.qty_on_hand-p.qty_received)>0 ORDER BY p.id DESC LIMIT 500`).all()});
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
            const inv=db.prepare('SELECT id FROM ot_invoices WHERE work_order_id=? AND voided_at IS NULL LIMIT 1').get(line.work_order_id);
            const approval=db.prepare("SELECT id FROM approvals WHERE work_order_id=? AND status='approved' LIMIT 1").get(line.work_order_id);
            if(!inv&&!approval)return respond(409,{error:`Part ${line.description} has no issued invoice or signed repair authorization; purchasing blocked`});
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
      if(String(e).includes('UNIQUE constraint'))return respond(409,{error:'Duplicate identifier, external receipt, or VIN/HIN'});
      if(/not found|must belong|No editable|Street address|billing address|ZIP\/postal|Invalid state|Address field/.test(String(e.message)))return respond(400,{error:e.message});
      return respond(500,{error:'Operation failed',detail:process.env.NODE_ENV==='production'?undefined:String(e.message||e)});
    }
    return false;
  }
}

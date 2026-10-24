// OPTIONAL test fixtures. Refuses to seed a live shop database that has jobs.
import {loadEnv} from '../src/env.mjs';
import {openDb} from '../src/db.mjs';
import {extendDatabase} from '../src/pos-extension.mjs';
loadEnv();
const db=openDb(process.env.OWNERTRACKER_DB||'./data/ownertracker.sqlite');extendDatabase(db);
if(db.prepare('SELECT COUNT(*) n FROM work_orders').get().n>0){console.error('Demo seed REFUSED: work orders already exist.');process.exit(1)}
db.exec('BEGIN');
try{
 const c=Number(db.prepare("INSERT INTO customers(name,phone,email,notes) VALUES('DEMO CUSTOMER','602-555-0100','demo@example.invalid','SAMPLE ONLY — NOT A REAL CUSTOMER')").run().lastInsertRowid);
 const v=Number(db.prepare("INSERT INTO vehicles(customer_id,category,year,make,model,vin,notes) VALUES(?,'UTV','2021','Can-Am','Maverick X3','DEMO-VIN-DO-NOT-USE','Demo vehicle')").run(c).lastInsertRowid);
 const wo=Number(db.prepare("INSERT INTO work_orders(source,ref_number,customer_id,vehicle_id,customer_name,phone,email,unit_label,year,make,model,complaint,stage,estimate_total,date_opened) VALUES('manual','DEMO-WO-001',?,?, 'DEMO CUSTOMER','602-555-0100','demo@example.invalid','2021 Can-Am Maverick X3','2021','Can-Am','Maverick X3','Demo preseason inspection / order test','Diagnosing',1500,date('now'))").run(c,v).lastInsertRowid);
 const items=[
  ['WSM','DEMO-WSM-40','DEMO WSM bearing kit',40,8],['WSM','DEMO-WSM-65','DEMO WSM seal kit',65,8],
  ['BRP','DEMO-BRP-200','DEMO BRP sensor',200,6],['BRP','DEMO-BRP-75','DEMO BRP fasteners',75,25],
  ['PU','DEMO-PU-9','DEMO Parts Unlimited filter',9,20],['TMS','DEMO-TMS-4','DEMO TMS hose clamp',4,20]
 ];
 const vendors=new Map(db.prepare('SELECT * FROM vendors').all().map(v=>[v.code,v]));
 const groups=new Map();
 for(const [code,sku,desc,cost,available] of items){const vendor=vendors.get(code);const r=db.prepare('INSERT INTO part_requirements(work_order_id,source,source_key,item_ref,description,qty_needed,status) VALUES(?,?,?,?,?,1,?)').run(wo,'demo',sku,sku,desc,'in_cart');const partId=Number(r.lastInsertRowid);db.prepare('INSERT INTO supplier_offers(part_requirement_id,vendor_id,vendor_sku,available_qty,unit_cost,eta_text,source) VALUES(?,?,?,?,?,?,?)').run(partId,vendor.id,sku,available,cost,'DEMO — stock not verified','demo');if(!groups.has(code))groups.set(code,[]);groups.get(code).push({partId,sku,desc,cost,available})}
 for(const [code,parts] of groups){const vendor=vendors.get(code),total=parts.reduce((sum,p)=>sum+p.cost,0),status=total>=vendor.order_threshold?'ready_to_submit':'waiting_threshold';const cartId=Number(db.prepare('INSERT INTO procurement_carts(vendor_id,status,total,threshold_snapshot) VALUES(?,?,?,?)').run(vendor.id,status,total,vendor.order_threshold).lastInsertRowid);for(const p of parts)db.prepare('INSERT INTO procurement_cart_lines(cart_id,part_requirement_id,work_order_id,vendor_sku,description,qty,unit_cost,available_qty,eta_text) VALUES(?,?,?,?,?,1,?,?,?)').run(cartId,p.partId,wo,p.sku,p.desc,p.cost,p.available,'DEMO ONLY')}
 db.exec('COMMIT');console.log('Sample shop job created: DEMO-WO-001 (WSM $105 / BRP $275 / PU $9 / TMS $4).')
 console.log('IMPORTANT: artificial examples; prices and supplier availability are not real. Do not queue demo orders.');
}catch(e){db.exec('ROLLBACK');throw e}

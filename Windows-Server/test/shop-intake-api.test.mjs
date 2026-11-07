import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../src/db.mjs';
import {extendDatabase,posRoutes} from '../src/pos-extension.mjs';
import {installShopOps} from '../src/shop-ops.mjs';
import {configureShopRoster,listAssignmentStaff} from '../src/shop-roster.mjs';

function fixture(t){
 const db=openDb(':memory:');extendDatabase(db);installShopOps(db);t.after(()=>db.close());
 const user={id:Number(db.prepare("INSERT INTO users(username,password_hash,salt,role) VALUES('owner','hash','salt','owner')").run().lastInsertRowid),username:'owner',role:'owner'};
 const customer=Number(db.prepare("INSERT INTO customers(name,phone) VALUES('Fictional intake customer','555-0100')").run().lastInsertRowid);
 const vehicle=Number(db.prepare("INSERT INTO vehicles(id,customer_id,category,vin) VALUES(9001,?,'PWC','FICTIONAL-VIN')").run(customer).lastInsertRowid);
 const route=posRoutes({db,currentUser:()=>user,json:(res,status,body)=>Object.assign(res,{status,body}),readBody:async req=>req.body});
 const call=async(path,method='GET',body={})=>{const res={},url=new URL(path,'http://local');assert.equal(await route({method,body},res,url.pathname,url),true);return res;};
 return {db,user,customer,vehicle,call};
}

test('creating a second repair cannot steal an existing physical check-in',async t=>{
 const f=fixture(t),payload={customer_id:f.customer,vehicle_id:f.vehicle,complaint:'Fictional inspection'};
 const first=await f.call('/api/pos/work-orders','POST',payload);assert.equal(first.status,201);
 f.db.prepare("INSERT INTO unit_custody(vehicle_id,work_order_id,status,lot_location) VALUES(?,?,'in_lot','Front lot')").run(f.vehicle,first.body.id);
 const second=await f.call('/api/pos/work-orders','POST',payload);assert.equal(second.status,409);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM work_orders').get().n,1);
 assert.equal(f.db.prepare('SELECT work_order_id FROM unit_custody').get().work_order_id,first.body.id);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='Created work order'").get().n,1);
});

test('exact vehicle lookup and roster-controlled assignment work outside capped directory lists',async t=>{
 const f=fixture(t);assert.equal((await f.call('/api/pos/vehicles/9001')).body.vehicle.vin,'FICTIONAL-VIN');
 assert.equal((await f.call('/api/pos/vehicles/9999')).status,404);
 configureShopRoster(f.db,{apply:true});const staff=listAssignmentStaff(f.db);
 assert.deepEqual(staff.map(x=>x.display_name).sort(),['Jacobo Medina','Tyler Whitener']);
 const created=await f.call('/api/pos/work-orders','POST',{customer_id:f.customer,vehicle_id:f.vehicle,complaint:'Fictional intake'});
 const path='/api/pos/work-orders/'+created.body.id;
 let row=f.db.prepare('SELECT * FROM work_orders WHERE id=?').get(created.body.id);
 assert.equal((await f.call(path,'PATCH',{assigned_user_id:f.user.id,expectedRevision:row.revision})).status,400);
 assert.equal((await f.call(path,'PATCH',{assigned_user_id:staff[0].id,expectedRevision:row.revision})).status,200);
 row=f.db.prepare('SELECT * FROM work_orders WHERE id=?').get(created.body.id);
 assert.equal(row.assigned_user_id,staff[0].id);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openDb} from '../src/db.mjs';
import {extendDatabase} from '../src/pos-extension.mjs';
import {installShopOps} from '../src/shop-ops.mjs';
import {vehicleCheckinRoutes,checkinChecklist} from '../src/vehicle-checkin.mjs';
import {checkinCompletionReady,checkinDraftValues} from '../public/vehicle-checkin.js';

const key=()=>crypto.randomUUID();
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA9sAAAAASUVORK5CYII=';
function fixture(t,{disk=false}={}) {
  const dir=disk?fs.mkdtempSync(path.join(os.tmpdir(),'ownertracker-checkin-')):null;
  const filename=dir?path.join(dir,'test.sqlite'):':memory:';
  let db=openDb(filename);extendDatabase(db);installShopOps(db);
  t.after(()=>{db.close();if(dir)fs.rmSync(dir,{recursive:true,force:true});});
  const addUser=(username,role)=>({id:Number(db.prepare('INSERT INTO users(username,password_hash,salt,role) VALUES(?,?,?,?)').run(username,'fictional-hash','fictional-salt',role).lastInsertRowid),username,role});
  const owner=addUser('checkin-owner','owner'),tech=addUser('checkin-tech','technician'),otherTech=addUser('other-tech','technician');
  const customer=Number(db.prepare("INSERT INTO customers(name) VALUES('Fictional Check-in Customer')").run().lastInsertRowid);
  const otherCustomer=Number(db.prepare("INSERT INTO customers(name) VALUES('Other Fictional Customer')").run().lastInsertRowid);
  const vehicle=Number(db.prepare("INSERT INTO vehicles(customer_id,make,model,hin) VALUES(?,'Yamaha','Fictional VX','FICTIONAL-HIN-CHECKIN')").run(customer).lastInsertRowid);
  const workOrder=Number(db.prepare("INSERT INTO work_orders(customer_id,vehicle_id,ref_number,complaint,assigned_user_id) VALUES(?,?,'CHECKIN-1','Fictional inspection',?)").run(customer,vehicle,tech.id).lastInsertRowid);
  let user=owner,route;
  const wire=()=>{route=vehicleCheckinRoutes({db,currentUser:()=>user,json:(res,status,value)=>{res.status=status;res.value=value;},readBody:async req=>{if(req.wait)await req.wait;return req.body;},canAccessJob:(actor,id)=>actor.role!=='technician'||db.prepare('SELECT assigned_user_id FROM work_orders WHERE id=?').get(id)?.assigned_user_id===actor.id,
    saveImage:photo=>Number(db.prepare('INSERT INTO media(work_order_id,scope,original_name,stored_name,mime_type,size_bytes,caption,customer_visible,uploaded_by) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(photo.workOrderId,photo.scope,photo.filename,key(),photo.mimeType,Buffer.from(photo.dataBase64,'base64').length,photo.caption,photo.customerVisible?1:0,photo.userId).lastInsertRowid)});};wire();
  const call=async(endpoint,method='GET',body={},wait)=>{const url=new URL(endpoint,'http://checkin.test'),res={};const handled=await route({method,body,wait},res,url.pathname,url);assert.equal(handled,true);return res;};
  const create=async(extra={})=>{const result=await call('/api/vehicle-checkins','POST',{workOrderId:workOrder,customerId:customer,vehicleId:vehicle,requestKey:key(),...extra});assert.ok([200,201].includes(result.status),JSON.stringify(result));return result.value.checkin;};
  const save=async(row,extra={})=>{const result=await call(`/api/vehicle-checkins/${row.id}`,'PATCH',{version:row.version,lotLocation:'Dirt lot',keysTag:'No keys',conditionNotes:'No visible damage seen; no belongings left.',checklist:Object.fromEntries(checkinChecklist.map(({key})=>[key,true])),...extra});assert.equal(result.status,200,JSON.stringify(result));return result.value.checkin;};
  const photo=async(row,extra={})=>call(`/api/vehicle-checkins/${row.id}/photos`,'POST',{requestKey:key(),filename:'front.png',mimeType:'image/png',dataBase64:png,caption:'Front before service',...extra});
  const ready=async()=>{let row=await create();row=await save(row);assert.equal((await photo(row)).status,201);const second=await photo(row,{filename:'rear.png',caption:'Rear before service'});assert.equal(second.status,201);return second.value.checkin;};
  return {get db(){return db;},owner,tech,otherTech,customer,otherCustomer,vehicle,workOrder,call,create,save,photo,ready,setUser:value=>user=value,reopen:()=>{db.close();db=openDb(filename);extendDatabase(db);installShopOps(db);wire();}};
}

test('check-in roles and exact assigned-technician scope are enforced before customer data is returned',async t=>{
  const f=fixture(t),endpoint=`/api/vehicle-checkins/context?workOrderId=${f.workOrder}`;
  f.setUser(null);assert.equal((await f.call(endpoint)).status,401);
  for(const role of ['parts','viewer']){f.setUser({...f.owner,role});assert.equal((await f.call(endpoint)).status,403);}
  f.setUser(f.otherTech);assert.equal((await f.call(endpoint)).status,403);
  f.setUser(f.tech);assert.equal((await f.call(endpoint)).status,200);
  const row=await f.ready();assert.equal((await f.call(`/api/vehicle-checkins/${row.id}/complete`,'POST',{version:row.version,requestKey:key()})).status,200);
  f.setUser(f.otherTech);assert.equal((await f.call(`/api/vehicle-checkins/${row.id}`)).status,403);
});

test('ownership mismatches and closed repairs fail without creating or rebinding records',async t=>{
  const f=fixture(t);
  assert.equal((await f.call('/api/vehicle-checkins','POST',{workOrderId:f.workOrder,customerId:f.otherCustomer,vehicleId:f.vehicle,requestKey:key()})).status,409);
  f.db.prepare('UPDATE vehicles SET customer_id=? WHERE id=?').run(f.otherCustomer,f.vehicle);
  assert.equal((await f.call(`/api/vehicle-checkins/context?workOrderId=${f.workOrder}`)).status,409);
  f.db.prepare('UPDATE vehicles SET customer_id=? WHERE id=?').run(f.customer,f.vehicle);
  f.db.prepare("UPDATE work_orders SET stage='Closed' WHERE id=?").run(f.workOrder);
  assert.equal((await f.call('/api/vehicle-checkins','POST',{workOrderId:f.workOrder,customerId:f.customer,vehicleId:f.vehicle,requestKey:key()})).status,409);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vehicle_checkins').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM unit_custody').get().n,0);
});

test('server draft is durable, retry-safe, versioned and has no physical custody side effect',async t=>{
  const f=fixture(t,{disk:true}),retry=key();let row=await f.create({requestKey:retry});
  assert.equal((await f.create({requestKey:retry})).id,row.id);
  assert.equal((await f.create()).id,row.id);
  assert.equal((await f.call(`/api/vehicle-checkins/${row.id}`,'PATCH',{version:row.version,lotLocation:'North row'})).status,400);
  const oldVersion=row.version;row=await f.save(row,{lotLocation:'Front lot'});
  assert.equal((await f.call(`/api/vehicle-checkins/${row.id}`,'PATCH',{version:oldVersion,lotLocation:'Dirt lot'})).status,409);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM unit_custody').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM custody_events').get().n,0);
  f.reopen();const restored=await f.call(`/api/vehicle-checkins/${row.id}`);
  assert.equal(restored.value.checkin.lot_location,'Front lot');assert.equal(restored.value.checkin.condition_notes,row.condition_notes);
  assert.equal(restored.value.checkin.status,'draft');assert.equal(restored.value.checkin.version,oldVersion+1);
});

test('completion requires the checklist, valid parking, notes and two retained internal photos',async t=>{
  const f=fixture(t);let row=await f.create();
  const complete=()=>f.call(`/api/vehicle-checkins/${row.id}/complete`,'POST',{version:row.version,requestKey:key()});
  assert.equal((await complete()).status,400);
  row=await f.save(row,{checklist:{}});assert.equal((await complete()).status,400);
  row=await f.save(row);assert.equal((await complete()).status,400);
  assert.equal((await f.photo(row)).status,201);assert.equal((await complete()).status,400);
  assert.equal((await f.photo(row,{filename:'rear.png',caption:'Rear'})).status,201);
  const result=await complete();assert.equal(result.status,200);assert.equal(result.value.checkin.status,'completed');
  assert.equal(result.value.checkin.photos.length,2);assert.ok(result.value.checkin.photos.every(photo=>photo.url===`/api/media/${photo.id}`));
  assert.deepEqual(f.db.prepare('SELECT DISTINCT scope,customer_visible FROM media').all().map(row=>({...row})),[{scope:'checkin',customer_visible:0}]);
  assert.equal(f.db.prepare('SELECT work_order_id,status,lot_location FROM unit_custody WHERE vehicle_id=?').get(f.vehicle).work_order_id,f.workOrder);
});

test('photo retries reuse a media record and reject changed content, unsupported format and excessive size',async t=>{
  const f=fixture(t),row=await f.create(),retry=key();
  const first=await f.photo(row,{requestKey:retry}),second=await f.photo(row,{requestKey:retry});
  assert.equal(first.status,201);assert.equal(second.status,200);assert.equal(first.value.mediaId,second.value.mediaId);
  assert.equal((await f.photo(row,{requestKey:retry,caption:'Changed photo'})).status,409);
  assert.equal((await f.photo(row,{mimeType:'image/svg+xml'})).status,400);
  assert.equal((await f.photo(row,{dataBase64:Buffer.from('not an image').toString('base64')})).status,400);
  assert.equal((await f.photo(row,{dataBase64:Buffer.alloc(8_000_001).toString('base64')})).status,400);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM media').get().n,1);
});

test('a conflicting current custody binding blocks completion without altering either repair or history',async t=>{
  const f=fixture(t),row=await f.ready();
  const otherJob=Number(f.db.prepare("INSERT INTO work_orders(customer_id,vehicle_id,ref_number) VALUES(?,?,'OTHER-CHECKIN')").run(f.customer,f.vehicle).lastInsertRowid);
  f.db.prepare("INSERT INTO unit_custody(vehicle_id,work_order_id,status,checked_in_at,lot_location,keys_tag) VALUES(?,?,'in_lot','2025-01-01','Historical bay','OLD')").run(f.vehicle,otherJob);
  const result=await f.call(`/api/vehicle-checkins/${row.id}/complete`,'POST',{version:row.version,requestKey:key()});
  assert.equal(result.status,409);assert.equal(f.db.prepare('SELECT work_order_id FROM unit_custody').get().work_order_id,otherJob);
  assert.equal(f.db.prepare('SELECT status FROM vehicle_checkins').get().status,'draft');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM custody_events').get().n,0);
});

test('completed retries preserve the existing arrival time, retained approvals and released custody',async t=>{
  const f=fixture(t);
  f.db.prepare("INSERT INTO unit_custody(vehicle_id,work_order_id,status,checked_in_at,lot_location,keys_tag) VALUES(?,?,'in_lot','2025-01-01','Historical bay','OLD')").run(f.vehicle,f.workOrder);
  const approval=Number(f.db.prepare("INSERT INTO approvals(work_order_id,token_hash,status,choice,signer_name,signed_at) VALUES(?,'fictional-token','completed','Approve Repairs','Fictional Customer','2025-01-01')").run(f.workOrder).lastInsertRowid);
  const row=await f.ready(),retry=key(),endpoint=`/api/vehicle-checkins/${row.id}/complete`;
  const body={version:row.version,requestKey:retry};assert.equal((await f.call(endpoint,'POST',body)).status,200);
  assert.equal(f.db.prepare('SELECT checked_in_at FROM unit_custody').get().checked_in_at,'2025-01-01');
  assert.equal(f.db.prepare('SELECT action FROM custody_events').get().action,'check_in_documented');
  f.db.prepare("UPDATE unit_custody SET status='checked_out',checked_out_at='2026-01-02' WHERE vehicle_id=?").run(f.vehicle);
  f.db.prepare("UPDATE work_orders SET stage='Picked Up' WHERE id=?").run(f.workOrder);
  assert.equal((await f.call(endpoint,'POST',body)).status,200);
  assert.equal(f.db.prepare('SELECT status FROM unit_custody').get().status,'checked_out');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM custody_events').get().n,1);
  assert.equal(f.db.prepare('SELECT status FROM approvals WHERE id=?').get(approval).status,'completed');
  assert.equal((await f.call(`/api/vehicle-checkins/${row.id}`,'PATCH',{version:row.version,lotLocation:'Front lot'})).status,409);
  assert.throws(()=>f.db.prepare('DELETE FROM vehicle_checkins WHERE id=?').run(row.id),/retained/);
  assert.throws(()=>f.db.prepare("UPDATE vehicle_checkins SET condition_notes='Altered' WHERE id=?").run(row.id),/retained/);
  assert.throws(()=>f.db.prepare('DELETE FROM vehicle_checkin_photos WHERE checkin_id=?').run(row.id),/retained/);
  const mediaId=f.db.prepare('SELECT media_id FROM vehicle_checkin_photos WHERE checkin_id=?').get(row.id).media_id;
  assert.throws(()=>f.db.prepare("UPDATE media SET customer_visible=1,scope='approval' WHERE id=?").run(mediaId),/retained and internal/);
  assert.throws(()=>f.db.prepare("UPDATE media SET stored_name='replacement.jpg' WHERE id=?").run(mediaId),/retained and internal/);
  assert.throws(()=>f.db.prepare('DELETE FROM media WHERE id=?').run(mediaId),/retained and internal/);
});

test('concurrent request body arrival cannot overwrite a newer draft version',async t=>{
  const f=fixture(t),row=await f.create();let release;
  const waiting=new Promise(resolve=>release=resolve);
  const slow=f.call(`/api/vehicle-checkins/${row.id}`,'PATCH',{version:row.version,lotLocation:'Dirt lot'},waiting);
  const updated=await f.save(row,{lotLocation:'Front lot'});release();
  assert.equal((await slow).status,409);assert.equal(updated.lot_location,'Front lot');
  assert.equal((await f.call(`/api/vehicle-checkins/${row.id}`)).value.checkin.lot_location,'Front lot');
});

test('completion readiness mirrors staff-visible mandatory fields without treating draft photos as saved',()=>{
  const values=checkinDraftValues({lot_location:'Dirt lot',keys_tag:'No keys',condition_notes:'No visible damage; no belongings',checklist:Object.fromEntries(checkinChecklist.map(({key})=>[key,true]))});
  const keys=checkinChecklist.map(item=>item.key);
  assert.equal(checkinCompletionReady(values,2,keys),true);
  assert.equal(checkinCompletionReady(values,1,keys),false);
  assert.equal(checkinCompletionReady({...values,lotLocation:'Old bay'},2,keys),false);
  assert.equal(checkinCompletionReady({...values,checklist:{...values.checklist,identityConfirmed:false}},2,keys),false);
});

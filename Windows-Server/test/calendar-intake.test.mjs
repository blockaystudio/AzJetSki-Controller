import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../src/db.mjs';
import {extendDatabase} from '../src/pos-extension.mjs';
import {installShopOps} from '../src/shop-ops.mjs';
import {installCalendarIntake,calendarIntakeRoutes,appointmentIntakeContext,createAppointmentJob,linkAppointmentJob,phoenixDate} from '../src/calendar-intake.mjs';
import {CalendarPreparation,calendarDate,calendarSyncLabel,arrivalCard} from '../public/calendar-arrivals.js';

function fixture(t) {
  const db=openDb(':memory:');t.after(()=>db.close());extendDatabase(db);installShopOps(db);installCalendarIntake(db);
  const user={id:Number(db.prepare("INSERT INTO users(username,password_hash,salt,role) VALUES('calendar-fiction','unused','unused','owner')").run().lastInsertRowid),username:'calendar-fiction',role:'owner'};
  const customer=Number(db.prepare("INSERT INTO customers(name,phone) VALUES('Fictional Calendar Customer','555-0100')").run().lastInsertRowid);
  const otherCustomer=Number(db.prepare("INSERT INTO customers(name) VALUES('Other Fictional Calendar Customer')").run().lastInsertRowid);
  const vehicle=Number(db.prepare("INSERT INTO vehicles(customer_id,category,make,model) VALUES(?,'PWC','Fictional','Calendar Unit')").run(customer).lastInsertRowid);
  const otherVehicle=Number(db.prepare("INSERT INTO vehicles(customer_id,category,make,model) VALUES(?,'PWC','Fictional','Other Unit')").run(otherCustomer).lastInsertRowid);
  const appointment=Number(db.prepare("INSERT INTO shop_appointments(customer_id,vehicle_id,title,starts_at,ends_at,notes) VALUES(?,?,'Fictional service arrival','2026-11-07T16:00:00.000Z','2026-11-07T17:00:00.000Z','Review fictional pump complaint')").run(customer,vehicle).lastInsertRowid);
  const createJob=(customerId=customer,vehicleId=vehicle,stage='Intake')=>{const id=Number(db.prepare("INSERT INTO work_orders(source,customer_id,vehicle_id,ref_number,stage) VALUES('manual',?,?,?,?)").run(customerId,vehicleId,'FICT-'+crypto.randomUUID(),stage).lastInsertRowid);return {id,ref_number:db.prepare('SELECT ref_number FROM work_orders WHERE id=?').get(id).ref_number};};
  const routes=calendarIntakeRoutes({db,currentUser:req=>req.user,json:(res,status,body)=>{res.status=status;res.body=body;},readBody:async req=>req.body});
  const call=async(path,method='GET',body={},actingUser=user,status=200)=>{const res={},url=new URL('http://fictional.test'+path);assert.equal(await routes({method,body,user:actingUser},res,url.pathname,url),true);assert.equal(res.status,status,JSON.stringify(res.body));return res.body;};
  return {db,user,customer,otherCustomer,vehicle,otherVehicle,appointment,createJob,call,body:{customer_id:customer,vehicle_id:vehicle,ref_number:'FICT-APPT',complaint:'Review pump',estimate_total:'0.00'}};
}
const rejection=(fn,status)=>assert.throws(fn,error=>error.status === status);

test('Phoenix arrivals include both local-day boundaries without truncating customer appointments',async t=>{
  const f=fixture(t);
  for(const [title,start] of [['before','2026-11-07T06:59:59Z'],['first','2026-11-07T07:00:00Z'],['last','2026-11-08T06:59:59Z'],['after','2026-11-08T07:00:00Z']])
    f.db.prepare('INSERT INTO shop_appointments(customer_id,title,starts_at,ends_at) VALUES(?,?,?,?)').run(f.customer,title,start,new Date(Date.parse(start)+1000).toISOString());
  const result=await f.call('/api/shop/calendar-arrivals?date=2026-11-07');
  assert.deepEqual(result.appointments.map(c=>c.appointment.title),['first','Fictional service arrival','last']);
  assert.equal(result.timeZone,'America/Phoenix');assert.equal(result.source,'saved_ownertracker_appointments');
  for(const date of ['2026-02-30','2026-13-01','not-a-date'])await f.call('/api/shop/calendar-arrivals?date='+date,'GET',{},f.user,400);
  assert.equal(phoenixDate(new Date('2026-11-08T06:00:00Z')),'2026-11-07');
  assert.equal(calendarDate(new Date('2026-11-08T06:00:00Z'),1),'2026-11-08');
});

test('calendar preparation is service-desk-only, handles missing records and never calls a provider',async t=>{
  const f=fixture(t);
  await f.call('/api/shop/calendar-arrivals','GET',{},null,401);
  for(const role of ['technician','viewer','parts'])await f.call('/api/shop/calendar-arrivals','GET',{},{...f.user,role},403);
  await f.call('/api/shop/schedule/98765/intake-context','GET',{},f.user,404);
  await f.call('/api/shop/calendar-arrivals','POST',{},f.user,405);
  const ctx=await f.call(`/api/shop/schedule/${f.appointment}/intake-context`);
  assert.equal(ctx.physicalCheckIn,false);assert.equal(ctx.canPrepare,true);assert.equal(ctx.sync.hasGoogleEvent,false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM custody_events').get().n,0);
});

test('appointment context shows only owned exact-unit jobs and blocks broken/archived customer links',t=>{
  const f=fixture(t),good=f.createJob(),wrong=f.createJob(f.otherCustomer,f.otherVehicle);
  f.createJob(f.customer,f.vehicle,'Closed');
  let ctx=appointmentIntakeContext(f.db,f.appointment);
  assert.deepEqual(ctx.jobs.map(j=>j.id),[good.id]);assert.ok(!JSON.stringify(ctx).includes(wrong.ref_number));
  f.db.prepare('UPDATE shop_appointments SET vehicle_id=? WHERE id=?').run(f.otherVehicle,f.appointment);
  ctx=appointmentIntakeContext(f.db,f.appointment);assert.equal(ctx.canPrepare,false);assert.match(ctx.blockedReason,/does not belong/);
  f.db.prepare('UPDATE shop_appointments SET vehicle_id=? WHERE id=?').run(f.vehicle,f.appointment);
  f.db.prepare('UPDATE customers SET archived=1 WHERE id=?').run(f.customer);
  ctx=appointmentIntakeContext(f.db,f.appointment);assert.equal(ctx.canPrepare,false);assert.deepEqual(ctx.jobs,[]);assert.deepEqual(ctx.vehicles,[]);
});

test('existing-job preparation retains one audited immutable link without check-in or Google sync changes',async t=>{
  const f=fixture(t),job=f.createJob(),body={workOrderId:job.id,customerId:f.customer,vehicleId:f.vehicle};
  const before=f.db.prepare('SELECT * FROM shop_appointments WHERE id=?').get(f.appointment);
  const first=await f.call(`/api/shop/schedule/${f.appointment}/intake-job`,'POST',body);
  assert.equal(first.duplicate,false);assert.equal(first.checkinUrl,`/vehicle-checkin.html?workOrderId=${job.id}&appointmentId=${f.appointment}`);
  const retry=await f.call(`/api/shop/schedule/${f.appointment}/intake-job`,'POST',body);
  assert.equal(retry.duplicate,true);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM audit_log WHERE action=?').get('Appointment intake prepared').n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM unit_custody').get().n,0);
  assert.deepEqual(f.db.prepare('SELECT * FROM shop_appointments WHERE id=?').get(f.appointment),before);
  assert.throws(()=>f.db.prepare('DELETE FROM appointment_intake_links').run(),/retained/);
  assert.throws(()=>f.db.prepare('UPDATE appointment_intake_links SET work_order_id=?').run(job.id),/retained/);
  const ctx=appointmentIntakeContext(f.db,f.appointment);assert.equal(ctx.linkedJob.id,job.id);assert.equal(ctx.physicalCheckIn,false);
});

test('wrong customer, wrong unit, closed repair, cancellation and a different replay cannot prepare an appointment',t=>{
  const f=fixture(t),good=f.createJob(),wrong=f.createJob(f.otherCustomer,f.otherVehicle),closed=f.createJob(f.customer,f.vehicle,'Closed');
  const body={workOrderId:good.id,customerId:f.customer,vehicleId:f.vehicle};
  for(const bad of [{...body,customerId:f.otherCustomer},{...body,vehicleId:f.otherVehicle},{...body,workOrderId:wrong.id},{...body,workOrderId:closed.id}])
    rejection(()=>linkAppointmentJob(f.db,f.user,f.appointment,bad),409);
  f.db.prepare("UPDATE shop_appointments SET status='cancelled' WHERE id=?").run(f.appointment);
  rejection(()=>linkAppointmentJob(f.db,f.user,f.appointment,body),409);
  f.db.prepare("UPDATE shop_appointments SET status='scheduled' WHERE id=?").run(f.appointment);
  linkAppointmentJob(f.db,f.user,f.appointment,body);
  const second=f.createJob();rejection(()=>linkAppointmentJob(f.db,f.user,f.appointment,{...body,workOrderId:second.id}),409);
  assert.equal(f.db.prepare('SELECT work_order_id FROM appointment_intake_links WHERE appointment_id=?').get(f.appointment).work_order_id,good.id);
});

test('atomic create retains a single repair across identical retries and rejects changed intake',t=>{
  const f=fixture(t);let creates=0;
  const create=()=>{creates++;return f.createJob();};
  const first=createAppointmentJob(f.db,f.user,f.appointment,f.body,create);
  const retry=createAppointmentJob(f.db,f.user,f.appointment,{...f.body},create);
  assert.equal(first.duplicate,false);assert.equal(retry.duplicate,true);assert.equal(retry.id,first.id);assert.equal(creates,1);
  rejection(()=>createAppointmentJob(f.db,f.user,f.appointment,{...f.body,complaint:'Changed complaint'},create),409);
  assert.equal(creates,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM work_orders').get().n,1);
});

test('creation and preparation rollback together on callback failure and compose with an outer transaction',t=>{
  const f=fixture(t);
  assert.throws(()=>createAppointmentJob(f.db,f.user,f.appointment,f.body,()=>{f.createJob();throw Error('fictional failure');}),/fictional failure/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM work_orders').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointment_intake_links').get().n,0);
  f.db.exec('BEGIN IMMEDIATE');
  createAppointmentJob(f.db,f.user,f.appointment,f.body,()=>f.createJob());
  assert.equal(f.db.isTransaction,true);f.db.exec('ROLLBACK');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM work_orders').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointment_intake_links').get().n,0);
});

test('new appointment job cannot overwrite another on-site job association',t=>{
  const f=fixture(t),job=f.createJob();
  f.db.prepare("INSERT INTO unit_custody(vehicle_id,work_order_id,status,lot_location) VALUES(?,?,'in_lot','Fictional bay')").run(f.vehicle,job.id);
  let calls=0;rejection(()=>createAppointmentJob(f.db,f.user,f.appointment,f.body,()=>{calls++;return f.createJob();}),409);
  assert.equal(calls,0);assert.equal(f.db.prepare('SELECT work_order_id FROM unit_custody').get().work_order_id,job.id);
});

test('unassigned appointment allows an owned vehicle choice but never another customer’s unit',t=>{
  const f=fixture(t);f.db.prepare('UPDATE shop_appointments SET vehicle_id=NULL WHERE id=?').run(f.appointment);
  assert.equal(appointmentIntakeContext(f.db,f.appointment).vehicle,null);
  rejection(()=>createAppointmentJob(f.db,f.user,f.appointment,{...f.body,vehicle_id:f.otherVehicle},()=>f.createJob()),409);
  const created=createAppointmentJob(f.db,f.user,f.appointment,f.body,()=>f.createJob());
  const ctx=appointmentIntakeContext(f.db,f.appointment);assert.equal(ctx.vehicle.id,f.vehicle);assert.equal(ctx.linkedJob.id,created.id);
});

test('a changed appointment/customer or a changed saved job blocks retained preparation without exposing another job',t=>{
  const f=fixture(t),job=f.createJob();linkAppointmentJob(f.db,f.user,f.appointment,{workOrderId:job.id,customerId:f.customer,vehicleId:f.vehicle});
  f.db.prepare('UPDATE work_orders SET customer_id=?,vehicle_id=? WHERE id=?').run(f.otherCustomer,f.otherVehicle,job.id);
  let ctx=appointmentIntakeContext(f.db,f.appointment);assert.equal(ctx.canPrepare,false);assert.equal(ctx.linkedJob,null);
  f.db.prepare('UPDATE shop_appointments SET customer_id=?,vehicle_id=? WHERE id=?').run(f.otherCustomer,f.otherVehicle,f.appointment);
  ctx=appointmentIntakeContext(f.db,f.appointment);assert.equal(ctx.canPrepare,false);assert.equal(ctx.linkedJob,null);
});

const context=()=>({appointment:{id:11,customer_id:21,vehicle_id:31,title:'Fictional <arrival>',starts_at:'2026-11-07T16:00:00Z',ends_at:'2026-11-07T17:00:00Z'},customer:{id:21,name:'Fictional Customer'},vehicle:{id:31,customer_id:21},vehicles:[{id:31,customer_id:21}],jobs:[{id:41,customer_id:21,vehicle_id:31,ref_number:'FICT-41',stage:'Intake'}],canPrepare:true,linkedJob:null,custody:null,sync:{hasGoogleEvent:false,status:'local_only'},intakeUrl:'/intake.html?appointmentId=11'});

test('calendar UI guards exact customer and vehicle before saving and blocks double submit',async()=>{
  const ctx=context(),calls=[];let release;
  const gate=new Promise(resolve=>release=resolve);
  const state=new CalendarPreparation({request:async(...args)=>{calls.push(args);await gate;return {ok:true,workOrderId:41};}});
  const first=state.prepare(ctx,41);assert.equal(await state.prepare(ctx,41),false);assert.equal(calls.length,1);
  release();assert.equal(await first,'/vehicle-checkin.html?workOrderId=41&appointmentId=11');
  assert.deepEqual(calls[0],['/api/shop/schedule/11/intake-job','POST',{workOrderId:41,customerId:21,vehicleId:31}]);
  await assert.rejects(state.prepare({...ctx,jobs:[{...ctx.jobs[0],customer_id:99}]},41),/exact appointment/);
  await assert.rejects(state.prepare({...ctx,appointment:{...ctx.appointment,vehicle_id:99}},41),/exact appointment/);
});

test('uncertain calendar link survives reload and must recover exact saved identity before another choice',async()=>{
  const ctx=context();let saved;
  const state=new CalendarPreparation({persist:draft=>saved=structuredClone(draft),request:async()=>{throw Error('Lost response');}});
  await assert.rejects(state.prepare(ctx,41),/Lost/);assert.equal(await state.prepare(ctx,41),false);
  const restored=new CalendarPreparation({draft:saved,request:async()=>({...ctx,linkedJob:{id:41,customer_id:21,vehicle_id:31}})});
  assert.equal((await restored.recover()).checkinUrl,'/vehicle-checkin.html?workOrderId=41&appointmentId=11');assert.equal(restored.pending,null);
  const wrong=new CalendarPreparation({draft:saved,request:async()=>({...ctx,linkedJob:{id:99,customer_id:21,vehicle_id:31}})});
  await assert.rejects(wrong.recover(),/different repair/);assert.ok(wrong.pending);
});

test('calendar display never equates a scheduled or local-only appointment with Google sync or physical arrival',()=>{
  const ctx=context(),html=arrivalCard(ctx);
  assert.match(html,/Not physically checked in/);assert.match(html,/no confirmed Google event/);assert.match(html,/Fictional &lt;arrival&gt;/);
  assert.equal(calendarSyncLabel({hasGoogleEvent:false,status:'synced'}),'Saved locally · no confirmed Google event');
  assert.equal(calendarSyncLabel({hasGoogleEvent:true,status:'synced'}),'Google sync confirmed');
  assert.match(calendarSyncLabel({hasGoogleEvent:true,status:'conflict'}),/needs review/);
});

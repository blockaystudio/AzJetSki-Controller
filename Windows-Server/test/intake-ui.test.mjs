import test from 'node:test';
import assert from 'node:assert/strict';
import {IntakeSession, intakeRoles} from '../public/intake-ui.js';

const customer = {id:21,name:'Fictional Intake Customer',address_line1:'123 Example Way',city:'Phoenix',state:'AZ',postal_code:'85027'};
const unit = {id:31,customer_id:21,make:'Example Marine',model:'Second Unit'};
const job = {id:41,ref_number:'OT-FICTIONAL'};
const failure = (message, status) => Object.assign(Error(message), status ? {status} : {});
function fixture({intercept=async()=>null,draft={}}={}) {
  const requests=[],snapshots=[];
  const session=new IntakeSession({draft,persist:state=>snapshots.push(structuredClone(state)),request:async(path,method='GET',body,record)=>{
    const call={path,method,body,record};requests.push(call);
    const result=await intercept(call);if(result)return result;
    if(path==='/api/pos/customers')return {customer};
    if(path==='/api/pos/vehicles')return {vehicle:unit};
    if(path==='/api/pos/work-orders')return {...job,ref_number:body.ref_number};
    if(path==='/api/shop/queues')return {inLot:[]};
    if(path===`/api/work-orders/${job.id}`)return {workOrder:{...job,revision:7,customer_id:customer.id,vehicle_id:unit.id,assigned_user_id:method==='PATCH'?body.assigned_user_id:null}};
    if(path.endsWith('/check-in'))return {ok:true,status:'in_lot'};
    throw Error('Unexpected request: '+path);
  }});
  return {session,requests,snapshots,posts:()=>requests.filter(call=>call.method==='POST')};
}
const prepared = extra => ({customer,unit,step:4,jobDraft:{complaint:'Fictional pump diagnosis',estimate_total:'100.50',assigned_user_id:'9',priority:'normal'},custodyDraft:{checkIn:true,lotLocation:'Example Bay 2',keysTag:'TEST-4'},dirty:true,...extra});

test('new customer → vehicle → assigned repair → check-in retains every accepted identity',async()=>{
  const f=fixture();
  await f.session.createCustomer(customer);
  assert.equal(f.session.state.customer.id,21);
  assert.equal(f.session.state.step,2);
  await f.session.createUnit({make:unit.make,model:unit.model});
  assert.equal(f.session.state.unit.id,31);
  assert.equal(f.session.state.step,3);
  Object.assign(f.session.state,prepared());
  await f.session.finish();
  assert.equal(f.session.state.complete,true);
  assert.equal(f.session.state.dirty,false);
  assert.deepEqual(f.posts().map(call=>call.path),['/api/pos/customers','/api/pos/vehicles','/api/pos/work-orders','/api/shop/vehicles/31/check-in']);
  assert.equal(f.posts()[1].body.customer_id,customer.id);
  const create=f.posts()[2];
  assert.equal(create.body.customer_id,21);assert.equal(create.body.vehicle_id,31);assert.equal(create.body.estimate_total,'100.50');
  assert.match(create.body.ref_number,/^OT-[A-F\d]{8}$/);
  const assignment=f.requests.find(call=>call.method==='PATCH');
  assert.equal(assignment.record.revision,7);assert.equal(assignment.body.assigned_user_id,9);
  assert.ok(f.snapshots.some(s=>s.job?.id===41&&!s.assignmentDone&&!s.checkinDone));
  assert.deepEqual(f.posts().at(-1).body,{workOrderId:41,lotLocation:'Example Bay 2',keysTag:'TEST-4',notes:''});
});

test('existing customer can add a second vehicle without recreating the customer',async()=>{
  const f=fixture({draft:{customer}});
  await f.session.createUnit({make:'Example Marine',model:'Second Unit'});
  assert.equal(f.session.state.customer.id,21);
  assert.equal(f.session.state.unit.id,31);
  assert.deepEqual(f.posts().map(call=>call.path),['/api/pos/vehicles']);
});

test('recoverable vehicle validation failure preserves saved customer and draft for explicit retry',async()=>{
  let failures=1;
  const f=fixture({draft:{customer,unitDraft:{make:'Example',model:'Retained'}},intercept:async call=>{
    if(call.path==='/api/pos/vehicles'&&failures--)throw failure('Vehicle fields invalid',400);
  }});
  await assert.rejects(f.session.createUnit(f.session.state.unitDraft),/invalid/);
  assert.equal(f.session.state.customer.id,21);assert.equal(f.session.state.unit,null);
  assert.equal(f.session.state.unitDraft.model,'Retained');assert.equal(f.session.state.uncertain,null);
  await f.session.createUnit(f.session.state.unitDraft);
  assert.equal(f.session.state.unit.id,31);assert.equal(f.posts().length,2);
});

test('double submit while a creation is pending sends one request',async()=>{
  let release,entered;
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const f=fixture({intercept:async call=>{if(call.path==='/api/pos/customers'){entered();await gate;}}});
  const first=f.session.createCustomer(customer);await started;
  assert.equal(await f.session.createCustomer(customer),false);
  assert.equal(f.posts().length,1);
  release();await first;
  assert.equal(f.session.state.customer.id,21);
});

for(const kind of ['customer','unit','job'])test(`unknown ${kind} save blocks a second mutation and survives a restored draft`,async()=>{
  const f=fixture({draft:kind==='job'?prepared():kind==='unit'?{customer}:{},intercept:async call=>{
    if(call.method==='POST')throw Error('Connection lost after sending request');
  }});
  const save=()=>kind==='customer'?f.session.createCustomer(customer):kind==='unit'?f.session.createUnit(unit):f.session.finish();
  await assert.rejects(save(),/Connection lost/);
  assert.equal(f.session.state.uncertain.kind,kind);assert.equal(await save(),false);
  assert.equal(f.posts().length,1);
  const restored=fixture({draft:structuredClone(f.session.state)});
  assert.equal(await restored.session.finish(),false);assert.equal(restored.posts().length,0);
  if(kind!=='customer')assert.equal(f.session.state.customer.id,21);
  if(kind==='job'){assert.equal(f.session.state.unit.id,31);assert.ok(f.session.state.jobRef);}
});

test('reload during in-flight mutation becomes uncertain and does not replay',async()=>{
  const f=fixture({draft:{...prepared(),pending:'job'}});
  assert.equal(f.session.state.uncertain.kind,'job');
  assert.equal(await f.session.finish(),false);assert.equal(f.posts().length,0);
});

test('missing success identity and HTTP 500 are treated as unknown outcomes',async()=>{
  for(const problem of ['missing','server']){
    const f=fixture({intercept:async()=>{if(problem==='server')throw failure('Server failed after save',500);return {};}});
    await assert.rejects(f.session.createCustomer(customer));
    assert.equal(f.session.state.uncertain.kind,'customer');
    assert.equal(await f.session.createCustomer(customer),false);
    assert.equal(f.posts().length,1);
  }
});

test('known assignment failure retains repair identity and retries only the remaining assignment',async()=>{
  let failures=1;
  const f=fixture({draft:prepared(),intercept:async call=>{if(call.method==='PATCH'&&failures--)throw failure('Assignment rejected',400);}});
  await assert.rejects(f.session.finish(),/rejected/);
  assert.equal(f.session.state.job.id,41);assert.equal(f.session.state.complete,false);
  await f.session.finish();
  assert.equal(f.session.state.complete,true);
  assert.equal(f.posts().filter(call=>call.path==='/api/pos/work-orders').length,1);
  assert.equal(f.requests.filter(call=>call.path==='/api/work-orders/41'&&call.method==='GET').length,1);
  assert.deepEqual(f.requests.filter(call=>call.method==='PATCH').map(call=>call.record.revision),[7,7]);
});

test('unknown or conflicted assignment preserves saved job and blocks automatic replays',async()=>{
  for(const status of [undefined,409]){
    const f=fixture({draft:prepared(),intercept:async call=>{if(call.method==='PATCH')throw failure('Assignment response unavailable',status);}});
    await assert.rejects(f.session.finish());
    assert.equal(f.session.state.job.id,41);assert.equal(f.session.state.uncertain.kind,'assignment');
    assert.equal(await f.session.finish(),false);
    assert.equal(f.requests.filter(call=>call.method==='PATCH').length,1);
    assert.equal(f.posts().filter(call=>call.path.endsWith('/check-in')).length,0);
  }
});

test('already checked-in vehicle uses backend job association without duplicate custody request',async()=>{
  const f=fixture({draft:prepared(),intercept:async call=>call.path==='/api/shop/queues'?{inLot:[{vehicle_id:31,work_order_id:41,lot_location:'Existing Bay',keys_tag:'Existing Key'}]}:null});
  await f.session.finish();
  assert.equal(f.session.state.complete,true);assert.equal(f.session.state.onSite.lot_location,'Existing Bay');
  assert.equal(f.posts().filter(call=>call.path.endsWith('/check-in')).length,0);
});

test('uncertain check-in keeps repair and assignment saved and never resubmits custody',async()=>{
  const f=fixture({draft:prepared(),intercept:async call=>{if(call.path.endsWith('/check-in'))throw Error('Lost check-in response');}});
  await assert.rejects(f.session.finish(),/Lost/);
  assert.equal(f.session.state.job.id,41);assert.equal(f.session.state.assignmentDone,true);
  assert.equal(f.session.state.uncertain.kind,'checkin');
  assert.equal(await f.session.finish(),false);
  assert.equal(f.posts().filter(call=>call.path.endsWith('/check-in')).length,1);
});

test('different on-site job association stops intake without writing duplicate custody',async()=>{
  const f=fixture({draft:prepared(),intercept:async call=>call.path==='/api/shop/queues'?{inLot:[{vehicle_id:31,work_order_id:99}]}:null});
  await assert.rejects(f.session.finish(),/different repair/);
  assert.equal(f.session.state.uncertain.kind,'checkin');
  assert.equal(f.posts().filter(call=>call.path.endsWith('/check-in')).length,0);
});

test('vehicle ownership mismatch is rejected before any creation',async()=>{
  const f=fixture({draft:prepared({unit:{...unit,customer_id:999}})});
  await assert.rejects(f.session.finish(),/customer’s vehicle/);
  assert.equal(f.posts().length,0);
  assert.deepEqual(intakeRoles,['owner','manager','service_writer','advisor']);
  assert.equal(intakeRoles.includes('technician'),false);
});

test('optional check-in can be skipped and finished intake cannot be resubmitted',async()=>{
  const f=fixture({draft:prepared({custodyDraft:{checkIn:false},jobDraft:{complaint:'Fictional',estimate_total:'0.00',assigned_user_id:''}})});
  await f.session.finish();assert.equal(f.session.state.complete,true);
  assert.equal(f.posts().length,1);assert.equal(await f.session.finish(),false);
  assert.equal(f.posts().length,1);
});

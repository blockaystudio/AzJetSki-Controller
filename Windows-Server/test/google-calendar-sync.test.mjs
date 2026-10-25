import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../src/db.mjs';
import {extendDatabase} from '../src/pos-extension.mjs';
import {installShopOps} from '../src/shop-ops.mjs';
import {syncAppointmentChange,resolveAppointmentConflict,calendarChangeRoutes} from '../src/google-calendar.mjs';

function fixture(t) {
  const vars={GOOGLE_CALENDAR_CLIENT_ID:'test-client',GOOGLE_CALENDAR_CLIENT_SECRET:'test-secret',GOOGLE_CALENDAR_REDIRECT_URL:'https://shop.example.test/api/shop/google-calendar/callback',GOOGLE_CALENDAR_TOKEN_KEY:'a'.repeat(64)};
  const before=Object.fromEntries(Object.keys(vars).map(key=>[key,process.env[key]]));Object.assign(process.env,vars);
  t.after(()=>{for(const key of Object.keys(vars)){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}});
  const db=openDb(':memory:');extendDatabase(db);installShopOps(db);t.after(()=>db.close());
  const user={id:Number(db.prepare("INSERT INTO users(username,password_hash,salt,role) VALUES('owner','hash','salt','owner')").run().lastInsertRowid),username:'owner',role:'owner'};
  const id=Number(db.prepare("INSERT INTO shop_appointments(title,starts_at,ends_at,notes,status,created_by) VALUES('Diagnostic booking','2026-11-01T16:00:00.000Z','2026-11-01T17:00:00.000Z','Local diagnostic details','scheduled',?)").run(user.id).lastInsertRowid);
  db.prepare("INSERT INTO google_calendar_connection(id,email,encrypted_refresh_token) VALUES(1,'shop@example.test','not-used-with-mock')").run();
  const row=()=>db.prepare('SELECT * FROM shop_appointments WHERE id=?').get(id);
  const linked=()=>{db.prepare('UPDATE shop_appointments SET google_event_id=?,google_event_etag=? WHERE id=?').run('event-one','"v1"',id);};
  const event=(extra={})=>({id:'event-one',etag:'"v1"',summary:'Old booking title',description:'Keep this remote detail',start:{dateTime:'2026-11-01T16:00:00.000Z'},end:{dateTime:'2026-11-01T17:00:00.000Z'},extendedProperties:{private:{ownerTrackerAppointmentId:String(id)}},...extra});
  const response=(status,body={})=>({status,ok:status>=200&&status<300,json:async()=>body});
  const options=fetchImpl=>({fetchImpl,tokenProvider:async()=>'mock-access-token'});
  return {db,id,user,row,linked,event,response,options};
}

test('calendar insertion retains etag; later reschedule PATCH is conditional and preserves remote description',async t=>{
  const f=fixture(t),calls=[];
  const inserted=await syncAppointmentChange(f.db,f.id,f.options(async(url,options)=>{calls.push({url,...options});return f.response(200,{...JSON.parse(options.body),etag:'"v1"'});}));
  assert.equal(inserted.status,'synced');assert.equal(f.row().google_event_etag,'"v1"');
  const eventId=f.row().google_event_id;
  f.db.prepare("UPDATE shop_appointments SET title='Rescheduled booking' WHERE id=?").run(f.id);
  const result=await syncAppointmentChange(f.db,f.id,f.options(async(url,options)=>{
    calls.push({url,...options});
    if(!options.method)return f.response(200,f.event({id:eventId}));
    assert.equal(options.method,'PATCH');assert.equal(options.headers['if-match'],'"v1"');assert.equal(JSON.parse(options.body).description,undefined);
    return f.response(200,f.event({id:eventId,summary:'Rescheduled booking',etag:'"v2"'}));
  }));
  assert.equal(result.status,'synced');assert.equal(f.row().google_event_etag,'"v2"');assert.equal(calls.filter(call=>call.method==='POST').length,1);
});

test('calendar cancellation DELETE uses If-Match and missing remote events are idempotent',async t=>{
  const f=fixture(t);f.linked();f.db.prepare("UPDATE shop_appointments SET status='cancelled' WHERE id=?").run(f.id);
  let deleted=0;
  const result=await syncAppointmentChange(f.db,f.id,f.options(async(_url,options)=>{
    if(!options.method)return f.response(200,f.event());
    assert.equal(options.method,'DELETE');assert.equal(options.headers['if-match'],'"v1"');deleted++;return f.response(204);
  }));
  assert.equal(result.status,'cancelled_synced');assert.equal(deleted,1);
  const retry=await syncAppointmentChange(f.db,f.id,f.options(async()=>f.response(410)));
  assert.equal(retry.status,'cancelled_synced');assert.equal(f.row().status,'cancelled');
});

test('remote edits and racing 412 responses create conflicts rather than overwriting',async t=>{
  const f=fixture(t);f.linked();
  let count=0;
  const remote=await syncAppointmentChange(f.db,f.id,f.options(async()=>{count++;return f.response(200,f.event({etag:'"other-edit"'}));}));
  assert.equal(remote.status,'conflict');assert.equal(count,1);assert.equal(f.row().sync_status,'conflict');
  const racing=await syncAppointmentChange(f.db,f.id,f.options(async(_url,options)=>options.method?f.response(412):f.response(200,f.event())));
  assert.equal(racing.status,'conflict');assert.match(racing.reason,/during this update/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM google_calendar_conflicts').get().n,2);
});

test('uncertain successful PATCH is acknowledged by matching remote schedule without applying it twice',async t=>{
  const f=fixture(t);f.linked();let count=0;
  const result=await syncAppointmentChange(f.db,f.id,f.options(async(_url,options)=>{
    count++;assert.equal(options.method,undefined);return f.response(200,f.event({summary:f.row().title,etag:'"already-applied"'}));
  }));
  assert.equal(result.synced,true);assert.equal(count,1);assert.equal(f.row().google_event_etag,'"already-applied"');
});

test('disconnected appointments remain local and provider errors retain a retryable error state',async t=>{
  const f=fixture(t);f.linked();f.db.prepare('DELETE FROM google_calendar_connection').run();
  const local=await syncAppointmentChange(f.db,f.id,f.options(async()=>{throw Error('Must not call Google');}));
  assert.equal(local.status,'local_only');assert.equal(local.synced,false);
  f.db.prepare("INSERT INTO google_calendar_connection(id,email,encrypted_refresh_token) VALUES(1,'shop@example.test','not-used')").run();
  await assert.rejects(syncAppointmentChange(f.db,f.id,f.options(async()=>f.response(500))),/HTTP 500/);
  assert.equal(f.row().sync_status,'error');
});

test('owner-reviewed conflict resolution checks remote version and preserves a newer local edit',async t=>{
  const f=fixture(t);f.linked();
  await assert.rejects(resolveAppointmentConflict(f.db,f.id,{decision:'adopt_remote',expectedRemoteEtag:'"v1"',reason:'Review update',user:{...f.user,role:'advisor'}}),error=>error.status===403);
  const adopted=await resolveAppointmentConflict(f.db,f.id,{decision:'adopt_remote',expectedRemoteEtag:'"v1"',reason:'Reviewed calendar booking',user:f.user,...f.options(async()=>f.response(200,f.event({summary:'External new title'})))});
  assert.equal(adopted.status,'synced');assert.equal(f.row().title,'External new title');
  const changed=await resolveAppointmentConflict(f.db,f.id,{decision:'adopt_remote',expectedRemoteEtag:'"v1"',reason:'Reviewed calendar booking',user:f.user,...f.options(async()=>{
    f.db.prepare("UPDATE shop_appointments SET title='Newer desk edit' WHERE id=?").run(f.id);return f.response(200,f.event({summary:'External old title'}));
  })});
  assert.equal(changed.status,'conflict');assert.equal(f.row().title,'Newer desk edit');
});

test('calendar conflict review endpoints are owner/manager-only and require explicit confirmation',async t=>{
  const f=fixture(t);f.linked();
  await syncAppointmentChange(f.db,f.id,f.options(async()=>f.response(200,f.event({etag:'"foreign-edit"',summary:'Google-side title'}))));
  let user=null;
  const route=calendarChangeRoutes({db:f.db,currentUser:()=>user,json:(res,status,value)=>{res.status=status;res.value=value;},readBody:async req=>req.body});
  const call=async(path,method='GET',body={})=>{const res={};await route({method,body},res,path);return res;};
  assert.equal((await call('/api/shop/google-calendar/conflicts')).status,401);
  user={...f.user,role:'advisor'};assert.equal((await call('/api/shop/google-calendar/conflicts')).status,403);
  user=f.user;const list=await call('/api/shop/google-calendar/conflicts');assert.equal(list.status,200);
  assert.equal(list.value.conflicts[0].remote.title,'Google-side title');assert.equal(list.value.conflicts[0].local.title,f.row().title);
  assert.equal((await call(`/api/shop/schedule/${f.id}/google-conflict`,'POST',{confirm:'true'})).status,400);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../src/db.mjs';
import {extendDatabase} from '../src/pos-extension.mjs';
import {installShopOps,shopOpsRoutes} from '../src/shop-ops.mjs';
import {startGoogleAuth,completeGoogleAuth,googleStatus,pushAppointment} from '../src/google-calendar.mjs';

function fixture(t){
 const vars={GOOGLE_CALENDAR_CLIENT_ID:'fictional-client',GOOGLE_CALENDAR_CLIENT_SECRET:'fictional-secret',GOOGLE_CALENDAR_REDIRECT_URL:'https://shop.example.test/api/shop/google-calendar/callback',GOOGLE_CALENDAR_TOKEN_KEY:'a'.repeat(64),GOOGLE_CALENDAR_EMAIL:'calendar@example.test'};
 const before=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]]));Object.assign(process.env,vars);
 t.after(()=>{for(const k of Object.keys(vars))if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];});
 const db=openDb(':memory:');extendDatabase(db);installShopOps(db);t.after(()=>db.close());
 const user={id:Number(db.prepare("INSERT INTO users(username,password_hash,salt,role) VALUES('owner','hash','salt','owner')").run().lastInsertRowid),username:'owner',role:'owner'};
 const auth=()=>new URL(startGoogleAuth(db,user.id));
 const response=(status,body)=>({status,ok:status>=200&&status<300,json:async()=>body});
 return {db,user,auth,response};
}

test('OAuth verifies the intended account, encrypts refresh tokens, rejects replay and uses the same transport for sync',async t=>{
 const f=fixture(t),url=f.auth(),state=url.searchParams.get('state');
 assert.equal(url.searchParams.get('login_hint'),'calendar@example.test');
 assert.equal(url.searchParams.get('redirect_uri'),process.env.GOOGLE_CALENDAR_REDIRECT_URL);
 const calls=[];
 const fetchImpl=async(url,init)=>{
  calls.push({url,init});
  if(url.endsWith('/token')){
   assert.equal(init.body.get('client_secret'),'fictional-secret');
   if(init.body.get('grant_type')==='authorization_code')return f.response(200,{access_token:'fictional-access',refresh_token:'fictional-refresh'});
   assert.equal(init.body.get('refresh_token'),'fictional-refresh');return f.response(200,{access_token:'fictional-renewed'});
  }
  if(url.endsWith('/userinfo')){assert.equal(init.headers.authorization,'Bearer fictional-access');return f.response(200,{email:'calendar@example.test',email_verified:true});}
  assert.equal(init.headers.authorization,'Bearer fictional-renewed');return f.response(200,{...JSON.parse(init.body),etag:'"v1"'});
 };
 await completeGoogleAuth(f.db,'fictional-code',state,{fetchImpl});
 assert.equal(googleStatus(f.db).connected,true);
 const stored=f.db.prepare('SELECT encrypted_refresh_token FROM google_calendar_connection').get().encrypted_refresh_token;
 assert.ok(!stored.includes('fictional-refresh'));assert.equal(stored.split('.').length,3);
 await assert.rejects(completeGoogleAuth(f.db,'fictional-code',state,{fetchImpl}),/invalid calendar OAuth state/);
 const id=Number(f.db.prepare("INSERT INTO shop_appointments(title,starts_at,ends_at,created_by) VALUES('Fictional dropoff','2026-12-01T16:00:00Z','2026-12-01T17:00:00Z',?)").run(f.user.id).lastInsertRowid);
 assert.equal((await pushAppointment(f.db,id,{fetchImpl})).status,'synced');
 assert.equal(calls.length,4);
});

test('wrong or unverified Google accounts never create a connection',async t=>{
 const f=fixture(t);
 for(const profile of [{email:'someone-else@example.test',email_verified:true},{email:'calendar@example.test',email_verified:false}]){
  const state=f.auth().searchParams.get('state');
  await assert.rejects(completeGoogleAuth(f.db,'fictional-code',state,{fetchImpl:async url=>f.response(200,url.endsWith('/token')?{access_token:'access',refresh_token:'refresh'}:profile)}),/Unexpected Google account/);
  assert.equal(googleStatus(f.db).connected,false);
 }
});

test('OAuth failures do not include returned provider credentials in the error',async t=>{
 const f=fixture(t),state=f.auth().searchParams.get('state');
 await assert.rejects(completeGoogleAuth(f.db,'fictional-code',state,{fetchImpl:async()=>f.response(400,{error:'invalid_client',error_description:'fictional-secret fictional-code',refresh_token:'fictional-refresh'})}),error=>{
  assert.match(error.message,/HTTP 400/);for(const secret of ['fictional-secret','fictional-code','fictional-refresh'])assert.ok(!error.message.includes(secret));return true;
 });
 assert.equal(googleStatus(f.db).connected,false);
});

test('saving an appointment remains local with a connected Calendar until explicit sync',async t=>{
 const f=fixture(t);
 f.db.prepare("INSERT INTO google_calendar_connection(id,email,encrypted_refresh_token) VALUES(1,'calendar@example.test','invalid-token-must-never-be-read-on-local-save')").run();
 const routes=shopOpsRoutes({db:f.db,currentUser:()=>f.user,json:(res,status,body)=>Object.assign(res,{status,body}),readBody:async req=>req.body});
 const res={},url=new URL('http://local/api/shop/schedule');
 assert.equal(await routes({method:'POST',body:{title:'Local appointment',startsAt:'2026-12-02T16:00:00Z',endsAt:'2026-12-02T17:00:00Z'}},res,url.pathname,url),true);
 assert.equal(res.status,201);assert.equal(res.body.calendarSync,'local_only');
 const row=f.db.prepare('SELECT google_event_id,sync_status FROM shop_appointments WHERE id=?').get(res.body.id);
 assert.equal(row.google_event_id,null);assert.equal(row.sync_status,'local_only');
});

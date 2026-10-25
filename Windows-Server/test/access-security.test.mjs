import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb,hashPassword} from '../src/db.mjs';
import {createAccessSecurity,installAccessSecurity} from '../src/access-security.mjs';

function fixture(options={}) {
  const db=openDb(':memory:');
  const hashed=hashPassword('Owner-Password-2026');
  const owner=Number(db.prepare("INSERT INTO users(username,password_hash,salt,role,active) VALUES('owner',?,?,'owner',1)").run(hashed.hash,hashed.salt).lastInsertRowid);
  const advisor=Number(db.prepare("INSERT INTO users(username,password_hash,salt,role,active) VALUES('advisor',?,?,'advisor',1)").run(hashed.hash,hashed.salt).lastInsertRowid);
  let time=Date.now();
  const json=(res,status,value,headers)=>{res.status=status;res.value=value;res.headers={...res.headers,...headers};};
  const access=createAccessSecurity({db,json,readBody:async req=>req.body || {},publicBaseUrl:'https://shop.example.test',sessionSecret:'unit-session-secret',now:()=>time,...options});
  const request=(body={},extra={})=>({method:'POST',headers:{host:'shop.example.test'},socket:{remoteAddress:'127.0.0.1'},body,...extra});
  const response=()=>({headers:{},setHeader(name,value){this.headers[name]=value;},writeHead(status,headers){this.status=status;this.headers={...this.headers,...headers};},end(body){this.body=body;}});
  const call=async(path,body={},extra={})=>{const req=request(body,extra),res=response();await access.routes(req,res,path);return res;};
  return {db,owner,advisor,access,request,response,call,advance:ms=>time+=ms};
}

test('password and PIN brute-force throttle persists, ignores spoofed proxy source and expires',async()=>{
  const f=fixture({loginFailureLimit:3});
  try {
    for(let i=0;i<3;i++)assert.equal((await f.call('/api/login',{username:'owner',password:'wrong'},{headers:{host:'shop.example.test','x-forwarded-for':`198.51.100.${i}`}})).status,401);
    assert.equal((await f.call('/api/login',{username:'owner',password:'Owner-Password-2026'})).status,429);
    installAccessSecurity(f.db);
    assert.equal((await f.call('/api/login',{username:'owner',pin:'0000'})).status,429);
    f.advance(15*60_000+1);
    const login=await f.call('/api/login',{username:'owner',password:'Owner-Password-2026'});
    assert.equal(login.status,200);
    assert.match(login.headers['set-cookie'],/HttpOnly; SameSite=Strict/);
    assert.match(login.headers['set-cookie'],/; Secure$/);
  }finally{f.db.close();}
});

test('secure origin checks reject foreign, opaque and cross-site mutations but permit native clients',()=>{
  const f=fixture();
  try {
    for(const headers of [{origin:'https://attacker.example'},{origin:'null'},{origin:'https://shop.example.test','sec-fetch-site':'cross-site'}]) {
      const res=f.response();assert.equal(f.access.middleware(f.request({}, {headers:{host:'shop.example.test',...headers}}),res),true);assert.equal(res.status,403);
    }
    assert.equal(f.access.middleware(f.request({}, {headers:{host:'shop.example.test',origin:'https://shop.example.test'}}),f.response()),false);
    const res=f.response();assert.equal(f.access.middleware(f.request(),res),false);assert.equal(res.headers['referrer-policy'],'no-referrer');
    assert.equal(f.access.middleware(f.request({}, {method:'GET',headers:{origin:'https://attacker.example'}}),f.response()),false);
  }finally{f.db.close();}
});

test('untrusted forwarded HTTPS cannot change local-cookie policy',()=>{
  const f=fixture({publicBaseUrl:'http://127.0.0.1:8787',trustProxy:false});
  try {assert.doesNotMatch(f.access.cookie(f.request({}, {headers:{'x-forwarded-proto':'https'}}),'token'),/Secure/);}
  finally{f.db.close();}
});

test('session expiration and identity changes revoke sessions without malformed-cookie crashes',async()=>{
  const f=fixture();
  try {
    const login=await f.call('/api/login',{username:'owner',password:'Owner-Password-2026'});
    const cookie=login.headers['set-cookie'].split(';')[0],req=f.request({}, {headers:{cookie}});
    assert.equal(f.access.sessionUser(req).id,f.owner);
    assert.equal(f.access.sessionUser(f.request({}, {headers:{cookie:'ot_session=%invalid'}})),null);
    f.db.prepare("UPDATE users SET role='manager' WHERE id=?").run(f.owner);
    assert.equal(f.access.sessionUser(req),null);
    const second=await f.call('/api/login',{username:'owner',password:'Owner-Password-2026'});
    const secondReq=f.request({}, {headers:{cookie:second.headers['set-cookie'].split(';')[0]}});
    f.advance(12*3600_000+1);
    assert.equal(f.access.sessionUser(secondReq),null);
  }finally{f.db.close();}
});

test('owner-only recovery is hashed, short-lived, one-use, clears PIN and revokes sessions',async()=>{
  const f=fixture();
  try {
    const login=await f.call('/api/login',{username:'owner',password:'Owner-Password-2026'}),cookie=login.headers['set-cookie'].split(';')[0];
    assert.equal((await f.call(`/api/security/users/${f.advisor}/recovery`,{confirm:true})).status,401);
    const advisor=await f.call('/api/login',{username:'advisor',password:'Owner-Password-2026'});
    assert.equal((await f.call(`/api/security/users/${f.owner}/recovery`,{confirm:true},{headers:{cookie:advisor.headers['set-cookie'].split(';')[0]}})).status,403);
    const tokenResponse=await f.call(`/api/security/users/${f.advisor}/recovery`,{confirm:true},{headers:{cookie}});
    assert.equal(tokenResponse.status,201);
    const token=new URL(tokenResponse.value.recoveryUrl).pathname.split('/').pop();
    assert.notEqual(f.db.prepare('SELECT token_hash FROM access_recovery_tokens').get().token_hash,token);
    assert.throws(()=>f.access.redeemRecovery(token,'short'),/12 to 256/);
    const result=f.access.redeemRecovery(token,'Recovered-Password-2026');assert.equal(result.ok,true);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(f.advisor).n,0);
    assert.throws(()=>f.access.redeemRecovery(token,'Recovered-Again-2026'),/invalid or expired/);
    assert.equal((await f.call('/api/login',{username:'advisor',password:'Recovered-Password-2026'})).status,200);
    const fresh=f.access.issueRecovery(f.advisor,{id:f.owner,username:'owner'}),freshToken=new URL(fresh.recoveryUrl).pathname.split('/').pop();
    f.advance(15*60_000+1);assert.throws(()=>f.access.redeemRecovery(freshToken,'Expired-Password-2026'),/invalid or expired/);
    assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT detail FROM audit_log').all()),new RegExp(token));
  }finally{f.db.close();}
});

test('session inventory exposes revocable IDs without credentials and requires strict confirmation',async()=>{
  const f=fixture();
  try {
    const login=await f.call('/api/login',{username:'owner',password:'Owner-Password-2026'}),cookie=login.headers['set-cookie'].split(';')[0];
    const extra={headers:{cookie}};
    const sessions=await f.call('/api/security/sessions',{}, {...extra,method:'GET'});
    assert.equal(sessions.status,200);assert.equal(sessions.value.sessions.length,1);
    assert.equal(Object.hasOwn(sessions.value.sessions[0],'token_hash'),false);
    const id=sessions.value.sessions[0].id;
    assert.equal((await f.call(`/api/security/sessions/${id}/revoke`,{confirm:'true'},extra)).status,400);
    assert.equal((await f.call(`/api/security/sessions/${id}/revoke`,{confirm:true},extra)).status,200);
    assert.equal(f.access.sessionUser(f.request({},extra)),null);
  }finally{f.db.close();}
});

test('PIN sign-in uses the same failure throttle, and password/PIN/deactivation changes sign out existing sessions',async t=>{
  for(const change of ['password','pin','inactive'])await t.test(change,async()=>{
    const f=fixture({loginFailureLimit:2});
    try {
      const pin=hashPassword('582914');
      f.db.prepare('UPDATE users SET pin_hash=?,pin_salt=? WHERE id=?').run(pin.hash,pin.salt,f.owner);
      const login=await f.call('/api/login',{username:'owner',pin:'582914'});assert.equal(login.status,200);
      const req=f.request({}, {headers:{cookie:login.headers['set-cookie'].split(';')[0]}});
      assert.equal(f.access.sessionUser(req).id,f.owner);
      if(change==='password')f.db.prepare("UPDATE users SET password_hash='new-password-hash' WHERE id=?").run(f.owner);
      if(change==='pin')f.db.prepare('UPDATE users SET pin_hash=NULL,pin_salt=NULL WHERE id=?').run(f.owner);
      if(change==='inactive')f.db.prepare('UPDATE users SET active=0 WHERE id=?').run(f.owner);
      assert.equal(f.access.sessionUser(req),null);
      assert.equal((await f.call('/api/login',{username:'owner',pin:'bad'})).status,401);
      assert.equal((await f.call('/api/login',{username:'owner',pin:'bad'})).status,401);
      assert.equal((await f.call('/api/login',{username:'owner',password:'Owner-Password-2026'})).status,429);
    }finally{f.db.close();}
  });
});

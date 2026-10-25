import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import http from 'node:http';
import worker,{cleanHeaders,decodeBase64,encodeBase64} from '../worker/index.js';
import {configuration,executeLocal,localTarget} from '../bridge-client.mjs';

const SECRET='test-only-'+('s'.repeat(48));
function d1() {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');sqlite.exec(readFileSync(new URL('../drizzle/0000_review_bridge.sql',import.meta.url),'utf8'));
  class Statement {
    constructor(sql,values=[]){this.sql=sql;this.values=values;}
    bind(...values){return new Statement(this.sql,values);}
    async first(){return sqlite.prepare(this.sql).get(...this.values)||null;}
    async all(){return {results:sqlite.prepare(this.sql).all(...this.values)};}
    async run(){const result=sqlite.prepare(this.sql).run(...this.values);return {meta:{changes:Number(result.changes)}};}
  }
  return {sqlite,prepare:sql=>new Statement(sql),async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
}
function environment(){return {DB:d1(),REVIEW_BRIDGE_SECRET:SECRET};}
const bridgeRequest=(path,body={},secret=SECRET)=>new Request('https://review.example'+path,{method:'POST',headers:{'content-type':'application/json','x-review-bridge-secret':secret},body:JSON.stringify(body)});
const poll=async env=>(await worker.fetch(bridgeRequest('/__bridge/poll'),env)).json();
const respond=(env,result)=>worker.fetch(bridgeRequest('/__bridge/respond',result),env);
async function claimNext(env) {for(let i=0;i<100;i++){const result=await poll(env);if(result.request)return result.request;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('No request queued');}
function proxy(url,options={}){return new Request('https://review.example'+url,options);}

test('private bridge rejects unauthorized polling and reports a disconnected app honestly',async()=>{
  const env=environment();
  assert.equal((await worker.fetch(bridgeRequest('/__bridge/poll',{},'wrong'),env)).status,403);
  const response=await worker.fetch(proxy('/'),env);assert.equal(response.status,503);assert.match((await response.json()).error,/offline/);
  env.DB.sqlite.close();
});

test('headers preserve app session/revisions and remove Site credentials and forwarding',()=>{
  const headers=cleanHeaders(new Headers({'cookie':'site_auth=private-platform; ot_session=app-session; other=x','oai-sites-authorization':'Bearer secret','oai-authenticated-user-id':'owner','x-forwarded-host':'evil.invalid','if-match':'"work_orders:3:4"','connection':'x-hidden','x-hidden':'secret'}));
  assert.deepEqual(headers,[['cookie','ot_session=app-session'],['if-match','"work_orders:3:4"']]);
  assert.deepEqual(cleanHeaders([['set-cookie','ot_session=one'],['set-cookie','ot_session=two']],true),[['set-cookie','ot_session=one'],['set-cookie','ot_session=two']]);
});

test('actual SQLite queue claims once and round-trips binary response and individual cookies',async()=>{
  const env=environment();await poll(env);
  const responsePromise=worker.fetch(proxy('/api/photo?name=sample',{method:'POST',headers:{'content-type':'image/png','cookie':'platform=secret; ot_session=abc','if-match':'"work_orders:2:3"'},body:Uint8Array.from([0,255,1,2])}),env);
  const [left,right]=await Promise.all([claimNext(env),poll(env)]),job=left;
  assert.equal(right.request,null);assert.equal(job.path,'/api/photo?name=sample');assert.equal(job.method,'POST');
  assert.deepEqual([...decodeBase64(job.bodyBase64)],[0,255,1,2]);assert.deepEqual(job.headers.find(([name])=>name==='cookie'),['cookie','ot_session=abc']);
  assert.equal((await respond(env,{id:job.id,claimToken:'wrong',status:201,headers:[],bodyBase64:''})).status,409);
  const result={id:job.id,claimToken:job.claimToken,status:201,headers:[['content-type','application/octet-stream'],['set-cookie','ot_session=abc; HttpOnly; Secure; SameSite=Strict; Path=/'],['set-cookie','ot_session=def; Path=/other'],['set-cookie','site_auth=forged'],['oai-authenticated-user-id','forged']],bodyBase64:encodeBase64(Uint8Array.from([255,0,23]))};
  assert.equal((await respond(env,result)).status,200);assert.equal((await respond(env,result)).status,409);
  const response=await responsePromise;assert.equal(response.status,201);assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[255,0,23]);
  assert.equal(response.headers.getSetCookie().length,2);assert.equal(response.headers.get('oai-authenticated-user-id'),null);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM review_bridge_requests').get().n,0);assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM review_bridge_chunks').get().n,0);env.DB.sqlite.close();
});

test('photo-sized payloads use bounded SQL rows and round-trip exact bytes',async()=>{
  const env=environment();await poll(env);
  const bytes=new Uint8Array(1024*1024+13);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
  const pending=worker.fetch(proxy('/api/media',{method:'POST',body:bytes}),env);const job=await claimNext(env);
  assert.ok(env.DB.sqlite.prepare("SELECT COUNT(*) n FROM review_bridge_chunks WHERE direction='request'").get().n>1);
  assert.ok(env.DB.sqlite.prepare('SELECT MAX(length(data)) n FROM review_bridge_chunks').get().n<=192*1024);
  assert.deepEqual(decodeBase64(job.bodyBase64),bytes);
  await respond(env,{id:job.id,claimToken:job.claimToken,status:200,headers:[],bodyBase64:job.bodyBase64});const response=await pending;assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);env.DB.sqlite.close();
});

test('expired claimed work is never requeued and oversized input is rejected before enqueue',async()=>{
  const env=environment();await poll(env);
  env.DB.sqlite.prepare("INSERT INTO review_bridge_requests(id,method,path,headers_json,state,created_at,expires_at) VALUES('expired','POST','/api/payments','[]','claimed',0,1)").run();
  assert.equal((await poll(env)).request,null);assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM review_bridge_requests').get().n,0);
  const response=await worker.fetch(proxy('/api/media',{method:'POST',headers:{'content-length':String(13*1024*1024)},body:'small'}),env);assert.equal(response.status,413);assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM review_bridge_requests').get().n,0);
  assert.throws(()=>decodeBase64('abc!'));assert.throws(()=>decodeBase64('a=== '));env.DB.sqlite.close();
});

test('localhost target is fixed and real HTTP preserves secure cookies, origin and exact response',async()=>{
  let seen;
  const server=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);seen={url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString()};res.writeHead(202,{'set-cookie':['ot_session=one; Secure; HttpOnly; SameSite=Strict','ot_session=two; Path=/other'],'content-type':'application/json'});res.end('{"realApplication":true}');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config=configuration({siteUrl:'https://review.example',siteBearer:'t'.repeat(32),bridgeSecret:SECRET,localOrigin:`http://127.0.0.1:${server.address().port}`});
  try{
    for(const path of ['https://evil.invalid/','//evil.invalid/','/\\evil.invalid/','/x\r\nHost:evil'])assert.throws(()=>localTarget(config,path));
    assert.throws(()=>configuration({...config,localOrigin:'http://example.com'}));
    const result=await executeLocal(config,{id:'id',claimToken:'claim',method:'POST',path:'/api/save?x=1',headers:[['cookie','platform=secret; ot_session=app'],['origin','https://review.example'],['if-match','"customers:1:5"'],['x-forwarded-host','evil.invalid'],['oai-sites-authorization','Bearer secret']],bodyBase64:Buffer.from('{"changed":true}').toString('base64')});
    assert.equal(result.status,202);assert.equal(result.headers.filter(([name])=>name==='set-cookie').length,2);assert.equal(Buffer.from(result.bodyBase64,'base64').toString(),'{"realApplication":true}');
    assert.equal(seen.url,'/api/save?x=1');assert.equal(seen.body,'{"changed":true}');assert.equal(seen.headers.cookie,'ot_session=app');assert.equal(seen.headers.origin,'https://review.example');assert.equal(seen.headers['if-match'],'"customers:1:5"');assert.equal(seen.headers['x-forwarded-host'],'review.example');assert.equal(seen.headers['x-forwarded-proto'],'https');assert.equal(seen.headers['oai-sites-authorization'],undefined);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

// The private Site's platform gate protects visitor access. This bridge forwards
// the real application to an isolated review server; it is not a replacement POS.
// No application database, provider credential or bridge secret belongs here.
const MAX_BODY = 12 * 1024 * 1024;
const MAX_BASE64 = Math.ceil(MAX_BODY / 3) * 4;
const CHUNK_SIZE = 192 * 1024;
const REQUEST_LIFETIME = 30_000;
const WAIT_LIMIT = 24_000;
const MAX_QUEUE = 48;
const MAX_HEADERS = 24 * 1024;
const METHODS = new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);
const HOP = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length','content-encoding','host']);
const reserved = name => HOP.has(name) || name.startsWith('oai-') || name.startsWith('cf-') || name.startsWith('x-forwarded-') || name === 'forwarded' || name === 'x-review-bridge-secret';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (value, status=200) => new Response(JSON.stringify(value), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
const problem = (status, message) => json({error:message,review:true},status);

export function cleanHeaders(headers, response=false) {
  const pairs=[];
  const blocked=new Set(HOP);
  const connection = headers instanceof Headers ? headers.get('connection') : headers.find?.(([name])=>name.toLowerCase()==='connection')?.[1];
  for(const name of String(connection||'').split(',')) blocked.add(name.trim().toLowerCase());
  const entries = headers instanceof Headers ? [...headers.entries()] : headers;
  for(const [rawName,rawValue] of entries) {
    const name=String(rawName).toLowerCase(), value=String(rawValue);
    if(blocked.has(name) || reserved(name) || /[\r\n]/.test(value) || !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
    // Only the application's session cookie is needed by the localhost POS.
    // Never copy the private Site's own sign-in cookies into its database queue.
    if(!response && name==='cookie') {
      const session=value.split(';').map(item=>item.trim()).find(item=>item.startsWith('ot_session='));
      if(session) pairs.push(['cookie',session]);
    } else pairs.push([name,value]);
  }
  if(JSON.stringify(pairs).length > MAX_HEADERS) throw new Error('Headers too large');
  return pairs;
}

export function encodeBase64(bytes) {
  let result='';
  for(let offset=0;offset<bytes.length;offset+=49_152) result+=btoa(String.fromCharCode(...bytes.subarray(offset,offset+49_152)));
  return result;
}
export function decodeBase64(value) {
  if(typeof value!=='string' || value.length>MAX_BASE64 || value.length%4!==0 || /[^A-Za-z0-9+/=]/.test(value) || value.slice(0,-2).includes('=') || /=./.test(value.slice(-2))&&value.slice(-2)!=='==') throw new Error('Invalid body encoding');
  const raw=atob(value), bytes=Uint8Array.from(raw,character=>character.charCodeAt(0));
  if(bytes.length>MAX_BODY) throw new Error('Body too large');
  return bytes;
}
async function readBytes(request, limit) {
  const length=Number(request.headers.get('content-length')||0);
  if(length>limit) throw new Error('Body too large');
  if(!request.body) return new Uint8Array();
  const reader=request.body.getReader(), chunks=[];let size=0;
  try {
    for(;;) {const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>limit)throw new Error('Body too large');chunks.push(next.value);}
  } catch(error) {await reader.cancel().catch(()=>{});throw error;}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
async function readJson(request, limit=MAX_BASE64+64*1024) {
  try {return JSON.parse(new TextDecoder().decode(await readBytes(request,limit)));}
  catch(error) {if(error.message==='Body too large')throw error;throw new Error('Invalid JSON');}
}
async function bridgeAuthorized(request,env) {
  const secret=String(env.REVIEW_BRIDGE_SECRET||''),provided=request.headers.get('x-review-bridge-secret')||'';
  if(secret.length<32 || provided.length<32 || provided.length>256) return false;
  const [left,right]=await Promise.all([secret,provided].map(value=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))));
  const a=new Uint8Array(left),b=new Uint8Array(right);let different=0;for(let i=0;i<a.length;i++)different|=a[i]^b[i];return different===0;
}
const statement=(db,sql,...params)=>db.prepare(sql).bind(...params);
const chunks=(db,id,direction,body)=>Array.from({length:Math.ceil(body.length/CHUNK_SIZE)},(_,i)=>statement(db,'INSERT INTO review_bridge_chunks(request_id,direction,sequence,data) VALUES(?,?,?,?)',id,direction,i,body.slice(i*CHUNK_SIZE,(i+1)*CHUNK_SIZE)));
async function bodyFor(db,id,direction) {
  const result=await statement(db,'SELECT data FROM review_bridge_chunks WHERE request_id=? AND direction=? ORDER BY sequence',id,direction).all();
  return result.results.map(row=>row.data).join('');
}
async function poll(request,env) {
  if(request.method!=='POST') return problem(405,'Use POST');
  const now=Date.now();
  await env.DB.batch([
    statement(env.DB,'DELETE FROM review_bridge_requests WHERE expires_at<?',now),
    statement(env.DB,'INSERT INTO review_bridge_state(id,last_seen) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen',now)
  ]);
  const claimToken=crypto.randomUUID();
  const result=await statement(env.DB,`UPDATE review_bridge_requests SET state='claimed',claim_token=? WHERE id=(SELECT id FROM review_bridge_requests WHERE state='pending' AND expires_at>? ORDER BY created_at,id LIMIT 1) AND state='pending' RETURNING id,method,path,headers_json,expires_at`,claimToken,now).all();
  const row=result.results[0];
  if(!row)return json({request:null});
  return json({request:{id:row.id,claimToken,method:row.method,path:row.path,headers:JSON.parse(row.headers_json),expiresAt:row.expires_at,bodyBase64:await bodyFor(env.DB,row.id,'request')}});
}
async function respond(request,env) {
  if(request.method!=='POST') return problem(405,'Use POST');
  const input=await readJson(request);
  if(!input || typeof input.id!=='string'||input.id.length>100||typeof input.claimToken!=='string'||input.claimToken.length>100||!Number.isInteger(input.status)||input.status<200||input.status>599||!Array.isArray(input.headers)||input.headers.length>100||!input.headers.every(pair=>Array.isArray(pair)&&pair.length===2&&pair.every(value=>typeof value==='string'))) return problem(400,'Invalid response');
  // Validate bytes before writing, and never let an arbitrary response forge
  // the Site's authentication cookies, identity or transport headers.
  decodeBase64(input.bodyBase64);
  const headers=cleanHeaders(input.headers,true).filter(([name,value])=>name!=='set-cookie'||/^ot_session=/i.test(value));
  const row=await statement(env.DB,"SELECT id FROM review_bridge_requests WHERE id=? AND claim_token=? AND state='claimed' AND expires_at>?",input.id,input.claimToken,Date.now()).first();
  if(!row)return problem(409,'Request is expired, complete or not claimed by this client');
  const operations=chunks(env.DB,input.id,'response',input.bodyBase64);
  operations.push(statement(env.DB,"UPDATE review_bridge_requests SET state='complete',response_status=?,response_headers_json=? WHERE id=? AND claim_token=? AND state='claimed'",input.status,JSON.stringify(headers),input.id,input.claimToken));
  await env.DB.batch(operations);
  return json({ok:true});
}
async function proxy(request,env) {
  if(!METHODS.has(request.method))return problem(405,'Method not supported');
  if(request.headers.get('upgrade'))return problem(400,'The review bridge supports ordinary HTTP requests');
  const now=Date.now(),state=await statement(env.DB,'SELECT last_seen FROM review_bridge_state WHERE id=1').first();
  if(!state||now-state.last_seen>15_000)return problem(503,'The complete application review server is offline. This private review requires the development runtime to remain running.');
  const pending=await statement(env.DB,'SELECT COUNT(*) AS total FROM review_bridge_requests WHERE expires_at>?',now).first();
  if(pending.total>=MAX_QUEUE)return problem(503,'The review server is busy. Reload after a moment.');
  const url=new URL(request.url),id=crypto.randomUUID(),path=url.pathname+url.search;
  const headers=cleanHeaders(request.headers);
  const body=encodeBase64(await readBytes(request,MAX_BODY));
  const operations=[statement(env.DB,'INSERT INTO review_bridge_requests(id,method,path,headers_json,created_at,expires_at) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM review_bridge_requests WHERE expires_at>?)<?',id,request.method,path,JSON.stringify(headers),now,now+REQUEST_LIFETIME,now,MAX_QUEUE),...chunks(env.DB,id,'request',body)];
  const results=await env.DB.batch(operations);
  if(results[0].meta?.changes===0)return problem(503,'The review server is busy. Reload after a moment.');
  const deadline=Date.now()+WAIT_LIMIT;
  do {
    await sleep(650);
    const row=await statement(env.DB,'SELECT state,response_status,response_headers_json FROM review_bridge_requests WHERE id=?',id).first();
    if(row?.state==='complete') {
      const bytes=decodeBase64(await bodyFor(env.DB,id,'response'));
      const responseHeaders=new Headers();
      for(const [name,value] of JSON.parse(row.response_headers_json))responseHeaders.append(name,value);
      responseHeaders.set('x-ownertracker-review','isolated-development-server');
      responseHeaders.set('cache-control','no-store');
      await statement(env.DB,'DELETE FROM review_bridge_requests WHERE id=?',id).run();
      return new Response(request.method==='HEAD'||[204,205,304].includes(row.response_status)?null:bytes,{status:row.response_status,headers:responseHeaders});
    }
    if(!row)break;
  } while(Date.now()<deadline);
  // A claimed operation may have completed locally even when its response was
  // lost. Never silently replay a financial or inventory mutation.
  await statement(env.DB,"DELETE FROM review_bridge_requests WHERE id=? AND state='pending'",id).run();
  return problem(504,'The review server response timed out. An operation may have completed. Reload its record before retrying.');
}
export default {
  async fetch(request,env) {
    try {
      if(!env.DB)return problem(503,'The private review queue is not configured.');
      const pathname=new URL(request.url).pathname;
      if(pathname.startsWith('/__bridge/')) {
        if(!await bridgeAuthorized(request,env))return problem(403,'Forbidden');
        if(pathname==='/__bridge/poll')return await poll(request,env);
        if(pathname==='/__bridge/respond')return await respond(request,env);
        return problem(404,'Not found');
      }
      return await proxy(request,env);
    } catch(error) {
      if(error.message==='Body too large')return problem(413,'Body exceeds the 12 MB review bridge limit');
      if(['Invalid JSON','Invalid body encoding','Headers too large'].includes(error.message))return problem(400,error.message);
      // Never send DB statements, request bodies, tokens or provider errors to
      // visitors or logs. The localhost app supplies its own safe error pages.
      return problem(503,'The private review bridge is temporarily unavailable.');
    }
  }
};

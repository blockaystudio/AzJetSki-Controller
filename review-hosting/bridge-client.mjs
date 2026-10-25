// Secrets are supplied as one JSON line on stdin and retained only in memory.
// This client connects a private review Site to one fixed loopback application.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const MAX_BODY=12*1024*1024;
const MAX_JSON=Math.ceil(MAX_BODY/3)*4+128*1024;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const HOP=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length','content-encoding','host']);

export function configuration(input) {
  const site=new URL(input.siteUrl),local=new URL(input.localOrigin);
  if(site.protocol!=='https:'||site.username||site.password||site.pathname!=='/'||site.search||site.hash)throw Error('siteUrl must be one HTTPS origin');
  if(local.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(local.hostname)||local.username||local.password||local.pathname!=='/'||local.search||local.hash)throw Error('localOrigin must be a fixed HTTP loopback origin');
  if(typeof input.siteBearer!=='string'||input.siteBearer.length<24||/[\r\n]/.test(input.siteBearer))throw Error('A private Site service bearer is required');
  if(typeof input.bridgeSecret!=='string'||input.bridgeSecret.length<32||input.bridgeSecret.length>256||/[\r\n]/.test(input.bridgeSecret))throw Error('A bridge secret of 32–256 characters is required');
  return {siteUrl:site.origin,localOrigin:local.origin,siteBearer:input.siteBearer,bridgeSecret:input.bridgeSecret};
}

export function localTarget(config,path) {
  if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||path.includes('\\')||/[\r\n\0]/.test(path)||path.length>8192)throw Error('Invalid application path');
  const target=new URL(path,config.localOrigin);
  if(target.origin!==config.localOrigin)throw Error('Only the configured loopback application can be reached');
  return target;
}

function proxyAgent(siteUrl) {
  const proxyValue=process.env.HTTPS_PROXY||process.env.https_proxy||process.env.HTTP_PROXY||process.env.http_proxy;
  if(!proxyValue)return new https.Agent({keepAlive:true,maxSockets:8});
  const proxy=new URL(proxyValue);
  if(!['http:','https:'].includes(proxy.protocol))throw Error('An HTTP or HTTPS session proxy is required');
  const target=new URL(siteUrl),agent=new https.Agent({keepAlive:true,maxSockets:8});
  // Preserve the session's HTTP proxy and normal CA verification. The proxy
  // authenticates outbound destinations independently of Site bearer access.
  agent.createConnection=(_options,callback)=>{
    const headers={host:`${target.hostname}:443`};
    if(proxy.username||proxy.password)headers['proxy-authorization']='Basic '+Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
    const transport=proxy.protocol==='https:'?https:http;
    const connect=transport.request(proxy,{method:'CONNECT',path:`${target.hostname}:443`,headers,timeout:15_000});
    let finished=false;
    const done=(error,socket)=>{if(finished){socket?.destroy();return;}finished=true;callback(error,socket);};
    connect.once('connect',(response,socket,head)=>{
      if(response.statusCode!==200){socket.destroy();done(Error('Session proxy rejected the Site connection'));return;}
      if(head.length)socket.unshift(head);
      const secure=tls.connect({socket,servername:target.hostname});
      secure.once('secureConnect',()=>done(null,secure));
      secure.once('error',error=>done(error));
    });
    connect.once('error',error=>done(error));
    connect.once('timeout',()=>connect.destroy(Error('Session proxy connection timed out')));
    connect.end();
  };
  return agent;
}

function requestBytes(target,{method='GET',headers={},body=null,agent,timeout=20_000,maxBytes=MAX_JSON}={}) {
  return new Promise((resolve,reject)=>{
    const transport=target.protocol==='https:'?https:http;
    const req=transport.request(target,{method,headers,agent,timeout},res=>{
      const parts=[];let size=0;
      res.on('data',part=>{size+=part.length;if(size>maxBytes){res.destroy(Error('Review response exceeds its size limit'));return;}parts.push(part);});
      res.once('end',()=>resolve({status:res.statusCode,headers:res.rawHeaders,body:Buffer.concat(parts)}));
      res.once('error',reject);
    });
    req.once('error',reject);
    req.once('timeout',()=>req.destroy(Error('Review request timed out')));
    req.end(body);
  });
}

export async function executeLocal(config,job) {
  const target=localTarget(config,job.path);
  if(!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(job.method)||!Array.isArray(job.headers)||job.headers.length>100)throw Error('Invalid application request');
  if(typeof job.bodyBase64!=='string'||job.bodyBase64.length>Math.ceil(MAX_BODY/3)*4||job.bodyBase64.length%4!==0||/[^A-Za-z0-9+/=]/.test(job.bodyBase64))throw Error('Invalid application body');
  const body=Buffer.from(job.bodyBase64,'base64');if(body.length>MAX_BODY)throw Error('Application request is too large');
  const headers={};
  for(const [rawName,rawValue] of job.headers) {
    const name=String(rawName).toLowerCase(),value=String(rawValue);
    if(HOP.has(name)||name.startsWith('oai-')||name.startsWith('cf-')||name.startsWith('x-forwarded-')||name==='forwarded'||name==='x-review-bridge-secret')continue;
    if(!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)||/[\r\n]/.test(value))throw Error('Invalid application header');
    if(name==='cookie')headers.cookie=value.split(';').map(part=>part.trim()).find(part=>part.startsWith('ot_session='))||'';
    else headers[name]=value;
  }
  headers['x-forwarded-proto']='https';headers['x-forwarded-host']=new URL(config.siteUrl).host;
  headers['accept-encoding']='identity';headers['content-length']=body.length;
  const result=await requestBytes(target,{method:job.method,headers,body,agent:false,maxBytes:MAX_BODY,timeout:20_000});
  const responseHeaders=[];
  for(let i=0;i<result.headers.length;i+=2) {
    const name=result.headers[i].toLowerCase(),value=result.headers[i+1];
    if(HOP.has(name)||name.startsWith('oai-')||name.startsWith('cf-')||name.startsWith('x-forwarded-'))continue;
    if(name==='set-cookie'&&!/^ot_session=/i.test(value))continue;
    responseHeaders.push([name,value]);
  }
  return {id:job.id,claimToken:job.claimToken,status:result.status,headers:responseHeaders,bodyBase64:result.body.toString('base64')};
}

export async function runBridge(input,{signal,log=message=>process.stderr.write(message+'\n')}={}) {
  const config=configuration(input),agent=proxyAgent(config.siteUrl);
  const call=async(path,data={})=>{
    const body=Buffer.from(JSON.stringify(data));
    const result=await requestBytes(new URL(path,config.siteUrl),{method:'POST',body,agent,timeout:20_000,maxBytes:MAX_JSON,headers:{'content-type':'application/json','content-length':body.length,'OAI-Sites-Authorization':`Bearer ${config.siteBearer}`,'x-review-bridge-secret':config.bridgeSecret}});
    if(result.status!==200)throw Error(`Private bridge endpoint returned HTTP ${result.status}`);
    let parsed;try{parsed=JSON.parse(result.body.toString('utf8'));}catch{throw Error('Private bridge endpoint returned invalid JSON');}return parsed;
  };
  let lastError=0,first=true;
  async function loop() {
    while(!signal?.aborted) {
      try {
        const {request:job}=await call('/__bridge/poll');
        if(first){first=false;log('Private review bridge connected. The complete application uses the isolated local review database.');}
        if(!job){await sleep(700);continue;}
        let result;
        try {result=await executeLocal(config,job);}
        catch {result={id:job.id,claimToken:job.claimToken,status:502,headers:[['content-type','application/json; charset=utf-8'],['cache-control','no-store']],bodyBase64:Buffer.from(JSON.stringify({error:'The isolated review application could not complete the request. Reload its record before retrying.'})).toString('base64')};}
        // Exactly one execution. A failed response submission must never replay
        // a payment, approval, stock adjustment or other local operation.
        await call('/__bridge/respond',result);
      } catch {
        if(Date.now()-lastError>15_000){lastError=Date.now();log('Private review bridge is reconnecting. Existing requests are never replayed.');}
        await sleep(1500);
      }
    }
  }
  try {await Promise.all(Array.from({length:4},()=>loop()));}
  finally {agent.destroy();}
}

async function main() {
  // Match the Site source helper's hidden-stdin convention. Raw mode disables
  // terminal echo before the readiness message appears; piped stdin works too.
  if(process.stdin.isTTY)process.stdin.setRawMode(true);
  process.stderr.write('Ready for private review bridge JSON on stdin (input is hidden).\n');
  const lines=readline.createInterface({input:process.stdin,terminal:false});
  let line;
  try{line=await new Promise((resolve,reject)=>{lines.once('line',resolve);lines.once('close',()=>reject(Error('Bridge configuration is required')));});}
  finally{lines.close();if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stdin.pause();}
  let input;try{input=JSON.parse(line);}catch{throw Error('Bridge configuration must be one JSON line');}
  const controller=new AbortController();process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());
  await runBridge(input,{signal:controller.signal});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{process.stderr.write('The private review bridge could not start. Check its protected configuration and network access.\n');process.exitCode=1;});

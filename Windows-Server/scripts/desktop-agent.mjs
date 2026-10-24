import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {loadEnv} from '../src/env.mjs';
loadEnv();
const base=process.env.DESKTOP_SERVER_URL||`http://127.0.0.1:${process.env.PORT||8787}`;
if(!base.startsWith('http://127.0.0.1:')&&!base.startsWith('http://localhost:')&&!base.startsWith('https://'))throw new Error('Unsafe desktop server URL; use local loopback or HTTPS');
const token=process.env.DESKTOP_AGENT_TOKEN;
if(!token||token.startsWith('CHANGE_ME'))throw new Error('Set DESKTOP_AGENT_TOKEN');
const outDir=path.resolve(process.env.ORDER_OUTBOX_DIR||'./data/order-outbox');
fs.mkdirSync(outDir,{recursive:true});
const header={authorization:`Bearer ${token}`};
async function ack(id,status,message){const r=await fetch(`${base}/api/desktop-agent/commands/${id}/ack`,{method:'POST',headers:{...header,'content-type':'application/json'},body:JSON.stringify({status,message})});if(!r.ok)throw new Error(`ack failed: HTTP ${r.status}`)}
export async function pollOnce(){
 const r=await fetch(`${base}/api/desktop-agent/commands`,{headers:header});if(!r.ok)throw new Error(`command fetch failed: HTTP ${r.status}`);
 const data=await r.json(),found=[];
 for(const command of data.commands||[]){
  const {id,sha256,status,...payload}=command;
  const actual=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  if(actual!==sha256){console.error('Rejected command snapshot mismatch',id);continue;}
  const file=path.join(outDir,`${id}.json`);
  if(!fs.existsSync(file)){
   const tmp=file+'.tmp';
   fs.writeFileSync(tmp,JSON.stringify({id,sha256,...payload,executionState:'PENDING SUPPLIER CONNECTOR — NOT PURCHASED'},null,2),{flag:'wx',mode:0o600});
   fs.renameSync(tmp,file);
  }
  // Default: only create exact immutable manifests; no websites are scraped or clicked.
  await ack(id,'needs_connector',`Verified purchasing manifest saved to ${file}. No actual supplier order placed.`);
  found.push({id,file});
 }
 const retailRes=await fetch(`${base}/api/desktop-agent/retail-commands`,{headers:header});
 if(!retailRes.ok)throw new Error(`retail command fetch failed: HTTP ${retailRes.status}`);
 const retailData=await retailRes.json();
 for(const command of retailData.commands||[]){
  const {id,sha256,...payload}=command;
  const actual=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  if(actual!==sha256){console.error('Rejected retail command hash mismatch',id);continue;}
  const file=path.join(outDir,`retail-${id}.json`);
  if(!fs.existsSync(file)){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify({id,sha256,...payload,executionState:'NOT PURCHASED — INTEGRATION REQUIRED'},null,2),{flag:'wx',mode:0o600});fs.renameSync(tmp,file)}
  const a=await fetch(`${base}/api/desktop-agent/retail-commands/${id}/ack`,{method:'POST',headers:{...header,'content-type':'application/json'},body:JSON.stringify({status:'needs_connector',message:`Saved ${file}. No supplier purchase was made.`})});
  if(!a.ok)throw new Error(`retail ack failed: HTTP ${a.status}`);
  found.push({id,file});
 }
 return found;
}
if(process.argv[1]&&process.argv[1].endsWith('desktop-agent.mjs')){
 const run=async()=>{try{const found=await pollOnce();if(found.length)console.log('Saved commands:',found.map(x=>x.id).join(', '))}catch(e){console.error(new Date().toISOString(),e.message)}};
 await run();if(!process.argv.includes('--once'))setInterval(run,30_000);
}

import fs from 'node:fs';
import path from 'node:path';
import {createEncryptedBackup} from '../scripts/encrypted-backup.mjs';

export function installMaintenance(db){
 db.exec(`CREATE TABLE IF NOT EXISTS maintenance_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,status TEXT NOT NULL,path TEXT,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,completed_at TEXT);
 CREATE TABLE IF NOT EXISTS migration_batches(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id INTEGER NOT NULL,source_name TEXT NOT NULL,row_count INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
}
const owner=user=>user&&['owner','manager'].includes(user.role);
export function createMaintenance({db,currentUser,json,readBody,fetchImpl=fetch}){
 installMaintenance(db);let running=false;
 async function backup(){
  if(running)throw Error('Backup already running');running=true;
  const id=Number(db.prepare("INSERT INTO maintenance_runs(kind,status) VALUES('encrypted_backup','running')").run().lastInsertRowid);
  let file;
  try{
   file=await createEncryptedBackup();
   const remote=process.env.BACKUP_OFFSITE_URL;
   if(remote){
    const filename=encodeURIComponent(path.basename(file));
    const url=new URL(remote.includes('{filename}')?remote.replaceAll('{filename}',filename):remote);
    if(!remote.includes('{filename}'))url.pathname=url.pathname.replace(/\/?$/,'/')+filename;
    if(url.protocol!=='https:'||url.username||url.password)throw Error('Offsite backup URL must use HTTPS without embedded credentials');
    const result=await fetchImpl(url,{method:'PUT',headers:{'content-type':'application/octet-stream',...(process.env.BACKUP_OFFSITE_TOKEN?{authorization:'Bearer '+process.env.BACKUP_OFFSITE_TOKEN}:{})},body:fs.createReadStream(file),duplex:'half',signal:AbortSignal.timeout(120000)});
    if(!result.ok)throw Error('Offsite backup upload failed (HTTP '+result.status+')');
   }
   db.prepare("UPDATE maintenance_runs SET status=?,path=?,detail=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(remote?'offsite_confirmed':'local_encrypted',file,remote?'Configured HTTPS destination accepted upload':'Offsite destination not configured',id);
   const retain=Math.max(2,Math.min(365,Number(process.env.BACKUP_RETAIN_COUNT)||30));
   const prior=db.prepare("SELECT id,path FROM maintenance_runs WHERE kind='encrypted_backup' AND status IN ('offsite_confirmed','local_encrypted') AND path IS NOT NULL ORDER BY id DESC").all();
   for(const record of prior.slice(retain))if(record.path.endsWith('.otb')&&path.dirname(path.resolve(record.path))===path.dirname(path.resolve(file))){fs.rmSync(record.path,{force:true});db.prepare('UPDATE maintenance_runs SET path=NULL WHERE id=?').run(record.id);}
   return {id,status:remote?'offsite_confirmed':'local_encrypted'};
  }catch(error){db.prepare("UPDATE maintenance_runs SET status='failed',path=?,detail=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(file||null,String(error.message).slice(0,250),id);throw error;}
  finally{running=false;}
 }
 const routes=async(req,res,p)=>{
  if(!p.startsWith('/api/maintenance'))return false;
  const user=currentUser(req),respond=(status,data)=>{json(res,status,data);return true;};
  if(!owner(user))return respond(user?403:401,{error:'Owner or manager access required'});
  try{
   if(p==='/api/maintenance/review-guide'&&req.method==='GET'){if(process.env.OWNERTRACKER_REVIEW!=='true')return respond(404,{error:'Not a review environment'});const file=path.resolve('data/review-guide.json');return respond(200,fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{review:true,links:[]});}
   if(p==='/api/maintenance/status'&&req.method==='GET')return respond(200,{reviewMode:process.env.OWNERTRACKER_REVIEW==='true',backupKeyConfigured:/^[a-f0-9]{64}$/i.test(process.env.OWNERTRACKER_BACKUP_KEY||''),offsiteConfigured:!!process.env.BACKUP_OFFSITE_URL,intervalHours:Number(process.env.BACKUP_INTERVAL_HOURS)||24,automatic:process.env.AUTO_ENCRYPTED_BACKUP==='true',runs:db.prepare('SELECT id,kind,status,detail,created_at,completed_at FROM maintenance_runs ORDER BY id DESC LIMIT 50').all(),nativeIOS:{sourceIncluded:true,signedBuild:false,requires:'Apple development team and macOS/Xcode signing'},providers:{dejavoo:'External terminal/manual ledger; merchant-certified live adapter required',suppliers:'Reviewed manifests/manual checkout; dealer APIs required',email:process.env.INVOICE_FROM_EMAIL?'Configured sender; verify delivery':'Needs authorized sender',google:process.env.GOOGLE_CALENDAR_CLIENT_ID?'App credentials supplied; owner OAuth required':'Needs Google Cloud app credentials'}});
   if(p==='/api/maintenance/backup'&&req.method==='POST'){const input=await readBody(req);if(input.confirm!==true)return respond(400,{error:'Confirm backup request'});return respond(201,await backup());}
   if(p==='/api/maintenance/import-customers'&&req.method==='POST'){
    const input=await readBody(req);if(!Array.isArray(input.rows)||input.rows.length<1||input.rows.length>500)return respond(400,{error:'Supply 1–500 customer rows'});
    const columns=['name','phone','email','address_line1','address_line2','city','state','postal_code'];
    const rows=input.rows.map(row=>Object.fromEntries(columns.map(col=>[col,String(row[col]??'').trim().slice(0,col==='name'?200:250)])));
    const errors=rows.flatMap((row,i)=>!row.name||!row.address_line1||!row.city||!row.state||!row.postal_code?[{row:i+1,error:'Name and complete service address required'}]:[]);
    if(errors.length)return respond(400,{errors});
    if(input.commit!==true)return respond(200,{valid:true,rowCount:rows.length,preview:rows.slice(0,10),notice:'Dry run only. No customers imported.'});
    if(input.confirm!=='IMPORT CUSTOMERS')return respond(400,{error:'Type IMPORT CUSTOMERS to commit'});
    db.exec('BEGIN IMMEDIATE');try{
     const insert=db.prepare(`INSERT INTO customers(${columns.join(',')},address,billing_same_as_service) VALUES(${columns.map(()=>'?').join(',')},?,1)`);
     for(const row of rows){if(row.email&&db.prepare('SELECT id FROM customers WHERE lower(email)=lower(?) AND lower(name)=lower(?)').get(row.email,row.name))throw Error('Existing customer matches '+row.name+'; reconcile before importing');insert.run(...columns.map(col=>row[col]),row.address_line1);}
     const batch=Number(db.prepare('INSERT INTO migration_batches(actor_id,source_name,row_count) VALUES(?,?,?)').run(user.id,String(input.sourceName||'Reviewed customer import').slice(0,200),rows.length).lastInsertRowid);
     db.prepare('INSERT INTO audit_log(actor,action,detail) VALUES(?,?,?)').run(user.username,'Customer import committed',JSON.stringify({batch,count:rows.length}));db.exec('COMMIT');return respond(201,{batch,imported:rows.length});
    }catch(error){db.exec('ROLLBACK');throw error;}
   }
   return respond(404,{error:'Unknown maintenance route'});
  }catch(error){return respond(400,{error:String(error.message).slice(0,300)});}
 };
 let timer;
 function start(){
  if(process.env.AUTO_ENCRYPTED_BACKUP!=='true')return;
  const hours=Math.max(1,Math.min(168,Number(process.env.BACKUP_INTERVAL_HOURS)||24));
  const latest=db.prepare("SELECT created_at FROM maintenance_runs WHERE kind='encrypted_backup' ORDER BY id DESC LIMIT 1").get();
  if(!latest||Date.now()-Date.parse(latest.created_at+'Z')>=hours*3600000)queueMicrotask(()=>backup().catch(()=>{}));
  timer=setInterval(()=>backup().catch(()=>{}),hours*3600000);timer.unref();
 }
 return {routes,start,stop(){clearInterval(timer);},backup};
}

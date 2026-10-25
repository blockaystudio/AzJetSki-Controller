import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {createFullBackup,safePath,privateDirectory} from './backup-all.mjs';
import {validateBackup} from './restore-all.mjs';
import {loadEnv} from '../src/env.mjs';

const magic=Buffer.from('OTBENC1\n');
const keyBytes=value=>{
 if(!/^[a-f0-9]{64}$/i.test(value||''))throw Error('Set OWNERTRACKER_BACKUP_KEY to 32 random bytes as 64 hex digits; keep a separate private recovery copy.');
 return Buffer.from(value,'hex');
};
function members(root,relative=''){
 return fs.readdirSync(path.join(root,relative),{withFileTypes:true}).flatMap(entry=>{
  const name=relative?relative+'/'+entry.name:entry.name,file=path.join(root,name);
  safePath(file);
  if(entry.isDirectory())return members(root,name);
  if(!entry.isFile())throw Error('Backup contains a non-file entry');
  return [{path:name,size:fs.statSync(file).size}];
 }).sort((a,b)=>a.path.localeCompare(b.path));
}
function directories(root,relative=''){
 return fs.readdirSync(path.join(root,relative),{withFileTypes:true}).filter(entry=>entry.isDirectory()).flatMap(entry=>{
  const name=relative?relative+'/'+entry.name:entry.name;safePath(path.join(root,name));return [name,...directories(root,name)];
 });
}
export async function encryptBackup(source,destination,key){
 validateBackup(source);
 const files=members(source),header=Buffer.from(JSON.stringify({version:1,files,directories:directories(source)}));
 if(header.length>8_000_000)throw Error('Backup file list exceeds supported limit');
 const length=Buffer.alloc(4);length.writeUInt32BE(header.length);
 const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',keyBytes(key),nonce);
 cipher.setAAD(magic);
 privateDirectory(path.dirname(path.resolve(destination)));
 const outputFd=fs.openSync(destination,'wx',0o600);
 const output=fs.createWriteStream(destination,{fd:outputFd});
 output.write(magic);output.write(nonce);
 async function* data(){yield length;yield header;for(const file of files)for await(const chunk of fs.createReadStream(path.join(source,file.path)))yield chunk;}
 try{
  await pipeline(Readable.from(data()),createGzip(),cipher,output);
  fs.appendFileSync(destination,cipher.getAuthTag());
  return path.resolve(destination);
 }catch(error){fs.rmSync(destination,{force:true});throw error;}
}
function readExactly(fd,size,position){
 const out=Buffer.alloc(size);let received=0;
 while(received<size){const n=fs.readSync(fd,out,received,size-received,position+received);if(!n)throw Error('Encrypted backup is truncated');received+=n;}
 return out;
}
export async function decryptBackup(source,destination,key){
 safePath(source,{type:'file'});
 const target=path.resolve(destination);if(fs.existsSync(target))throw Error('Decryption destination must be a new empty path');
 privateDirectory(path.dirname(target));
 const stage=fs.mkdtempSync(path.join(path.dirname(target),'.backup-decrypt-'));
 const packed=path.join(stage,'payload'),unpacked=path.join(stage,'backup');
 try{
  const size=fs.statSync(source).size;if(size<magic.length+12+16)throw Error('Encrypted backup is truncated');
  const fd=fs.openSync(source,'r');let iv,tag;
  try{if(!readExactly(fd,magic.length,0).equals(magic))throw Error('Unsupported encrypted backup format');iv=readExactly(fd,12,magic.length);tag=readExactly(fd,16,size-16);}finally{fs.closeSync(fd);}
  const decipher=crypto.createDecipheriv('aes-256-gcm',keyBytes(key),iv);decipher.setAAD(magic);decipher.setAuthTag(tag);
  // No decrypted file is trusted until the authentication tag validates.
  await pipeline(fs.createReadStream(source,{start:magic.length+12,end:size-17}),decipher,createGunzip(),fs.createWriteStream(packed,{flags:'wx',mode:0o600}));
  const pack=fs.openSync(packed,'r');
  try{
   const headerLength=readExactly(pack,4,0).readUInt32BE();if(headerLength>8_000_000)throw Error('Backup header is too large');
   const header=JSON.parse(readExactly(pack,headerLength,4).toString());if(header.version!==1||!Array.isArray(header.files)||header.files.length>100000)throw Error('Invalid encrypted backup index');
   let offset=4+headerLength;const seen=new Set();privateDirectory(unpacked);
   for(const name of header.directories||[]){if(typeof name!=='string'||/[\\:\x00-\x1f]/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Unsafe backup directory');privateDirectory(path.join(unpacked,name));}
   for(const item of header.files){
    if(typeof item.path!=='string'||item.path.length>1000||/[\\:\x00-\x1f]/.test(item.path)||item.path.split('/').some(p=>!p||p==='.'||p==='..')||!Number.isSafeInteger(item.size)||item.size<0||seen.has(item.path))throw Error('Unsafe encrypted backup entry');
    seen.add(item.path);const file=path.join(unpacked,item.path);privateDirectory(path.dirname(file));const out=fs.openSync(file,'wx',0o600);
    try{for(let remaining=item.size;remaining;){const n=Math.min(remaining,1024*1024),chunk=readExactly(pack,n,offset);fs.writeSync(out,chunk);offset+=n;remaining-=n;}}finally{fs.closeSync(out);}
   }
   if(offset!==fs.statSync(packed).size)throw Error('Unexpected data after encrypted backup');
  }finally{fs.closeSync(pack);}
  validateBackup(unpacked);fs.renameSync(unpacked,target);return target;
 }catch(error){throw Error('Encrypted backup could not be authenticated or validated: '+error.message);}
 finally{fs.rmSync(stage,{recursive:true,force:true});}
}
export async function createEncryptedBackup(options={}){
 const key=options.key??process.env.OWNERTRACKER_BACKUP_KEY;
 keyBytes(key);
 const snapshot=createFullBackup(options);
 const destination=snapshot+'.otb';
 try{await encryptBackup(snapshot,destination,key);return destination;}finally{fs.rmSync(snapshot,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 process.umask(0o077);loadEnv();
 try{if(process.argv[2]==='decrypt'){if(!process.argv[3]||!process.argv[4])throw Error('Usage: node scripts/encrypted-backup.mjs decrypt FILE.otb NEW_DIRECTORY');console.log(await decryptBackup(process.argv[3],process.argv[4],process.env.OWNERTRACKER_BACKUP_KEY));}else console.log(await createEncryptedBackup());}
 catch(error){console.error(error.message);process.exitCode=1;}
}

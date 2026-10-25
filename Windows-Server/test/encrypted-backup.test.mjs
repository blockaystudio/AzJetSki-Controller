import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createFullBackup} from '../scripts/backup-all.mjs';
import {encryptBackup,decryptBackup} from '../scripts/encrypted-backup.mjs';
import {validateBackup} from '../scripts/restore-all.mjs';

test('encrypted full backup round trip preserves DB, documents and empty photo directories',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ot-encrypted-')));
 try{
  const dbPath=path.join(root,'source.sqlite'),db=new DatabaseSync(dbPath);db.exec("CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO records VALUES(1,'Private customer document')");db.close();
  const photos=path.join(root,'photos');fs.mkdirSync(path.join(photos,'empty'),{recursive:true});fs.writeFileSync(path.join(photos,'signed.pdf'),'Private signed form');
  const source=createFullBackup({databasePath:dbPath,uploadsPath:photos,backupRoot:path.join(root,'backups')});
  const output=path.join(root,'copy.otb'),key='12'.repeat(32);
  await encryptBackup(source,output,key);
  assert.equal(fs.readFileSync(output).includes(Buffer.from('Private signed form')),false);
  await assert.rejects(decryptBackup(output,path.join(root,'wrong-key'),'13'.repeat(32)),/authenticated/);
  assert.equal(fs.existsSync(path.join(root,'wrong-key')),false);
  const restored=await decryptBackup(output,path.join(root,'restored'),key);validateBackup(restored);
  assert.equal(fs.readFileSync(path.join(restored,'uploads','signed.pdf'),'utf8'),'Private signed form');
  assert.ok(fs.statSync(path.join(restored,'uploads','empty')).isDirectory());
  const original=fs.readFileSync(output);
  await assert.rejects(encryptBackup(source,output,key),/EEXIST/);
  assert.deepEqual(fs.readFileSync(output),original);
  const corrupted=Buffer.from(original);corrupted[30]^=1;fs.writeFileSync(path.join(root,'tampered.otb'),corrupted);
  await assert.rejects(decryptBackup(path.join(root,'tampered.otb'),path.join(root,'tampered'),key),/authenticated/);
  assert.equal(fs.existsSync(path.join(root,'tampered')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRelease,verifyRelease} from '../scripts/package-release.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ot-release-')),source=path.join(root,'source'),output=path.join(root,'release');
  fs.mkdirSync(path.join(source,'src'),{recursive:true});
  fs.mkdirSync(path.join(source,'public'));
  fs.writeFileSync(path.join(source,'src/server.mjs'),'// POS server code\n');
  fs.writeFileSync(path.join(source,'public/index.html'),'<h1>OwnerTracker</h1>');
  fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({name:'ownertracker',version:'11.1.0-shop',engines:{node:'>=22.16.0 <23'}}));
  fs.writeFileSync(path.join(source,'OwnerTrackerDesktop.exe'),Buffer.from([0x4d,0x5a]));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,source,output};
}

test('release includes application code and version/hash metadata while excluding shop secrets, customer files and runtimes',t=>{
  const f=fixture(t);
  for(const dir of ['data','uploads','backups','runtime','.git','node_modules']) {
    fs.mkdirSync(path.join(f.source,dir));fs.writeFileSync(path.join(f.source,dir,'private.txt'),'must not ship');
  }
  for(const file of ['.env','.env.production','public/private.sqlite','public/private.pem','public/run.log'])fs.writeFileSync(path.join(f.source,file),'must not ship');
  fs.writeFileSync(path.join(f.source,'.env.example'),'OWNERTRACKER_ADMIN_PASSWORD=CHANGE_ME_NOW');
  const result=createRelease({sourceDir:f.source,outputDir:f.output,commit:'test-commit'});
  assert.equal(result.manifest.nodeEngine,'>=22.16.0 <23');
  assert.equal(result.manifest.version,'11.1.0-shop');assert.equal(result.manifest.commit,'test-commit');
  assert.ok(result.manifest.files.some(file=>file.path==='.env.example'));
  assert.deepEqual(result.manifest,verifyRelease(f.output));
  const files=result.manifest.files.map(file=>file.path);
  assert.ok(files.includes('src/server.mjs'));assert.ok(files.includes('OwnerTrackerDesktop.exe'));
  assert.ok(!files.some(file=>/private|node_modules|^data\/|^runtime\/|^backups\/|^\.git\//.test(file)));
  assert.equal(fs.existsSync(path.join(f.output,'.env')),false);
});

test('tampered code, missing files and unexpected entries fail complete release verification',async t=>{
  for(const mode of ['tamper','missing','extra'])await t.test(mode,t=>{
    const f=fixture(t);createRelease({sourceDir:f.source,outputDir:f.output});
    if(mode==='tamper')fs.appendFileSync(path.join(f.output,'src/server.mjs'),'changed');
    if(mode==='missing')fs.unlinkSync(path.join(f.output,'public/index.html'));
    if(mode==='extra')fs.writeFileSync(path.join(f.output,'public/extra.js'),'unexpected');
    assert.throws(()=>verifyRelease(f.output),/inventory|checksum/);
  });
});

test('unsafe, duplicate and case-colliding manifest paths are rejected',async t=>{
  for(const mode of ['traversal','private','duplicate','case'])await t.test(mode,t=>{
    const f=fixture(t);createRelease({sourceDir:f.source,outputDir:f.output});
    const file=path.join(f.output,'RELEASE-MANIFEST.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8'));
    if(mode==='traversal')manifest.files[0].path='../outside';
    if(mode==='private')manifest.files[0].path='.env';
    if(mode==='duplicate')manifest.files.push({...manifest.files[0]});
    if(mode==='case')manifest.files.push({...manifest.files[0],path:manifest.files[0].path.toUpperCase()});
    fs.writeFileSync(file,JSON.stringify(manifest));
    assert.throws(()=>verifyRelease(f.output),/Invalid|Duplicate|case/);
  });
});

test('source links and overlapping/existing output fail without modifying the source',t=>{
  const f=fixture(t);
  assert.throws(()=>createRelease({sourceDir:f.source,outputDir:path.join(f.source,'release')}),/overlap/);
  assert.throws(()=>createRelease({sourceDir:f.source,outputDir:f.source}),/overlap/);
  fs.mkdirSync(f.output);
  assert.throws(()=>createRelease({sourceDir:f.source,outputDir:f.output}),/already exists/);
  fs.rmdirSync(f.output);
  fs.linkSync(path.join(f.source,'src/server.mjs'),path.join(f.source,'src/hardlink.mjs'));
  assert.throws(()=>createRelease({sourceDir:f.source,outputDir:f.output}),/unlinked/);
  assert.equal(fs.existsSync(f.output),false);
  assert.equal(fs.readFileSync(path.join(f.source,'src/server.mjs'),'utf8'),'// POS server code\n');
});

test('release runtime/version changes require review and retained PowerShell baseline JSON supports BOM/property ordering',t=>{
  const f=fixture(t);
  assert.throws(()=>createRelease({sourceDir:f.source,outputDir:f.output,version:'../invalid'}),/version/);
  createRelease({sourceDir:f.source,outputDir:f.output});
  const file=path.join(f.output,'RELEASE-MANIFEST.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8'));
  manifest.files=manifest.files.map(item=>({sha256:item.sha256,size:item.size,path:item.path}));
  fs.writeFileSync(file,'\uFEFF'+JSON.stringify(manifest));
  assert.equal(verifyRelease(f.output).version,'11.1.0-shop');
  const metadata=JSON.parse(fs.readFileSync(path.join(f.source,'package.json'),'utf8'));
  metadata.engines.node='>=24';fs.writeFileSync(path.join(f.source,'package.json'),JSON.stringify(metadata));
  assert.throws(()=>createRelease({sourceDir:f.source,outputDir:path.join(f.root,'future')}),/Node engine/);
});

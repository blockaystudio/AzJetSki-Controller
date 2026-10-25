import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const releaseRoots=['src','public','scripts','windows','ios','deploy','docs','package.json','OwnerTrackerDesktop.exe','.env.example','README.md','START_HERE_V11.md','IMPLEMENTATION_PLAN_V11.md','QA_AND_ACCEPTANCE_V11.md','RELEASE_NOTES_V11.md'];
const excluded=new Set(['.git','.codex','.agents','node_modules','data','uploads','backups','runtime','.openai']);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function safeRelative(file) {
  return typeof file==='string' && file.length>0 && !/[\\:\x00-\x1f]/.test(file)
    && file.split('/').every(part=>part&&part!=='.'&&part!=='..')
    && releaseRoots.includes(file.split('/')[0])
    && !file.split('/').some(part=>excluded.has(part)||((part==='.env'||part.startsWith('.env.'))&&part!=='.env.example'))
    && !/\.(sqlite(?:-[a-z]+)?|db|log|pem|key)$/i.test(file);
}
function isWithin(file,root) {const relative=path.relative(root,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
function assertRegular(file,directory=false) {
  const stat=fs.lstatSync(file);
  if(stat.isSymbolicLink()||(!directory&&!stat.isFile())||(directory&&!stat.isDirectory())||(!directory&&stat.nlink!==1))throw Error('Release entries must be regular unlinked files/directories: '+file);
  return stat;
}
function inventory(root,{filter=false}={}) {
  const files=[];
  function walk(directory,prefix='') {
    for(const name of fs.readdirSync(directory).sort()) {
      const relative=prefix?`${prefix}/${name}`:name;
      if(relative==='RELEASE-MANIFEST.json')continue;
      if(!safeRelative(relative)) {
        if(filter)continue;
        throw Error('Unexpected or private release entry: '+relative);
      }
      const full=path.join(directory,name),stat=fs.lstatSync(full);
      if(stat.isSymbolicLink())throw Error('Release symlinks are not allowed: '+relative);
      if(stat.isDirectory())walk(full,relative);
      else {assertRegular(full);const bytes=fs.readFileSync(full);files.push({path:relative,size:bytes.length,sha256:sha(bytes)});}
    }
  }
  walk(root);
  return files;
}

export function verifyRelease(directory) {
  const root=path.resolve(directory);assertRegular(root,true);
  const file=path.join(root,'RELEASE-MANIFEST.json');
  const stat=assertRegular(file);
  if(stat.size>16*1024*1024)throw Error('Release manifest is too large');
  const manifest=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  if(manifest.schemaVersion!==1||manifest.product!=='OwnerTracker'||manifest.nodeEngine!=='>=22.16.0 <23'||!Array.isArray(manifest.files)||!manifest.files.length)throw Error('Invalid or unsupported release manifest');
  if(typeof manifest.version!=='string'||!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(manifest.version))throw Error('Invalid release version');
  if(new Set(manifest.files.map(item=>String(item.path).toLowerCase())).size!==manifest.files.length)throw Error('Duplicate/case-colliding release manifest entry');
  for(const item of manifest.files)if(!safeRelative(item.path)||!Number.isSafeInteger(item.size)||item.size<0||!/^[a-f0-9]{64}$/.test(item.sha256||''))throw Error('Invalid release file metadata');
  const actual=inventory(root);
  const expected=new Map(manifest.files.map(item=>[item.path,item]));
  if(actual.length!==expected.size||actual.some(item=>{
    const wanted=expected.get(item.path);return !wanted||wanted.size!==item.size||wanted.sha256!==item.sha256;
  }))throw Error('Release file inventory or checksum mismatch');
  if(!actual.some(item=>item.path==='src/server.mjs')||!actual.some(item=>item.path==='package.json'))throw Error('Release is missing the POS server or package metadata');
  return manifest;
}

export function createRelease({sourceDir=fileURLToPath(new URL('../',import.meta.url)),outputDir,version,commit='unknown'}={}) {
  if(!outputDir)throw Error('An output directory is required');
  const source=fs.realpathSync(path.resolve(sourceDir)),destination=path.resolve(outputDir);
  if(isWithin(destination,source)||isWithin(source,destination))throw Error('Release output and application source must not overlap');
  if(fs.existsSync(destination))throw Error('Release output already exists; choose a new empty path');
  const metadata=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
  const selectedVersion=version||metadata.version;
  if(typeof selectedVersion!=='string'||!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(selectedVersion))throw Error('Invalid release version');
  if(metadata.engines?.node!=='>=22.16.0 <23')throw Error('Unexpected Node engine; review the updater before changing runtime requirements');
  fs.mkdirSync(destination,{recursive:true,mode:0o700});
  try {
    const files=inventory(source,{filter:true});
    for(const item of files) {
      const target=path.join(destination,...item.path.split('/'));
      fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
      fs.copyFileSync(path.join(source,...item.path.split('/')),target,fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target,0o600);
    }
    const manifest={schemaVersion:1,product:'OwnerTracker',version:selectedVersion,nodeEngine:metadata.engines.node,target:'windows-x64',createdAt:new Date().toISOString(),commit,files};
    fs.writeFileSync(path.join(destination,'RELEASE-MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    verifyRelease(destination);
    return {directory:destination,manifest};
  } catch(error) {fs.rmSync(destination,{recursive:true,force:true});throw error;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  try {
    if(args[0]==='--verify'&&args.length===2){const result=verifyRelease(args[1]);console.log(`Verified OwnerTracker ${result.version}: ${result.files.length} files`);}
    else if(args.length>=1&&args.length<=2){const result=createRelease({outputDir:args[0],version:args[1],commit:process.env.GITHUB_SHA||'unknown'});console.log(`Packaged OwnerTracker ${result.manifest.version}: ${result.manifest.files.length} files in ${result.directory}`);}
    else throw Error('Usage: node scripts/package-release.mjs OUTPUT_DIR [VERSION] | --verify RELEASE_DIR');
  } catch(error){console.error(error.message);process.exitCode=1;}
}

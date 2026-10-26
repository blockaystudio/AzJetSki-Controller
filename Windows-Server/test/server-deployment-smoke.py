'''Disposable local Linux deployment smoke test; requires Node 22, Python 3, and Docker Compose 2.24.4+.'''
import json, os, pathlib, shutil, subprocess, tempfile, http.client
root=pathlib.Path(tempfile.mkdtemp(prefix='ot-server-compose-'))
repo=pathlib.Path(__file__).resolve().parents[1]
node=os.environ.get('OWNERTRACKER_NODE') or shutil.which('node')
if not node: raise SystemExit('Node 22 is required; set OWNERTRACKER_NODE to its binary.')
version=subprocess.run([node,'--version'],capture_output=True,text=True,check=True).stdout.strip().lstrip('v').split('.')
if version[0]!='22' or int(version[1])<16: raise SystemExit('Use Node 22.16+ within 22.x; set OWNERTRACKER_NODE to its binary.')
env=os.environ.copy()
for key in ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']: env.pop(key,None)
docker=['docker','--host=unix:///var/run/docker.sock']
project='ot-server-check-'+root.name.rsplit('-',1)[-1]
(root/'deploy').mkdir()
for name in ['compose.server.yml','Caddyfile']: shutil.copyfile(repo/'deploy'/name, root/'deploy'/name)
setup=(repo/'scripts'/'setup-server.mjs').as_uri()
subprocess.run([node,'--input-type=module','-e',"import {createServerSetup} from "+json.dumps(setup)+";createServerSetup({domain:'shop.example.com',directory:process.argv[1]});",str(root/'.server')],check=True,env=env)
image='ownertracker-server-smoke:'+root.name
(root/'deploy'/'compose.test.yml').write_text(f'''services:
  ownertracker:
    image: {image}
  https:
    environment:
      SHOP_DOMAIN: http://server-check.invalid
    ports: !override
      - '127.0.0.1::80'
''')
compose=docker+['compose','-p',project,'--env-file',str(root/'.server'/'.env'),'-f',str(root/'deploy'/'compose.server.yml'),'-f',str(root/'deploy'/'compose.test.yml')]
def call(args):
    result=subprocess.run(args,capture_output=True,text=True,env=env)
    if result.returncode:
        raise RuntimeError('Command failed: '+str(args[:5])+'\n'+result.stdout+'\n'+result.stderr)
    return result.stdout.strip()
def execute(code): return call(compose+['exec','-T','ownertracker','node','--input-type=module','-e',code])
def offline(code): return call(compose+['run','--rm','--no-deps','ownertracker','node','--input-type=module','-e',code])
try:
    call(docker+['build','-f',str(repo/'deploy'/'Dockerfile.server'),'-t',image,str(repo)])
    print('PASS: server image builds from the supplied source and private context exclusions',flush=True)
    call(compose+['config','--quiet'])
    call(compose+['up','-d','--no-build','--wait','--wait-timeout','120'])
    print('PASS: actual server Compose file parses and waits for a healthy app',flush=True)
    cid=call(compose+['ps','-q','ownertracker'])
    state=json.loads(call(docker+['inspect','--format','{{json .HostConfig}}',cid]))
    assert state['ReadonlyRootfs'] and state['RestartPolicy']['Name']=='unless-stopped'
    assert state['CapDrop']==['ALL'] and 'no-new-privileges:true' in state['SecurityOpt']
    assert not state['PortBindings']
    execute("import fs from 'node:fs';if(process.getuid()!==1000)throw Error('not node user');for(const p of ['/app/data','/app/backups'])if(fs.statSync(p).uid!==1000)throw Error('volume owner');try{fs.writeFileSync('/app/forbidden','x');throw Error('root writable')}catch(e){if(e.code!=='EROFS')throw e};if(fs.existsSync('/app/.server')||fs.existsSync('/app/.env'))throw Error('private config in image');")
    print('PASS: UID 1000, node-owned persistent volumes, read-only root, dropped capabilities, restart policy, no public app port, private files absent from image',flush=True)
    bind=call(compose+['port','https','80']); port=int(bind.rsplit(':',1)[1])
    conn=http.client.HTTPConnection('127.0.0.1',port,timeout=10);conn.request('GET','/health',headers={'Host':'server-check.invalid'});response=conn.getresponse();body=response.read();conn.close()
    assert response.status==200, 'Caddy health response status: '+str(response.status)
    assert json.loads(body)['ok']
    print('PASS: loopback HTTP request through real Caddy reverse proxy reaches app health',flush=True)
    execute("import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.env.OWNERTRACKER_DB);if(db.prepare('SELECT count(*) AS n FROM customers').get().n!==0)throw Error('demo customers');db.exec(\"CREATE TABLE deployment_check(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO deployment_check VALUES(1,'fictional restart record')\");db.close();fs.writeFileSync('/app/data/uploads/deployment-check.txt','fictional attachment');")
    call(compose+['restart','ownertracker']);call(compose+['up','-d','--no-build','--wait','--wait-timeout','120'])
    execute("import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.env.OWNERTRACKER_DB);if(db.prepare('SELECT value FROM deployment_check WHERE id=1').get().value!=='fictional restart record'||fs.readFileSync('/app/data/uploads/deployment-check.txt','utf8')!=='fictional attachment')throw Error('lost persisted data');const b=db.prepare(\"SELECT status FROM maintenance_runs WHERE kind='encrypted_backup' ORDER BY id DESC LIMIT 1\").get();if(b?.status!=='local_encrypted')throw Error('automatic backup failed');db.close();")
    print('PASS: no demo customers; SQLite + upload survive container restart; scheduled encrypted startup backup succeeds',flush=True)
    execute("import fs from 'node:fs';import {createEncryptedBackup} from './scripts/encrypted-backup.mjs';import {DatabaseSync} from 'node:sqlite';const backup=await createEncryptedBackup();fs.writeFileSync('/app/backups/deployment-check-path.txt',backup,{mode:0o600});const db=new DatabaseSync(process.env.OWNERTRACKER_DB);db.exec(\"UPDATE deployment_check SET value='changed after backup' WHERE id=1\");db.close();fs.writeFileSync('/app/data/uploads/deployment-check.txt','changed after backup');")
    call(compose+['stop','https','ownertracker'])
    offline("import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {decryptBackup} from './scripts/encrypted-backup.mjs';import {restoreFullBackup} from './scripts/restore-all.mjs';const db=new DatabaseSync(process.env.OWNERTRACKER_DB);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();const source=fs.readFileSync('/app/backups/deployment-check-path.txt','utf8');await decryptBackup(source,'/app/backups/restore-verified',process.env.OWNERTRACKER_BACKUP_KEY);restoreFullBackup('/app/backups/restore-verified');")
    call(compose+['up','-d','--no-build','--wait','--wait-timeout','120'])
    execute("import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.env.OWNERTRACKER_DB);if(db.prepare('SELECT value FROM deployment_check WHERE id=1').get().value!=='fictional restart record'||fs.readFileSync('/app/data/uploads/deployment-check.txt','utf8')!=='fictional attachment')throw Error('restore mismatch');if(!fs.readdirSync('/app/data').some(n=>n.startsWith('ownertracker-before-restore-')))throw Error('no pre-restore copy');db.close();")
    print('PASS: encrypted archive decrypted and restored database + attachment; pre-restore recovery copy retained; restored app healthy',flush=True)
    print('VERIFIED LOCAL ONLY: no public DNS, public certificate, or paid host provisioned',flush=True)
except Exception:
    print(call(compose+['logs','--tail','30','ownertracker','https']),flush=True)
    raise
finally:
    cleanup=subprocess.run(compose+['down','--volumes','--remove-orphans'],capture_output=True,text=True,env=env)
    if cleanup.returncode:
        print('Cleanup failed; inspect test project '+project+' and private temporary directory '+str(root),flush=True)
    else:
        subprocess.run(docker+['image','rm',image],capture_output=True,text=True,env=env)
        shutil.rmtree(root)
        print('Disposable test containers, networks, volumes, and generated secrets removed',flush=True)

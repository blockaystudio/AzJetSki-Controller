import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadEnv} from '../src/env.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
try {
 process.umask(0o077);process.chdir(root);loadEnv();
 if(process.argv.length!==3)throw Error('Usage: node scripts/configure-google-calendar.mjs /private/path/client.json');
 const file=path.join(root,'.env'),original=fs.readFileSync(file,'utf8');
 if(process.env.GOOGLE_CALENDAR_CLIENT_ID||process.env.GOOGLE_CALENDAR_CLIENT_SECRET)throw Error('Calendar credentials already exist; refusing to replace a configured connection.');
 const origin=new URL(process.env.PUBLIC_BASE_URL||'');
 if(origin.protocol!=='https:'||origin.username||origin.password)throw Error('Configure the stable HTTPS PUBLIC_BASE_URL first.');
 const callback=origin.origin+'/api/shop/google-calendar/callback';
 const {web}=JSON.parse(fs.readFileSync(path.resolve(process.argv[2]),'utf8'));
 if(!web?.client_id||!web.client_secret||!web.redirect_uris?.includes(callback))throw Error('A Web OAuth client with the exact registered shop callback is required.');
 for(const value of [web.client_id,web.client_secret])if(typeof value!=='string'||!value||/[\r\n"'#\s]/.test(value))throw Error('Unsupported OAuth credential format.');
 const updates={GOOGLE_CALENDAR_CLIENT_ID:web.client_id,GOOGLE_CALENDAR_CLIENT_SECRET:web.client_secret,GOOGLE_CALENDAR_REDIRECT_URL:callback,GOOGLE_CALENDAR_EMAIL:'jetskiarizona@gmail.com',GOOGLE_CALENDAR_TOKEN_KEY:process.env.GOOGLE_CALENDAR_TOKEN_KEY||crypto.randomBytes(32).toString('hex')};
 if(!/^[a-f0-9]{64}$/i.test(updates.GOOGLE_CALENDAR_TOKEN_KEY))throw Error('Existing token encryption key is invalid; reconcile before changing credentials.');
 const rest=original.split('\n').filter(line=>!Object.keys(updates).some(key=>new RegExp('^\\s*'+key+'\\s*=').test(line))).join('\n');
 const temporary=file+'.calendar-'+crypto.randomUUID();
 try{fs.writeFileSync(temporary,rest+'\n'+Object.entries(updates).map(([key,value])=>key+'='+value).join('\n')+'\n',{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
 console.log('Private Calendar configuration saved. Restart the server, then connect from Schedule. No credentials were printed.');
} catch(error){console.error('Calendar setup failed: '+(error instanceof SyntaxError?'Invalid client JSON':error.message));process.exitCode=1;}

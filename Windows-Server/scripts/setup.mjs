import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
const f=path.resolve('.env');
if(fs.existsSync(f)){console.error('Existing .env found; refusing to overwrite credentials.');process.exit(1)}
const secret=()=>crypto.randomBytes(32).toString('base64url');
const initialPass=secret().slice(0,22);
const lines=[
 'PORT=8787','HOST=127.0.0.1','OWNERTRACKER_DB=./data/ownertracker.sqlite',
 'OWNERTRACKER_ADMIN_USER=owner',`OWNERTRACKER_ADMIN_PASSWORD=${initialPass}`,
 `OWNERTRACKER_SESSION_SECRET=${secret()}`,`QBPOS_BRIDGE_TOKEN=${secret()}`,`DESKTOP_AGENT_TOKEN=${secret()}`,
 'SHOP_NAME=AZ Jet Ski, Boats & Powersports','SHOP_PHONE=602-482-9322','SHOP_LOGO_URL=/brand-logo.png',
 'PUBLIC_BASE_URL=http://127.0.0.1:8787','LIVE_VENDOR_ORDERING=false',
 'AUTO_BUILD_PROCUREMENT=true','AUTO_SUPPLIER_LOOKUP=false',
 'NODE_ENV=production','NOTIFY_WEBHOOK_URL=',
 'GOOGLE_CALENDAR_CLIENT_ID=','GOOGLE_CALENDAR_CLIENT_SECRET=','GOOGLE_CALENDAR_REDIRECT_URL=',
 `GOOGLE_CALENDAR_TOKEN_KEY=${crypto.randomBytes(32).toString('hex')}`,'GOOGLE_CALENDAR_EMAIL=jetskiarizona@gmail.com'
];
fs.writeFileSync(f,lines.join('\n')+'\n',{flag:'wx',mode:0o600});
fs.mkdirSync('./data',{recursive:true});
console.log('\nSETUP COMPLETE — PRIVATE CREDENTIALS\n');
console.log('First owner login: owner');
console.log('First owner password: '+initialPass);
console.log('Change the password in Employees after first login. Protect .env and shop computer.');
console.log('Do NOT send dealer usernames/passwords in chat or place them in the mobile applications.');

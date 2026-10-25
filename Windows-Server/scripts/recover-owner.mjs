// Run locally on the protected shop computer when no owner can sign in.
// This prints a private recovery capability only to the invoking local terminal.
import path from 'node:path';
import fs from 'node:fs';
import {loadEnv} from '../src/env.mjs';
import {openDb} from '../src/db.mjs';
import {createAccessSecurity} from '../src/access-security.mjs';

loadEnv();
const username=process.argv[2];
if(!username || process.argv.length!==3) {
  console.error('Usage from Windows-Server: node scripts/recover-owner.mjs OWNER_USERNAME');
  process.exitCode=1;
} else {
  const databasePath=path.resolve(process.env.OWNERTRACKER_DB || './data/ownertracker.sqlite');
  if(!fs.existsSync(databasePath)||!fs.statSync(databasePath).isFile()) {
    console.error('Existing shop database not found. Check OWNERTRACKER_DB; recovery never initializes a new shop.');
    process.exit(1);
  }
  const db=openDb(databasePath);
  try {
    const user=db.prepare("SELECT id,username FROM users WHERE username=? AND role='owner' AND active=1").get(username);
    if(!user)throw Error('An active owner account with this username is required');
    const access=createAccessSecurity({db,publicBaseUrl:process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:8787',sessionSecret:process.env.OWNERTRACKER_SESSION_SECRET || 'local-recovery-session-not-used',json(){},readBody(){}});
    const recovery=access.issueRecovery(user.id);
    console.log('PRIVATE OWNER RECOVERY — keep this terminal and link private. No email was sent.');
    console.log('Expires:',recovery.expiresAt);
    console.log(recovery.recoveryUrl);
    console.log('Open the link while the shop server is running. Recovery revokes old sessions and PIN.');
  } catch(error) { console.error(error.message);process.exitCode=1; }
  finally { db.close(); }
}

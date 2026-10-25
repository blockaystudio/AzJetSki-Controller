// Shop authentication controls. No credential values or recovery tokens enter logs.
import crypto from 'node:crypto';
import {hashPassword as defaultHashPassword, verifyPassword as defaultVerifyPassword} from './db.mjs';

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const text = (value, max = 200) => String(value ?? '').trim().slice(0, max);
const safeCookie = req => {
  for (const part of String(req.headers?.cookie || '').split(';')) {
    const equal = part.indexOf('=');
    if (equal < 0 || part.slice(0, equal).trim() !== 'ot_session') continue;
    try { return decodeURIComponent(part.slice(equal + 1).trim()); } catch { return ''; }
  }
  return '';
};
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const owner = user => user?.role === 'owner';

export function installAccessSecurity(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS access_login_attempts (
    key_hash TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS access_recovery_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id), created_by INTEGER REFERENCES users(id),
    expires_at TEXT NOT NULL, used_at TEXT, revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TRIGGER IF NOT EXISTS access_revoke_sessions_on_identity_change
    AFTER UPDATE OF password_hash,salt,pin_hash,pin_salt,active,role,username ON users
    WHEN OLD.password_hash IS NOT NEW.password_hash OR OLD.salt IS NOT NEW.salt
      OR OLD.pin_hash IS NOT NEW.pin_hash OR OLD.pin_salt IS NOT NEW.pin_salt
      OR OLD.active IS NOT NEW.active OR OLD.role IS NOT NEW.role OR OLD.username IS NOT NEW.username
    BEGIN
      DELETE FROM sessions WHERE user_id=NEW.id;
      UPDATE access_recovery_tokens SET revoked_at=CURRENT_TIMESTAMP
        WHERE user_id=NEW.id AND used_at IS NULL AND revoked_at IS NULL;
    END;`);
  if (!db.prepare('PRAGMA table_info(sessions)').all().some(column => column.name === 'access_id')) {
    db.exec("ALTER TABLE sessions ADD COLUMN access_id TEXT NOT NULL DEFAULT ''");
  }
  for (const row of db.prepare("SELECT token_hash FROM sessions WHERE access_id=''").all()) {
    db.prepare('UPDATE sessions SET access_id=? WHERE token_hash=?').run(crypto.randomUUID(), row.token_hash);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_session_access_id ON sessions(access_id) WHERE access_id<>''");
}

export function createAccessSecurity({db, json, readBody, publicBaseUrl, sessionSecret,
  hashPassword = defaultHashPassword, verifyPassword = defaultVerifyPassword,
  trustProxy = process.env.TRUST_PROXY === 'true', now = () => Date.now(),
  loginFailureLimit = 6, loginWindowMs = 15 * 60_000, sessionMs = 12 * 3600_000}) {
  installAccessSecurity(db);
  const configuredOrigin = new URL(publicBaseUrl || 'http://127.0.0.1:8787').origin;
  const tokenHash = token => crypto.createHmac('sha256', sessionSecret).update(token).digest('hex');
  const dummy = hashPassword(crypto.randomBytes(24).toString('base64url'));
  const timestamp = () => new Date(now()).toISOString();
  const send = (res, status, body, headers = {}) => { json(res, status, body, {'cache-control':'no-store',...headers}); return true; };
  const audit = (user, action, detail) => db.prepare('INSERT INTO audit_log(actor,action,detail) VALUES(?,?,?)')
    .run(user?.username || 'recovery', action, JSON.stringify(detail));
  const secureRequest = req => !!req.socket?.encrypted || configuredOrigin.startsWith('https://') ||
    (trustProxy && req.headers?.['x-forwarded-proto'] === 'https');
  const cookie = (req, token = '', duration = sessionMs) => `ot_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? Math.floor(duration / 1000) : 0}${secureRequest(req) ? '; Secure' : ''}`;
  const userView = user => ({id:user.id,username:user.username,displayName:user.display_name || user.username,role:user.role,active:!!user.active});

  function sessionUser(req) {
    const token = safeCookie(req);
    if (!token) return null;
    const row = db.prepare(`SELECT u.id,u.username,COALESCE(u.display_name,u.username) display_name,u.role,u.active,
      s.expires_at,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND u.active=1`).get(tokenHash(token));
    if (!row || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now()) return null;
    const {expires_at,token_hash,...user} = row;
    return user;
  }

  // Only explicitly configured proxy deployments may trust forwarding headers.
  function source(req) {
    if (trustProxy) return text(String(req.headers?.['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || 'unknown', 100);
    return text(req.socket?.remoteAddress || 'unknown', 100);
  }
  const keys = (req, username) => [sha(`account-source:${source(req)}:${username}`),sha(`source:${source(req)}`)];
  function throttled(req, username) {
    const attempts = keys(req,username).map(key => db.prepare('SELECT * FROM access_login_attempts WHERE key_hash=?').get(key));
    const active = attempts.map(row => row && Date.parse(row.expires_at) > now() ? row : null);
    const blocked = active.find((row,index) => row && row.failures >= (index === 0 ? loginFailureLimit : loginFailureLimit * 10));
    return blocked ? Math.max(1,Math.ceil((Date.parse(blocked.expires_at)-now()) / 1000)) : 0;
  }
  function failed(req, username) {
    const expiry = new Date(now()+loginWindowMs).toISOString(), time=timestamp();
    for (const key of keys(req,username)) {
      db.prepare(`INSERT INTO access_login_attempts(key_hash,failures,expires_at,updated_at) VALUES(?,1,?,?)
        ON CONFLICT(key_hash) DO UPDATE SET failures=CASE WHEN julianday(access_login_attempts.expires_at)<=julianday(?) THEN 1 ELSE failures+1 END,
        expires_at=CASE WHEN julianday(access_login_attempts.expires_at)<=julianday(?) THEN excluded.expires_at ELSE access_login_attempts.expires_at END,
        updated_at=excluded.updated_at`).run(key,expiry,time,time,time);
    }
    db.prepare('DELETE FROM access_login_attempts WHERE julianday(expires_at)<julianday(?)').run(new Date(now()-86400_000).toISOString());
  }

  function middleware(req, res) {
    res.setHeader?.('x-content-type-options','nosniff');
    res.setHeader?.('referrer-policy','no-referrer');
    res.setHeader?.('x-frame-options','DENY');
    res.setHeader?.('permissions-policy','camera=(self), microphone=(), geolocation=()');
    if (secureRequest(req)) res.setHeader?.('strict-transport-security','max-age=31536000');
    if (['GET','HEAD','OPTIONS'].includes(req.method)) return false;
    const origin = req.headers?.origin;
    // Non-browser native/mobile clients have no Origin; cookie browsers are also
    // protected by SameSite=Strict. Explicit foreign and opaque origins fail.
    if (origin) {
      let candidate;
      try { candidate=new URL(origin).origin; } catch { return send(res,403,{error:'Cross-origin mutation denied'}); }
      let localOrigin='';
      try { localOrigin=new URL(`${req.socket?.encrypted ? 'https':'http'}://${req.headers.host}`).origin; } catch {}
      const localDevelopment = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(localOrigin);
      if (candidate!==configuredOrigin && !(localDevelopment && candidate===localOrigin)) return send(res,403,{error:'Cross-origin mutation denied'});
    }
    if (req.headers?.['sec-fetch-site']==='cross-site') return send(res,403,{error:'Cross-site mutation denied'});
    return false;
  }

  function issueRecovery(userId, actorUser = null) {
    const target = db.prepare('SELECT id,username,active FROM users WHERE id=?').get(userId);
    if (!target?.active) { const error=new Error('Active employee not found'); error.status=404; throw error; }
    const token=crypto.randomBytes(32).toString('base64url'), expiresAt=new Date(now()+15*60_000).toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE access_recovery_tokens SET revoked_at=? WHERE user_id=? AND used_at IS NULL AND revoked_at IS NULL').run(timestamp(),userId);
      const result=db.prepare('INSERT INTO access_recovery_tokens(token_hash,user_id,created_by,expires_at) VALUES(?,?,?,?)').run(sha(token),userId,actorUser?.id || null,expiresAt);
      audit(actorUser,'Employee recovery token issued',{userId,expiresAt,localOwnerRecovery:!actorUser});
      db.exec('COMMIT');
      return {id:Number(result.lastInsertRowid),expiresAt,recoveryUrl:`${configuredOrigin}/recover/${token}`,notice:'One-time recovery link. Deliver privately; no email was sent.'};
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }

  function redeemRecovery(token, password) {
    if (typeof password!=='string' || password.length<12 || password.length>256) { const error=new Error('Use a password of 12 to 256 characters'); error.status=400; throw error; }
    const hashed=hashPassword(password);
    db.exec('BEGIN IMMEDIATE');
    try {
      const recovery=db.prepare(`SELECT r.* FROM access_recovery_tokens r JOIN users u ON u.id=r.user_id
        WHERE r.token_hash=? AND r.used_at IS NULL AND r.revoked_at IS NULL AND u.active=1`).get(sha(token));
      if (!recovery || Date.parse(recovery.expires_at)<=now() || !Number.isFinite(Date.parse(recovery.expires_at))) { const error=new Error('Recovery link is invalid or expired');error.status=400;throw error; }
      db.prepare('UPDATE access_recovery_tokens SET used_at=? WHERE id=? AND used_at IS NULL').run(timestamp(),recovery.id);
      db.prepare('UPDATE users SET password_hash=?,salt=?,pin_hash=NULL,pin_salt=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(hashed.hash,hashed.salt,recovery.user_id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(recovery.user_id);
      audit(null,'Employee account recovered',{userId:recovery.user_id,recoveryId:recovery.id,pinCleared:true});
      db.exec('COMMIT');
      return {ok:true,notice:'Password updated. Sign in again. Any prior PIN and sessions were revoked.'};
    } catch(error) { db.exec('ROLLBACK');throw error; }
  }

  async function routes(req,res,p) {
    try {
      if (p==='/api/login' && req.method==='POST') {
        const body=await readBody(req),username=text(body.username,100), retry=throttled(req,username.toLowerCase());
        if (retry) return send(res,429,{error:'Too many sign-in attempts. Try again later.',retryAfterSeconds:retry},{'retry-after':String(retry)});
        const user=db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
        const secret=String(body.password || body.pin || '');
        const valid=secret.length<=256 && user && (verifyPassword(secret,user.salt,user.password_hash) || verifyPassword(secret,user.pin_salt,user.pin_hash));
        if (!user) verifyPassword(secret.slice(0,256),dummy.salt,dummy.hash);
        if (!valid) { failed(req,username.toLowerCase());return send(res,401,{error:'Invalid credentials'}); }
        db.prepare('DELETE FROM access_login_attempts WHERE key_hash=?').run(keys(req,username.toLowerCase())[0]);
        const token=crypto.randomBytes(32).toString('base64url'),expires=new Date(now()+sessionMs).toISOString();
        db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,access_id) VALUES(?,?,?,?)').run(tokenHash(token),user.id,expires,crypto.randomUUID());
        db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(timestamp(),user.id);
        return send(res,200,{ok:true,user:userView(user)},{'set-cookie':cookie(req,token)});
      }
      if (p==='/api/logout' && req.method==='POST') {
        const token=safeCookie(req);if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
        return send(res,200,{ok:true},{'set-cookie':cookie(req)});
      }
      if (p.startsWith('/api/security/')) {
        const user=sessionUser(req);
        if (!user) return send(res,401,{error:'Login required'});
        if (!owner(user)) return send(res,403,{error:'Owner permission required'});
        if (p==='/api/security/status' && req.method==='GET') return send(res,200,{httpsConfigured:configuredOrigin.startsWith('https://'),trustedProxy:trustProxy,loginFailureLimit,loginWindowMinutes:loginWindowMs/60_000,sessionHours:sessionMs/3600_000,recoveryMinutes:15,notice:'Recovery links are one-use and must be delivered privately. Secure hosting and real-device acceptance remain deployment tasks.'});
        if (p==='/api/security/sessions' && req.method==='GET') return send(res,200,{sessions:db.prepare(`SELECT s.access_id id,s.user_id,u.username,u.role,s.created_at,s.expires_at
          FROM sessions s JOIN users u ON u.id=s.user_id WHERE julianday(s.expires_at)>julianday(?) ORDER BY s.created_at DESC`).all(timestamp())});
        const revoke=p.match(/^\/api\/security\/sessions\/([a-f0-9-]{36})\/revoke$/);
        if (revoke && req.method==='POST') {
          const body=await readBody(req);if(body.confirm!==true)return send(res,400,{error:'Explicit confirmation required'});
          const row=db.prepare('SELECT user_id FROM sessions WHERE access_id=?').get(revoke[1]);
          if(!row)return send(res,404,{error:'Session not found'});
          db.prepare('DELETE FROM sessions WHERE access_id=?').run(revoke[1]);audit(user,'Employee session revoked',{userId:row.user_id});
          return send(res,200,{ok:true});
        }
        const recover=p.match(/^\/api\/security\/users\/(\d+)\/recovery$/);
        if (recover && req.method==='POST') {
          const body=await readBody(req);if(body.confirm!==true)return send(res,400,{error:'Explicit confirmation required'});
          return send(res,201,issueRecovery(Number(recover[1]),user));
        }
        return send(res,404,{error:'Security route not found'});
      }
      const recoverPage=p.match(/^\/recover\/([A-Za-z0-9_-]{40,})$/);
      if (recoverPage && req.method==='GET') {
        const nonce=crypto.randomBytes(18).toString('base64');
        const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Employee account recovery</title><link rel="stylesheet" href="/styles.css"><main class="login"><form id="recovery" class="login-card"><h1>Set a new password</h1><p>Use the private one-time link supplied by your shop owner.</p><label>New password<input name="password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required></label><label>Confirm password<input name="confirmation" type="password" minlength="12" autocomplete="new-password" required></label><button>Update password</button><p id="result" role="status"></p><a href="/">Return to sign in</a></form></main><script nonce="${nonce}">document.getElementById('recovery').onsubmit=async event=>{event.preventDefault();const f=event.target;if(f.password.value!==f.confirmation.value){document.getElementById('result').textContent='Passwords must match';return;}const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:f.password.value})});const data=await r.json();document.getElementById('result').textContent=data.notice||data.error;if(r.ok)f.reset();};</script></html>`;
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':`default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`});res.end(html);return true;
      }
      if (recoverPage && req.method==='POST') {
        const body=await readBody(req);return send(res,200,redeemRecovery(recoverPage[1],body.password),{'set-cookie':cookie(req)});
      }
      return false;
    } catch(error) { return send(res,error.status || 400,{error:String(error.message).slice(0,240)}); }
  }
  return {middleware,routes,sessionUser,cookie,issueRecovery,redeemRecovery,source,throttled};
}

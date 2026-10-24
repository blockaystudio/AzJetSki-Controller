// Owner Tracker Google Calendar integration: owner-authorized OAuth 2.0.
// No passwords in app; refresh token encrypted at rest; appointments keep independent local records.
// Production requires a Google Cloud OAuth Web Application, HTTPS callback and configured env vars.
import crypto from 'node:crypto';
const enc=x=>encodeURIComponent(x);
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const txt=x=>String(x??'').trim();
const oauth={authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',userinfo:'https://openidconnect.googleapis.com/v1/userinfo',events:'https://www.googleapis.com/calendar/v3/calendars/primary/events'};
export function installGoogleCalendar(db){
 db.exec(`CREATE TABLE IF NOT EXISTS google_oauth_states(state_hash TEXT PRIMARY KEY,initiated_by INTEGER NOT NULL REFERENCES users(id),expires_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS google_calendar_connection(id INTEGER PRIMARY KEY CHECK(id=1),email TEXT NOT NULL,encrypted_refresh_token TEXT NOT NULL,connected_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
 const cols=new Set(db.prepare('PRAGMA table_info(shop_appointments)').all().map(x=>x.name));
 for(const field of ['google_event_id TEXT','sync_status TEXT DEFAULT \'local_only\'','sync_error TEXT DEFAULT \'\'','synced_at TEXT'])if(!cols.has(field.split(' ')[0]))db.exec(`ALTER TABLE shop_appointments ADD COLUMN ${field}`);
}
const conf=()=>({clientId:process.env.GOOGLE_CALENDAR_CLIENT_ID||'',clientSecret:process.env.GOOGLE_CALENDAR_CLIENT_SECRET||'',callback:process.env.GOOGLE_CALENDAR_REDIRECT_URL||'',tokenKey:process.env.GOOGLE_CALENDAR_TOKEN_KEY||'',expectedEmail:process.env.GOOGLE_CALENDAR_EMAIL||'jetskiarizona@gmail.com'});
export function googleCalendarConfig(){const c=conf();const configured=!!(c.clientId&&c.clientSecret&&c.callback&&/^[a-f0-9]{64}$/i.test(c.tokenKey)&&/^https:\/\//.test(c.callback));return {configured,expectedEmail:c.expectedEmail,callback:c.callback||null,mode:'one-way Owner Tracker → Google Calendar'};}
function key(){const x=conf().tokenKey;if(!/^[a-f0-9]{64}$/i.test(x))throw Error('GOOGLE_CALENDAR_TOKEN_KEY must be 32 random bytes expressed as 64 hex digits');return Buffer.from(x,'hex')}
function encrypt(value){const nonce=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key(),nonce),ciphertext=Buffer.concat([c.update(value,'utf8'),c.final()]);return [nonce.toString('base64url'),c.getAuthTag().toString('base64url'),ciphertext.toString('base64url')].join('.');}
function decrypt(value){const [n,t,b]=String(value).split('.');if(!b)throw Error('Invalid token storage');const d=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(n,'base64url'));d.setAuthTag(Buffer.from(t,'base64url'));return Buffer.concat([d.update(Buffer.from(b,'base64url')),d.final()]).toString('utf8');}
async function jsonFetch(url,init={}){const res=await fetch(url,{...init,signal:AbortSignal.timeout(12000)});const body=await res.json().catch(()=>({}));if(!res.ok)throw Error(`Google API HTTP ${res.status}: ${JSON.stringify(body).slice(0,350)}`);return body;}
export function googleStatus(db){const conn=db.prepare('SELECT email,connected_at FROM google_calendar_connection WHERE id=1').get();return {...googleCalendarConfig(),connected:!!conn,email:conn?.email||null,connectedAt:conn?.connected_at||null};}
export function startGoogleAuth(db,userId){const c=conf();if(!googleCalendarConfig().configured)throw Error('Google Calendar OAuth credentials and HTTPS callback not configured');
 const state=crypto.randomBytes(32).toString('base64url');db.prepare('DELETE FROM google_oauth_states WHERE expires_at<CURRENT_TIMESTAMP').run();
 db.prepare("INSERT INTO google_oauth_states(state_hash,initiated_by,expires_at) VALUES(?,?,datetime('now','+10 minutes'))").run(digest(state),userId);
 const p=new URLSearchParams({client_id:c.clientId,redirect_uri:c.callback,response_type:'code',scope:'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email openid',access_type:'offline',prompt:'consent',state});
 return oauth.authorize+'?'+p;
}
export async function completeGoogleAuth(db,code,state){if(!code||!state)throw Error('Missing OAuth code/state');const row=db.prepare('SELECT * FROM google_oauth_states WHERE state_hash=? AND expires_at>CURRENT_TIMESTAMP').get(digest(state));if(!row)throw Error('Expired or invalid calendar OAuth state');
 db.prepare('DELETE FROM google_oauth_states WHERE state_hash=?').run(digest(state));
 const c=conf();const tokens=await jsonFetch(oauth.token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:c.clientId,client_secret:c.clientSecret,redirect_uri:c.callback,grant_type:'authorization_code'})});
 if(!tokens.access_token||!tokens.refresh_token)throw Error('Google did not supply refresh token; reconnect with consent');
 const profile=await jsonFetch(oauth.userinfo,{headers:{authorization:`Bearer ${tokens.access_token}`}});
 if(txt(profile.email).toLowerCase()!==c.expectedEmail.toLowerCase()||profile.email_verified!==true)throw Error(`Unexpected Google account. Sign in as ${c.expectedEmail}`);
 db.prepare(`INSERT INTO google_calendar_connection(id,email,encrypted_refresh_token) VALUES(1,?,?)
   ON CONFLICT(id) DO UPDATE SET email=excluded.email,encrypted_refresh_token=excluded.encrypted_refresh_token,updated_at=CURRENT_TIMESTAMP`).run(profile.email,encrypt(tokens.refresh_token));
 return {email:profile.email,connected:true};
}
async function accessToken(db){const conn=db.prepare('SELECT * FROM google_calendar_connection WHERE id=1').get();if(!conn)throw Error('Google Calendar is not connected');const c=conf();const t=await jsonFetch(oauth.token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,refresh_token:decrypt(conn.encrypted_refresh_token),grant_type:'refresh_token'})});if(!t.access_token)throw Error('Google access token missing');return t.access_token}
export async function pushAppointment(db,id){const a=db.prepare('SELECT a.*,c.name customer_name FROM shop_appointments a LEFT JOIN customers c ON c.id=a.customer_id WHERE a.id=?').get(id);if(!a)throw Error('Appointment missing');
 const token=await accessToken(db);
 const eventId='ot'+digest('AZJETSKI_OWNERTRACKER_CAL_EVENT_'+a.id).slice(0,38);
 const event={id:eventId,summary:a.title,description:[a.customer_name&&`Customer: ${a.customer_name}`,`Owner Tracker appointment ${a.id}`,a.notes].filter(Boolean).join('\n'),start:{dateTime:a.starts_at,timeZone:'America/Phoenix'},end:{dateTime:a.ends_at,timeZone:'America/Phoenix'},extendedProperties:{private:{ownerTrackerAppointmentId:String(a.id)}}};
 // Send deterministic ID for retry deduplication; do not create duplicate Google appointments.
 const res=await fetch(oauth.events+'?sendUpdates=none',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(event),signal:AbortSignal.timeout(12000)});
 let result=await res.json().catch(()=>({}));
 if(res.status===409){result=await jsonFetch(oauth.events+'/'+enc(eventId),{headers:{authorization:`Bearer ${token}`}})}
 else if(!res.ok)throw Error(`Google calendar insert HTTP ${res.status}: ${JSON.stringify(result).slice(0,350)}`);
 if(result.id!==eventId)throw Error('Unexpected Google event identifier');
 db.prepare("UPDATE shop_appointments SET google_event_id=?,sync_status='synced',sync_error='',synced_at=CURRENT_TIMESTAMP WHERE id=?").run(eventId,id);
 return {synced:true,googleEventId:eventId,htmlLink:result.htmlLink||null};
}
export function markSyncFailed(db,id,error){db.prepare("UPDATE shop_appointments SET sync_status='error',sync_error=? WHERE id=?").run(String(error).slice(0,500),id)}
export function disconnectGoogle(db){db.prepare('DELETE FROM google_calendar_connection WHERE id=1').run();return {connected:false,note:'Local appointments retained. Previously created Google events were not deleted.'}}

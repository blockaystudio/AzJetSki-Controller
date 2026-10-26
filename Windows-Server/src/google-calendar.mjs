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
 for(const field of ['google_event_id TEXT','sync_status TEXT DEFAULT \'local_only\'','sync_error TEXT DEFAULT \'\'','synced_at TEXT','google_event_etag TEXT','google_synced_fingerprint TEXT'])if(!cols.has(field.split(' ')[0]))db.exec(`ALTER TABLE shop_appointments ADD COLUMN ${field}`);
}
// ETags follow Google's documented conditional-modification contract:
// https://developers.google.com/workspace/calendar/api/guides/version-resources
// https://developers.google.com/workspace/calendar/api/v3/reference/events/patch
// https://developers.google.com/workspace/calendar/api/v3/reference/events/delete
function installCalendarVersions(db) {
 installGoogleCalendar(db);
 const columns=new Set(db.prepare('PRAGMA table_info(shop_appointments)').all().map(x=>x.name));
 for(const definition of ['google_event_etag TEXT','google_synced_fingerprint TEXT'])if(!columns.has(definition.split(' ')[0]))db.exec(`ALTER TABLE shop_appointments ADD COLUMN ${definition}`);
 db.exec(`CREATE TABLE IF NOT EXISTS google_calendar_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,appointment_id INTEGER NOT NULL REFERENCES shop_appointments(id),
  reason TEXT NOT NULL,local_fingerprint TEXT NOT NULL,remote_etag TEXT NOT NULL DEFAULT '',
  remote_snapshot_json TEXT NOT NULL DEFAULT '{}',resolved_at TEXT,resolution TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );`);
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
 const p=new URLSearchParams({client_id:c.clientId,redirect_uri:c.callback,response_type:'code',login_hint:c.expectedEmail,scope:'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email openid',access_type:'offline',prompt:'consent',state});
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
function appointmentRecord(db,id){return db.prepare('SELECT a.*,c.name customer_name FROM shop_appointments a LEFT JOIN customers c ON c.id=a.customer_id WHERE a.id=?').get(Number(id));}
function appointmentEvent(a){return {summary:a.title,description:[a.customer_name&&`Customer: ${a.customer_name}`,`Owner Tracker appointment ${a.id}`,a.notes].filter(Boolean).join('\n'),start:{dateTime:a.starts_at,timeZone:'America/Phoenix'},end:{dateTime:a.ends_at,timeZone:'America/Phoenix'},extendedProperties:{private:{ownerTrackerAppointmentId:String(a.id)}}};}
function fingerprint(a){return digest(JSON.stringify({event:appointmentEvent(a),status:a.status}));}
function sameSchedule(remote,local){return remote.status!=='cancelled'&&remote.summary===local.title&&Date.parse(remote.start?.dateTime)===Date.parse(local.starts_at)&&Date.parse(remote.end?.dateTime)===Date.parse(local.ends_at);}
function sameEvent(remote,local){const desired=appointmentEvent(local);return remote.status!=='cancelled'&&remote.summary===desired.summary&&(remote.description||'')===desired.description&&Date.parse(remote.start?.dateTime)===Date.parse(local.starts_at)&&Date.parse(remote.end?.dateTime)===Date.parse(local.ends_at);}
function validRemote(remote,a){return remote.id===a.google_event_id&&remote.extendedProperties?.private?.ownerTrackerAppointmentId===String(a.id);}
function conflict(db,a,reason,remote={}){
 const mark=fingerprint(a),etag=String(remote.etag||'');
 const existing=db.prepare('SELECT id FROM google_calendar_conflicts WHERE appointment_id=? AND reason=? AND local_fingerprint=? AND remote_etag=? AND resolved_at IS NULL').get(a.id,reason,mark,etag);
 if(!existing)db.prepare('INSERT INTO google_calendar_conflicts(appointment_id,reason,local_fingerprint,remote_etag,remote_snapshot_json) VALUES(?,?,?,?,?)').run(a.id,reason,mark,etag,JSON.stringify(remote));
 db.prepare("UPDATE shop_appointments SET sync_status='conflict',sync_error=? WHERE id=?").run(reason,a.id);
 return {synced:false,status:'conflict',reason,googleEventId:a.google_event_id,remoteEtag:etag||null};
}
function savedSync(db,a,eventId,remote,status='synced'){
 const latest=appointmentRecord(db,a.id),same=latest&&fingerprint(latest)===fingerprint(a);
 db.prepare('UPDATE shop_appointments SET google_event_id=?,google_event_etag=?,google_synced_fingerprint=?,sync_status=?,sync_error=?,synced_at=CURRENT_TIMESTAMP WHERE id=?')
 .run(eventId,remote?.etag||null,fingerprint(a),same?status:'update_pending',same?'':'Local appointment changed while Google was updating; retry required',a.id);
 if(same)db.prepare("UPDATE google_calendar_conflicts SET resolved_at=CURRENT_TIMESTAMP,resolution='remote_matches_local' WHERE appointment_id=? AND resolved_at IS NULL").run(a.id);
 return {synced:same,status:same?status:'update_pending',googleEventId:eventId,htmlLink:remote?.htmlLink||null};
}
async function calendarRequest(fetchImpl,url,init){return fetchImpl(url,{...init,signal:AbortSignal.timeout(12000)});}
async function bodyJson(response){return response.json().catch(()=>({}));}

async function performSyncAppointmentChange(db,appointment,{fetchImpl=globalThis.fetch,tokenProvider=()=>accessToken(db),allowRemoteEtag=null}={}){
 installCalendarVersions(db);
 const a=appointmentRecord(db,typeof appointment==='object'?appointment.id:appointment);if(!a)throw Error('Appointment missing');
 if(!googleStatus(db).connected||!googleCalendarConfig().configured){db.prepare("UPDATE shop_appointments SET sync_status='local_only',sync_error='Google Calendar is disconnected or unconfigured; changes retained locally' WHERE id=?").run(a.id);return {synced:false,status:'local_only',notice:'Changes saved locally; Google Calendar is not connected/configured'};}
 if(!a.google_event_id){
  if(a.status==='cancelled'){db.prepare("UPDATE shop_appointments SET sync_status='local_only',sync_error='' WHERE id=?").run(a.id);return {synced:false,status:'local_only',notice:'Cancelled locally; no Google event exists'};}
  return insertAppointment(db,a,{fetchImpl,tokenProvider});
 }
 const token=await tokenProvider(),url=oauth.events+'/'+enc(a.google_event_id);
 const headers={authorization:`Bearer ${token}`};
 const response=await calendarRequest(fetchImpl,url,{headers});
 if([404,410].includes(response.status))return a.status==='cancelled'?savedSync(db,a,a.google_event_id,null,'cancelled_synced'):conflict(db,a,'Remote event was deleted; review before recreating');
 if(!response.ok)throw Error(`Google Calendar event lookup HTTP ${response.status}`);
 const remote=await bodyJson(response);
 if(remote.status==='cancelled')return a.status==='cancelled'?savedSync(db,a,a.google_event_id,remote,'cancelled_synced'):conflict(db,a,'Remote event was cancelled; review before recreating',remote);
 if(!validRemote(remote,a))return conflict(db,a,'Remote event is not owned by this appointment',remote);
 // An earlier response may have been lost after Google accepted our update.
 if(a.status!=='cancelled'&&sameSchedule(remote,a))return savedSync(db,a,a.google_event_id,remote);
 if(allowRemoteEtag!==null&&remote.etag!==allowRemoteEtag)return conflict(db,a,'Google event changed after the reviewed conflict',remote);
 if(a.google_event_etag&&remote.etag!==a.google_event_etag&&allowRemoteEtag!==remote.etag)return conflict(db,a,'Google event changed outside Owner Tracker',remote);
 if(!remote.etag)return conflict(db,a,'Google event version is missing; conditional update refused',remote);
 const method=a.status==='cancelled'?'DELETE':'PATCH';
 const outgoing=await calendarRequest(fetchImpl,url+'?sendUpdates=none',{method,headers:{...headers,'content-type':'application/json','if-match':remote.etag},...(method==='PATCH'?{body:JSON.stringify({summary:a.title,start:appointmentEvent(a).start,end:appointmentEvent(a).end})}:{})});
 if(outgoing.status===412)return conflict(db,a,'Google event changed during this update',remote);
 if(method==='DELETE'&&[200,204,404,410].includes(outgoing.status))return savedSync(db,a,a.google_event_id,null,'cancelled_synced');
 if(!outgoing.ok)throw Error(`Google Calendar ${method==='DELETE'?'cancellation':'reschedule'} HTTP ${outgoing.status}`);
 const updated=await bodyJson(outgoing);if(updated.id!==a.google_event_id||!updated.etag)throw Error('Google did not return the updated event version');
 return savedSync(db,a,a.google_event_id,updated);
}

export async function syncAppointmentChange(db,appointment,options={}){
 try{return await performSyncAppointmentChange(db,appointment,options);}catch(error){const id=typeof appointment==='object'?appointment.id:appointment;markSyncFailed(db,id,error.message);throw error;}
}

async function insertAppointment(db,a,{fetchImpl=globalThis.fetch,tokenProvider=()=>accessToken(db)}={}){
 const token=await tokenProvider(),eventId='ot'+digest('AZJETSKI_OWNERTRACKER_CAL_EVENT_'+a.id).slice(0,38),event={id:eventId,...appointmentEvent(a)};
 const response=await calendarRequest(fetchImpl,oauth.events+'?sendUpdates=none',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(event)});
 let result=await bodyJson(response);
 if(response.status===409){
  const found=await calendarRequest(fetchImpl,oauth.events+'/'+enc(eventId),{headers:{authorization:`Bearer ${token}`}});
  if(!found.ok)throw Error(`Google Calendar duplicate lookup HTTP ${found.status}`);result=await bodyJson(found);
  if(result.id!==eventId||result.extendedProperties?.private?.ownerTrackerAppointmentId!==String(a.id)||!sameEvent(result,a)){if(result.id===eventId&&result.extendedProperties?.private?.ownerTrackerAppointmentId===String(a.id))db.prepare('UPDATE shop_appointments SET google_event_id=? WHERE id=?').run(eventId,a.id);return conflict(db,{...a,google_event_id:eventId},'Existing deterministic event differs; review before changing it',result);}
 }else if(!response.ok)throw Error(`Google Calendar insert HTTP ${response.status}`);
 if(result.id!==eventId||!result.etag)throw Error('Google did not return the created event version');
 return savedSync(db,a,eventId,result);
}

export async function pushAppointment(db,id,options={}){return syncAppointmentChange(db,id,options);}

export async function resolveAppointmentConflict(db,id,{decision,expectedRemoteEtag,reason,user,fetchImpl=globalThis.fetch,tokenProvider=()=>accessToken(db)}={}){
 installCalendarVersions(db);
 if(!user||!['owner','manager'].includes(user.role))throw Object.assign(Error('Owner/manager calendar review required'),{status:403});
 if(!['apply_local','adopt_remote'].includes(decision)||String(reason||'').trim().length<5||!expectedRemoteEtag)throw Object.assign(Error('Reviewed Google version, resolution choice and reason required'),{status:400});
 const a=appointmentRecord(db,id);if(!a?.google_event_id)throw Object.assign(Error('Linked appointment not found'),{status:404});
 let result;
 if(decision==='apply_local')result=await syncAppointmentChange(db,a,{fetchImpl,tokenProvider,allowRemoteEtag:expectedRemoteEtag});
 else{
  const token=await tokenProvider(),response=await calendarRequest(fetchImpl,oauth.events+'/'+enc(a.google_event_id),{headers:{authorization:`Bearer ${token}`}});
  if(!response.ok)throw Error(`Google Calendar reviewed event HTTP ${response.status}`);
  const remote=await bodyJson(response);
  if(fingerprint(appointmentRecord(db,a.id))!==fingerprint(a))return conflict(db,appointmentRecord(db,a.id),'Local appointment changed during conflict review',remote);
  if(!validRemote(remote,a)||remote.etag!==expectedRemoteEtag)return conflict(db,a,'Google event no longer matches the reviewed version',remote);
  const starts=Date.parse(remote.start?.dateTime),ends=Date.parse(remote.end?.dateTime);
  if(remote.status!=='cancelled'&&(!Number.isFinite(starts)||!Number.isFinite(ends)||ends<=starts||ends-starts>86400000))throw Error('Google event dates are unsupported; review manually');
  const hasRevision=db.prepare('PRAGMA table_info(shop_appointments)').all().some(c=>c.name==='management_revision');
  db.prepare(`UPDATE shop_appointments SET title=?,starts_at=?,ends_at=?,status=?${hasRevision?',management_revision=management_revision+1':''} WHERE id=?`).run(String(remote.summary||a.title).slice(0,150),remote.status==='cancelled'?a.starts_at:new Date(starts).toISOString(),remote.status==='cancelled'?a.ends_at:new Date(ends).toISOString(),remote.status==='cancelled'?'cancelled':'scheduled',a.id);
  result=savedSync(db,appointmentRecord(db,a.id),a.google_event_id,remote,remote.status==='cancelled'?'cancelled_synced':'synced');
 }
 db.prepare('INSERT INTO audit_log(actor,action,detail) VALUES(?,?,?)').run(user.username,'Google Calendar conflict reviewed',JSON.stringify({appointmentId:Number(id),decision,reason:String(reason).trim().slice(0,500),remoteEtag:expectedRemoteEtag,status:result.status}));
 return result;
}

export function calendarChangeRoutes({db,currentUser,json,readBody,providerOptions={}}){
 installCalendarVersions(db);
 return async(req,res,p)=>{
  const conflictRoute=p.match(/^\/api\/shop\/schedule\/(\d+)\/google-conflict$/);
  if(p!=='/api/shop/google-calendar/conflicts'&&!conflictRoute)return false;
  const send=(status,value)=>{json(res,status,value,{'cache-control':'no-store'});return true;};
  const user=currentUser(req);
  if(!user)return send(401,{error:'Login required'});
  if(!['owner','manager'].includes(user.role))return send(403,{error:'Owner/manager calendar review required'});
  try{
   if(p==='/api/shop/google-calendar/conflicts'&&req.method==='GET')return send(200,{conflicts:db.prepare('SELECT id,appointment_id,reason,remote_etag,remote_snapshot_json,created_at FROM google_calendar_conflicts WHERE resolved_at IS NULL ORDER BY id DESC LIMIT 100').all().map(row=>{
    let remote={};try{remote=JSON.parse(row.remote_snapshot_json);}catch{}
    const local=appointmentRecord(db,row.appointment_id),{remote_snapshot_json,...record}=row;
    return {...record,remote:{title:remote.summary||'',startsAt:remote.start?.dateTime||null,endsAt:remote.end?.dateTime||null,status:remote.status||''},local:local?{title:local.title,startsAt:local.starts_at,endsAt:local.ends_at,status:local.status}:null};
   })});
   if(conflictRoute&&req.method==='POST'){
    const body=await readBody(req);if(body.confirm!==true)return send(400,{error:'Explicit calendar resolution confirmation required'});
    return send(200,await resolveAppointmentConflict(db,Number(conflictRoute[1]),{decision:body.decision,expectedRemoteEtag:body.expectedRemoteEtag,reason:body.reason,user,...providerOptions}));
   }
   return send(405,{error:'Method not allowed'});
  }catch(error){return send(error.status||503,{error:String(error.message).slice(0,250),notice:'Local appointment retained. Remote calendar result requires review.'});}
 };
}
export function markSyncFailed(db,id,error){db.prepare("UPDATE shop_appointments SET sync_status='error',sync_error=? WHERE id=?").run(String(error).slice(0,500),id)}
export function disconnectGoogle(db){db.prepare('DELETE FROM google_calendar_connection WHERE id=1').run();return {connected:false,note:'Local appointments retained. Previously created Google events were not deleted.'}}

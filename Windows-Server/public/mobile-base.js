import {rememberEditRevisions,prepareRevisionRequest,editConflictMessage} from './edit-revisions-ui.js';
export const $=s=>document.querySelector(s);
export const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
export const money=v=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(v||0));
export async function api(url,method='GET',body,context={}){const options=prepareRevisionRequest(url,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin'},context);const r=await fetch(url,options);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(editConflictMessage(r,j)||j.error||`HTTP ${r.status}`);return rememberEditRevisions(j);}
export const flash=message=>{const old=$('#toast');if(old)old.remove();const el=document.createElement('div');el.id='toast';el.textContent=message;document.body.append(el);setTimeout(()=>el.remove(),4000)};
export async function login(kind,done){const d=await api('/api/me');if(d.user){return done(d.user)};
  $('#mobile-app').innerHTML=`<header><img src="/brand-logo.png" class="mobile-brand-logo" alt="AZ Jet Ski + Powersports"><h1>Owner Tracker</h1><div class="muted">${kind} sign-in</div></header><main><form id="login"><label>Username<input name="username" autocomplete="username" required></label><label>Password or employee PIN<input name="password" type="password" autocomplete="current-password" required></label><button class="btn primary full">Sign in</button></form></main>`;
  $('#login').onsubmit=async e=>{e.preventDefault();try{await api('/api/login','POST',Object.fromEntries(new FormData(e.target)));location.reload()}catch(err){flash(err.message)}};
}
export async function logout(){await api('/api/logout','POST',{});location.reload()}

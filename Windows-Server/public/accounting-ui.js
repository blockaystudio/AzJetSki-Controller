import {mountAccountWorkspace} from './account-workspace.js';
const el=selector=>document.querySelector(selector);
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money=value=>(Number(value||0)/100).toLocaleString('en-US',{style:'currency',currency:'USD'});
let user,scope='repair',accountWorkspace=null,selectionEpoch=0,dayEpoch=0;
const retainedKeys=new WeakMap();
async function api(path,method='GET',body){const response=await fetch(path,{method,credentials:'same-origin',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json().catch(()=>({}));if(!response.ok)throw Error(value.error||`HTTP ${response.status}`);return value;}
function message(value){el('#message').textContent=value;}
function moneyInput(value,label){const raw=String(value??'').trim();if(!/^-?\d+(?:\.\d{1,2})?$/.test(raw))throw Error(`${label}: enter dollars with at most two decimals`);const cents=Math.round(Number(raw)*100);if(!Number.isSafeInteger(cents))throw Error(`${label}: invalid amount`);return cents;}
async function submit(form,path,body,after,isCurrent=()=>true){
  if(form.dataset.busy||!isCurrent())return;
  form.dataset.busy='true';
  const fingerprint=JSON.stringify({path,body});let retained=retainedKeys.get(form);
  if(!retained||retained.fingerprint!==fingerprint){retained={fingerprint,key:crypto.randomUUID()};retainedKeys.set(form,retained);}
  const buttons=[...form.querySelectorAll('button')];buttons.forEach(button=>button.disabled=true);let saved=false;
  try{
    await api(path,'POST',{...body,idempotencyKey:retained.key});form.reset();retainedKeys.delete(form);saved=true;
    if(!isCurrent())return;
    message('Saved. Updating the close…');await after();message('Saved and refreshed.');
  }catch(error){if(isCurrent())message(saved?`Saved, but refreshing failed. Refresh before entering another action. ${error.message}`:error.message);}
  finally{delete form.dataset.busy;buttons.forEach(button=>button.disabled=false);}
}
function eventForm(form,read,path,after,isCurrent=()=>true){form.onsubmit=event=>{event.preventDefault();if(!isCurrent())return;try{const body=read(form);return submit(form,typeof path==='function'?path():path,body,after,isCurrent);}catch(error){message(error.message);}};}

async function loadAccounts(){
  const epoch=++selectionEpoch;scope=el('#selectAccount').elements.scope.value;
  accountWorkspace?.destroy();accountWorkspace=null;el('#account').innerHTML='';
  const selectedScope=scope,select=el('#selectAccount').elements.account;
  select.innerHTML='<option value="">Loading accounts…</option>';select.disabled=true;
  const options=selectedScope==='repair'?(await api('/api/work-orders')).workOrders.filter(row=>row.source==='manual').map(row=>({id:row.id,label:`WO ${row.ref_number||row.id} · ${row.customer_name||'Customer'}`})):(await api('/api/shop/retail-orders')).orders.map(row=>({id:row.id,label:`${row.invoice_number} · ${row.customer_name}`}));
  if(epoch!==selectionEpoch||scope!==selectedScope)return;
  select.innerHTML='<option value="">Select an account</option>'+options.map(row=>`<option value="${Number(row.id)}">${escape(row.label)}</option>`).join('');select.disabled=false;
}
async function loadAccount(id=Number(el('#selectAccount').elements.account.value)){
  if(!id)throw Error('Select an account');
  accountWorkspace?.destroy();
  el('#selectAccount').elements.account.value=String(id);
  accountWorkspace=mountAccountWorkspace(el('#account'),{scope,id,user,onError:error=>message(error.message)});
  await accountWorkspace.ready;
}
async function loadDay(){
  const date=el('#selectDay').elements.date.value,epoch=++dayEpoch;
  const current=()=>epoch===dayEpoch&&el('#selectDay').elements.date.value===date;
  el('#day').innerHTML='<p role="status">Loading the selected business day…</p>';el('#exportCsv').removeAttribute('href');
  const report=await api(`/api/accounting/daily-close?date=${encodeURIComponent(date)}`);if(!current())return;el('#exportCsv').href=`/api/accounting/daily-close?date=${encodeURIComponent(date)}&format=csv`;
  el('#day').innerHTML=`<h3>${escape(date)} · repair and counter sales combined</h3><p class="muted">${escape(report.basis)}</p><p class="muted">Pending and voided payments are excluded from these method totals.</p><div class="accounting-table"><table><thead><tr><th>Method</th><th>Received/deposits</th><th>Refunds</th><th>Net funds</th><th>Entries</th></tr></thead><tbody>${Object.entries(report.methods).map(([method,row])=>`<tr><td>${escape(method)}</td><td>${money(row.receivedCents)}</td><td>${money(row.refundCents)}</td><td>${money(row.netCents)}</td><td>${Number(row.count)}</td></tr>`).join('')}</tbody></table></div>
  <details><summary>Invoice and tax document review</summary><p class="accounting-warning">Review invoice documents with your accountant. Reissued repair invoices must not be counted twice as new sales. Tax is not calculated from money received.</p><p>Tax credited today: ${money(report.creditedTaxCents)}</p>${report.invoiceReview.map(row=>`<p><strong>${escape(row.invoiceNumber)}</strong> · snapshot total ${row.totalCents===null?'Unknown':money(row.totalCents)} · tax ${row.taxCents===null?'Unknown':money(row.taxCents)}${row.voided?' · Cancelled':''}${row.note?`<br>${escape(row.note)}`:''}</p>`).join('')||'<p>No invoice documents issued this day.</p>'}</details>
  ${['owner','manager'].includes(user.role)?`<details open><summary>Verify and retain a close</summary><form id="closeForm"><div class="accounting-grid"><label>Opening cash float ($)<input name="openingFloat" type="number" inputmode="decimal" min="0" step="0.01" value="0.00" required></label><label>Non-refund cash paid out ($)<input name="cashPaidOut" type="number" inputmode="decimal" min="0" step="0.01" value="0.00" required></label><label>Actual cash counted, including float ($)<input name="cashCounted" type="number" inputmode="decimal" min="0" step="0.01" required></label><label>Verified Dejavoo net payments minus refunds ($)<input name="cardVerified" type="number" inputmode="decimal" step="0.01" required></label><label>Verified Zelle net receipts minus refunds ($)<input name="zelleVerified" type="number" inputmode="decimal" step="0.01" required></label></div><label>Notes and discrepancy explanation<textarea name="notes" maxlength="2000"></textarea></label><label class="check"><input name="verified" type="checkbox" required>I compared the actual drawer, terminal report and receiving bank.</label>${report.taxReviewRequired?'<label class="check"><input name="taxReview" type="checkbox" required>I reviewed the flagged invoice documents and understand this is not a tax-liability calculation.</label>':''}<button class="btn primary">Retain authorized close snapshot</button></form></details>`:''}
  <h3>Retained closes</h3><p class="muted">Re-closing after a correction keeps the previous close; it never rewrites history.</p>${report.priorCloses.map(row=>`<p><a href="/api/accounting/daily-close/${Number(row.id)}" target="_blank" rel="noopener">Revision ${Number(row.revision)}</a> · ${escape(row.actor_username)} · ${escape(row.created_at)} · cash difference ${money(row.cash_difference_cents)} · card difference ${money(row.card_difference_cents)} · Zelle difference ${money(row.zelle_difference_cents)}</p>`).join('')||'<p>No close retained.</p>'}`;
  const closeForm=el('#closeForm');
  if(closeForm)eventForm(closeForm,form=>({date,cashCountedCents:moneyInput(form.elements.cashCounted.value,'Counted cash'),openingFloatCents:moneyInput(form.elements.openingFloat.value,'Opening float'),cashPaidOutCents:moneyInput(form.elements.cashPaidOut.value,'Cash paid out'),cardVerifiedCents:moneyInput(form.elements.cardVerified.value,'Card net'),zelleVerifiedCents:moneyInput(form.elements.zelleVerified.value,'Zelle net'),notes:form.elements.notes.value.trim(),externalTotalsVerified:form.elements.verified.checked,taxReviewAcknowledged:form.elements.taxReview?.checked===true}),'/api/accounting/daily-close',loadDay,()=>current()&&el('#closeForm')===closeForm);
}
async function start(){try{const me=await api('/api/me');user=me.user;if(!user){el('#login').hidden=false;el('#workspace').hidden=true;message('Sign in to open the shop accounting workspace.');return;}if(!['owner','manager','advisor','service_writer'].includes(user.role))throw Error('Accounting access is restricted to owner, manager, advisor and service writer roles.');el('#signOut').hidden=false;el('#login').hidden=true;el('#workspace').hidden=false;el('#selectDay').elements.date.value=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Phoenix',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const params=new URLSearchParams(location.search);if(['repair','retail'].includes(params.get('scope')))el('#selectAccount').elements.scope.value=params.get('scope');await loadAccounts();if(Number(params.get('account')||params.get('id'))>0)await loadAccount(Number(params.get('account')||params.get('id')));await loadDay();message(`Signed in as ${user.displayName||user.username} · ${user.role}.`);}catch(error){message(error.message);}}
el('#loginForm').onsubmit=async event=>{event.preventDefault();try{await api('/api/login','POST',Object.fromEntries(new FormData(event.target)));event.target.reset();await start();}catch(error){message(error.message);}};
el('#signOut').onclick=async()=>{try{await api('/api/logout','POST',{});location.reload();}catch(error){message(error.message);}};
el('#selectAccount').elements.scope.onchange=()=>loadAccounts().catch(error=>message(error.message));
el('#selectAccount').elements.account.onchange=()=>{accountWorkspace?.destroy();accountWorkspace=null;el('#account').innerHTML='';if(el('#selectAccount').elements.account.value)loadAccount().catch(error=>message(error.message));};
el('#selectAccount').onsubmit=event=>{event.preventDefault();loadAccount().catch(error=>message(error.message));};
el('#selectDay').elements.date.oninput=()=>{dayEpoch++;el('#day').innerHTML='<p>Load this business date to review its totals and retain a close.</p>';el('#exportCsv').removeAttribute('href');};
el('#selectDay').onsubmit=event=>{event.preventDefault();loadDay().catch(error=>message(error.message));};
start();

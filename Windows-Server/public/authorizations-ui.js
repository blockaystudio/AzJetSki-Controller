const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = cents => (Number(cents||0)/100).toLocaleString('en-US',{style:'currency',currency:'USD'});
async function api(url,method='GET',body) {
  const response=await fetch(url,{method,credentials:'same-origin',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok)throw Error(result.error||'Unable to load authorizations');
  return result;
}

// The same local module drives the scoped customer form without inline script,
// so a self-only content security policy can protect authorization pages.
const signingForm=typeof document==='undefined'?null:document.getElementById('signAuthorization');
if(signingForm)signingForm.addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.target,button=form.querySelector('button');
  if(button.disabled)return;
  button.disabled=true;
  try {
    const fields=new FormData(form);
    await api(location.pathname,'POST',{choice:fields.get('choice'),signerName:fields.get('signerName'),agree:fields.get('agree')==='on'});
    location.reload();
  } catch(error) {
    document.getElementById('result').textContent=error.message;
    button.disabled=false;
  }
});

// Staff-only work-order panel. The server independently enforces the user's role.
export async function mountAuthorizations(container,workOrderId,{media=[],description='',revision,onChanged=async()=>{}}={}) {
  const id=Number(workOrderId),base=`/api/work-orders/${id}/authorizations`;
  const {authorizations,hasCurrentRepairAuthorization}=await api(base);
  const latest=authorizations.find(row=>!row.revokedAt&&!row.supersededBy);
  container.innerHTML=`<section class="card section"><h2>Retained customer authorizations</h2>
    <p>${hasCurrentRepairAuthorization?'The current work scope and estimate have customer repair approval.':'The current work scope and estimate do not have a matching retained repair approval.'}</p>
    <p>Each request retains its exact estimate, terms and inspection photos. Revised work requires a new full-total authorization; prior records remain in the history.</p>
    <form data-auth-request><label class="field">Full revised work description<textarea name="description" required maxlength="4000">${escape(description||latest?.snapshot?.description||'')}</textarea></label>
    <label class="field">Link valid for <select name="expiresDays"><option value="7">7 days</option><option value="14" selected>14 days</option><option value="30">30 days</option></select></label>
    ${media.filter(image=>image.customer_visible!==0).map(image=>`<label><input type="checkbox" name="photo" value="${Number(image.id)}"> Include ${escape(image.caption||image.original_name||'inspection photo #'+image.id)}</label>`).join('')}
    <p>${latest?`Replaces authorization #${Number(latest.id)}. The current estimate is the revised full total.`:'Creates a new customer authorization for the current estimate.'}</p>
    <button class="btn primary">${latest?'Create revised authorization':'Request authorization'}</button></form><div role="status" data-auth-result></div>
    <h3>Authorization history</h3>${authorizations.map(row=>`<div class="timeline-item"><strong>#${Number(row.id)} · ${escape(row.legacy?'Legacy record':row.revokedAt?'Revoked':row.supersededBy?'Superseded':Date.parse(row.expiresAt)<=Date.now()&&row.status!=='completed'?'Expired':row.status)}</strong>
      <p>${escape(row.snapshot?.description||'Historical authorization without retained estimate/terms snapshot')}</p>
      <p>${row.snapshot?`Estimate ${money(row.snapshot.estimateCents)} · `:''}${escape(row.choice||'Awaiting decision')}${row.signerName?' · '+escape(row.signerName):''}${row.signedAt?' · '+escape(row.signedAt):''}</p>
      ${row.previousApprovalId?`<p>Replaces #${Number(row.previousApprovalId)}</p>`:''}${row.revocationReason?`<p>Revocation reason: ${escape(row.revocationReason)}</p>`:''}
      ${row.documentAvailable?`<a class="btn" href="${escape(row.documentUrl)}" target="_blank" rel="noopener">Download PDF</a> <a class="btn" href="${base}/${Number(row.id)}/record" target="_blank" rel="noopener">Download exact UTF-8 record</a><p><small>UTF-8 record preserves non-Latin names and signature text exactly; PDF uses a base Latin font.</small></p>`:''}
      ${!row.revokedAt&&!row.supersededBy?`<form data-auth-revoke="${Number(row.id)}"><label>Reason to revoke access <input name="reason" required minlength="5" maxlength="500"></label><button class="btn">Revoke authorization link</button></form>`:''}
      ${row.snapshotSha256?`<small>Snapshot SHA-256: ${escape(row.snapshotSha256)}</small>`:''}</div>`).join('')||'<p>No authorization requests yet.</p>'}
    </section>`;
  const message=container.querySelector('[data-auth-result]');
  const request=container.querySelector('[data-auth-request]');
  request.onsubmit=async event=>{
    event.preventDefault();const button=request.querySelector('button');if(button.disabled)return;button.disabled=true;
    try {
      const result=await api(`/api/work-orders/${id}/request-approval`,'POST',{authorizedDescription:request.elements.description.value,expiresDays:Number(request.elements.expiresDays.value),...(revision!==undefined?{expectedRevision:revision}:{}),...(latest?{previousApprovalId:latest.id}:{}),mediaIds:[...request.querySelectorAll('[name=photo]:checked')].map(input=>Number(input.value))});
      message.replaceChildren();
      const note=document.createElement('p');note.textContent=`Authorization #${result.approvalId} retained. Delivery: ${result.deliveryStatus}. Share the customer link below.`;
      const link=document.createElement('a');link.href=result.approvalUrl;link.target='_blank';link.rel='noopener';link.textContent='Open customer authorization';
      const copy=document.createElement('input');copy.readOnly=true;copy.value=result.approvalUrl;copy.setAttribute('aria-label','Customer authorization link');copy.style.width='100%';
      message.append(note,link,copy);
      await onChanged();
    } catch(error){message.textContent=error.message;button.disabled=false;}
  };
  container.querySelectorAll('[data-auth-revoke]').forEach(form=>form.onsubmit=async event=>{
    event.preventDefault();const button=form.querySelector('button');button.disabled=true;
    try {await api(`${base}/${Number(form.dataset.authRevoke)}/revoke`,'POST',{reason:form.elements.reason.value});await mountAuthorizations(container,id,{media,description,revision,onChanged});await onChanged();}
    catch(error){message.textContent=error.message;button.disabled=false;}
  });
}

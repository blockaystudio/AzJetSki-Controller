const escapeText=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function request(url,method='GET',body) {
  const result=await fetch(url,{method,credentials:'same-origin',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await result.json();
  if(!result.ok)throw Error(value.error || `HTTP ${result.status}`);
  return value;
}

export async function mountSecurityPanel(host) {
  const [status,sessions,employees]=await Promise.all([request('/api/security/status'),request('/api/security/sessions'),request('/api/users')]);
  host.innerHTML=`<section class="card section"><h2>Shop access and employee recovery</h2><p>Secure HTTPS hosting: <strong>${status.httpsConfigured?'Configured':'Local development only'}</strong>. Sessions expire after ${Number(status.sessionHours)} hours. Sign-in throttling is enabled.</p><h3>Active employee sessions</h3>${sessions.sessions.map(session=>`<div class="status-line"><strong>${escapeText(session.username)}</strong> · ${escapeText(session.role)} · expires ${escapeText(session.expires_at)} <button class="btn" data-revoke-session="${escapeText(session.id)}">Sign out this session</button></div>`).join('')||'<p>No active sessions.</p>'}<h3>Recover an employee account</h3><p>Create a private one-time link valid for 15 minutes. Recovery clears that employee’s old PIN and signs out existing sessions. No email is sent automatically.</p><form id="employeeRecovery"><label class="field">Employee<select name="employee" required>${employees.users.filter(employee=>employee.active).map(employee=>`<option value="${Number(employee.id)}">${escapeText(employee.displayName || employee.username)} · ${escapeText(employee.role)}</option>`).join('')}</select></label><button class="btn">Create private recovery link</button></form><p role="status" id="accessMessage"></p><div id="recoveryLink"></div></section>`;
  const message=host.querySelector('#accessMessage');
  host.querySelectorAll('[data-revoke-session]').forEach(button=>button.onclick=async()=>{
    button.disabled=true;
    try{await request(`/api/security/sessions/${button.dataset.revokeSession}/revoke`,'POST',{confirm:true});button.closest('.status-line').remove();message.textContent='Session signed out.';}catch(error){message.textContent=error.message;button.disabled=false;}
  });
  host.querySelector('#employeeRecovery').onsubmit=async event=>{
    event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;
    try{
      const value=await request(`/api/security/users/${Number(event.target.elements.employee.value)}/recovery`,'POST',{confirm:true});
      const result=host.querySelector('#recoveryLink');result.replaceChildren();
      const link=document.createElement('a');link.href=value.recoveryUrl;link.textContent=value.recoveryUrl;link.rel='noreferrer';
      result.append(link);message.textContent=`Deliver this link privately. Expires ${value.expiresAt}.`;
    }catch(error){message.textContent=error.message;}finally{button.disabled=false;}
  };
}

export async function mountCustomerAccessPanel(host,workOrderId) {
  const url=`/api/work-orders/${Number(workOrderId)}/customer-links`;
  const result=await request(url);
  host.innerHTML=`<section class="card section"><h3>Private customer links</h3><p>Links show only this work order’s customer-visible updates and photos. Document access additionally includes this work order’s issued invoices and retained authorizations.</p><form data-customer-access><label class="field">Access scope<select name="scope"><option value="status">Repair status and photos</option><option value="documents">Status, photos, invoices and authorizations</option></select></label><label class="field">Expires in days<input name="days" type="number" min="1" max="90" value="30" required></label><button class="btn">Create customer link</button></form><p data-access-message role="status"></p><div data-new-link></div><h4>Link history</h4>${result.links.map(link=>`<div class="status-line"><strong>Link #${Number(link.id)}</strong> · ${escapeText(link.scope)} · expires ${escapeText(link.expires_at)} · ${link.active&&!link.revoked_at?'active':'revoked'}${link.active&&!link.revoked_at?` <button class="btn" data-revoke-link="${Number(link.id)}">Revoke</button>`:`<small> ${escapeText(link.revocation_reason)}</small>`}</div>`).join('')||'<p>No customer links created.</p>'}</section>`;
  const message=host.querySelector('[data-access-message]');
  host.querySelector('[data-customer-access]').onsubmit=async event=>{
    event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;
    try{
      const body=Object.fromEntries(new FormData(event.target));body.days=Number(body.days);
      const value=await request(url,'POST',body),holder=host.querySelector('[data-new-link]');holder.replaceChildren();
      const link=document.createElement('a');link.href=value.portalUrl;link.textContent=value.portalUrl;link.rel='noreferrer';link.target='_blank';holder.append(link);message.textContent='Private link created. Share only with this customer.';
    }catch(error){message.textContent=error.message;}finally{button.disabled=false;}
  };
  host.querySelectorAll('[data-revoke-link]').forEach(button=>button.onclick=async()=>{
    const reason=prompt('Reason for revoking this customer link:');if(!reason?.trim())return;button.disabled=true;
    try{await request(`${url}/${Number(button.dataset.revokeLink)}/revoke`,'POST',{confirm:true,reason:reason.trim()});await mountCustomerAccessPanel(host,workOrderId);}catch(error){message.textContent=error.message;button.disabled=false;}
  });
}

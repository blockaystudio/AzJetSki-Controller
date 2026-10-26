import {mountAuthorizations} from './authorizations-ui.js';
import {rememberEditRevisions,prepareRevisionRequest,editConflictMessage} from './edit-revisions-ui.js';
import {financePanel,bindFinancePanel} from './finance-ui.js';
const $=s=>document.querySelector(s);
const money=n=>Number(n||0).toLocaleString('en-US',{style:'currency',currency:'USD'});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const requestKey=()=>globalThis.crypto?.randomUUID?.()||`ot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let job=null,invoices=[],loadEpoch=0,refundDue=false;
const attempts=new Map();
async function api(path,method='GET',body,context={}){
  const options=prepareRevisionRequest(path,{method,credentials:'same-origin',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)},context);
  const r=await fetch(path,options),j=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(editConflictMessage(r,j)||j.error||`HTTP ${r.status}`);
  return rememberEditRevisions(j);
}
const show=(node,txt,good=false)=>{$(node).textContent=txt;$(node).style.borderColor=good?'#2c825a':'#26354a'};
const current=context=>context.epoch===loadEpoch&&Number($('#jobs').value)===context.id&&job?.id===context.id;
function selected(){
  if(!job||Number($('#jobs').value)!==Number(job.id))throw Error('Select a work order and wait for it to finish loading.');
  return {id:Number(job.id),record:job,epoch:loadEpoch};
}
function controls(){
  for(const id of ['invoiceForm','payForm','p1Form','signForm']){
    const form=$('#'+id),disabled=!job||(id==='payForm'&&refundDue)||(id==='p1Form'&&!invoices.some(x=>!x.voided_at&&!x.superseded_by));
    [...form.elements].forEach(field=>field.disabled=disabled||Boolean(form.dataset.busy)&&(field.tagName==='BUTTON'||field.type==='submit'));
  }
  $('#checkSign').disabled=!job||Boolean($('#checkSign').dataset.busy);
  $('#pdfPreview').setAttribute('aria-disabled',String(!job));
  $('#pdfPreview').tabIndex=job?0:-1;
}
function clearSelection(preserveResults=false){
  job=null;invoices=[];refundDue=false;
  for(const id of ['invoiceForm','payForm','p1Form','signForm'])$('#'+id).reset();
  $('#p1Invoice').replaceChildren();$('#pdfPreview').removeAttribute('href');
  $('#payments').textContent='No payments loaded.';$('#invoices').textContent='Select a work order.';$('#signHistory').replaceChildren();
  $('#invoiceMeaning').textContent='Select a work order to review its current account balance.';$('#invoiceForm button').textContent='Issue Invoice';
  $('#billingAuthorizations')?.remove();
  if(!preserveResults){$('#invoiceResult').textContent='No invoice created yet.';$('#p1Result').textContent='No payment request yet.';$('#signResult').textContent='No authorization prepared yet.';}
  controls();
}
async function init(){
  controls();
  try{
    const me=await api('/api/me');if(!me.user){$('#jobinfo').textContent='Please sign in to the desktop POS first.';return;}
    const s=await api('/api/billing/integration-status');
    $('#intStatus').innerHTML=`<p>Dejavoo SPIn: <b>${s.dejavoo.terminalConfigured?'Credentials present; live adapter not yet certified':'Setup needed'}</b></p><p>Dejavoo HPP: <b>${s.dejavoo.hppConfigured?'Credentials present; live adapter not yet certified':'Setup needed'}</b></p><p>DocuSign app OAuth: <b>${s.docusign.appTokenConfigured?'Configured':'Needs credentials'}</b></p><p>Remote HTTPS: <b>${s.basePublicHttps?'Configured':'Needed for invoice links'}</b></p>`;
    const data=await api('/api/work-orders'),orders=data.workOrders.filter(x=>x.source==='manual');
    $('#jobs').innerHTML='<option value="">Select a work order</option>'+orders.map(x=>`<option value="${x.id}">WO ${esc(x.ref_number||x.id)} — ${esc(x.customer_name)} (${money(x.balance)})</option>`).join('');
    if(orders.length){const requested=Number(new URLSearchParams(location.search).get('workOrderId')||0);$('#jobs').value=orders.find(x=>Number(x.id)===requested)?.id||orders[0].id;await load();}
    else $('#jobinfo').textContent='No repair work orders are available.';
  }catch(e){show('#jobinfo',e.message);}
}
async function load({preserveResults=false}={}){
  const epoch=++loadEpoch,id=Number($('#jobs').value);
  clearSelection(preserveResults);
  $('#jobinfo').textContent=id?'Loading selected work order…':'Select a work order.';
  if(!id)return;
  const stillSelected=()=>epoch===loadEpoch&&Number($('#jobs').value)===id;
  try{
    const [d,p,i,s]=await Promise.all([
      api(`/api/work-orders/${id}`),api(`/api/pos/work-orders/${id}/payments`),
      api(`/api/pos/work-orders/${id}/invoices`),api(`/api/pos/work-orders/${id}/docusign`)
    ]);
    if(!stillSelected())return;
    const record=d.workOrder;
    if(Number(record.id)!==id)throw Error('The loaded work order does not match your selection. Refresh and try again.');
    // Mount into a detached element: late authorization responses cannot restore
    // an old job's form or active controls after the selector changes.
    const authorizations=document.createElement('section');authorizations.id='billingAuthorizations';authorizations.className='card section';
    await mountAuthorizations(authorizations,id,{media:record.media||[],description:record.authorized_work||record.complaint,revision:record.revision,onChanged:async()=>{if(stillSelected())await load();}});
    if(!stillSelected())return;
    job=record;invoices=i.invoices||[];refundDue=Number(p.totals.refundDue)>0;
    $('#jobinfo').innerHTML=`<b>WO ${esc(job.ref_number||job.id)}</b> — ${esc(job.customer_name)} · ${esc(job.unit_label||[job.year,job.make,job.model].filter(Boolean).join(' '))}<br>Original total ${money(p.totals.originalTotal??job.estimate_total)} · Credits ${money(p.totals.credits)} · Account total ${money(p.totals.total??job.estimate_total)}<br>Verified net paid ${money(p.totals.paid)} · <b>Customer due ${money(p.totals.balance)}</b> · Pending Zelle ${money(p.totals.pending)}${refundDue?`<p><strong>Refund owed to customer: ${money(p.totals.refundDue)}</strong>. An owner or manager must record the externally completed refund below.</p>`:''}<p><a class="btn" href="/accounting.html?scope=repair&id=${id}">Credit notes / returns</a></p>`;
    $('#recipient').value=job.email||'';$('#signer').value=job.customer_name||'';$('#signEmail').value=job.email||'';$('#signScope').value=job.authorized_work||job.complaint||'';
    $('#pdfPreview').href=`/api/pos/work-orders/${id}/docusign/preview`;
    $('#payments').innerHTML=financePanel({kind:'repair',id,...p,showReceipt:true});
    bindFinancePanel($('#payments'),{kind:'repair',id,reload:async()=>{if(stillSelected())await load();}});
    $('#invoices').innerHTML=invoices.map(x=>`<div class="status-line">${esc(x.number)} • ${money(x.amount_cents/100)} at issue<br><small>${x.voided_at?'Voided':x.superseded_by?'Historical — replaced':x.document_kind==='revised_invoice'?'Current revised invoice':'Current invoice'}${x.supersedes_invoice_id?` · replaces #${Number(x.supersedes_invoice_id)}`:''} · ${esc(x.recipient_email)} · ${esc(x.issued_at)}</small></div>`).join('')||'No invoices';
    $('#invoiceForm button').textContent=invoices.length?'Issue Revised Invoice':'Issue Invoice';
    $('#invoiceMeaning').textContent=invoices.length?`A revised invoice replaces ${invoices[0].number} with the full current account balance. Previous documents remain in history. It adds no new debt.`:'This invoice records the selected work order’s current account balance. Verified payments reduce that same account.';
    $('#p1Invoice').innerHTML=invoices.filter(x=>!x.voided_at&&!x.superseded_by).map(x=>`<option value="${x.id}">${esc(x.number)} • ${money(x.amount_cents/100)} at issue</option>`).join('');
    $('#signHistory').innerHTML=s.packets.map(x=>`<p>Packet ${x.id}: ${esc(x.status)} · ${esc(x.recipient_email)}${x.status==='completed'&&!x.authorization_applied?' · historical evidence; current scope not authorized':''}</p>`).join('')||'No DocuSign packets';
    $('#jobinfo').closest('section').after(authorizations);controls();
  }catch(error){if(stillSelected()){clearSelection(preserveResults);show('#jobinfo',error.message);} }
}
function retryPayload(action,path,payload){
  const fingerprint=JSON.stringify({path,payload});let attempt=attempts.get(action);
  if(!attempt||attempt.fingerprint!==fingerprint){attempt={fingerprint,key:requestKey()};attempts.set(action,attempt);}
  return {...payload,idempotencyKey:attempt.key};
}
async function action(form,result,operation){
  if(form.dataset.busy)return;
  let context;
  try{context=selected();form.dataset.busy='true';controls();await operation(context);}
  catch(error){if(!context||current(context))show(result,error.message);}
  finally{delete form.dataset.busy;controls();}
}
$('#jobs').onchange=()=>load();$('#refresh').onclick=()=>load();
$('#invoiceForm').onsubmit=event=>{
  event.preventDefault();return action(event.currentTarget||$('#invoiceForm'),'#invoiceResult',async context=>{
    const path=`/api/pos/work-orders/${context.id}/invoices`;
    const payload=retryPayload('invoice',path,{email:$('#recipient').value,sendEmail:$('#sendEmail').checked,expectedRevision:context.record.revision,documentKind:invoices.length?'revised_invoice':'invoice',...(invoices.length?{supersedesInvoiceId:invoices[0].id}:{})});
    const d=await api(path,'POST',payload,{record:context.record});attempts.delete('invoice');if(!current(context))return;
    $('#invoiceResult').innerHTML=`<b>${esc(d.number)}</b> — ${money(d.amount)}<br>Delivery: ${esc(d.deliveryStatus)}<br><a href="${esc(d.link)}" target="_blank" rel="noopener noreferrer">Open Customer Invoice</a><p><button class="btn" id="copyLink">Copy Invoice Link</button> <a class="btn" id="mailto" href="#">Email Using Mail App</a></p>`;
    $('#copyLink').onclick=()=>navigator.clipboard.writeText(d.link).catch(()=>prompt('Copy link:',d.link));$('#mailto').href=`mailto:${encodeURIComponent(d.customerEmail)}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.message)}`;
    await load({preserveResults:true});
  });
};
$('#payForm').onsubmit=event=>{
  event.preventDefault();return action($('#payForm'),'#payments',async context=>{
    if(refundDue)throw Error('Resolve the refund owed before recording another payment.');
    const form=$('#payForm'),fields=Object.fromEntries(new FormData(form)),path=`/api/pos/work-orders/${context.id}/payments`;
    const payload=retryPayload('payment',path,{method:fields.method,amount:fields.amount,reference:fields.reference||'',verified:form.elements.verified.checked,status:fields.method==='zelle'&&!form.elements.verified.checked?'pending':'confirmed'});
    await api(path,'POST',payload);attempts.delete('payment');if(current(context))await load();
  });
};
$('#p1Form').onsubmit=event=>{
  event.preventDefault();return action($('#p1Form'),'#p1Result',async context=>{
    const fields=Object.fromEntries(new FormData($('#p1Form'))),id=Number($('#p1Invoice').value);
    if(!invoices.some(x=>x.id===id&&!x.voided_at&&!x.superseded_by))throw Error('Issue a current invoice first.');
    const path=`/api/billing/invoices/${id}/payment-requests`,payload=retryPayload('p1',path,fields);
    const d=await api(path,'POST',{...fields,requestKey:payload.idempotencyKey});attempts.delete('p1');
    if(current(context))show('#p1Result',`Request #${d.id??d.request?.id}: ${d.status??d.request?.status}. ${d.notice||'Prepared for merchant review; no charge processed.'}`);
  });
};
$('#signForm').onsubmit=event=>{
  event.preventDefault();return action($('#signForm'),'#signResult',async context=>{
    if(!confirm('Prepare the work order authorization and send via DocuSign if configured?'))return;
    const fields=Object.fromEntries(new FormData($('#signForm')));
    const d=await api(`/api/pos/work-orders/${context.id}/docusign/send`,'POST',{...fields,confirmSend:true,expectedRevision:context.record.revision},{record:context.record});
    if(!current(context))return;show('#signResult',`Packet ${d.packetId}: ${d.status}. ${d.notice||('Envelope: '+d.envelopeId)}`,true);await load({preserveResults:true});
  });
};
$('#checkSign').onclick=()=>action($('#checkSign'),'#signResult',async context=>{
  const d=await api(`/api/pos/work-orders/${context.id}/docusign/sync`,'POST',{});
  if(!current(context))return;show('#signResult',`DocuSign status: ${d.status}. ${d.notice||''}`);await load({preserveResults:true});
});
init();

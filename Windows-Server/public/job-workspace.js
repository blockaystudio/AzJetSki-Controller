const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>Number(value||0).toLocaleString('en-US',{style:'currency',currency:'USD'});

export const JOB_TABS=Object.freeze([
  ['overview','Overview'],['estimate','Estimate & Approval'],['work','Work & Photos'],
  ['parts','Parts'],['payments','Payments & Documents'],['history','History']
]);
export const normalizeJobTab=tab=>JOB_TABS.some(([id])=>id===tab)?tab:'overview';
export function jobUrl(id,tab='overview') {
  const query=new URLSearchParams({view:'workorders',workOrderId:String(Number(id)),tab:normalizeJobTab(tab)});
  return '/?'+query;
}

// Only the retained-authorization API can establish current approval. A stage
// named Approved or a historical signature is not evidence of current scope.
export function authorizationSummary(authorization,workOrder) {
  if(authorization?.hasCurrentRepairAuthorization===true)return {approved:true,label:'Current repair approval',amount:Number(workOrder.estimate_total||0)};
  return {approved:false,label:authorization?.hasCurrentRepairAuthorization===false?'Current repair approval needed':'Approval not verified',amount:null};
}

export function financialSummary(workOrder,totals) {
  if(!totals)return {available:false,original:Number(workOrder.estimate_total||0)};
  return {available:true,original:Number(totals.originalTotal??workOrder.estimate_total??0),credits:Number(totals.credits||0),
    total:Number(totals.total??workOrder.estimate_total??0),paid:Number(totals.paid||0),pending:Number(totals.pending||0),
    due:Math.max(0,Number(totals.balance||0)),refund:Math.max(0,Number(totals.refundDue||0))};
}

export function nextJobAction(workOrder,summary,approval) {
  if(summary.refund>0)return {tab:'payments',label:'Review refund owed',detail:'Record the externally completed refund before pickup.'};
  if(['Ready','Ready for Pickup'].includes(workOrder.stage)&&summary.due>0)return {tab:'payments',label:'Collect remaining balance',detail:'Verify payment before releasing the unit.'};
  if(['Ready','Ready for Pickup'].includes(workOrder.stage))return {tab:'payments',label:'Review account & pickup',detail:'Complete the pickup checklist and confirm custody.'};
  if(['Picked Up','Closed'].includes(workOrder.stage))return {tab:'history',label:'Review job history',detail:'This unit has left shop custody.'};
  if(workOrder.stage==='Awaiting Approval'||(!approval.approved&&workOrder.stage==='Approved'))return {tab:'estimate',label:'Review current authorization',detail:'Confirm the retained scope and amount before repair work.'};
  if((workOrder.parts||[]).some(part=>Number(part.qty_received)<Number(part.qty_needed)))return {tab:'parts',label:'Review required parts',detail:'Check sourcing, quantities received and expected arrival.'};
  return {tab:'work',label:'Add work update or photos',detail:workOrder.next_action||'Record progress and keep the customer informed.'};
}

function formValue(form) {
  return JSON.stringify([...form.elements].filter(field=>field.name&&field.type!=='submit'&&field.type!=='button').map(field=>[
    field.name,field.type==='checkbox'||field.type==='radio'?field.checked:
      field.type==='file'?[...field.files||[]].map(file=>[file.name,file.size,file.lastModified]):field.value
  ]));
}

// Forms are compared with their mounted values, so correcting an edit back to
// its original value is clean. Failed saves retain their dirty state.
export function createUnsavedGuard(root,{confirmLeave=message=>globalThis.confirm(message)}={}) {
  const baselines=new WeakMap(),restoredDrafts=new WeakSet();
  const observe=()=>root.querySelectorAll('form').forEach(form=>{if(!baselines.has(form))baselines.set(form,formValue(form));});
  const dirty=(scope=root)=>{observe();return [...scope.querySelectorAll('form')].filter(form=>restoredDrafts.has(form)||baselines.get(form)!==formValue(form));};
  const saved=event=>{const form=event.target.closest?.('form');if(form){restoredDrafts.delete(form);baselines.set(form,formValue(form));queueMicrotask(()=>baselines.set(form,formValue(form)));}};
  const restored=event=>{const form=event.target.closest?.('form');if(form)restoredDrafts.add(form);};
  const focus=()=>observe();
  root.addEventListener('focusin',focus);root.addEventListener('workspace:saved',saved);root.addEventListener('workspace:restored',restored);
  const observer=typeof MutationObserver==='undefined'?null:new MutationObserver(observe);
  observer?.observe(root,{childList:true,subtree:true});observe();
  return {
    dirty,markSaved(form){if(form){restoredDrafts.delete(form);baselines.set(form,formValue(form));}},
    canLeave(){return !dirty().length||confirmLeave('You have unsaved changes in this job. Discard them and leave?');},
    canSwitch(panel){return !dirty(panel).length||confirmLeave('This section has unsaved changes. Switch tabs? Your edits will stay in this job until you save or leave.');},
    canDiscard(scope){return !dirty(scope).length||confirmLeave('Discard the unsaved changes in this form?');},
    destroy(){observer?.disconnect();root.removeEventListener('focusin',focus);root.removeEventListener('workspace:saved',saved);root.removeEventListener('workspace:restored',restored);}
  };
}

export function pickupEligibility(workOrder,queues) {
  const row=(queues?.inLot||[]).find(item=>Number(item.vehicle_id)===Number(workOrder.vehicle_id)&&Number(item.work_order_id)===Number(workOrder.id));
  if(!row)return {allowed:false,message:['Picked Up','Closed'].includes(workOrder.stage)?'Pickup is complete. The unit is no longer in shop custody.':'This job has no matching unit checked in. Review check-in before pickup.'};
  if(row.stage!=='Ready')return {allowed:false,message:'Mark this job Ready after the work is complete.'};
  if(Number(row.refundDue)>0)return {allowed:false,message:'Record the refund owed before releasing this unit.'};
  if(Number(row.balance)>0.005)return {allowed:false,message:'Collect and verify the remaining balance before pickup.'};
  return {allowed:true,message:'Ready, payment settled, and this unit is checked in for this job.'};
}

export function mountRepairPickup(container,workOrder,{request,onSaved=()=>{},isCurrent=()=>true}) {
  container.innerHTML='<h3>Unit pickup</h3><p data-pickup-status role="status">Checking pickup eligibility…</p><form data-job-pickup><label class="field">Pickup notes<textarea name="notes" maxlength="2000" placeholder="Person collecting, keys and paperwork returned"></textarea></label><label class="check-row"><input type="checkbox" name="confirmed" required> I verified the customer, unit, completed work, keys and paperwork for this pickup.</label><button class="btn primary">Complete pickup</button></form>';
  const form=container.querySelector('form'),message=container.querySelector('[data-pickup-status]');
  let allowed=false,busy=false,epoch=0;
  const controls=()=>{for(const field of form.elements)field.disabled=!allowed||busy;};controls();
  async function refresh(){const attempt=++epoch;try{const queues=await request('/api/shop/queues');if(attempt!==epoch||!isCurrent())return false;const state=pickupEligibility(workOrder,queues);allowed=state.allowed;message.textContent=state.message;controls();return allowed;}catch(error){if(attempt===epoch&&isCurrent()){allowed=false;message.textContent='Unable to verify pickup: '+error.message;controls();}return false;}}
  form.onsubmit=async event=>{event.preventDefault();if(busy||!allowed)return;busy=true;controls();try{if(!await refresh())return;await request(`/api/shop/vehicles/${Number(workOrder.vehicle_id)}/check-out`,{method:'POST',body:JSON.stringify({workOrderId:Number(workOrder.id),notes:form.elements.notes.value})});if(!isCurrent())return;form.dispatchEvent(new CustomEvent('workspace:saved',{bubbles:true}));message.textContent='Pickup recorded. Unit released from shop custody.';allowed=false;await onSaved();}catch(error){if(isCurrent())message.textContent=error.message;}finally{busy=false;controls();}};
  return {ready:refresh(),refresh};
}

export function mountJobWorkspace(container,{workOrder,totals,authorization,initialTab='overview',onTab=()=>{},onPayments=()=>{},back=()=>{}}) {
  const sections=[...container.querySelectorAll('[data-job-section]')];
  const title=container.querySelector('.detail-title');
  const root=document.createElement('section');root.id='jobWorkspace';root.className='job-workspace';
  root.innerHTML=`<header class="job-context"><div data-job-title></div><div data-job-context></div><p class="job-context-stale" role="status" hidden></p></header>
    <div class="job-tabs" role="tablist" aria-label="Job workspace">${JOB_TABS.map(([id,label])=>`<button type="button" class="job-tab" id="job-tab-${id}" role="tab" aria-controls="job-panel-${id}" aria-selected="false" tabindex="-1" data-job-tab="${id}">${label}</button>`).join('')}</div>
    ${JOB_TABS.map(([id,label])=>`<section class="job-panel" id="job-panel-${id}" role="tabpanel" aria-labelledby="job-tab-${id}" tabindex="0" hidden><h2 class="job-panel-heading">${label}</h2></section>`).join('')}`;
  root.querySelector('[data-job-title]').append(title);
  for(const section of sections)root.querySelector('#job-panel-'+section.dataset.jobSection)?.append(section);
  root.querySelectorAll('.field > label').forEach((label,index)=>{const field=label.parentElement.querySelector('input,select,textarea');if(field){field.id ||= 'job-field-'+index;label.htmlFor=field.id;}});
  const financial=document.createElement('div');financial.id='jobAccountWorkspace';root.querySelector('#job-panel-payments').append(financial);
  const estimateEditor=document.createElement('div');estimateEditor.id='jobEstimateEditor';root.querySelector('#job-panel-estimate').prepend(estimateEditor);
  container.replaceChildren(root);
  const guard=createUnsavedGuard(root);
  let active='',financialMounted=false;
  const tabStrip=root.querySelector('.job-tabs');
  function revealActiveTab(){if(!active)return;const button=root.querySelector('#job-tab-'+active),stripBounds=tabStrip.getBoundingClientRect(),bounds=button.getBoundingClientRect();if(bounds.left<stripBounds.left)tabStrip.scrollLeft-=stripBounds.left-bounds.left;else if(bounds.right>stripBounds.right)tabStrip.scrollLeft+=bounds.right-stripBounds.right;}
  const resize=typeof ResizeObserver==='undefined'?null:new ResizeObserver(revealActiveTab);resize?.observe(tabStrip);
  function updateContext(nextTotals=totals,nextAuthorization=authorization) {
    totals=nextTotals;authorization=nextAuthorization;
    const summary=financialSummary(workOrder,totals),approval=authorizationSummary(authorization,workOrder),next=nextJobAction(workOrder,summary,approval);
    root.querySelector('[data-job-context]').innerHTML=`<dl class="job-context-facts"><div><dt>Status</dt><dd>${esc(workOrder.stage)}</dd></div><div><dt>Assigned</dt><dd>${esc(workOrder.assigned_name||workOrder.tech||'Unassigned')}</dd></div><div><dt>Authorization</dt><dd>${esc(approval.label)}${approval.amount!==null?' · '+money(approval.amount):''}</dd></div></dl>
      <div class="job-context-summary" aria-label="Job financial summary">${summary.available?`<span>Estimate <strong>${money(summary.original)}</strong></span><span>Credits <strong>${money(summary.credits)}</strong></span><span>Current total <strong>${money(summary.total)}</strong></span><span>Net paid <strong>${money(summary.paid)}</strong></span><span>Due <strong>${money(summary.due)}</strong></span>${summary.pending>0?`<span>Pending verification <strong>${money(summary.pending)}</strong></span>`:''}${summary.refund>0?`<span class="notice">Refund owed <strong>${money(summary.refund)}</strong></span>`:''}`:`<span>Estimate <strong>${money(summary.original)}</strong></span><span>Account balance unavailable for this session.</span>`}</div>
      <div class="job-next-action"><div><strong>${esc(next.label)}</strong><span>${esc(next.detail)}</span></div><button type="button" class="btn primary" data-next-tab="${next.tab}">${esc(next.label)}</button></div>`;
    root.querySelector('[data-next-tab]').onclick=()=>selectTab(next.tab,{focus:true});
  }
  function selectTab(tab,{focus=false,history=true,force=false}={}) {
    tab=normalizeJobTab(tab);
    if(active===tab){if(focus)root.querySelector('#job-tab-'+tab).focus();return true;}
    if(active&&!force&&!guard.canSwitch(root.querySelector('#job-panel-'+active)))return false;
    active=tab;
    for(const [id] of JOB_TABS){const selected=id===tab,button=root.querySelector('#job-tab-'+id);button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;root.querySelector('#job-panel-'+id).hidden=!selected;}
    revealActiveTab();
    if(tab==='payments'&&!financialMounted){financialMounted=true;onPayments(financial);}
    if(focus)root.querySelector('#job-tab-'+tab).focus();
    if(history)onTab(tab);
    return true;
  }
  root.querySelectorAll('[data-job-tab]').forEach(button=>{
    button.onclick=()=>selectTab(button.dataset.jobTab);
    button.onkeydown=event=>{
      const index=JOB_TABS.findIndex(([id])=>id===button.dataset.jobTab);
      const next=event.key==='ArrowRight'?(index+1)%JOB_TABS.length:event.key==='ArrowLeft'?(index+JOB_TABS.length-1)%JOB_TABS.length:event.key==='Home'?0:event.key==='End'?JOB_TABS.length-1:null;
      if(next===null)return;event.preventDefault();selectTab(JOB_TABS[next][0],{focus:true});
    };
  });
  root.querySelector('#back').onclick=back;
  updateContext();selectTab(initialTab,{history:false,force:true});
  return {root,guard,selectTab,updateContext,get activeTab(){return active;},
    stale(message='This job changed. Reload to use the latest work order revision.') {const notice=root.querySelector('.job-context-stale');notice.textContent=message;notice.hidden=false;updateContext(totals,null);},
    destroy(){guard.destroy();resize?.disconnect();}
  };
}

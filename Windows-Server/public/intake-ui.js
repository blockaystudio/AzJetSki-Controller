import {dailyNavigation} from './shared-ui.js';

export const intakeRoles = ['owner', 'manager', 'service_writer', 'advisor'];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const unitName = unit => [unit?.year, unit?.make, unit?.model].filter(Boolean).join(' ') || unit?.category || 'Vehicle';
const jobUrl = id => `/?view=workorders&workOrderId=${encodeURIComponent(id)}`;
const blank = () => ({step:1, customer:null, unit:null, job:null, customerMode:'search', unitMode:'select', query:'', customerDraft:{state:'AZ',billing_state:'AZ',billing_same_as_service:true}, unitDraft:{category:'PWC'}, jobDraft:{estimate_total:'0.00',priority:'normal',assigned_user_id:''}, custodyDraft:{checkIn:false}, assignmentDone:false, checkinDone:false, complete:false, dirty:false, pending:null, uncertain:null});

// The existing creation endpoints do not support idempotency keys. Persist each
// accepted identity before the next operation, and never replay an uncertain write.
export class IntakeSession {
  constructor({request, persist = () => {}, draft = {}}) {
    this.request = request;
    this.persist = persist;
    this.state = {...blank(), ...draft};
    this.busy = false;
    if (this.state.pending) {
      this.state.uncertain = {kind:this.state.pending, message:'The previous save did not return a confirmed result. Find the saved record before continuing.'};
      this.state.pending = null;
    }
  }
  save() { this.persist(this.state); }
  touch() { this.state.dirty = true; this.save(); }
  async run(action) {
    if (this.busy || this.state.uncertain || this.state.complete) return false;
    this.busy = true;
    try { await action(); return true; }
    finally { this.busy = false; this.save(); }
  }
  async mutate(kind, path, body, accept) {
    this.state.pending = kind;
    this.save();
    try {
      const result = await this.request(path, 'POST', body);
      accept(result);
      this.state.pending = null;
      this.save();
      return result;
    } catch (error) {
      this.state.pending = null;
      if (!error.status || error.status >= 500 || error.status === 408) {
        this.state.uncertain = {kind, message:'The save result is unknown. It may already be saved. Find the saved record below before continuing.'};
      }
      this.save();
      throw error;
    }
  }
  async createCustomer(body) {
    return this.run(async () => {
      await this.mutate('customer', '/api/pos/customers', body, result => {
        if (!Number.isSafeInteger(result.customer?.id)) throw Error('Customer save could not be confirmed.');
        this.state.customer = result.customer;
        this.state.unit = null;
        this.state.step = 2;
        this.state.customerMode = 'search';
        this.state.customerDraft = blank().customerDraft;
      });
    });
  }
  async createUnit(body) {
    return this.run(async () => {
      if (!this.state.customer) throw Error('Choose a customer first.');
      await this.mutate('unit', '/api/pos/vehicles', {...body, customer_id:this.state.customer.id}, result => {
        if (!Number.isSafeInteger(result.vehicle?.id) || Number(result.vehicle.customer_id) !== this.state.customer.id) throw Error('Vehicle save could not be confirmed.');
        this.state.unit = result.vehicle;
        this.state.step = 3;
        this.state.unitMode = 'select';
        this.state.unitDraft = blank().unitDraft;
      });
    });
  }
  async finish() {
    return this.run(async () => {
      const s = this.state;
      if (!s.customer || !s.unit || Number(s.unit.customer_id) !== Number(s.customer.id)) throw Error('Choose this customer’s vehicle before creating the repair.');
      if (!s.job) {
        s.jobRef ||= 'OT-' + crypto.randomUUID().slice(0, 8).toUpperCase();
        this.save();
        await this.mutate('job', '/api/pos/work-orders', {...s.jobDraft, ref_number:s.jobRef, customer_id:s.customer.id, vehicle_id:s.unit.id}, result => {
          if (!Number.isSafeInteger(result.id)) throw Error('Repair save could not be confirmed.');
          s.job = result;
          s.step = 4;
        });
      }
      if (!s.assignmentDone && s.jobDraft.assigned_user_id) {
        // Capture the newly created record once. A failed retry keeps this revision.
        s.assignmentRecord ||= (await this.request(`/api/work-orders/${s.job.id}`)).workOrder;
        const current = s.assignmentRecord;
        if (!Number.isSafeInteger(current?.revision)) throw Error('The repair is saved. Open the job to review its assignment.');
        s.pending = 'assignment'; this.save();
        try {
          const assigned = await this.request(`/api/work-orders/${s.job.id}`, 'PATCH', {assigned_user_id:Number(s.jobDraft.assigned_user_id)}, current);
          if (Number(assigned.workOrder?.assigned_user_id) !== Number(s.jobDraft.assigned_user_id)) throw Error('The saved assignment could not be confirmed.');
          s.assignmentDone = true;
          s.pending = null; this.save();
        } catch (error) {
          s.pending = null;
          if (!error.status || error.status >= 500 || [408,409,428].includes(error.status)) s.uncertain = {kind:'assignment',message:'The repair is saved. Review its current assignment before continuing.'};
          this.save(); throw error;
        }
      } else s.assignmentDone = true;
      if (!s.checkinDone) {
        // Job creation already attaches an on-site vehicle to the new repair.
        const queues = await this.request('/api/shop/queues');
        const onSite = queues.inLot.find(row => Number(row.vehicle_id) === s.unit.id);
        if (onSite) {
          if (Number(onSite.work_order_id) !== s.job.id) {
            s.uncertain = {kind:'checkin',message:'This vehicle is on site with a different repair. Review the lot record before continuing.'};
            throw Error(s.uncertain.message);
          }
          s.checkinDone = true;
          s.onSite = onSite;
        } else if (s.custodyDraft.checkIn) {
          await this.mutate('checkin', `/api/shop/vehicles/${s.unit.id}/check-in`, {workOrderId:s.job.id,lotLocation:s.custodyDraft.lotLocation || '',keysTag:s.custodyDraft.keysTag || '',notes:s.custodyDraft.notes || ''}, result => {
            if (result.status !== 'in_lot') throw Error('Check-in could not be confirmed.');
            s.checkinDone = true;
            s.onSite = {lot_location:s.custodyDraft.lotLocation,keys_tag:s.custodyDraft.keysTag};
          });
        }
      }
      s.complete = true;
      s.dirty = false;
    });
  }
}

export async function intakeRequest(path, method = 'GET', body, record) {
  const headers = {'content-type':'application/json'};
  if (record) headers['if-match'] = `"work_orders:${record.id}:${record.revision}"`;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(path, {method, credentials:'same-origin', headers, signal:controller.signal, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const error = Error(result?.error || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    if (!result) throw Error('The server response could not be confirmed.');
    return result;
  } finally { clearTimeout(timer); }
}

const field = (label, name, value = '', attrs = '') => `<label class="field"><span>${label}</span><input name="${name}" value="${esc(value)}" ${attrs}></label>`;
const address = (c, billing = false) => {
  const prefix = billing ? 'billing_' : '', same = c.billing_same_as_service !== false;
  return `<fieldset class="address-fieldset" ${billing ? `id="billingAddress" ${same?'hidden':''}` : ''}><legend>${billing?'Separate billing address':'Customer / mailing address'}</legend><div class="form-grid">${[
    ['Street address','address_line1','address-line1'],['Apartment / Suite','address_line2','address-line2'],['City','city','address-level2'],['State','state','address-level1'],['ZIP / Postal code','postal_code','postal-code']
  ].map(([label,key,autocomplete]) => {
    const name = billing && key === 'postal_code' ? 'billing_postal_code' : prefix + key;
    return field((billing?'Billing ':'') + label, name, c[name] || '', `autocomplete="${billing?'billing':'shipping'} ${autocomplete}" ${key!=='address_line2'&&(!billing||!same)?'required':''}`);
  }).join('')}</div></fieldset>`;
};

export async function mountIntake(root) {
  let me, session, storageKey, uiBusy = false, message = '', customers = [], vehicles = [], staff = [], lot = [], recovery = [], currentAssignment = null;
  const read = path => intakeRequest(path);
  const s = () => session.state;
  const persist = draft => { try { if (draft.complete) sessionStorage.removeItem(storageKey); else sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch {} };
  const clearDraft = () => { s().dirty = false; try { sessionStorage.removeItem(storageKey); } catch {} };
  const exitText = () => s().uncertain ? 'Leave intake with an unknown save result? Review saved records before creating another customer, vehicle, repair, or check-in.' : s().job ? 'Leave intake? The repair is saved. Any unfinished assignment or check-in will need attention in the job workspace.' : 'Leave intake? Unsaved form details will be discarded. Customer and vehicle records already saved will remain in the directory.';
  const canLeave = () => !s().dirty || confirm(exitText());
  const errors = error => { message = error.message || 'Unable to complete this action.'; };
  const lock = () => { root.querySelectorAll('button,input,select,textarea').forEach(node => node.disabled = true); root.querySelector('#intakeStep')?.setAttribute('aria-busy','true'); };
  const act = action => async event => {
    event?.preventDefault();
    if (uiBusy) return;
    uiBusy = true; message = ''; lock();
    try { await action(event); } catch (error) { errors(error); }
    finally { uiBusy = false; render(); }
  };
  const readVehicles = async () => { vehicles = (await read(`/api/pos/vehicles?customerId=${s().customer.id}`)).vehicles; };
  const searchCustomers = async () => { customers = (await read('/api/pos/customers?q='+encodeURIComponent(s().query))).customers; };
  const goStep = async step => { s().step = step; if(step===2) await readVehicles(); if(step===4) lot=(await read('/api/shop/queues')).inLot; session.save(); };
  const selectCustomer = async id => {
    const customer = (await read('/api/pos/customers/'+id)).customer;
    if (!customer || customer.archived) throw Error('This customer is unavailable. Search again.');
    if (s().customer?.id !== customer.id) { s().unit=null; s().unitDraft=blank().unitDraft; }
    s().customer=customer; s().customerMode='search'; s().uncertain=null; recovery=[];
    session.touch(); await goStep(2);
  };
  const selectUnit = id => {
    const unit = vehicles.find(row => Number(row.id)===Number(id));
    if (!unit || Number(unit.customer_id)!==s().customer.id) throw Error('Choose a vehicle belonging to this customer.');
    s().unit=unit; s().unitMode='select'; s().uncertain=null; recovery=[]; s().step=3; session.touch();
  };
  const buttons = (back, next) => `<div class="intake-actions">${back?`<button type="button" class="btn" data-back="${back}">Back</button>`:''}${next||''}</div>`;
  const customerResults = (rows, target='data-customer') => rows.map(c => `<button type="button" class="directory-row" ${target}="${c.id}"><strong>${esc(c.name)}</strong><span>${esc(c.phone || c.email || 'No contact recorded')}</span><span>${esc([c.address_line1,c.city,c.state,c.postal_code].filter(Boolean).join(', '))}</span></button>`).join('') || '<p class="empty">No matching customers. Check the name, phone, or email before adding a customer.</p>';
  const unitResults = rows => rows.map(v => `<button type="button" class="directory-row" data-unit="${v.id}"><strong>${esc(unitName(v))}</strong><span>${esc(v.vin||v.hin||'No VIN / HIN recorded')}</span></button>`).join('') || '<p class="empty">No vehicles saved for this customer yet.</p>';
  function customerStep() {
    if (s().customerMode === 'new') {
      const c=s().customerDraft;
      return `<h2 id="stepHeading" tabindex="-1">1. Add customer</h2><p>Save the customer’s contact and mailing address, then add their vehicle.</p><form id="customerCreate"><div class="form-grid">${field('Customer name','name',c.name,'required autocomplete="name"')}${field('Phone','phone',c.phone,'type="tel" autocomplete="tel"')}${field('Email','email',c.email,'type="email" autocomplete="email"')}</div>${address(c)}<label class="check-row"><input type="checkbox" name="billing_same_as_service" ${c.billing_same_as_service!==false?'checked':''}> Billing address same as customer address</label>${address(c,true)}${buttons(1,'<button class="btn primary">Save customer &amp; continue</button>')}</form>`;
    }
    return `<h2 id="stepHeading" tabindex="-1">1. Find customer</h2><p>Search by name, phone, email, city, or ZIP.</p><form id="customerSearch"><label class="field">Search customers<input name="q" value="${esc(s().query)}" autocomplete="off"></label><div class="intake-actions"><button class="btn">Search customers</button><button class="btn primary" type="button" id="newCustomer">New customer</button></div></form><div id="customerChoices">${customerResults(customers)}</div>`;
  }
  function unitStep() {
    if (s().unitMode === 'new') {
      const v=s().unitDraft;
      return `<h2 id="stepHeading" tabindex="-1">2. Add a vehicle</h2><p>Owned by ${esc(s().customer.name)}.</p><form id="unitCreate"><div class="form-grid">${field('Type / category','category',v.category,'required')}${field('Year','year',v.year,'inputmode="numeric" maxlength="4"')}${field('Make','make',v.make,'required')}${field('Model','model',v.model,'required')}${field('VIN','vin',v.vin,'autocomplete="off"')}${field('HIN','hin',v.hin,'autocomplete="off"')}${field('Hours','hours',v.hours,'type="number" min="0" step="0.1" inputmode="decimal"')}${field('Mileage','mileage',v.mileage,'type="number" min="0" step="0.1" inputmode="decimal"')}${field('Color','color',v.color)}</div>${buttons(2,'<button class="btn primary">Save vehicle &amp; continue</button>')}</form>`;
    }
    return `<h2 id="stepHeading" tabindex="-1">2. Choose vehicle</h2><p>Vehicles owned by ${esc(s().customer.name)}. Choose the machine arriving for this repair.</p><div id="unitChoices">${unitResults(vehicles)}</div>${buttons(1,'<button class="btn primary" type="button" id="newUnit">Add a vehicle</button>')}`;
  }
  function jobStep() {
    const j=s().jobDraft;
    return `<h2 id="stepHeading" tabindex="-1">3. Service request</h2><form id="jobDetails"><label class="field">Customer complaint<textarea name="complaint" required>${esc(j.complaint)}</textarea></label><div class="form-grid">${field('Basic estimate ($)','estimate_total',j.estimate_total,'type="number" min="0" step="0.01" inputmode="decimal" required')}<label class="field">Assigned employee<select name="assigned_user_id"><option value="">Unassigned</option>${staff.map(u=>`<option value="${u.id}" ${String(j.assigned_user_id)===String(u.id)?'selected':''}>${esc(u.displayName||u.username)} · ${esc(u.role.replaceAll('_',' '))}</option>`).join('')}</select></label><label class="field">Priority<select name="priority">${['normal','high','urgent'].map(p=>`<option ${j.priority===p?'selected':''}>${p}</option>`).join('')}</select></label></div><p class="muted">The basic estimate is the initial total. Add itemized parts, labor, and customer authorization in the job workspace.</p>${buttons(2,'<button class="btn primary">Review intake</button>')}</form>`;
  }
  function reviewStep() {
    const onSite=lot.find(row=>Number(row.vehicle_id)===s().unit.id), d=s().custodyDraft, assigned=staff.find(u=>String(u.id)===String(s().jobDraft.assigned_user_id));
    return `<h2 id="stepHeading" tabindex="-1">4. Review &amp; check in</h2><dl class="intake-summary"><dt>Customer complaint</dt><dd>${esc(s().jobDraft.complaint)}</dd><dt>Basic estimate</dt><dd>${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(s().jobDraft.estimate_total)||0)}</dd><dt>Assigned employee</dt><dd>${esc(assigned?.displayName||assigned?.username||'Unassigned')}</dd><dt>Priority</dt><dd>${esc(s().jobDraft.priority)}</dd></dl>${s().job?`<p class="success">Repair ${esc(s().job.ref_number)} is saved. Continue to finish the remaining intake steps.</p><p><a href="${jobUrl(s().job.id)}">Open saved job</a></p>`:''}<form id="completeIntake">${onSite?`<p class="notice">Already checked in${onSite.lot_location?' at '+esc(onSite.lot_location):''}${onSite.keys_tag?' · Key '+esc(onSite.keys_tag):''}. The saved repair will use this existing check-in.</p>`:`<label class="check-row"><input type="checkbox" name="checkIn" ${d.checkIn?'checked':''} ${s().checkinDone?'disabled':''}> Vehicle is here — check in now</label><fieldset class="address-fieldset" id="checkinFields" ${d.checkIn?'':'hidden'}><legend>Physical check-in</legend><div class="form-grid">${field('Lot parking location','lotLocation',d.lotLocation,'maxlength="80"')}${field('Key tag','keysTag',d.keysTag,'maxlength="80"')}</div><label class="field">Condition notes<textarea name="notes">${esc(d.notes)}</textarea></label></fieldset>`}${buttons(s().job?null:3,`<button class="btn primary">${s().job?'Finish saved repair intake':'Create repair'}</button>`)}</form>`;
  }
  function recoveryPanel() {
    const issue=s().uncertain, labels={customer:'Find saved customer',unit:'Find saved vehicle',job:'Find saved repair',assignment:'Check saved assignment',checkin:'Check lot status'};
    return `<section class="intake-recovery" aria-labelledby="recoveryHeading"><h2 id="recoveryHeading" tabindex="-1">Review the save result</h2><p>${esc(issue.message)}</p><p>Customer and vehicle selections already saved are retained. No save will be repeated automatically.</p><button type="button" class="btn" id="recover">${labels[issue.kind]}</button>${issue.kind==='customer'?`<form id="recoverySearch"><label class="field">Search saved customers<input name="q" value="${esc(s().query||s().customerDraft.name)}"></label><button class="btn">Search saved customers</button></form>${customerResults(recovery,'data-recover-customer')}`:''}${issue.kind==='unit'?unitResults(recovery):''}${issue.kind==='job'?recovery.map(w=>`<button type="button" class="directory-row" data-recover-job="${w.id}"><strong>Use saved repair ${esc(w.ref_number)}</strong><span>${esc(w.stage)} · ${esc(w.created_at)}</span></button>`).join(''):''}${issue.kind==='assignment'&&currentAssignment?`<p>Saved assignment: ${esc(staff.find(u=>Number(u.id)===Number(currentAssignment.assigned_user_id))?.displayName||'Unassigned')}</p><button type="button" class="btn" id="acceptAssignment">Keep current saved assignment</button>`:''}<p>${s().job?`<a href="${jobUrl(s().job.id)}">Open saved job</a> · `:''}<a href="/?view=customers${s().customer?'&customerId='+s().customer.id:''}">Open customer directory</a>${issue.kind==='checkin'?' · <a href="/shop-ops.html?tab=lot">Review lot</a>':''}</p></section>`;
  }
  function render() {
    const state=s();
    root.innerHTML=`<header class="topbar"><div class="brand"><img class="header-logo" src="/brand-logo.png" alt="AZ Jet Ski + Powersports">Owner <span>Tracker</span></div><span class="user-chip">${esc(me.user.displayName)} · ${esc(me.user.role.replaceAll('_',' '))}</span></header><main class="container intake-workspace">${dailyNavigation(me.user.role,'intake')}<div class="page-title"><div><h1>New Repair / Check In</h1><p class="muted">Customer, vehicle, service request, and arrival in one place.</p></div>${!state.complete?'<button class="btn" id="cancelIntake" type="button">Cancel intake</button>':''}</div><ol class="intake-steps" aria-label="Intake progress">${['Customer','Vehicle','Service request','Review & check in'].map((name,index)=>`<li class="${index+1===state.step?'current':index+1<state.step?'completed':''}" ${index+1===state.step?'aria-current="step"':''}>${name}${index+1<state.step?' — complete':''}</li>`).join('')}</ol>${state.customer?`<section class="intake-summary card" aria-label="Selected customer and vehicle"><strong>${esc(state.customer.name)}</strong><span>${esc(state.customer.phone||state.customer.email||'')}</span>${state.unit?`<strong>${esc(unitName(state.unit))}</strong><span>${esc(state.unit.vin||state.unit.hin||'')}</span>`:''}</section>`:''}<div id="intakeMessage" tabindex="-1" role="${message?'alert':'status'}" class="${message?'operation-notice':''}">${esc(message)}</div><section class="card section" id="intakeStep">${state.complete?`<div id="intakeComplete"><h2 tabindex="-1" id="stepHeading">Repair ${esc(state.job.ref_number)} created</h2><p>${state.onSite?'Vehicle is checked in'+(state.onSite.lot_location?' at '+esc(state.onSite.lot_location):'')+(state.onSite.keys_tag?' · Key '+esc(state.onSite.keys_tag):'')+'.':'Vehicle was not checked in. Check it in when it arrives.'}</p><a class="btn primary" href="${jobUrl(state.job.id)}">Open job</a> <a class="btn" href="/intake.html">Start another repair</a></div>`:state.uncertain?recoveryPanel():({1:customerStep,2:unitStep,3:jobStep,4:reviewStep}[state.step]||customerStep)()}</section></main>`;
    bind();
    root.querySelector(message?'#intakeMessage':'#recoveryHeading, #stepHeading')?.focus();
  }
  function bind() {
    const get=selector=>root.querySelector(selector), on=(selector,event,handler)=>{const node=get(selector);if(node)node[event]=handler;};
    on('#cancelIntake','onclick',()=>{if(canLeave()){clearDraft();location.href='/';}});
    root.querySelectorAll('[data-back]').forEach(button=>button.onclick=act(async()=>{
      const target=Number(button.dataset.back);
      if(target===1&&s().customerMode==='new')s().customerMode='search';
      if(target===2&&s().unitMode==='new')s().unitMode='select';
      await goStep(target);
    }));
    on('#newCustomer','onclick',()=>{s().customerMode='new';render();});
    on('#newUnit','onclick',()=>{s().unitMode='new';render();});
    on('#customerSearch','onsubmit',act(async()=>{await searchCustomers();}));
    on('#customerCreate','onsubmit',act(async()=>{await session.createCustomer({...s().customerDraft});if(!s().uncertain&&s().customer)await readVehicles();}));
    on('#unitCreate','onsubmit',act(async()=>{await session.createUnit({...s().unitDraft});}));
    on('#jobDetails','onsubmit',act(async()=>{session.touch();await goStep(4);}));
    on('#completeIntake','onsubmit',act(async()=>{await session.finish();}));
    root.querySelectorAll('[data-customer], [data-recover-customer]').forEach(button=>button.onclick=act(()=>selectCustomer(button.dataset.customer||button.dataset.recoverCustomer)));
    root.querySelectorAll('[data-unit]').forEach(button=>button.onclick=act(async()=>{if(s().uncertain)vehicles=recovery;selectUnit(button.dataset.unit);}));
    const bindDraft=(selector,key)=>{
      const form=get(selector);if(!form)return;
      form.addEventListener('input',event=>{
        const input=event.target;if(!input.name)return;
        s()[key][input.name]=input.type==='checkbox'?input.checked:input.value;
        session.touch();
        if(input.name==='billing_same_as_service'){
          const area=get('#billingAddress');area.hidden=input.checked;
          area.querySelectorAll('input').forEach(node=>node.required=!input.checked&&node.name!=='billing_address_line2');
        }
        if(input.name==='checkIn')get('#checkinFields').hidden=!input.checked;
      });
      // Some browser select widgets emit change without input.
      form.addEventListener('change',event=>{const input=event.target;if(input.name){s()[key][input.name]=input.type==='checkbox'?input.checked:input.value;session.touch();}});
    };
    bindDraft('#customerCreate','customerDraft');bindDraft('#unitCreate','unitDraft');bindDraft('#jobDetails','jobDraft');bindDraft('#completeIntake','custodyDraft');
    on('#customerSearch input','oninput',event=>{s().query=event.target.value;session.save();});
    on('#recoverySearch input','oninput',event=>{s().query=event.target.value;session.save();});
    on('#recoverySearch','onsubmit',act(async()=>{recovery=(await read('/api/pos/customers?q='+encodeURIComponent(s().query||s().customerDraft.name||''))).customers;}));
    on('#recover','onclick',act(async()=>{
      const kind=s().uncertain.kind;
      if(kind==='customer')recovery=(await read('/api/pos/customers?q='+encodeURIComponent(s().query||s().customerDraft.name||''))).customers;
      if(kind==='unit')recovery=(await read(`/api/pos/vehicles?customerId=${s().customer.id}`)).vehicles;
      if(kind==='job')recovery=(await read('/api/pos/customers/'+s().customer.id)).customer.workOrders.filter(w=>Number(w.vehicle_id)===s().unit.id&&w.ref_number===s().jobRef);
      if(kind==='assignment'){
        currentAssignment=(await read(`/api/work-orders/${s().job.id}`)).workOrder;
        if(Number(currentAssignment.assigned_user_id)===Number(s().jobDraft.assigned_user_id)){s().assignmentDone=true;s().uncertain=null;message='The requested assignment is saved. Continue to finish intake.';}
      }
      if(kind==='checkin'){
        lot=(await read('/api/shop/queues')).inLot;
        const row=lot.find(x=>Number(x.vehicle_id)===s().unit.id);
        if(row&&Number(row.work_order_id)===s().job.id){s().checkinDone=true;s().onSite=row;s().uncertain=null;message='Check-in is confirmed. Continue to finish intake.';}
        else message=row?'This vehicle is linked to another repair. Open the saved job and review the lot record.':'No check-in is currently confirmed. Open the saved job and review the lot before attempting a check-in.';
      }
      if(['customer','unit','job'].includes(kind)&&!recovery.length)message='No saved match was found. Check the directory or job history before starting another record.';
      session.save();
    }));
    root.querySelectorAll('[data-recover-job]').forEach(button=>button.onclick=act(async()=>{
      const job=recovery.find(row=>Number(row.id)===Number(button.dataset.recoverJob));
      const record=(await read('/api/work-orders/'+job.id)).workOrder;
      if(Number(record.customer_id)!==s().customer.id||Number(record.vehicle_id)!==s().unit.id)throw Error('This repair belongs to a different customer or vehicle.');
      s().job=job;s().step=4;s().uncertain=null;s().assignmentRecord=record;recovery=[];session.save();
      message='Saved repair selected. Review its service details in the job workspace; continue here for the remaining intake steps.';
    }));
    on('#acceptAssignment','onclick',()=>{s().assignmentDone=true;s().uncertain=null;session.save();message='Current saved assignment retained. Continue to finish intake.';render();});
  }
  async function start() {
    try {
      me=await read('/api/me');
      if(!me.user){
        root.innerHTML='<main class="login"><form class="login-card" id="intakeLogin"><h1>Sign in for repair intake</h1><label>Employee username<input name="username" autocomplete="username" required></label><label>Password or employee PIN<input name="password" type="password" autocomplete="current-password" required></label><p id="loginError" role="alert"></p><button class="btn primary">Sign in</button></form></main>';
        root.querySelector('#intakeLogin').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');if(button.disabled)return;button.disabled=true;try{await intakeRequest('/api/login','POST',Object.fromEntries(new FormData(form)));await start();}catch(error){form.querySelector('#loginError').textContent=error.message;button.disabled=false;}};
        return;
      }
      if(!intakeRoles.includes(me.user.role)){root.innerHTML=`<main class="container">${dailyNavigation(me.user.role)}<section class="card"><h1>Repair intake requires service desk access</h1><p>Owners, managers, service writers, and advisors can create repair intake records.</p><a class="btn" href="/">Return to your workspace</a></section></main>`;return;}
      storageKey='ownertracker:intake:'+me.user.id;
      let draft={};try{draft=JSON.parse(sessionStorage.getItem(storageKey)||'{}');}catch{}
      session=new IntakeSession({request:intakeRequest,persist,draft});
      const results=await Promise.all([read('/api/staff'),read('/api/shop/queues')]);
      staff=results[0].users.filter(user=>user.active);lot=results[1].inLot;
      const params=new URLSearchParams(location.search),customerId=params.get('customerId'),vehicleId=params.get('vehicleId');
      if(!s().customer&&!s().uncertain&&/^\d+$/.test(customerId||'')){
        await selectCustomer(Number(customerId));
        if(/^\d+$/.test(vehicleId||'')&&vehicles.some(v=>Number(v.id)===Number(vehicleId)))selectUnit(Number(vehicleId));
      }else if(s().customer)await readVehicles();
      await searchCustomers();
      if(draft.dirty)message='Your unfinished intake has been restored. Review the saved selections before continuing.';
      render();
    }catch(error){root.innerHTML=`<main class="container"><section class="card"><h1>Unable to load repair intake</h1><p role="alert">${esc(error.message)}</p><button id="retryIntake" class="btn">Reload intake</button> <a href="/">Return to workspace</a></section></main>`;root.querySelector('#retryIntake').onclick=start;}
  }
  addEventListener('beforeunload',event=>{if(session?.state.dirty&&!session.state.complete){event.preventDefault();event.returnValue='';}});
  root.addEventListener('click',event=>{
    const link=event.target.closest('a[href]');
    if(!link||!session||event.defaultPrevented||event.ctrlKey||event.metaKey||event.shiftKey||link.target==='_blank')return;
    if(!canLeave()){event.preventDefault();return;}
    clearDraft();
  });
  await start();
}

if (typeof document !== 'undefined' && document.querySelector('#intake')) mountIntake(document.querySelector('#intake'));

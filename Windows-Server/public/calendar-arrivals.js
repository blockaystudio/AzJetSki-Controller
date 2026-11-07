import {dailyNavigation} from './shared-ui.js';

const roles = ['owner','manager','service_writer','advisor'];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const vehicleName = vehicle => [vehicle?.year,vehicle?.make,vehicle?.model].filter(Boolean).join(' ') || vehicle?.unit_label || vehicle?.category || 'Vehicle';
export const calendarCheckinUrl = (jobId, appointmentId) => `/vehicle-checkin.html?workOrderId=${Number(jobId)}&appointmentId=${Number(appointmentId)}`;
export function calendarDate(now = new Date(), offset = 0) {
  const day = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Phoenix',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  return new Date(Date.parse(day+'T12:00:00Z') + offset*86400000).toISOString().slice(0,10);
}
export function calendarSyncLabel(sync = {}) {
  if (!sync.hasGoogleEvent) return 'Saved locally · no confirmed Google event';
  if (sync.status === 'synced') return 'Google sync confirmed';
  return 'Google sync needs review · '+String(sync.status || 'unconfirmed').replaceAll('_',' ');
}

// Linking is idempotent on the server. Never change the selected job while an
// uncertain link is pending; reload the retained appointment context first.
export class CalendarPreparation {
  constructor({request,persist = () => {},draft = {}}) {
    this.request=request;this.persist=persist;this.pending=draft.pending || null;this.busy=false;
  }
  async prepare(context, jobId) {
    if(this.busy || this.pending) return false;
    if(!context.canPrepare || context.linkedJob) throw Error('Reload this appointment’s saved preparation before continuing.');
    const job=context.jobs.find(row=>row.id === Number(jobId));
    if(!job || job.customer_id !== context.customer?.id || !context.vehicles.some(vehicle=>vehicle.id === job.vehicle_id && vehicle.customer_id === job.customer_id)
      || (context.appointment.vehicle_id && context.appointment.vehicle_id !== job.vehicle_id)) throw Error('Choose a saved repair for this exact appointment customer and vehicle.');
    this.pending={appointmentId:context.appointment.id,workOrderId:job.id,customerId:job.customer_id,vehicleId:job.vehicle_id};
    this.persist({pending:this.pending});this.busy=true;
    try {
      const result=await this.request(`/api/shop/schedule/${context.appointment.id}/intake-job`,'POST',{workOrderId:job.id,customerId:job.customer_id,vehicleId:job.vehicle_id});
      if(result?.ok !== true || result.workOrderId !== job.id) throw Error('The saved appointment preparation could not be confirmed.');
      this.pending=null;this.persist({pending:null});
      return calendarCheckinUrl(job.id,context.appointment.id);
    } catch(error) {
      if(error.status && error.status < 500 && error.status !== 408) {this.pending=null;this.persist({pending:null});}
      throw error;
    } finally {this.busy=false;}
  }
  async recover() {
    if(!this.pending || this.busy) return null;
    this.busy=true;
    try {
      const expected=this.pending, context=await this.request(`/api/shop/schedule/${expected.appointmentId}/intake-context`);
      if(context.appointment?.id !== expected.appointmentId) throw Error('The saved appointment could not be confirmed.');
      const linked=context.linkedJob;
      if(linked && (linked.id !== expected.workOrderId || linked.customer_id !== expected.customerId || linked.vehicle_id !== expected.vehicleId)) throw Error('This appointment is prepared for a different repair. Review the saved appointment before continuing.');
      this.pending=null;this.persist({pending:null});
      return {context,checkinUrl:linked && context.canPrepare ? calendarCheckinUrl(linked.id,expected.appointmentId) : null};
    } finally {this.busy=false;}
  }
}

async function request(path,method='GET',body) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
  try {
    const response=await fetch(path,{method,credentials:'same-origin',headers:{'content-type':'application/json'},signal:controller.signal,...(body === undefined ? {} : {body:JSON.stringify(body)})});
    const result=await response.json().catch(()=>null);
    if(!response.ok) throw Object.assign(Error(result?.error || `Request failed (${response.status}).`),{status:response.status});
    if(!result) throw Error('The server response could not be confirmed.');
    return result;
  } finally {clearTimeout(timer);}
}

export function arrivalCard(context) {
  const {appointment:a,customer,vehicle,linkedJob,custody}=context;
  const time=value=>new Intl.DateTimeFormat('en-US',{timeZone:'America/Phoenix',hour:'numeric',minute:'2-digit'}).format(new Date(value));
  const physical=custody?.status === 'in_lot' ? `Physically checked in${custody.lot_location ? ' · '+custody.lot_location : ''}${custody.work_order_id && custody.work_order_id !== linkedJob?.id ? ' · review its saved lot job' : ''}` : 'Not physically checked in';
  return `<article class="card arrival" data-appointment="${a.id}"><h2>${esc(time(a.starts_at))} – ${esc(time(a.ends_at))} · ${esc(a.title)}</h2><dl><dt>Customer</dt><dd>${esc(customer?.name || 'No active customer selected')}${customer?.phone ? ' · '+esc(customer.phone) : ''}</dd><dt>Vehicle</dt><dd>${esc(vehicle ? vehicleName(vehicle) : 'Choose the arriving vehicle during intake')}</dd><dt>Preparation</dt><dd>${linkedJob ? `Saved repair ${esc(linkedJob.ref_number || linkedJob.id)} · ${esc(linkedJob.stage)}` : 'Not prepared'}</dd><dt>Arrival</dt><dd>${esc(physical)}</dd><dt>Calendar</dt><dd>${esc(calendarSyncLabel(context.sync))}</dd></dl>${a.notes ? `<p class="arrival-note">${esc(a.notes)}</p>` : ''}${context.blockedReason ? `<p class="notice">${esc(context.blockedReason)}</p>` : ''}${context.canPrepare && !linkedJob && context.jobs.length ? `<details><summary>Use an existing open repair</summary><p>Choose the exact repair for this appointment. This prepares its link; physical check-in is a separate step.</p><div class="arrival-jobs">${context.jobs.map(job=>`<button class="btn" type="button" data-prepare-job="${job.id}" data-appointment-id="${a.id}"><strong>${esc(job.ref_number || 'Saved repair')} · ${esc(job.stage)}</strong><span>${esc(vehicleName(context.vehicles.find(v=>v.id === job.vehicle_id)))}${job.complaint ? ' · '+esc(job.complaint) : ''}</span></button>`).join('')}</div></details>` : ''}<div class="arrival-actions">${linkedJob ? `<a class="btn" href="${esc(context.jobUrl)}">Open saved repair</a>${context.canPrepare && context.checkinUrl ? `<a class="btn primary" href="${esc(context.checkinUrl)}">${custody?.status === 'in_lot' ? 'Review physical check-in' : 'Check in arriving vehicle'}</a>` : ''}` : context.canPrepare ? `<a class="btn primary" href="${esc(context.intakeUrl)}">Prepare new repair intake</a>` : ''}<a class="btn" href="/shop-ops.html?tab=schedule">Open calendar</a></div></article>`;
}

export async function mountCalendarArrivals(root) {
  let user,date=new URLSearchParams(location.search).get('date') || calendarDate(),appointments=[],message='',busy=false,preparation;
  const render=()=>{
    root.innerHTML=`<header class="topbar"><div class="brand"><img class="header-logo" src="/brand-logo.png" alt="AZ Jet Ski"><span>Scheduled arrivals</span></div><a class="btn" href="/shop-ops.html?tab=schedule">Calendar</a></header><main class="container">${dailyNavigation(user.role,'schedule')}<section class="card"><div class="arrivals-head"><h1>Prepare scheduled arrivals</h1><a class="btn" href="/intake.html">Walk-in repair intake</a></div><p>Saved Owner Tracker appointments, shown in Phoenix time. Prepare the correct customer, vehicle, and repair before arrival. Physical check-in requires confirming that the vehicle is here.</p><form class="arrivals-date" id="arrivalDate"><label class="field">Appointment date<input type="date" name="date" value="${esc(date)}" required></label><button class="btn" ${busy?'disabled':''}>Show appointments</button><button class="btn" type="button" data-date="${calendarDate()}" ${busy?'disabled':''}>Today</button><button class="btn" type="button" data-date="${calendarDate(new Date(),1)}" ${busy?'disabled':''}>Tomorrow</button></form><p class="muted">Google events appear here only when they have a saved Owner Tracker appointment. Local appointments remain local until staff explicitly sync them.</p>${message ? `<p role="alert">${esc(message)}</p>` : ''}${preparation.pending ? '<p class="notice">An appointment preparation did not return a confirmed result. Review its saved status before choosing another repair.</p><button class="btn" id="recoverPreparation">Review saved preparation</button>' : ''}</section><section class="arrival-list" aria-label="Scheduled appointments" ${busy?'aria-busy="true"':''}>${appointments.map(arrivalCard).join('') || '<p class="empty">No scheduled appointments on this Phoenix calendar date.</p>'}</section></main>`;
    root.querySelector('#arrivalDate').onsubmit=event=>{event.preventDefault();load(new FormData(event.currentTarget).get('date'));};
    root.querySelectorAll('[data-date]').forEach(button=>button.onclick=()=>load(button.dataset.date));
    root.querySelectorAll('[data-prepare-job]').forEach(button=>{
      button.disabled=busy || !!preparation.pending;
      button.onclick=async()=>{
        if(busy)return;busy=true;message='';render();
        try {
          const context=appointments.find(row=>row.appointment.id === Number(button.dataset.appointmentId));
          const target=await preparation.prepare(context,Number(button.dataset.prepareJob));
          if(target)location.assign(target);
        }catch(error){message=error.message;}finally{busy=false;render();}
      };
    });
    const recover=root.querySelector('#recoverPreparation');
    if(recover) {recover.disabled=busy;recover.onclick=async()=>{if(busy)return;busy=true;message='';render();try{const result=await preparation.recover();if(result?.checkinUrl){location.assign(result.checkinUrl);return;}message='No saved preparation was found. Review the appointment and choose its repair again.';await refresh();}catch(error){message=error.message;}finally{busy=false;render();}};}
  };
  const refresh=async()=>{appointments=(await request('/api/shop/calendar-arrivals?date='+encodeURIComponent(date))).appointments;};
  const load=async next=>{if(busy)return;busy=true;message='';date=String(next);render();try{await refresh();history.replaceState(null,'','/calendar-arrivals.html?date='+encodeURIComponent(date));}catch(error){appointments=[];message=error.message;}finally{busy=false;render();}};
  try {
    user=(await request('/api/me')).user;
    if(!user){root.innerHTML='<main class="container"><section class="card"><h1>Sign in to prepare scheduled arrivals</h1><p>Use your employee account to review customer appointments.</p><a class="btn primary" href="/">Sign in</a></section></main>';return;}
    if(!roles.includes(user.role)){root.innerHTML=`<main class="container">${dailyNavigation(user.role)}<section class="card"><h1>Scheduled arrivals require service desk access</h1><a class="btn" href="/">Return to workspace</a></section></main>`;return;}
    const storageKey='ownertracker:calendar-preparation:'+user.id;
    let draft={};try{draft=JSON.parse(sessionStorage.getItem(storageKey) || '{}');}catch{}
    preparation=new CalendarPreparation({request,draft,persist:value=>{try{value.pending ? sessionStorage.setItem(storageKey,JSON.stringify(value)) : sessionStorage.removeItem(storageKey);}catch{}}});
    await refresh();render();
  }catch(error){root.innerHTML=`<main class="container"><section class="card"><h1>Unable to load scheduled arrivals</h1><p role="alert">${esc(error.message)}</p><a class="btn" href="/calendar-arrivals.html">Reload arrivals</a> <a href="/shop-ops.html?tab=schedule">Open calendar</a></section></main>`;}
}

if(typeof document !== 'undefined' && document.querySelector('#calendarArrivals')) mountCalendarArrivals(document.querySelector('#calendarArrivals'));

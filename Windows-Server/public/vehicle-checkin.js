import {login,safe} from './mobile-base.js';
import {dailyNavigation} from './shared-ui.js';

export const checkinDraftValues = row => ({lotLocation:row?.lot_location||'',keysTag:row?.keys_tag||'',conditionNotes:row?.condition_notes||'',checklist:{...row?.checklist}});
export const checkinCompletionReady = (values,photoCount,checklistKeys) => ['Dirt lot','Front lot'].includes(values.lotLocation) && !!values.keysTag.trim() && !!values.conditionNotes.trim() && photoCount>=2 && checklistKeys.every(key=>values.checklist[key]===true);

async function request(path,method='GET',body) {
  const response=await fetch(path,{method,credentials:'same-origin',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(data.error||`HTTP ${response.status}`),{status:response.status});
  return data;
}
const uuid=()=>crypto.randomUUID();
const unitName=vehicle=>[vehicle.year,vehicle.make,vehicle.model].filter(Boolean).join(' ')||'Vehicle';
const jobUrl=id=>`/?view=workorders&workOrderId=${id}&tab=overview`;

async function photoQueue() {
  const database=await new Promise((resolve,reject)=>{
    const open=indexedDB.open('ownertracker-checkin-photos',1);
    open.onupgradeneeded=()=>open.result.createObjectStore('photos',{keyPath:'requestKey'});
    open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(new Error('Photo storage is unavailable on this phone'));
  });
  const operation=(mode,action)=>new Promise((resolve,reject)=>{
    const tx=database.transaction('photos',mode),result=action(tx.objectStore('photos'));
    tx.oncomplete=()=>resolve(result.result);tx.onerror=()=>reject(new Error('Photo could not be retained on this phone'));tx.onabort=tx.onerror;
  });
  return {put:photo=>operation('readwrite',store=>store.put(photo)),remove:key=>operation('readwrite',store=>store.delete(key)),list:async scope=>(await operation('readonly',store=>store.getAll())).filter(photo=>photo.scope===scope)};
}
async function preparePhoto(file) {
  if(file.size>30_000_000)throw new Error('Choose a photo smaller than 30 MB');
  const url=URL.createObjectURL(file),image=new Image();
  try {
    await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('This image format cannot be opened. Take a photo with the camera or choose JPEG, PNG or WebP.'));image.src=url;});
    const scale=Math.min(1,1600/Math.max(image.naturalWidth,image.naturalHeight)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
    canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    return {filename:file.name.replace(/\.[^.]+$/,'')+'.jpg',mimeType:'image/jpeg',dataBase64:canvas.toDataURL('image/jpeg',.84).split(',')[1]};
  } finally {URL.revokeObjectURL(url);}
}

async function mount(user) {
  const root=document.querySelector('#mobile-app'),params=new URLSearchParams(location.search),workOrderId=Number(params.get('workOrderId'));
  const shell=body=>{root.innerHTML=`<main class="checkin-shell"><header class="topbar"><strong>Owner Tracker</strong><span class="user-chip">${safe(user.displayName||user.username)}</span></header>${dailyNavigation(user.role)}${body}</main>`;};
  if(!Number.isSafeInteger(workOrderId)||workOrderId<1){shell('<h1>Vehicle check-in</h1><p>Open a saved repair to start its vehicle check-in.</p><a class="btn primary" href="/?view=workorders">Choose a repair</a>');return;}
  let context=await request(`/api/vehicle-checkins/context?workOrderId=${workOrderId}`);
  const scope=`${user.id}:${workOrderId}`,storageKey=`ownertracker.checkin.${scope}`;
  let local=null;try{local=JSON.parse(localStorage.getItem(storageKey)||'null');}catch{}
  let storageAvailable=true;
  let checkin=context.checkin;
  const createKey=local?.createKey||uuid();
  const persist=data=>{try{localStorage.setItem(storageKey,JSON.stringify(data));return true;}catch{storageAvailable=false;return false;}};
  if(!checkin){persist({...local,createKey});checkin=(await request('/api/vehicle-checkins','POST',{workOrderId,customerId:context.customer.id,vehicleId:context.vehicle.id,requestKey:createKey})).checkin;}
  let values=checkinDraftValues(checkin),restorable=local?.recoveryValues||null,queue=null,pending=[],busy=false,dirty=false,conflict=false,saveTimer=null,saveChain=Promise.resolve(),completeKey=local?.completeKey||null;
  if(checkin.status==='draft'&&local?.values){
    if(local.baseVersion===checkin.version){values=local.values;dirty=JSON.stringify(values)!==JSON.stringify(checkinDraftValues(checkin));}
    else if(!restorable&&JSON.stringify(local.values)!==JSON.stringify(checkinDraftValues(checkin)))restorable=local.values;
  }
  try{queue=await photoQueue();pending=await queue.list(scope);}catch(error){storageAvailable=false;}
  const persistDraft=()=>persist({createKey,values,baseVersion:checkin.version,completeKey,recoveryValues:restorable});
  const notice=(message,isError=false)=>{const element=document.querySelector('#checkinStatus');if(!element)return;element.textContent=message;element.setAttribute('role',isError?'alert':'status');};
  const photos=()=>{
    const saved=checkin.photos.map(photo=>`<figure><img src="${safe(photo.url)}" alt="${safe(photo.caption||'Before-service condition photo')}"><figcaption>${safe(photo.caption||photo.original_name)}<span class="photo-state">Saved to repair</span></figcaption></figure>`).join('');
    const waiting=pending.map(photo=>`<figure><img src="data:${safe(photo.mimeType)};base64,${photo.dataBase64}" alt="${safe(photo.caption||'Before-service photo waiting to upload')}"><figcaption>${safe(photo.caption||photo.filename)}<span class="photo-state">Retained on this phone · waiting to upload</span></figcaption></figure>`).join('');
    document.querySelector('#checkinPhotos').innerHTML=saved+waiting;
    document.querySelector('#photoCount').textContent=`${checkin.photos.length} saved · ${pending.length} waiting. At least 2 saved photos required.`;
  };
  const capture=()=>{
    const form=document.querySelector('#checkinForm');if(!form)return;
    values={lotLocation:form.elements.lotLocation.value,keysTag:form.elements.keysTag.value,conditionNotes:form.elements.conditionNotes.value,checklist:Object.fromEntries(context.checklist.map(({key})=>[key,form.elements[key].checked]))};
  };
  const paintValues=()=>{
    const form=document.querySelector('#checkinForm');if(!form)return;
    form.elements.lotLocation.value=values.lotLocation;form.elements.keysTag.value=values.keysTag;form.elements.conditionNotes.value=values.conditionNotes;
    for(const {key} of context.checklist)form.elements[key].checked=values.checklist[key]===true;
  };
  const mergePhotos=next=>[...new Map([...checkin.photos,...next.photos].map(photo=>[photo.id,photo])).values()];
  const savedCheckin=next=>{checkin={...next,photos:mergePhotos(next)};persistDraft();};
  const save=()=>{
    clearTimeout(saveTimer);
    saveChain=saveChain.catch(()=>{}).then(async()=>{
      if(conflict)throw new Error('Check-in changed on another device. Review the saved draft before continuing');
      if(!dirty||checkin.status!=='draft')return;
      const snapshot=JSON.parse(JSON.stringify(values));
      try{
        const result=await request(`/api/vehicle-checkins/${checkin.id}`,'PATCH',{...snapshot,version:checkin.version});
        savedCheckin(result.checkin);dirty=JSON.stringify(snapshot)!==JSON.stringify(values);persistDraft();
        notice(dirty?'New edits are retained on this phone.':'Draft saved to this repair. Another staff member can continue it.');
      }catch(error){if(error.status===409){conflict=true;document.querySelector('#reloadDraft').hidden=false;}notice(`${error.message}. ${storageAvailable?'Your edits are retained on this phone.':'Keep this page open to preserve your edits.'}`,true);throw error;}
    });
    return saveChain;
  };
  const upload=async()=>{
    await saveChain;
    if(!queue||!pending.length)return;
    for(const photo of [...pending]) {
      const {scope:unused,...body}=photo;
      const result=await request(`/api/vehicle-checkins/${checkin.id}/photos`,'POST',body);
      // Photo attachment is independent of text editing. Keep our text version
      // so another device's edits still cause an explicit draft conflict.
      checkin={...checkin,photos:mergePhotos(result.checkin)};persistDraft();await queue.remove(photo.requestKey);pending=pending.filter(item=>item.requestKey!==photo.requestKey);photos();
    }
  };
  const run=async action=>{
    if(busy)return;busy=true;
    clearTimeout(saveTimer);
    const controls=[...document.querySelectorAll('#checkinForm input,#checkinForm select,#checkinForm textarea,#checkinForm button,[data-mutation]')].map(element=>({element,disabled:element.disabled}));
    for(const {element} of controls)element.disabled=true;
    try{await action();}catch(error){notice(error.message,true);}finally{busy=false;for(const {element,disabled} of controls)if(element.isConnected)element.disabled=disabled;}
  };
  const identity=()=>{const retained=checkin.status==='completed',customerName=retained?(context.job.customer_name||context.customer.name):context.customer.name,unit=retained?(context.job.unit_label||[context.job.year,context.job.make,context.job.model].filter(Boolean).join(' ')||unitName(context.vehicle)):unitName(context.vehicle),vin=retained?(context.job.serial||context.vehicle.vin||context.vehicle.hin):(context.vehicle.vin||context.vehicle.hin);return `<section class="card"><h2>1. Confirm customer, unit and repair</h2><dl class="checkin-identity"><dt>Customer</dt><dd>${safe(customerName)}</dd><dt>Unit</dt><dd>${safe(unit)}</dd><dt>VIN</dt><dd>${safe(vin||'No VIN saved — confirm the exact unit with staff')}</dd><dt>Repair</dt><dd>${safe(context.job.ref_number||context.job.id)} · ${safe(context.job.complaint||'')}</dd></dl></section>`;};
  const completeView=()=>{
    shell(`<h1>Vehicle check-in complete</h1><p class="checkin-complete">Arrival recorded at ${safe(checkin.lot_location)}. Before-service notes, checklist and photos are retained with this repair.</p>${identity()}<section class="card"><h2>Retained check-in</h2><p>Completed ${safe(checkin.completed_at)} · Key / lanyard: ${safe(checkin.keys_tag)}</p><p style="white-space:pre-wrap">${safe(checkin.condition_notes)}</p><ul>${context.checklist.map(({label})=>`<li>${safe(label)}</li>`).join('')}</ul><div id="checkinPhotos" class="checkin-photos"></div><p id="photoCount" class="muted"></p></section><div class="checkin-actions"><a class="btn primary" href="${jobUrl(workOrderId)}">Open repair</a><a class="btn" href="/shop-ops.html?tab=lot">Lot &amp; pickup</a></div>`);
    photos();
  };
  if(checkin.status==='completed'){try{localStorage.removeItem(storageKey);}catch{};completeView();return;}
  shell(`<h1>Vehicle check-in</h1><p class="muted">Use this phone to document arrival before service. Save a draft at any point; complete after the walk-around and photos.</p><ol class="progress-steps"><li>Confirm identity</li><li>Record condition</li><li>Take photos</li><li>Complete</li></ol><p id="checkinStatus" class="checkin-status" role="status"></p><div class="checkin-actions"><a class="btn" href="${jobUrl(workOrderId)}">Back to repair</a><button class="btn" id="reloadDraft" ${restorable?'':'hidden'}>Review saved draft</button></div>${restorable?'<section class="card" id="localRecovery"><h2>Edits from this phone</h2><p>The saved draft changed since this phone last edited it. Review the current saved values below before restoring local edits.</p><button class="btn" id="restoreLocal">Restore this phone’s edits for review</button> <button class="btn" id="keepSaved">Keep the displayed draft</button></section>':''}${identity()}<form id="checkinForm"><section class="card"><h2>2. Parking, keys and condition</h2>${context.custody?.status==='in_lot'?'<p class="notice">This unit is already on site. Completing this record documents its existing arrival and retains the original arrival time.</p>':''}<label class="field">Parking location<select name="lotLocation" required><option value="">Choose a lot</option>${context.parkingLocations.map(location=>`<option>${safe(location)}</option>`).join('')}</select></label><label class="field">Key / lanyard tag, or “No keys”<input name="keysTag" maxlength="80" required placeholder="K-23 / No keys"></label><label class="field">Before-service condition and belongings<textarea name="conditionNotes" maxlength="4000" required placeholder="Record scratches, damage, fuel / battery condition if checked, accessories and loose belongings. If none: No visible damage seen; no belongings left."></textarea></label><fieldset><legend>Walk-around checklist</legend>${context.checklist.map(({key,label})=>`<label class="check-row"><input type="checkbox" name="${safe(key)}"> <span>${safe(label)}</span></label>`).join('')}</fieldset></section><section class="card"><h2>3. Before-service photos</h2><p class="muted">Take at least 2 photos: front and rear / opposite side. Add close-ups of existing damage and accessories. Photos stay internal to the repair.</p><label class="field">Photo caption<input id="photoCaption" maxlength="500" placeholder="Front / rear / existing damage"></label><label class="field">Take or choose photos<input id="checkinCamera" type="file" accept="image/*" capture="environment" multiple ${queue?'':'disabled'}></label><p id="photoCount" class="muted"></p><div id="checkinPhotos" class="checkin-photos"></div><button class="btn" id="retryPhotos" type="button" data-mutation>Upload waiting photos</button></section><section class="card"><h2>4. Save or complete arrival</h2><p class="muted">A saved draft does not check the unit into the lot. Complete check-in records custody after every item and at least 2 photos are saved.</p><div class="checkin-actions"><button class="btn" id="saveDraft" type="button" data-mutation>Save draft</button><button class="btn primary" type="submit" data-mutation>Complete check-in</button></div></section></form>`);
  paintValues();photos();
  if(!storageAvailable)notice('Persistent phone storage is unavailable. Save your draft to the server before leaving; use a browser with phone storage available to capture photos.',true);
  else if(pending.length)notice('Photos from this phone are waiting to upload. Use Upload waiting photos to retry safely.');
  else if(dirty)notice('Unsaved edits restored from this phone. Save draft to retain them with the repair.');
  document.querySelector('#checkinForm').addEventListener('input',event=>{
    if(!event.target.name)return;capture();dirty=true;persistDraft();clearTimeout(saveTimer);saveTimer=setTimeout(()=>save().catch(()=>{}),900);
  });
  document.querySelector('#saveDraft').onclick=()=>run(async()=>{capture();await save();await upload();notice('Draft and photos saved to this repair.');});
  document.querySelector('#retryPhotos').onclick=()=>run(async()=>{await upload();notice('All waiting photos are saved to this repair.');});
  document.querySelector('#reloadDraft').onclick=()=>run(async()=>{
    capture();restorable ||= JSON.parse(JSON.stringify(values));
    const result=await request(`/api/vehicle-checkins/${checkin.id}`);checkin=result.checkin;conflict=false;
    if(checkin.status==='completed'){completeView();return;}
    values=checkinDraftValues(checkin);dirty=false;paintValues();photos();
    let panel=document.querySelector('#localRecovery');
    if(!panel){panel=document.createElement('section');panel.className='card';panel.id='localRecovery';document.querySelector('#checkinForm').before(panel);}
    panel.innerHTML='<h2>Saved draft loaded</h2><p>Review the saved values. Your earlier edits remain available on this phone until you save a draft.</p><button class="btn" id="restoreLocal">Restore this phone’s edits for review</button> <button class="btn" id="keepSaved">Keep the displayed draft</button>';persistDraft();bindRestore();notice('Saved draft loaded. Review before saving or completing.');
  });
  const bindRestore=()=>{const button=document.querySelector('#restoreLocal');if(button)button.onclick=()=>{if(!restorable)return;values=restorable;restorable=null;dirty=true;conflict=false;paintValues();persistDraft();document.querySelector('#localRecovery').remove();notice('Phone edits restored for review. Save draft when ready.');};const keep=document.querySelector('#keepSaved');if(keep)keep.onclick=()=>{restorable=null;conflict=false;persistDraft();document.querySelector('#localRecovery').remove();notice('Displayed draft kept. Continue the checklist when ready.');};};bindRestore();
  document.querySelector('#checkinCamera').onchange=event=>run(async()=>{
    const files=[...event.target.files];event.target.value='';
    if(checkin.photos.length+pending.length+files.length>20)throw new Error('A check-in can hold up to 20 photos');
    for(const file of files){
      const photo={...await preparePhoto(file),requestKey:uuid(),caption:document.querySelector('#photoCaption').value.trim(),scope};
      await queue.put(photo);pending.push(photo);photos();notice('Photo retained on this phone. Uploading…');
    }
    await upload();notice('Before-service photos saved to this repair.');
  });
  document.querySelector('#checkinForm').onsubmit=event=>{event.preventDefault();run(async()=>{
    if(conflict||restorable&&document.querySelector('#localRecovery'))throw new Error('Review the current saved draft and local edits before completing');
    capture();await save();await upload();
    if(!checkinCompletionReady(values,checkin.photos.length,context.checklist.map(item=>item.key)))throw new Error('Choose a lot, record keys and condition, check every item and save at least 2 before-service photos');
    completeKey ||= uuid();persistDraft();
    const result=await request(`/api/vehicle-checkins/${checkin.id}/complete`,'POST',{version:checkin.version,requestKey:completeKey});
    checkin=result.checkin;dirty=false;try{localStorage.removeItem(storageKey);}catch{};completeView();
  });};
  window.addEventListener('beforeunload',event=>{if((dirty&&!storageAvailable)||busy){event.preventDefault();event.returnValue='';}});
}
if(typeof document!=='undefined')login('Vehicle check-in',user=>mount(user).catch(error=>{document.querySelector('#mobile-app').innerHTML=`<main class="checkin-shell"><h1>Vehicle check-in</h1><p role="alert">${safe(error.message)}</p><a class="btn" href="/?view=workorders">Open repairs</a> <button class="btn" onclick="location.reload()">Retry</button></main>`;})).catch(error=>{document.querySelector('#mobile-app').textContent=error.message;});

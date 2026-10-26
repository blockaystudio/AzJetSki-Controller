// Shared daily navigation, accessible form labels and accurate operation outcomes.
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function dailyNavigation(role,active=''){
 const staff=['owner','manager','service_writer','advisor'].includes(role),manager=['owner','manager'].includes(role);
 const items=role==='technician'?[['mywork','My Jobs','/?view=mywork'],['workorders','Jobs','/?view=workorders']]:[['dashboard','Today','/'],['workorders','Jobs','/?view=workorders'],...(staff?[['customers','Customers & Units','/?view=customers']]:[]),...(['owner','manager','service_writer','advisor','parts'].includes(role)?[['parts','Parts & Inventory','/shop-ops.html?tab=stock']]:[]),...(staff?[['payments','Payments','/?view=payments'],['schedule','Schedule','/shop-ops.html?tab=schedule']]:[])];
 const secondary=[...(staff?[['Units','/?view=vehicles'],['Invoices & Documents','/billing.html'],['Printer & Tax','/?view=hardware']]:[]),...(['owner','manager','service_writer','advisor','parts'].includes(role)?[['Supplier Carts','/?view=procurement'],['Lot & Pickup','/shop-ops.html?tab=lot'],['Counter Sales & Special Orders','/shop-ops.html?tab=retail']]:[]),...(['owner','manager','advisor','parts'].includes(role)?[['Purchasing & Receiving','/shop-management.html']]:[]),...(manager?[['Accounting & Returns','/accounting.html'],['Reports','/shop-reports.html'],['Employees','/?view=employees'],['Settings & Connections','/shop-management.html?tab=connections'],['Setup & Launch','/launch.html']]:[]),...(role==='owner'?[['Security & Recovery','/?view=security']]:[])];
 return `<nav class="daily-nav" aria-label="Daily shop navigation">${items.map(([id,label,href])=>`<a href="${href}" ${id===active?'aria-current="page"':''}>${label}</a>`).join('')}${secondary.length?`<details class="secondary-nav"><summary>More & Settings</summary><div class="secondary-links">${secondary.map(([label,href])=>`<a href="${href}">${label}</a>`).join('')}</div></details>`:''}</nav>`;
}
export function notificationOutcome(result){
 const n=result?.notification??result;
 if(!n?.status)return 'Update saved. No customer notification was requested.';
 const labels={draft:'Notification draft saved; review and queue it in Communications.',queued:'Notification queued; delivery has not been confirmed.',provider_accepted:'Notification accepted by the email provider.',delivered:'Notification delivered.',delivery_unknown:'Notification delivery is unknown. Review Communications before retrying.',provider_failed:'Notification failed. Review Communications for the error.',retry_wait:'Notification waiting for a delivery retry.',consent_required:'Notification blocked: record customer service-email consent.',needs_review:'Notification needs review in Communications.',not_queued:'Notification was not queued. Review Communications.',waiting_provider:'Notification waiting for email provider setup.',cancelled:'Notification cancelled.'};
 return labels[n.status]||`Notification status: ${String(n.status).replaceAll('_',' ')}. Review Communications.`;
}
export function calendarOutcome(result){
 if(result?.synced===true&&['synced','cancelled'].includes(result.status))return result.status==='cancelled'?'Google Calendar cancellation confirmed.':'Google Calendar sync confirmed.';
 const labels={local_only:'Saved locally. Google Calendar is not connected; use Calendar File to export.',conflict:'Calendar conflict: review the local and Google versions in Schedule Changes.',update_pending:'Saved locally; Google Calendar update is pending. Retry after reviewing the appointment.',cancel_pending:'Cancelled locally; Google Calendar cancellation is pending.',error:'Calendar sync failed. Review Schedule Changes before retrying.'};
 return labels[result?.status]||result?.notice||`Calendar status: ${String(result?.status||'unconfirmed').replaceAll('_',' ')}. Review before retrying.`;
}
export function supplierOutcome(results=[]){
 if(!results.length)return 'No active parts require a supplier lookup.';
 const ok=results.filter(x=>x.status==='ok'),failed=results.filter(x=>['error','failed'].includes(x.status)),unconfigured=results.filter(x=>x.status==='not_configured'),other=results.length-ok.length-failed.length-unconfigured.length;
 return [ok.length?`${ok.length} job(s) refreshed; ${ok.reduce((n,x)=>n+Number(x.offers||0),0)} offer(s) returned.`:'',failed.length?`${failed.length} lookup(s) failed. Review supplier setup or add a manual offer.`:'',unconfigured.length?`${unconfigured.length} lookup(s) unavailable: supplier connector not configured. Manual offers remain available.`:'',other?`${other} lookup(s) have an unconfirmed outcome; review before retrying.`:''].filter(Boolean).join(' ');
}
let labelCounter=0;
export function enhanceAccessibility(scope=document){
 for(const label of scope.querySelectorAll('label:not([for])')){if(label.querySelector('input,select,textarea'))continue;const field=label.parentElement?.querySelector('input,select,textarea');if(field){field.id ||= `shop-field-${++labelCounter}`;label.htmlFor=field.id;}}
 for(const container of scope.querySelectorAll('.line-table,.ops-table,.accounting-table,.scroll')){if(!container.hasAttribute('tabindex')){container.tabIndex=0;container.setAttribute('role','region');container.setAttribute('aria-label','Scrollable records');}}
}
if(typeof document!=='undefined'){
 const pending=()=>enhanceAccessibility();pending();
 new MutationObserver(pending).observe(document.body,{childList:true,subtree:true});
 const holder=document.querySelector('#shared-navigation');
 if(holder)fetch('/api/me').then(r=>r.json()).then(r=>{if(r.user)holder.innerHTML=dailyNavigation(r.user.role,holder.dataset.active||'');}).catch(()=>{});
}

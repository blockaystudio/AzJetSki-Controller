import {businessDayRange} from './accounting.mjs';
import {enqueueCustomerMessage} from './shop-management.mjs';

const managers=new Set(['owner','manager']);
const text=(value,max=500)=>String(value??'').trim().slice(0,max);
const has=(db,table)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const fail=(status,message)=>{const error=new Error(message);error.status=status;throw error;};
const phoenixDate=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Phoenix',year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
function timestamp(value){
  if(!value)return null;
  const raw=String(value);
  const normalized=/^\d{4}-\d{2}-\d{2}$/.test(raw)?`${raw}T07:00:00Z`:/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)?raw.replace(' ','T')+'Z':raw;
  const parsed=Date.parse(normalized);return Number.isFinite(parsed)?parsed:null;
}
function rangeFor(from,to){
  const first=businessDayRange(from),last=businessDayRange(to);
  if(Date.parse(first.startsAt)>Date.parse(last.startsAt))fail(400,'Start date must not follow end date');
  if(Date.parse(last.endsAt)-Date.parse(first.startsAt)>366*86400000)fail(400,'Report range must be at most 366 Phoenix business days');
  return {from,to,timeZone:'America/Phoenix',startsAt:first.startsAt,endsAt:last.endsAt};
}
const inRange=(value,range)=>{const time=timestamp(value);return time!==null&&time>=Date.parse(range.startsAt)&&time<Date.parse(range.endsAt);};
const ageDays=(value,now)=>{const time=timestamp(value);return time===null?null:Math.max(0,Math.floor((now-time)/86400000));};

function cashflow(db,range){
  const methods=Object.fromEntries(['cash','card_dejavoo','zelle'].map(method=>[method,{receivedCents:0,refundCents:0,netCents:0,count:0}]));
  const scopes={repair:{receivedCents:0,refundCents:0,netCents:0,count:0},retail:{receivedCents:0,refundCents:0,netCents:0,count:0}};
  let pendingCents=0,voidedCents=0,excludedCount=0;
  for(const [scope,table] of [['repair','pos_payments'],['retail','retail_payments']]){
    if(!has(db,table))continue;
    const effective=has(db,'finance_events')?`COALESCE((SELECT MIN(e.created_at) FROM finance_events e WHERE e.scope='${scope}' AND e.payment_id=p.id AND e.operation='confirm'),p.created_at)`:'p.created_at';
    const rows=db.prepare(`SELECT p.*,${effective} effective_at FROM ${table} p WHERE datetime(${effective})>=datetime(?) AND datetime(${effective})<datetime(?)`).all(range.startsAt,range.endsAt);
    for(const row of rows){
      if(row.voided_at){voidedCents+=row.amount_cents;excludedCount++;continue;}
      if(row.status!=='confirmed'){if(row.direction==='payment')pendingCents+=row.amount_cents;excludedCount++;continue;}
      if(!methods[row.method])continue;
      const field=row.direction==='refund'?'refundCents':'receivedCents';
      methods[row.method][field]+=row.amount_cents;methods[row.method].count++;
      scopes[scope][field]+=row.amount_cents;scopes[scope].count++;
    }
  }
  for(const item of [...Object.values(methods),...Object.values(scopes)])item.netCents=item.receivedCents-item.refundCents;
  const receivedCents=Object.values(methods).reduce((n,item)=>n+item.receivedCents,0),refundCents=Object.values(methods).reduce((n,item)=>n+item.refundCents,0);
  const credits=has(db,'accounting_credits')?db.prepare('SELECT COALESCE(SUM(subtotal_cents),0) subtotal,COALESCE(SUM(tax_cents),0) tax,COALESCE(SUM(total_cents),0) total,COUNT(*) count FROM accounting_credits WHERE datetime(created_at)>=datetime(?) AND datetime(created_at)<datetime(?)').get(range.startsAt,range.endsAt):{subtotal:0,tax:0,total:0,count:0};
  return {receivedCents,refundCents,netConfirmedReceiptsCents:receivedCents-refundCents,pendingCents,voidedCents,excludedCount,methods,scopes,creditNotes:{subtotalCents:credits.subtotal,taxCents:credits.tax,totalCents:credits.total,count:credits.count},basis:'Staff-verified receipts and refunds on recording/bank-confirmation date, including deposits once. Pending and voided entries are excluded. This is cashflow, not recognized sales revenue, processor settlement or an accounting close.'};
}

function retailPartSpread(db,range){
  if(!has(db,'retail_special_lines'))return {knownCostSalesCents:0,knownRecordedCostCents:0,knownCostLineSpreadCents:null,knownCostLineCount:0,missingCostLineCount:0};
  const hasVoid=db.prepare('PRAGMA table_info(retail_special_orders)').all().some(c=>c.name==='invoice_voided_at');
  const lines=db.prepare(`SELECT l.*,r.id order_id FROM retail_special_lines l JOIN retail_special_orders r ON r.id=l.retail_order_id
    WHERE r.invoice_issued_at IS NOT NULL ${hasVoid?'AND r.invoice_voided_at IS NULL':''} AND datetime(r.invoice_issued_at)>=datetime(?) AND datetime(r.invoice_issued_at)<datetime(?)`).all(range.startsAt,range.endsAt);
  let knownCostSalesCents=0,knownRecordedCostCents=0,knownCostLineCount=0,missingCostLineCount=0;
  const affectedOrders=new Set();
  for(const line of lines){
    if(!Number.isSafeInteger(line.unit_cost_cents)||line.unit_cost_cents<=0||!Number.isSafeInteger(line.unit_price_cents)||!Number.isSafeInteger(line.quantity)||line.quantity<=0){missingCostLineCount++;continue;}
    knownCostSalesCents+=line.quantity*line.unit_price_cents;knownRecordedCostCents+=line.quantity*line.unit_cost_cents;knownCostLineCount++;
    if(has(db,'accounting_credits')&&db.prepare("SELECT 1 FROM accounting_credits WHERE scope='retail' AND entity_id=? LIMIT 1").get(line.order_id))affectedOrders.add(line.order_id);
  }
  return {knownCostSalesCents,knownRecordedCostCents,knownCostLineSpreadCents:knownCostLineCount?knownCostSalesCents-knownRecordedCostCents:null,knownCostLineCount,missingCostLineCount,ordersWithCredits:affectedOrders.size,
    basis:'Quoted retail part price less explicitly recorded current unit cost, before tax, on invoices issued in the period. Missing/zero costs are not treated as free stock. This is not realized gross profit: credits, returns, freight, overhead and settlement are not allocated. Repair cost fields lack a consistent unit/extended-cost basis and are excluded.'};
}

function operationalQueues(db,now){
  const hasAdvisor=db.prepare('PRAGMA table_info(work_orders)').all().some(c=>c.name==='service_advisor_id');
  const rows=db.prepare(`SELECT w.*,${hasAdvisor?'u.display_name':'NULL'} advisor_name FROM work_orders w ${hasAdvisor?'LEFT JOIN users u ON u.id=w.service_advisor_id':''} WHERE w.stage NOT IN ('Closed','Picked Up','Declined') ORDER BY w.id`).all();
  const quotes=[],ready=[],overdue=[];
  for(const wo of rows){
    const common={id:wo.id,refNumber:wo.ref_number,customerId:wo.customer_id,customerName:wo.customer_name,stage:wo.stage,advisorName:wo.advisor_name||null,balanceCents:Math.round(Number(wo.balance||0)*100)};
    if(wo.stage==='Awaiting Approval'){
      const latest=has(db,'approvals')?db.prepare('SELECT created_at FROM approvals WHERE work_order_id=? ORDER BY id DESC LIMIT 1').get(wo.id):null;
      const since=latest?.created_at||wo.date_opened||wo.created_at;
      quotes.push({...common,since,ageDays:ageDays(since,now),ageBasis:latest?'Latest authorization request':'Job opening date'});
    }
    if(wo.stage==='Ready'){
      const marked=db.prepare("SELECT created_at FROM audit_log WHERE work_order_id=? AND action LIKE 'Marked ready%' ORDER BY id DESC LIMIT 1").get(wo.id);
      const update=has(db,'work_order_updates')?db.prepare("SELECT created_at FROM work_order_updates WHERE work_order_id=? AND stage='Ready' ORDER BY id DESC LIMIT 1").get(wo.id):null;
      const since=marked?.created_at||update?.created_at||null;
      const custody=has(db,'unit_custody')?db.prepare("SELECT status,checked_in_at FROM unit_custody WHERE work_order_id=?").get(wo.id):null;
      ready.push({...common,since,ageDays:ageDays(since,now),ageBasis:since?'Recorded ready transition':'Ready timestamp not recorded',physicallyOnSite:custody?.status==='in_lot'});
    }
    if(wo.promised_date){
      let due=timestamp(wo.promised_date);
      if(/^\d{4}-\d{2}-\d{2}$/.test(wo.promised_date)){try{due=Date.parse(businessDayRange(wo.promised_date).endsAt);}catch{due=null;}}
      if(due!==null&&due<now)overdue.push({...common,promisedDate:wo.promised_date,overdueDays:Math.max(1,Math.ceil((now-due)/86400000))});
    }
  }
  const sortAge=(a,b)=>(b.ageDays??-1)-(a.ageDays??-1);
  return {asOf:new Date(now).toISOString(),basis:'Current operational queues across all open jobs, not restricted to the reporting date window.',quotes:quotes.sort(sortAge).slice(0,100),readyForPickup:ready.sort(sortAge).slice(0,100),overdue:overdue.sort((a,b)=>b.overdueDays-a.overdueDays).slice(0,100),counts:{quotes:quotes.length,ready:ready.length,overdue:overdue.length}};
}

function workOrderActivity(db,range){
  const rows=db.prepare('SELECT * FROM work_orders').all();
  const stages={},advisors=new Map();let opened=0,completed=0,totalDays=0,datedCycles=0,closedWithoutDates=0;
  const users=new Map(db.prepare('SELECT id,COALESCE(display_name,username) name FROM users').all().map(u=>[u.id,u.name]));
  for(const wo of rows){
    const opening=wo.date_opened||wo.created_at,isOpened=inRange(opening,range),isCompleted=['Closed','Picked Up'].includes(wo.stage)&&inRange(wo.date_closed,range);
    if(['Closed','Picked Up'].includes(wo.stage)&&!wo.date_closed)closedWithoutDates++;
    if(!isOpened&&!isCompleted)continue;
    const advisorId=wo.service_advisor_id||null,key=advisorId||'unassigned';
    if(!advisors.has(key))advisors.set(key,{advisorId,name:users.get(advisorId)||'Unassigned',opened:0,completed:0,currentOpen:0});
    const advisor=advisors.get(key);
    if(isOpened){opened++;stages[wo.stage]=(stages[wo.stage]||0)+1;advisor.opened++;if(!['Closed','Picked Up','Declined'].includes(wo.stage))advisor.currentOpen++;}
    if(isCompleted){completed++;advisor.completed++;const start=timestamp(opening),end=timestamp(wo.date_closed);if(start!==null&&end!==null&&end>=start){totalDays+=(end-start)/86400000;datedCycles++;}}
  }
  return {opened,completed,currentStageOfOpenedJobs:stages,averageCompletedCycleDays:datedCycles?Math.round(totalDays/datedCycles*10)/10:null,datedCycleCount:datedCycles,completedMissingDates:closedWithoutDates,advisors:[...advisors.values()].sort((a,b)=>b.completed-a.completed||b.opened-a.opened),
    basis:'Opened jobs use recorded opening date; completions require a recorded closed date. Date-only values use Phoenix business-day boundaries. Current advisor assignment is not a historical completion snapshot. Missing dates are excluded from cycle averages.'};
}

function retentionCandidates(db,now){
  const consent=has(db,'customer_contact_consents');
  const rows=db.prepare(`SELECT w.id work_order_id,w.customer_id,w.date_closed,c.name,c.email${consent?',co.service_email':',0 service_email'} FROM work_orders w JOIN customers c ON c.id=w.customer_id ${consent?'LEFT JOIN customer_contact_consents co ON co.customer_id=c.id':''} WHERE w.stage IN ('Closed','Picked Up') AND w.date_closed IS NOT NULL AND c.archived=0`).all();
  const latest=new Map();
  for(const row of rows){const ended=timestamp(row.date_closed);if(ended!==null&&(!latest.has(row.customer_id)||ended>latest.get(row.customer_id).ended))latest.set(row.customer_id,{...row,ended});}
  const candidates=[];
  for(const row of latest.values()){
    const days=Math.floor((now-row.ended)/86400000);if(days<30)continue;
    const next=has(db,'shop_appointments')?db.prepare("SELECT id FROM shop_appointments WHERE customer_id=? AND status='scheduled' AND julianday(starts_at)>=julianday(?) LIMIT 1").get(row.customer_id,new Date(now).toISOString()):null;if(next)continue;
    const validEmail=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(row.email||'');
    candidates.push({customerId:row.customer_id,customerName:row.name,lastWorkOrderId:row.work_order_id,lastServiceDate:row.date_closed,daysSinceService:days,serviceEmailConsent:row.service_email===1,draftEligible:row.service_email===1&&validEmail,reason:!validEmail?'Email address needed':row.service_email!==1?'Service email consent needed':'Eligible for a service reminder draft'});
  }
  return candidates.sort((a,b)=>b.daysSinceService-a.daysSinceService).slice(0,100);
}

export function shopDashboardReport(db,{from,to,now=new Date()}={}){
  const instant=now instanceof Date?now:new Date(now);if(!Number.isFinite(instant.getTime()))fail(400,'Invalid report clock');
  const today=phoenixDate(instant),range=rangeFor(from||today.slice(0,8)+'01',to||today);
  return {...range,generatedAt:instant.toISOString(),cashflow:cashflow(db,range),partsSpread:retailPartSpread(db,range),workOrders:workOrderActivity(db,range),queues:operationalQueues(db,instant.getTime()),retentionCandidates:retentionCandidates(db,instant.getTime()),notice:'Management reporting uses recorded shop data. Verify opening balances, costs, close dates and external settlement before accounting decisions.'};
}

export function shopReportsRoutes({db,currentUser,json,readBody,now=()=>new Date()}){
  return async function route(req,res,p,url){
    if(!p.startsWith('/api/reports/'))return false;
    const send=(status,body)=>{json(res,status,body,{'cache-control':'no-store'});return true;};
    const user=currentUser(req);if(!user)return send(401,{error:'Login required'});if(!managers.has(user.role))return send(403,{error:'Owner/manager reporting permission required'});
    try{
      if(p==='/api/reports/dashboard'&&req.method==='GET')return send(200,shopDashboardReport(db,{from:url.searchParams.get('from')||undefined,to:url.searchParams.get('to')||undefined,now:now()}));
      if(p==='/api/reports/retention-drafts'&&req.method==='POST'){
        if(!readBody)fail(503,'Reminder draft preparation is not available');
        const input=await readBody(req);if(input.confirmDrafts!==true||!Array.isArray(input.customerIds)||input.customerIds.length>25)fail(400,'Choose up to 25 customers and explicitly confirm draft preparation');
        const candidates=retentionCandidates(db,now().getTime()),results=[];
        for(const id of [...new Set(input.customerIds)]){
          const customer=candidates.find(candidate=>candidate.customerId===Number(id));
          if(!customer?.draftEligible){results.push({customerId:Number(id),status:'not_eligible',notice:'Current service consent, valid contact details and a suitable service history are required'});continue;}
          try{const draft=enqueueCustomerMessage(db,user,{customerId:customer.customerId,category:'service',subject:'Service follow-up from the shop',message:`Hello ${customer.customerName},\n\nWe are following up on your service visit recorded on ${customer.lastServiceDate}. Please contact the shop if you have questions about the completed work or would like to discuss your unit's next service.`,draft:true,idempotencyKey:`retention-service-v1:${customer.customerId}:${customer.lastWorkOrderId}`});results.push({customerId:customer.customerId,messageId:draft.id,status:draft.status,duplicate:!!draft.duplicate});}
          catch(error){results.push({customerId:customer.customerId,status:'needs_review',notice:text(error.message,200)});}
        }
        return send(200,{results,notice:'Prepared service follow-up drafts only. Review them in Customer Communications; no email was sent.'});
      }
      return send(404,{error:'Unknown report route'});
    }catch(error){return send(error.status||400,{error:text(error.message,300)});}
  };
}

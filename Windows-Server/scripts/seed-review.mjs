// Isolated review records only. Refuse ordinary shop installations and existing data.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {loadEnv} from '../src/env.mjs';
loadEnv();
if(process.env.OWNERTRACKER_REVIEW!=='true')throw Error('Review seeding requires the isolated OWNERTRACKER_REVIEW=true environment.');
const origin=`http://127.0.0.1:${process.env.PORT||18877}`;
let cookie='';
async function api(url,method='GET',body){const response=await fetch(origin+url,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw Error(`${url}: ${JSON.stringify(value)}`);return value;}
const login=await fetch(origin+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:process.env.OWNERTRACKER_ADMIN_PASSWORD})});
if(!login.ok)throw Error('Review owner sign-in failed');cookie=login.headers.get('set-cookie').split(';')[0];
if((await api('/api/work-orders')).workOrders.length)throw Error('Review seeding refused: work orders already exist.');
const staff={};for(const [username,role,name]of [['manager','manager','Sam · sample manager'],['advisor','advisor','Alex · sample advisor'],['technician','technician','Taylor · sample technician'],['parts','parts','Chris · sample parts']])staff[role]=(await api('/api/users','POST',{username,password:'Review-Only-2026!',displayName:name,role})).user;
const guide={review:true,notice:'Fictional records for examination only. No real funds, orders, emails, or signatures.',links:[]};
const people=[['Avery · SAMPLE','Sea-Doo','GTX 230','Diagnosing'],['Morgan · SAMPLE','Yamaha','FX Cruiser','Awaiting Approval'],['Jordan · SAMPLE','Can-Am','Maverick X3','Ready'],['Riley · SAMPLE','Yamaha','212X','Ready']];
for(let index=0;index<people.length;index++){
 const [name,make,model,stage]=people[index];
 const customer=(await api('/api/pos/customers','POST',{name,phone:`602-555-010${index}`,email:`sample-${index}@example.invalid`,address_line1:`${100+index} Example Lane`,city:'Phoenix',state:'AZ',postal_code:'85001',notes:'Fictional review record; not a real customer.'})).customer;
 const vehicle=(await api('/api/pos/vehicles','POST',{customer_id:customer.id,year:'2023',make,model,hin:'REVIEW-ONLY-'+index,notes:'SAMPLE vehicle'})).vehicle;
 const order=await api('/api/pos/work-orders','POST',{customer_id:customer.id,vehicle_id:vehicle.id,ref_number:`REVIEW-${1001+index}`,complaint:'Sample seasonal service and inspection',estimate_total:0});
 async function addLine(line){const current=(await api(`/api/work-orders/${order.id}`)).workOrder;return api(`/api/pos/work-orders/${order.id}/lines`,'POST',{...line,expectedRevision:current.revision});}
 await addLine({line_type:'labor',description:'Sample inspection and service labor',qty:2,rate:140});
 await addLine({line_type:'part',item_ref:'REVIEW-SERVICE-KIT',description:'Sample service kit — no supplier order',qty:1,rate:80,cost:40,taxable:true});
 await api(`/api/management/work-orders/${order.id}/advisor`,'POST',{advisorId:staff.advisor.id,reason:'Sample advisor assignment'});
 await api(`/api/shop/vehicles/${vehicle.id}/check-in`,'POST',{workOrderId:order.id,lotLocation:'Sample Bay '+(index+1),keysTag:'SAMPLE-'+(index+1)});
 let current=(await api(`/api/work-orders/${order.id}`)).workOrder;
 await api(`/api/work-orders/${order.id}`,'PATCH',{stage,assigned_user_id:staff.technician.id,next_action:index===1?'Customer authorization needed':'Review sample service workflow',expectedRevision:current.revision});
 if(index>=2){current=(await api(`/api/work-orders/${order.id}`)).workOrder;await api(`/api/pos/work-orders/${order.id}/payments`,'POST',{method:'cash',amount:index===2?'100.00':Number(current.estimate_total).toFixed(2),verified:true,reference:'SAMPLE-NO-REAL-MONEY',idempotencyKey:crypto.randomUUID()});}
 if(index===1){current=(await api(`/api/work-orders/${order.id}`)).workOrder;const approval=await api(`/api/work-orders/${order.id}/request-approval`,'POST',{authorizedDescription:'Sample service and inspection at the displayed estimate. This is a review example.',expectedRevision:current.revision});guide.links.push({label:'Examine a sample customer authorization',url:approval.approvalUrl});}
 if(index===0){const portal=await api(`/api/work-orders/${order.id}/customer-link`,'POST',{scope:'documents',days:7});guide.links.push({label:'Examine a sample customer status page',url:portal.portalUrl});}
}
const customer=(await api('/api/pos/customers')).customers[0];
const retail=(await api('/api/shop/retail-orders','POST',{customerId:customer.id,notes:'Sample counter order — not a real supplier purchase'})).order;
await api(`/api/shop/retail-orders/${retail.id}/lines`,'POST',{description:'Sample impeller service part',requestedSku:'REVIEW-PART',quantity:1,unitCost:'45',unitPrice:'100',taxable:true,expectedRevision:retail.revision});
const updated=(await api(`/api/shop/retail-orders/${retail.id}`)).order;
await api(`/api/shop/retail-orders/${retail.id}/issue-invoice`,'POST',{expectedRevision:updated.revision});
await api(`/api/shop/retail-orders/${retail.id}/payments`,'POST',{method:'zelle',status:'pending',amount:'40',idempotencyKey:crypto.randomUUID()});
const next=new Date(Date.now()+86400000);next.setUTCHours(17,0,0,0);
await api('/api/shop/schedule','POST',{customerId:customer.id,title:'SAMPLE drop-off appointment',startsAt:next.toISOString(),endsAt:new Date(next.getTime()+3600000).toISOString(),notes:'Review scheduling example. Not synced to a real calendar.'});
await api('/api/management/catalog','POST',{sku:'REVIEW-SERVICE-KIT',barcode:'000000001001',description:'Sample service kit',bin:'DEMO-A1',reorderLevel:3});
guide.links.push({label:'Examine the sample retail receipt',url:`${process.env.PUBLIC_BASE_URL}/api/receipts/retail/${retail.id}`});
fs.mkdirSync('data',{recursive:true});fs.writeFileSync('data/review-guide.json',JSON.stringify(guide,null,2),{mode:0o600});
console.log('Sample customers, vehicles, staff, jobs, authorizations, retail invoice, pending payment, catalog and schedule are ready. No live provider was contacted.');

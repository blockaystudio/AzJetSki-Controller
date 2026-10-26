import assert from 'node:assert/strict';
import fs from 'node:fs';
const root=process.env.TEST_URL||'http://127.0.0.1:18989';let cookie='';
async function call(uri,method='GET',body,want=200,raw=false){const r=await fetch(root+uri,{method,headers:{...(cookie?{cookie}:{}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.equal(r.status,want,`${method} ${uri} -> ${r.status}: ${await r.clone().text()}`);if(raw)return r;return await r.json();}
const login=await call('/api/login','POST',{username:'owner',password:'Test-Owner-Password-2395!'});assert.ok(login.ok);
const r=await fetch(root+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'Test-Owner-Password-2395!'})});cookie=r.headers.get('set-cookie').split(';')[0];
const cust=(await call('/api/pos/customers','POST',{name:'Test Customer',email:'test@example.com',phone:'6025550101',address_line1:'123 Example St',city:'Phoenix',state:'AZ',postal_code:'85001'},201)).customer;
const v=(await call('/api/pos/vehicles','POST',{customer_id:cust.id,year:'2019',make:'Sea-Doo',model:'RXT',hin:'V9-TEST-018'},201)).vehicle;
const w=await call('/api/pos/work-orders','POST',{customer_id:cust.id,vehicle_id:v.id,ref_number:'AUTH-990',complaint:'Inspect and replace the jet pump',estimate_total:850},201), id=w.id;
const config=await call('/api/billing/integration-status');assert.equal(config.basePublicHttps,true);
const pdf=await call(`/api/pos/work-orders/${id}/docusign/preview`,'GET',undefined,200,true);const bytes=Buffer.from(await pdf.arrayBuffer());assert.equal(bytes.subarray(0,8).toString(),'%PDF-1.4');assert.ok(bytes.includes(Buffer.from('/ot_sig/')));fs.writeFileSync('/tmp/v9-authorization-test.pdf',bytes);
const drafted=await call(`/api/pos/work-orders/${id}/docusign/send`,'POST',{name:'Test Customer',email:'test@example.com',description:'Jet pump repair up to stated estimate.',confirmSend:true,expectedRevision:(await call(`/api/work-orders/${id}`)).workOrder.revision},202);assert.equal(drafted.status,'prepared');assert.equal((await call(`/api/pos/work-orders/${id}/docusign`)).packets.length,1);
await call(`/api/pos/work-orders/${id}/docusign/sync`,'POST',{},404);
const invoice=await call(`/api/pos/work-orders/${id}/invoices`,'POST',{email:'test@example.com',sendEmail:true,idempotencyKey:'v9-invoice-0001',expectedRevision:(await call(`/api/work-orders/${id}`)).workOrder.revision},201);assert.match(invoice.link,/https:\/\/tracker.example.test\/invoice\//);assert.equal(invoice.deliveryStatus,'consent_required');assert.equal(invoice.amount,850);
const publicInvoice=await call(invoice.link.replace('https://tracker.example.test',''),'GET',undefined,200,true);const html=await publicInvoice.text();assert.match(html,/Test Customer/);assert.match(html, /\$850\.00/);assert.doesNotMatch(html,/Pay securely by card/);
const p1=await call(`/api/billing/invoices/${invoice.id}/payment-requests`,'POST',{requestKey:'qa-v9-request-12345678',method:'dejavoo_p1_terminal',amount:'350.00'},201);assert.equal(p1.chargeProcessed,false);assert.equal(p1.status,'prepared');
const same=await call(`/api/billing/invoices/${invoice.id}/payment-requests`,'POST',{requestKey:'qa-v9-request-12345678',method:'dejavoo_p1_terminal',amount:'350.00'});assert.equal(same.duplicate,true);
await call(`/api/billing/invoices/${invoice.id}/payment-requests`,'POST',{requestKey:'qa-v9-overpay-12345678',method:'dejavoo_hpp',amount:'900'},409);
await call(`/api/pos/work-orders/${id}/payments`,'POST',{method:'cash',amount:'150',verified:true,idempotency_key:'qa-v9-cash-12345678'},201);
await call(`/api/pos/work-orders/${id}/payments`,'POST',{method:'card_dejavoo',amount:'250',reference:'P1-APPROVED-QA-42',verified:true,idempotency_key:'qa-v9-card-12345678'},201);
let z=await call(`/api/pos/work-orders/${id}/payments`,'POST',{method:'zelle',amount:'450',status:'pending',idempotency_key:'qa-v9-zelle-12345678'},201);assert.equal(z.totals.balance,450);assert.equal(z.totals.pending,450);
let invoiceAfter=await call(invoice.link.replace('https://tracker.example.test',''),'GET',undefined,200,true);assert.match(await invoiceAfter.text(), /\$450\.00/);
z=await call(`/api/pos/payments/${z.id}/confirm`,'POST',{verified:true,reference:'BANK-REF-V9'},200);assert.equal(z.totals.balance,0);
await call(`/api/billing/invoices/${invoice.id}/payment-requests`,'POST',{requestKey:'qa-v9-zero-12345678',method:'dejavoo_hpp',amount:'1'},409);
await call(`/api/pos/work-orders/${id}/invoices`,'POST',{email:'test@example.com',idempotencyKey:'v9-no-balance-invoice',expectedRevision:(await call(`/api/work-orders/${id}`)).workOrder.revision},409);
await call(`/api/pos/work-orders/${id}/docusign/send`,'POST',{description:'x',expectedRevision:(await call(`/api/work-orders/${id}`)).workOrder.revision},400);
// No user: no staff access; public invoice uses token independently.
cookie='';await call(`/api/pos/work-orders/${id}/invoices`,'GET',undefined,403);
console.log('PASS V9: login, job-specific PDF/anchor, DocuSign draft (not sent), invoice link/snapshot, no fake email, P1 prepared-not-charged, duplicate/overpay controls, split cash/card/Zelle, pending verification, public balance updates, staff authorization.');

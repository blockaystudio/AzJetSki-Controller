import assert from 'node:assert/strict';
const root='http://127.0.0.1:18987';let cookie='';
async function call(path,method='GET',body,status=200){const r=await fetch(root+path,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();assert.equal(r.status,status,`${method} ${path}: ${JSON.stringify(j)}`);return j;}
const login=await fetch(root+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'Test-Owner-Password-2395!'})});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
const c=(await call('/api/pos/customers','POST',{name:'V8 Pay Customer',address_line1:'123 Example St',city:'Phoenix',state:'AZ',postal_code:'85001'},201)).customer;
const v=(await call('/api/pos/vehicles','POST',{customer_id:c.id,make:'Yamaha',model:'FX HO',hin:'TEST-HIN-PAY'},201)).vehicle;
const wo=await call('/api/pos/work-orders','POST',{customer_id:c.id,vehicle_id:v.id,estimate_total:700,complaint:'Repair engine'},201),id=wo.id,uri=`/api/pos/work-orders/${id}/payments`;
const key='v8-cash-00000001';const payload={method:'cash',amount:'100.00',verified:true,idempotency_key:key};
let p=await call(uri,'POST',payload,201);const cashPaymentId=p.id;assert.equal(p.totals.balance,600);
p=await call(uri,'POST',payload,200);assert.equal(p.duplicate,true);assert.equal((await call(uri)).payments.length,1);
await call(uri,'POST',{method:'card_dejavoo',amount:200,idempotency_key:'v8-card-00000001',verified:false},400);
p=await call(uri,'POST',{method:'card_dejavoo',amount:'200.00',idempotency_key:'v8-card-00000001',verified:true,reference:'DEJ-APPROVED-897'},201);assert.equal(p.totals.balance,400);const cardPaymentId=p.id;
p=await call(uri,'POST',{method:'zelle',amount:'150',status:'pending',idempotency_key:'v8-zelle-00000001'},201);assert.equal(p.totals.balance,400);assert.equal(p.totals.pending,150);
await call(`/api/pos/payments/${p.id}/confirm`,'POST',{verified:false,reference:'ZL-123'},400);
p=await call(`/api/pos/payments/${p.id}/confirm`,'POST',{verified:true,reference:'BANK-VERIFIED-123'},200);assert.equal(p.totals.balance,250);
await call(uri,'POST',{method:'cash',amount:260,verified:true,idempotency_key:'v8-over-0000001'},409);
await call(uri,'POST',{method:'card_dejavoo',direction:'refund',amount:100,reason:'Customer requested partial refund',originalPaymentId:cardPaymentId,reference:'DEJ-REFUND',verified:true,idempotency_key:'v8-refund-000001'},201);
await call(uri,'POST',{method:'card_dejavoo',direction:'refund',amount:200,reason:'Test original payment refund limit',originalPaymentId:cardPaymentId,reference:'OVER-CARD',verified:true,idempotency_key:'v8-method-cap-01'},409);
await call(uri,'POST',{method:'cash',direction:'refund',amount:1000,reason:'Test original payment refund limit',originalPaymentId:cashPaymentId,reference:'REFUND-TOO-HIGH',verified:true,idempotency_key:'v8-refund-000002'},409);
await call(`/api/pos/work-orders/${id}`,'PATCH',{paid_total:0},400);
await call(`/api/pos/work-orders/${id}`,'PATCH',{estimate_total:400}); // balance must recompute from ledger
const final=(await call(uri)).totals;assert.equal(final.paid,350);assert.equal(final.balance,50);
console.log('PASS V8 payment ledger: customer + unit + job, partial cash, Dejavoo approval reference, Zelle pending and verification, idempotency, overpay prevention, refund protection, paid_total edit blocked, balance recompute.');

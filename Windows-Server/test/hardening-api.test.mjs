import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// This file runs only inside the isolated V11 server fixture.
const base = 'http://127.0.0.1:18991';
async function login(username, password) {
  const result = await fetch(base+'/api/login', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
  assert.equal(result.status,200);
  return result.headers.get('set-cookie').split(';')[0];
}
const owner = await login('owner','Test-Owner-Password-2395!');
async function call(path, method='GET', body, status=200, cookie=owner) {
  const response = await fetch(base+path,{method,headers:{'content-type':'application/json',cookie},body:body===undefined?undefined:JSON.stringify(body)});
  const value = await response.json();
  assert.equal(response.status,status,`${method} ${path}: ${JSON.stringify(value)}`);
  return value;
}
const customer = (await call('/api/pos/customers','POST',{name:'Account receipt QA',address_line1:'100 Example',city:'Phoenix',state:'AZ',postal_code:'85001'},201)).customer;
const vehicle = (await call('/api/pos/vehicles','POST',{customer_id:customer.id,make:'Yamaha',model:'VX'},201)).vehicle;
const workOrder = await call('/api/pos/work-orders','POST',{customer_id:customer.id,vehicle_id:vehicle.id,estimate_total:100},201);
const payments = `/api/pos/work-orders/${workOrder.id}/payments`;
const cash = await call(payments,'POST',{method:'cash',amount:'60.00',verified:true,idempotencyKey:crypto.randomUUID()},201);
const bank = await call(payments,'POST',{method:'zelle',amount:'20.00',status:'pending',idempotencyKey:crypto.randomUUID()},201);
const advisor = await login('v11-advisor','AdvisorPassword2026!');
const refund = {method:'cash',direction:'refund',amount:'10.00',verified:true,reference:'CASH-RETURN-'+crypto.randomUUID(),originalPaymentId:cash.id,reason:'Partial service cancellation',idempotencyKey:crypto.randomUUID()};
await call(payments,'POST',refund,403,advisor);
await call(payments,'POST',refund,201);
await call(payments,'POST',refund,200);
await call(payments,'POST',{...refund,amount:'11.00'},409);
await call(`/api/pos/payments/${bank.id}/void`,'POST',{reason:'Duplicate pending entry',idempotencyKey:crypto.randomUUID()},403,advisor);
await call(`/api/pos/payments/${bank.id}/void`,'POST',{reason:'Duplicate pending entry',idempotencyKey:crypto.randomUUID()});
await call(`/api/pos/payments/${bank.id}/confirm`,'POST',{verified:true,reference:'VOIDED-BANK'},409);
const ledger = await call(payments);
assert.equal(ledger.totals.paid,50);
assert.equal(ledger.totals.pending,0);
assert.equal(ledger.totals.balance,50);
assert.ok(ledger.financialEvents.some(event=>event.operation==='refund'&&event.actor_role==='owner'));
const receipt = await fetch(`${base}/api/receipts/repair/${workOrder.id}`,{headers:{cookie:owner}});
assert.equal(receipt.status,200);
assert.match(receipt.headers.get('content-type'),/text\/html/);
assert.match(receipt.headers.get('cache-control'),/no-store/);
const html = await receipt.text();
assert.match(html,/not an issued tax invoice/);
assert.doesNotMatch(html,/Partial service cancellation|Duplicate pending entry/);
assert.equal((await fetch(`${base}/api/receipts/repair/${workOrder.id}`)).status,401);
const retail = (await call('/api/shop/retail-orders','POST',{customerId:customer.id},201)).order;
await call(`/api/shop/retail-orders/${retail.id}/lines`,'POST',{description:'Receipt test part',quantity:1,unitPrice:'20',unitCost:'10',taxable:false},201);
await call(`/api/shop/retail-orders/${retail.id}/issue-invoice`,'POST',{});
await call(`/api/shop/retail-orders/${retail.id}/payments`,'POST',{method:'cash',amount:'10',verified:true,idempotencyKey:crypto.randomUUID()},201);
const retailReceipt = await fetch(`${base}/api/receipts/retail/${retail.id}`,{headers:{cookie:owner}});
assert.equal(retailReceipt.status,200);
assert.match(await retailReceipt.text(),/Receipt test part/);
const ui = await fetch(`${base}/finance-ui.js`);
assert.equal(ui.status,200);
assert.match(await ui.text(),/export function financePanel/);
console.log('PASS: live HTTP repair/retail financial controls, permission denials, replay conflict, void exclusion, private printable receipts and served UI module');

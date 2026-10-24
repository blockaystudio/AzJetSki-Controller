import assert from 'node:assert/strict';
const root='http://127.0.0.1:18987';
const login=await fetch(root+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'Test-Owner-Password-2395!'})});
const cookie=login.headers.get('set-cookie').split(';')[0];
async function api(p,method='GET',body){const r=await fetch(root+p,{method,headers:{'content-type':'application/json',Cookie:cookie},body:body?JSON.stringify(body):undefined});const j=await r.json();assert.ok(r.ok,`${p} ${r.status} ${JSON.stringify(j)}`);return j}
const vendors=(await api('/api/vendors')).vendors;
async function add(code,sku,cost){const p=await api('/api/work-orders/1/parts','POST',{item_ref:sku,description:sku,qty_needed:1});const v=vendors.find(x=>x.code===code);await api('/api/parts/'+p.partId+'/offers','POST',{vendorId:v.id,vendorSku:sku,availableQty:3,unitCost:cost,eta:'Dealer quoted'});}
async function cart(code){await api('/api/procurement/build-all','POST',{});return (await api('/api/procurement')).carts.filter(x=>x.vendor_code===code&&['waiting_threshold','ready_to_submit'].includes(x.status)).sort((a,b)=>b.id-a.id)[0]}
await add('WSM','WSM-A',40);assert.equal((await cart('WSM')).status,'waiting_threshold');
await add('BRP','BRP-A',200);assert.equal((await cart('BRP')).status,'waiting_threshold');
await add('PU','PU-A',9);assert.equal((await cart('PU')).status,'ready_to_submit');
await add('TMS','TMS-A',4);assert.equal((await cart('TMS')).status,'ready_to_submit');
await add('WSM','WSM-B',65);assert.equal((await cart('WSM')).total,105);assert.equal((await cart('WSM')).status,'ready_to_submit');
await add('BRP','BRP-B',75);assert.equal((await cart('BRP')).total,275);assert.equal((await cart('BRP')).status,'ready_to_submit');
console.log('PASS: WSM $40 waits -> $105 ready; BRP $200 waits -> $275 ready; Parts Unlimited $9 immediately ready; TMS $4 immediately ready. No vendor orders placed.');

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {makePurchaseTarget} from '../public/purchase-target.js';

const source = fileURLToPath(new URL('../', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function unusedPort() {
  const socket=net.createServer();
  await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});
  const port=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));
  return port;
}

test('strict shop launch: authenticated edits, retained Unicode approvals, scoped links, credits/refunds and bound purchasing work together over HTTP', {timeout:60000}, async () => {
  // Copy source as well as data: the server derives its upload directory from its
  // own module location. This test must never write photos into a real checkout.
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ownertracker-launch-api-')));
  let child, logs='';
  try {
    for(const directory of ['src','public','scripts'])fs.cpSync(path.join(source,directory),path.join(root,directory),{recursive:true});
    fs.copyFileSync(path.join(source,'package.json'),path.join(root,'package.json'));
    const port=await unusedPort(),base=`http://127.0.0.1:${port}`;
    const env={};
    for(const name of ['SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','PATH','HOME','USERPROFILE','TEMP','TMP','TMPDIR'])if(process.env[name]!==undefined)env[name]=process.env[name];
    Object.assign(env,{HOST:'127.0.0.1',PORT:String(port),NODE_ENV:'test',OWNERTRACKER_DB:path.join(root,'data','ownertracker.sqlite'),
      OWNERTRACKER_ADMIN_USER:'owner',OWNERTRACKER_ADMIN_PASSWORD:'Launch-Owner-Test-2026!',
      OWNERTRACKER_SESSION_SECRET:crypto.randomBytes(32).toString('hex'),QBPOS_BRIDGE_TOKEN:crypto.randomBytes(32).toString('hex'),DESKTOP_AGENT_TOKEN:crypto.randomBytes(32).toString('hex'),
      PUBLIC_BASE_URL:'https://shop.example.test',REQUIRE_EDIT_REVISION:'true',LIVE_VENDOR_ORDERING:'false',AUTO_SUPPLIER_LOOKUP:'false',AUTO_BUILD_PROCUREMENT:'false',DOCUSIGN_ENABLE_SEND:'false',DOCUSIGN_POLICY_APPROVED:'false',REVIEW_MODE:'false'});
    child=spawn(process.execPath,[path.join(root,'src/server.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',bytes=>logs=(logs+bytes).slice(-16000));
    child.stderr.on('data',bytes=>logs=(logs+bytes).slice(-16000));
    let spawnError;
    child.once('error',error=>spawnError=error);
    const until=Date.now()+15000;
    let ready=false;
    while(Date.now()<until){
      if(spawnError)throw spawnError;
      if(child.exitCode!==null)throw Error(`Isolated launch server exited: ${logs}`);
      try{const health=await fetch(base+'/health');if(health.ok&&(await health.json()).ok){ready=true;break;}}catch{}
      await wait(30);
    }
    assert.ok(ready,`Isolated launch server never became ready: ${logs}`);

    async function json(url,{method='GET',body,cookie,expected=200,headers={}}={}) {
      const response=await fetch(base+url,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
      const value=await response.json();
      assert.equal(response.status,expected,`${method} ${url}: ${JSON.stringify(value)}`);
      return {response,value};
    }
    async function login(username,password) {
      const {response}=await json('/api/login',{method:'POST',body:{username,password}});
      const cookie=response.headers.get('set-cookie');
      assert.match(cookie,/HttpOnly/i);assert.match(cookie,/SameSite=Strict/i);
      return cookie.split(';')[0];
    }
    const owner=await login('owner','Launch-Owner-Test-2026!');
    await json('/api/users',{method:'POST',cookie:owner,body:{username:'scope-tech',displayName:'Scoped technician',role:'technician',password:'Scoped-Tech-Test-2026!'},expected:201});
    const techCookie=await login('scope-tech','Scoped-Tech-Test-2026!');
    for(const route of ['/api/pos/customers','/api/pos/vehicles','/api/pos/work-orders/1/payments','/api/shop/retail-orders/1','/api/shop/queues','/api/shop/schedule','/api/shop/schedule/1/ics','/api/pos/parts-board','/api/dashboard'])await json(route,{cookie:techCookie,expected:403});

    assert.equal((await json('/api/me',{cookie:owner})).value.user.role,'owner');
    const customer=(await json('/api/pos/customers',{method:'POST',cookie:owner,expected:201,body:{name:'José Rivera 林',email:'launch@example.test',address_line1:'100 Test Way',city:'Phoenix',state:'AZ',postal_code:'85001'}})).value.customer;
    const vehicle=(await json('/api/pos/vehicles',{method:'POST',cookie:owner,expected:201,body:{customer_id:customer.id,make:'Yamaha',model:'VX',hin:'STRICT-LAUNCH-TEST'}})).value.vehicle;
    const created=(await json('/api/pos/work-orders',{method:'POST',cookie:owner,expected:201,body:{customer_id:customer.id,vehicle_id:vehicle.id,estimate_total:100,complaint:'Inspect pump',ref_number:'LAUNCH-STRICT'}})).value;
    const jobPath=`/api/work-orders/${created.id}`;
    let job=(await json(jobPath,{cookie:owner})).value.workOrder;
    assert.ok(Number.isSafeInteger(job.revision));
    await json(jobPath,{method:'PATCH',cookie:owner,body:{complaint:'Missing version must not save'},expected:428});
    const results=await Promise.all(['First desk change','Second desk change'].map(complaint=>fetch(base+jobPath,{method:'PATCH',headers:{cookie:owner,'content-type':'application/json','if-match':`"${job.revision}"`},body:JSON.stringify({complaint})})));
    assert.deepEqual(results.map(response=>response.status).sort(),[200,409]);
    const failed=results.find(response=>response.status===409);assert.ok((await failed.json()).currentRevision>job.revision);
    job=(await json(jobPath,{cookie:owner})).value.workOrder;
    assert.match(job.complaint,/^(First|Second) desk change$/);
    const customerVersion=customer.revision;
    await json(`/api/pos/customers/${customer.id}`,{method:'PATCH',cookie:owner,body:{name:'José Rivera 林',notes:'First profile edit',expectedRevision:customerVersion}});
    await json(`/api/pos/customers/${customer.id}`,{method:'PATCH',cookie:owner,body:{name:'Must not replace the customer',expectedRevision:customerVersion},expected:409});
    assert.equal((await json(`/api/pos/customers/${customer.id}`,{cookie:owner})).value.customer.name,'José Rivera 林');
    await json(jobPath,{method:'PATCH',cookie:owner,headers:{origin:'https://unrelated.example.test'},body:{stage:'Ready',expectedRevision:job.revision},expected:403});

    // Assets are the real project files, not placeholder pages or a mocked API.
    for(const asset of ['/','/billing.html','/shop-ops.html','/owner.html','/tech.html','/accounting.html','/shop-management.html','/launch.html','/app.js','/edit-revisions-ui.js','/authorizations-ui.js','/access-ui.js']){
      const response=await fetch(base+asset);assert.equal(response.status,200,asset);assert.ok((await response.text()).length>50,asset);
    }

    job=(await json(jobPath,{cookie:owner})).value.workOrder;
    const approval=(await json(jobPath+'/request-approval',{method:'POST',cookie:owner,body:{authorizedDescription:'Réparation complète — pompe à eau',expectedRevision:job.revision}})).value;
    assert.ok(approval.approvalId);assert.ok(approval.snapshotSha256);
    const approvalPath=new URL(approval.approvalUrl).pathname;
    await json(approvalPath,{method:'POST',body:{choice:'Approve Repairs',signerName:'José Rivera 林',agree:true}});
    await json(approvalPath,{method:'POST',body:{choice:'Approve Repairs',signerName:'Another signer',agree:true},expected:409});
    const history=(await json(jobPath+'/authorizations',{cookie:owner})).value;
    assert.equal(history.hasCurrentRepairAuthorization,true);
    assert.equal(history.authorizations[0].signerName,'José Rivera 林');
    const recordResponse=await fetch(base+jobPath+`/authorizations/${approval.approvalId}/record`,{headers:{cookie:owner}});
    assert.equal(recordResponse.status,200);
    const record=await recordResponse.json();
    assert.match(JSON.stringify(record),/José Rivera 林/);
    assert.match(JSON.stringify(record),/Réparation complète/);
    const pdf=await fetch(base+jobPath+`/authorizations/${approval.approvalId}/document`,{headers:{cookie:owner}});
    assert.equal(pdf.status,200);assert.match(pdf.headers.get('content-type'),/application\/pdf/);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
    assert.match(pdf.headers.get('cache-control'),/no-store/);

    await json(jobPath+'/notes',{method:'POST',cookie:owner,body:{body:'INTERNAL-PIN-DO-NOT-SHARE'}});
    const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEtcAAAAASUVORK5CYII=';
    const visible=(await json(jobPath+'/media',{method:'POST',cookie:owner,body:{filename:'visible.png',mimeType:'image/png',dataBase64:png,caption:'Customer inspection photo',customerVisible:true}})).value.mediaId;
    const privatePhoto=(await json(jobPath+'/media',{method:'POST',cookie:owner,body:{filename:'internal.png',mimeType:'image/png',dataBase64:png,caption:'INTERNAL-PHOTO-DO-NOT-SHARE',customerVisible:false}})).value.mediaId;
    const statusLink=(await json(jobPath+'/customer-links',{method:'POST',cookie:owner,body:{scope:'status',days:1},expected:201})).value;
    const portalPath=new URL(statusLink.portalUrl).pathname;
    const portal=await fetch(base+portalPath);assert.equal(portal.status,200);
    const portalHtml=await portal.text();assert.match(portalHtml,/Customer inspection photo/);assert.doesNotMatch(portalHtml,/INTERNAL-PIN|INTERNAL-PHOTO/);
    assert.equal((await fetch(base+portalPath+`/media/${visible}`)).status,200);
    assert.equal((await fetch(base+portalPath+`/media/${privatePhoto}`)).status,404);
    const invoice=(await json(`/api/pos/work-orders/${created.id}/invoices`,{method:'POST',cookie:owner,body:{sendEmail:false,idempotencyKey:crypto.randomUUID(),expectedRevision:(await json(jobPath,{cookie:owner})).value.workOrder.revision},expected:201})).value;
    const invoiceId=(await json(`/api/pos/work-orders/${created.id}/invoices`,{cookie:owner})).value.invoices[0].id;
    assert.ok(invoice.number);
    const otherCustomer=(await json('/api/pos/customers',{method:'POST',cookie:owner,expected:201,body:{name:'Private Other Customer',address_line1:'200 Test Way',city:'Phoenix',state:'AZ',postal_code:'85001'}})).value.customer;
    const otherVehicle=(await json('/api/pos/vehicles',{method:'POST',cookie:owner,expected:201,body:{customer_id:otherCustomer.id,make:'Sea-Doo',model:'WRONG-CUSTOMER-UNIT'}})).value.vehicle;
    const otherOrder=(await json('/api/pos/work-orders',{method:'POST',cookie:owner,expected:201,body:{customer_id:otherCustomer.id,vehicle_id:otherVehicle.id,estimate_total:75,complaint:'PRIVATE-OTHER-ORDER'} })).value;
    await json(`/api/pos/work-orders/${otherOrder.id}/invoices`,{method:'POST',cookie:owner,body:{sendEmail:false,idempotencyKey:crypto.randomUUID(),expectedRevision:(await json(`/api/work-orders/${otherOrder.id}`,{cookie:owner})).value.workOrder.revision},expected:201});
    const otherInvoiceId=(await json(`/api/pos/work-orders/${otherOrder.id}/invoices`,{cookie:owner})).value.invoices[0].id;
    const otherPhoto=(await json(`/api/work-orders/${otherOrder.id}/media`,{method:'POST',cookie:owner,body:{filename:'other-unit.png',mimeType:'image/png',dataBase64:png,caption:'PRIVATE-OTHER-CUSTOMER-PHOTO',customerVisible:true}})).value.mediaId;
    assert.equal((await fetch(base+portalPath+`/invoices/${invoiceId}`)).status,404,'status-only link cannot expose invoices');
    const documents=(await json(jobPath+'/customer-links',{method:'POST',cookie:owner,body:{scope:'documents',days:1},expected:201})).value;
    const documentsPath=new URL(documents.portalUrl).pathname;
    assert.equal((await fetch(base+documentsPath+`/invoices/${invoiceId}`)).status,200);
    assert.equal((await fetch(base+documentsPath+`/authorizations/${approval.approvalId}`)).status,200);
    assert.equal((await fetch(base+documentsPath+`/invoices/${otherInvoiceId}`)).status,404,'document-enabled link cannot expose an existing other customer invoice');
    assert.equal((await fetch(base+documentsPath+`/media/${otherPhoto}`)).status,404,'customer-visible photos still belong to only their own work order');
    assert.doesNotMatch(await (await fetch(base+documentsPath)).text(),/Private Other Customer|PRIVATE-OTHER-ORDER|WRONG-CUSTOMER-UNIT/);
    const links=(await json(jobPath+'/customer-links',{cookie:owner})).value.links;
    const documentLink=links.find(link=>link.scope==='documents'&&link.active);
    await json(jobPath+`/customer-links/${documentLink.id}/revoke`,{method:'POST',cookie:owner,body:{confirm:true,reason:'Customer requested a replacement link'}});
    assert.equal((await fetch(base+documentsPath)).status,404);

    const paymentUrl=`/api/pos/work-orders/${created.id}/payments`;
    const original=(await json(paymentUrl,{method:'POST',cookie:owner,body:{method:'cash',amount:'100.00',verified:true,idempotencyKey:crypto.randomUUID()},expected:201})).value;
    const credit=(await json(`/api/accounting/accounts/repair/${created.id}/credits`,{method:'POST',cookie:owner,body:{invoiceId,subtotalCents:2500,taxCents:0,reason:'Unused work removed with customer agreement',idempotencyKey:crypto.randomUUID()},expected:201})).value;
    assert.equal(credit.balance.dueCents,0);assert.equal(credit.balance.refundDueCents,2500);
    let totals=(await json(paymentUrl,{cookie:owner})).value.totals;
    assert.equal(totals.credits,25);assert.equal(totals.total,75);assert.equal(totals.refundDue,25);
    await json(paymentUrl,{method:'POST',cookie:owner,body:{method:'cash',direction:'refund',amount:'25.00',verified:true,reference:'LAUNCH-CASH-REFUND',reason:'Unused service credit returned',originalPaymentId:original.id,idempotencyKey:crypto.randomUUID()},expected:201});
    totals=(await json(paymentUrl,{cookie:owner})).value.totals;
    assert.equal(totals.paid,75);assert.equal(totals.balance,0);assert.equal(totals.refundDue,0);
    const account=(await json(`/api/accounting/accounts/repair/${created.id}`,{cookie:owner})).value;
    assert.equal(account.credits.length,1);assert.equal(account.balance.netPaidCents,7500);

    // A high-value retail manifest must have an independent approval bound to
    // exactly its real, invoice-backed, supplier-verified lines.
    const manager=(await json('/api/users',{method:'POST',cookie:owner,body:{username:'launch-manager',displayName:'Launch Manager',password:'Launch-Manager-Test-2026!',role:'manager'},expected:201})).value.user;
    const managerCookie=await login('launch-manager','Launch-Manager-Test-2026!');
    const ownerId=(await json('/api/me',{cookie:owner})).value.user.id;
    await json('/api/users',{method:'POST',cookie:managerCookie,body:{username:'unauthorized-owner',password:'Owner-Escalation-Test!',role:'owner'},expected:403});
    await json(`/api/users/${ownerId}`,{method:'PATCH',cookie:managerCookie,body:{password:'Owner-Escalation-Test!'},expected:403});
    await json(`/api/users/${manager.id}`,{method:'PATCH',cookie:managerCookie,body:{role:'owner'},expected:403});
    await json(`/api/users/${ownerId}`,{method:'PATCH',cookie:owner,body:{active:false},expected:409});
    const directDb=new DatabaseSync(path.join(root,'data','ownertracker.sqlite'));
    const supplier=directDb.prepare("SELECT id FROM vendors WHERE code='WSM'").get();
    const unreviewed=Number(directDb.prepare("INSERT INTO procurement_carts(vendor_id,status,total,threshold_snapshot) VALUES(?,'ready_to_submit',100,100)").run(supplier.id).lastInsertRowid);
    directDb.close();
    await json(`/api/procurement/carts/${unreviewed}`,{method:'PATCH',cookie:managerCookie,body:{status:'ordered',order_reference:'UNREVIEWED-NO-PURCHASE'},expected:409});

    await json('/api/management/policy',{method:'PATCH',cookie:owner,body:{advisorPurchaseLimitCents:10000,partsPurchaseLimitCents:5000,independentApprovalCents:10000}});
    const vendor=(await json('/api/vendors',{cookie:owner})).value.vendors.find(row=>row.code==='WSM');
    let retail=(await json('/api/shop/retail-orders',{method:'POST',cookie:owner,body:{customerId:customer.id},expected:201})).value.order;
    const line=(await json(`/api/shop/retail-orders/${retail.id}/lines`,{method:'POST',cookie:owner,body:{description:'Verified launch wear ring',requestedSku:'TEST-WR-100',vendorId:vendor.id,vendorSku:'TEST-EXACT-WR-100',quantity:1,unitCost:'200.00',unitPrice:'300.00',taxable:true,expectedRevision:retail.revision},expected:201})).value;
    retail=(await json(`/api/shop/retail-orders/${retail.id}`,{cookie:owner})).value.order;
    await json(`/api/shop/retail-orders/${retail.id}/issue-invoice`,{method:'POST',cookie:owner,body:{expectedRevision:retail.revision}});
    retail=(await json(`/api/shop/retail-orders/${retail.id}`,{cookie:owner})).value.order;
    const retailLine=retail.lines.find(row=>row.id===line.lineId);
    await json(`/api/shop/retail-orders/${retail.id}/lines/${line.lineId}/verify`,{method:'POST',cookie:owner,body:{available:true,fitment:true,expectedRevision:retailLine.revision}});
    const cart=(await json('/api/shop/retail-carts',{cookie:owner})).value.carts.find(row=>row.id===vendor.id);
    assert.equal(cart.eligible,true);
    const target=makePurchaseTarget('retail',vendor.id,vendor.id,cart.items);
    const reviewed={confirmText:'ORDER WSM',lines:cart.items.map(row=>({id:row.id,sku:row.vendor_sku,quantity:row.quantity,unitCostCents:row.unit_cost_cents,confirmed:true}))};
    await json(`/api/shop/retail-carts/${vendor.id}/queue`,{method:'POST',cookie:owner,body:reviewed,expected:403});
    const wrongTarget={...target,lines:target.lines.map(row=>({...row,sku:'TEST-DIFFERENT-EXACT-SKU'}))};
    const wrongRequest=(await json('/api/management/purchase-requests',{method:'POST',cookie:owner,body:{totalCents:cart.total_cents,workOrderIds:[],context:'purchase',reason:'Separate target must not authorize this cart',target:wrongTarget,idempotencyKey:crypto.randomUUID()},expected:201})).value.request;
    await json(`/api/management/purchase-requests/${wrongRequest.id}/decision`,{method:'POST',cookie:managerCookie,body:{decision:'approve',reason:'Approved only the separately specified target'}});
    await json(`/api/shop/retail-carts/${vendor.id}/queue`,{method:'POST',cookie:owner,body:{...reviewed,purchaseApprovalId:wrongRequest.id},expected:403});
    const requested=(await json('/api/management/purchase-requests',{method:'POST',cookie:owner,body:{totalCents:cart.total_cents,workOrderIds:[],context:'purchase',reason:'Exact verified retail cart approval',target,idempotencyKey:crypto.randomUUID()},expected:201})).value.request;
    await json(`/api/management/purchase-requests/${requested.id}/decision`,{method:'POST',cookie:owner,body:{decision:'approve',reason:'Self approval must be rejected'},expected:403});
    await json(`/api/management/purchase-requests/${requested.id}/decision`,{method:'POST',cookie:managerCookie,body:{decision:'approve',reason:'Independent manager checked exact lines'}});
    const queued=(await json(`/api/shop/retail-carts/${vendor.id}/queue`,{method:'POST',cookie:owner,body:{...reviewed,purchaseApprovalId:requested.id},expected:202})).value;
    assert.equal(queued.status,'queued_not_purchased');
    const overview=(await json('/api/management/overview',{cookie:owner})).value;
    assert.equal(overview.purchaseRequests.find(row=>row.id===requested.id).status,'consumed');
    assert.equal(overview.purchaseRequests.find(row=>row.id===wrongRequest.id).status,'approved','failed mismatch cannot consume a different purchase approval');

    const recovery=(await json(`/api/security/users/${manager.id}/recovery`,{method:'POST',cookie:owner,body:{confirm:true},expected:201})).value;
    const recoveryPath=new URL(recovery.recoveryUrl).pathname;
    await json(recoveryPath,{method:'POST',body:{password:'Recovered-Manager-Test-2026!'}});
    assert.equal((await json('/api/me',{cookie:managerCookie})).value.user,null,'recovery revokes previous employee sessions');
    await json(recoveryPath,{method:'POST',body:{password:'Another-Recovery-Test-2026!'},expected:400});
    await login('launch-manager','Recovered-Manager-Test-2026!');
  } catch(error) {
    error.message += `\nIsolated server output:\n${logs}`;
    throw error;
  } finally {
    if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('close',resolve)),wait(2000)]);if(child.exitCode===null)child.kill('SIGKILL');}
    fs.rmSync(root,{recursive:true,force:true});
  }
});

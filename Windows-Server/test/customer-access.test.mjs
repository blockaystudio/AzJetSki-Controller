import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {openDb} from '../src/db.mjs';
import {createCustomerAccess} from '../src/customer-access.mjs';

function fixture() {
  const db=openDb(':memory:'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'customer-access-'));
  const owner={id:Number(db.prepare("INSERT INTO users(username,password_hash,salt,role) VALUES('owner','hash','salt','owner')").run().lastInsertRowid),username:'owner',role:'owner'};
  const job=Number(db.prepare("INSERT INTO work_orders(ref_number,customer_name,unit_label,stage,assigned_user_id) VALUES('WO-ONE','Alice Customer','Yamaha VX','Diagnosing',?)").run(owner.id).lastInsertRowid);
  const other=Number(db.prepare("INSERT INTO work_orders(ref_number,customer_name,unit_label,stage) VALUES('WO-TWO','Other Customer','Private unit','Intake')").run().lastInsertRowid);
  db.exec(`CREATE TABLE ot_invoices(id INTEGER PRIMARY KEY,work_order_id INTEGER,number TEXT,snapshot_json TEXT,issued_at TEXT,voided_at TEXT)`);
  db.prepare('INSERT INTO ot_invoices VALUES(1,?,?,?,CURRENT_TIMESTAMP,NULL)').run(job,'INV-ONE',JSON.stringify({refNumber:'WO-ONE',estimateCents:10000,items:[{description:'Wear ring',qty:1,amount:100}]}));
  db.prepare('INSERT INTO ot_invoices VALUES(2,?,?,?,CURRENT_TIMESTAMP,NULL)').run(other,'INV-TWO',JSON.stringify({refNumber:'WO-TWO',estimateCents:20000,items:[{description:'Other customer invoice',qty:1,amount:200}]}));
  let user=owner,time=Date.now();
  const json=(res,status,value,headers)=>{res.status=status;res.value=value;res.headers=headers;};
  const access=createCustomerAccess({db,currentUser:()=>user,json,readBody:async req=>req.body || {},publicBaseUrl:'https://shop.example.test',uploadDir:dir,now:()=>time});
  const request=async(pathname,method='GET',body)=>{
    const res={headers:{},writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};
    const handled=await access.routes({method,body,headers:{}},res,pathname);
    return {...res,handled};
  };
  const addMedia=(workOrder,visible,name)=>{
    const stored=crypto.randomUUID()+'.jpg';fs.writeFileSync(path.join(dir,stored),Buffer.from('jpeg-test-'+name));
    return Number(db.prepare("INSERT INTO media(work_order_id,original_name,stored_name,mime_type,size_bytes,caption,customer_visible) VALUES(?,?,?,'image/jpeg',8,?,?)").run(workOrder,name,stored,name,visible).lastInsertRowid);
  };
  return {db,owner,job,other,access,request,addMedia,setUser:value=>user=value,advance:ms=>time+=ms,close(){db.close();fs.rmSync(dir,{recursive:true,force:true});}};
}

test('customer portal shows only its work order and customer-visible updates/photos with no caching',async()=>{
  const f=fixture();
  try {
    f.db.prepare("INSERT INTO work_order_updates(work_order_id,author_name,title,body,customer_visible) VALUES(?,'Advisor','Visible update','Parts ordered',1)").run(f.job);
    f.db.prepare("INSERT INTO work_order_updates(work_order_id,author_name,title,body,customer_visible) VALUES(?,'Advisor','Private title','Internal cost and supplier password',0)").run(f.job);
    f.db.prepare("INSERT INTO work_order_updates(work_order_id,author_name,title,body,customer_visible) VALUES(?,'Advisor','Other private job','Wrong customer',1)").run(f.other);
    const visible=f.addMedia(f.job,1,'Visible photo'),hidden=f.addMedia(f.job,0,'Internal photo'),other=f.addMedia(f.other,1,'Wrong customer photo');
    const token=new URL(f.access.createLink(f.job)).pathname.split('/').pop();
    const portal=await f.request('/portal/'+token);
    assert.equal(portal.status,200);assert.equal(portal.headers['cache-control'],'no-store');
    assert.match(portal.body,/Visible update|Parts ordered/);assert.match(portal.body,/Visible photo/);
    assert.doesNotMatch(portal.body,/Internal cost|supplier password|Other private job|Wrong customer|Internal photo/);
    assert.equal((await f.request(`/portal/${token}/media/${visible}`)).status,200);
    assert.equal((await f.request(`/portal/${token}/media/${hidden}`)).status,404);
    assert.equal((await f.request(`/portal/${token}/media/${other}`)).status,404);
    assert.equal((await f.request(`/portal/${token}/invoices/1`)).status,404);
  }finally{f.close();}
});

test('document-enabled links remain scoped to their own active invoices and expire at the exact time',async()=>{
  const f=fixture();
  try {
    const token=new URL(f.access.createLink(f.job,{scope:'documents',days:1})).pathname.split('/').pop();
    const invoice=await f.request(`/portal/${token}/invoices/1`);assert.equal(invoice.status,200);assert.match(invoice.body,/Wear ring/);
    assert.equal((await f.request(`/portal/${token}/invoices/2`)).status,404);
    f.db.prepare('UPDATE ot_invoices SET voided_at=CURRENT_TIMESTAMP WHERE id=1').run();assert.equal((await f.request(`/portal/${token}/invoices/1`)).status,404);
    f.advance(24*3600_000);assert.equal((await f.request(`/portal/${token}`)).status,404);
  }finally{f.close();}
});

test('staff link creation and revocation require authorized work-order access, strict confirmation and no token disclosure in history',async()=>{
  const f=fixture();
  try {
    f.setUser(null);assert.equal((await f.request(`/api/work-orders/${f.job}/customer-link`,'POST',{})).status,401);
    f.setUser({id:22,username:'other-tech',role:'technician'});assert.equal((await f.request(`/api/work-orders/${f.job}/customer-link`,'POST',{})).status,403);
    f.setUser(f.owner);
    const created=await f.request(`/api/work-orders/${f.job}/customer-link`,'POST',{scope:'documents',days:3});assert.equal(created.status,200);
    const token=new URL(created.value.portalUrl).pathname.split('/').pop();
    const history=await f.request(`/api/work-orders/${f.job}/customer-links`);assert.equal(history.status,200);
    assert.doesNotMatch(JSON.stringify(history.value),new RegExp(token));
    const id=history.value.links[0].id;
    const url=`/api/work-orders/${f.job}/customer-links/${id}/revoke`;
    assert.equal((await f.request(url,'POST',{confirm:'true',reason:'Customer requested revocation'})).status,400);
    assert.equal((await f.request(url,'POST',{confirm:true,reason:'Customer requested revocation'})).status,200);
    assert.equal((await f.request('/portal/'+token)).status,404);
    assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT detail FROM audit_log').all()),new RegExp(token));
  }finally{f.close();}
});

test('legacy unlimited links get bounded expiry and untrusted customer content is escaped',async()=>{
  const f=fixture();
  try {
    f.db.prepare("UPDATE work_orders SET customer_name='<script>steal()</script>' WHERE id=?").run(f.job);
    const token=new URL(f.access.createLink(f.job)).pathname.split('/').pop();
    const portal=await f.request('/portal/'+token);assert.doesNotMatch(portal.body,/<script>/);assert.match(portal.body,/&lt;script&gt;/);
    assert.equal((await f.request(`/portal/${token}/unknown/1`)).status,404);
    assert.equal((await f.request('/portal/'+token,'POST',{})).status,405);
    assert.throws(()=>f.access.createLink(f.job,{days:0}),/1 to 90/);
    assert.throws(()=>f.access.createLink(f.job,{scope:'all-staff-records'}),/status\/documents/);
  }finally{f.close();}
});

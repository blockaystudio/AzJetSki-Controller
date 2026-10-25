import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../src/db.mjs';
import {extendDatabase,posRoutes} from '../src/pos-extension.mjs';
import {installShopOps} from '../src/shop-ops.mjs';
import {installEditRevisions,requireEditRevision,editRevisionTarget,withEditRevisions,revisionEtag} from '../src/edit-revisions.mjs';
import {rememberEditRevisions,captureEditRevision,prepareRevisionRequest} from '../public/edit-revisions-ui.js';

function fixture() {
  const db=openDb(':memory:');extendDatabase(db);installShopOps(db);installEditRevisions(db);
  db.exec('PRAGMA recursive_triggers=ON');
  const owner={id:Number(db.prepare("INSERT INTO users(username,password_hash,salt,role) VALUES('revision-owner','unused','unused','owner')").run().lastInsertRowid),username:'revision-owner',role:'owner'};
  const customer=Number(db.prepare("INSERT INTO customers(name,address_line1,city,state,postal_code) VALUES('Original','1 Test St','Phoenix','AZ','85001')").run().lastInsertRowid);
  const vehicle=Number(db.prepare("INSERT INTO vehicles(customer_id,make,model) VALUES(?,'Yamaha','VX')").run(customer).lastInsertRowid);
  const order=Number(db.prepare("INSERT INTO work_orders(source,customer_id,vehicle_id,estimate_total) VALUES('manual',?,?,100)").run(customer,vehicle).lastInsertRowid);
  const line=Number(db.prepare("INSERT INTO work_order_lines(work_order_id,description,qty,rate,amount) VALUES(?,'Labor',1,100,100)").run(order).lastInsertRowid);
  const retail=Number(db.prepare("INSERT INTO retail_special_orders(customer_id,invoice_number) VALUES(?,'REVISION-RETAIL')").run(customer).lastInsertRowid);
  const retailLine=Number(db.prepare("INSERT INTO retail_special_lines(retail_order_id,description,quantity,unit_price_cents) VALUES(?,'Part',1,10000)").run(retail).lastInsertRowid);
  const revision=(table,id)=>db.prepare(`SELECT revision FROM ${table} WHERE id=?`).get(id).revision;
  const req=(method,version)=>({method,headers:version===undefined?{}:{'if-match':String(version)}});
  return {db,owner,customer,vehicle,order,line,retail,retailLine,revision,req};
}

test('all six record tables invalidate stale edits from alternate writers within the same timestamp',()=>{
  const f=fixture();
  try {
    for(const [table,id,column,next,path]of[
      ['customers',f.customer,'name','Updated','/api/pos/customers/'+f.customer],
      ['vehicles',f.vehicle,'model','FX','/api/pos/vehicles/'+f.vehicle],
      ['work_orders',f.order,'stage','Ready','/api/work-orders/'+f.order],
      ['work_order_lines',f.line,'description','Revised labor','/api/pos/lines/'+f.line],
      ['retail_special_orders',f.retail,'notes','Revised note','/api/shop/retail-orders/'+f.retail],
      ['retail_special_lines',f.retailLine,'description','Different part',`/api/shop/retail-orders/${f.retail}/lines/${f.retailLine}`]
    ]){
      const original=f.revision(table,id);
      f.db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(next,id);
      assert.ok(f.revision(table,id)>original,table);
      assert.throws(()=>requireEditRevision(f.db,f.req('PATCH',original),path,{}, {required:true}),error=>error.status===409&&error.currentRevision===f.revision(table,id));
    }
  }finally{f.db.close();}
});

test('no-op and timestamp-only account refreshes do not invalidate editors, recursive triggers terminate',()=>{
  const f=fixture();
  try{
    const before=f.revision('work_orders',f.order);
    f.db.prepare("UPDATE work_orders SET estimate_total=estimate_total,updated_at='2099-01-01' WHERE id=?").run(f.order);
    assert.equal(f.revision('work_orders',f.order),before);
    f.db.prepare('UPDATE work_orders SET balance=50 WHERE id=?').run(f.order);
    assert.equal(f.revision('work_orders',f.order),before+1);
    assert.throws(()=>f.db.prepare('UPDATE work_orders SET revision=1 WHERE id=?').run(f.order),/revision/);
    assert.throws(()=>f.db.prepare('UPDATE work_orders SET revision=revision+8 WHERE id=?').run(f.order),/revision/);
    installEditRevisions(f.db);
    assert.equal(f.revision('work_orders',f.order),before+1,'rerunning migration preserves versions');
  }finally{f.db.close();}
});

test('zero-price line changes invalidate the parent order even when accounting totals are unchanged',()=>{
  const f=fixture();
  try{
    const orderRevision=f.revision('work_orders',f.order);
    const lineRevision=f.revision('work_order_lines',f.line);
    f.db.prepare("UPDATE work_order_lines SET description='New agreed scope' WHERE id=?").run(f.line);
    assert.equal(f.revision('work_order_lines',f.line),lineRevision+1);
    assert.equal(f.revision('work_orders',f.order),orderRevision+1);
    f.db.prepare('DELETE FROM work_order_lines WHERE id=?').run(f.line);
    assert.equal(f.revision('work_orders',f.order),orderRevision+2);
  }finally{f.db.close();}
});

test('revision preconditions distinguish missing, malformed, mismatched and stale records',()=>{
  const f=fixture();
  try{
    const path='/api/pos/customers/'+f.customer,revision=f.revision('customers',f.customer);
    assert.throws(()=>requireEditRevision(f.db,f.req('PATCH'),path,{}, {required:true}),error=>error.status===428);
    assert.throws(()=>requireEditRevision(f.db,f.req('PATCH','*'),path,{}, {required:true}),error=>error.status===400);
    assert.throws(()=>requireEditRevision(f.db,f.req('PATCH','W/"1"'),path,{}, {required:true}),error=>error.status===400);
    assert.throws(()=>requireEditRevision(f.db,f.req('PATCH',revision),path,{expectedRevision:revision+1},{required:true}),error=>error.status===400);
    assert.throws(()=>requireEditRevision(f.db,f.req('PATCH','"vehicles:1:1"'),path,{}, {required:true}),error=>error.status===409);
    assert.equal(requireEditRevision(f.db,f.req('PATCH'),path,{expectedRevision:revision},{required:true}).currentRevision,revision);
    assert.equal(requireEditRevision(f.db,f.req('PATCH'),path,{}, {required:false}).currentRevision,revision);
    assert.throws(()=>requireEditRevision(f.db,f.req('PATCH',revision),'/api/pos/customers/999',{}, {required:true}),error=>error.status===404);
    assert.equal(requireEditRevision(f.db,f.req('POST'),'/api/pos/work-orders/1/payments',{}, {required:true}),null,'payment ledger controls have their own atomic invariants');
    assert.equal(editRevisionTarget('POST','/approval/customer-token',{}),null,'customer signing does not inherit staff edit headers');
  }finally{f.db.close();}
});

test('two simultaneous customer editors cannot silently overwrite the first successful write',async()=>{
  const f=fixture();const prior=process.env.REQUIRE_EDIT_REVISION;
  process.env.REQUIRE_EDIT_REVISION='true';
  try{
    const route=posRoutes({db:f.db,currentUser:()=>f.owner,json:(res,status,payload)=>Object.assign(res,{status,payload}),readBody:async req=>req.body});
    const revision=f.revision('customers',f.customer),path='/api/pos/customers/'+f.customer;
    const requests=['First desk','Second desk'].map(name=>({method:'PATCH',headers:{'if-match':revisionEtag('customers',f.customer,revision)},body:{name}}));
    const responses=[{},{}];
    await Promise.all(requests.map((req,index)=>route(req,responses[index],path,new URL('http://test'+path))));
    assert.deepEqual(responses.map(res=>res.status),[200,409]);
    assert.equal(f.db.prepare('SELECT name FROM customers WHERE id=?').get(f.customer).name,'First desk');
    assert.equal(responses[1].payload.currentRevision,revision+1);
  }finally{if(prior===undefined)delete process.env.REQUIRE_EDIT_REVISION;else process.env.REQUIRE_EDIT_REVISION=prior;f.db.close();}
});

test('explicit-select responses expose edit versions without exposing extra customer fields',()=>{
  const f=fixture();
  try{
    const value=withEditRevisions(f.db,{customers:[{id:f.customer,name:'Display'}],workOrder:{id:f.order,lines:[{id:f.line,work_order_id:f.order}]},order:{id:f.retail,invoice_number:'REVISION-RETAIL',lines:[{id:f.retailLine,retail_order_id:f.retail}]}});
    assert.equal(value.customers[0].revision,f.revision('customers',f.customer));
    assert.equal(value.workOrder.lines[0].revision,f.revision('work_order_lines',f.line));
    assert.equal(value.order.lines[0].revision,f.revision('retail_special_lines',f.retailLine));
    assert.deepEqual(Object.keys(value.customers[0]).sort(),['id','name','revision']);
  }finally{f.db.close();}
});

test('rejected itemized-order and sale-line changes leave related records untouched',async()=>{
  const f=fixture();const prior=process.env.REQUIRE_EDIT_REVISION;process.env.REQUIRE_EDIT_REVISION='true';
  try{
    const route=posRoutes({db:f.db,currentUser:()=>f.owner,json:(res,status,payload)=>Object.assign(res,{status,payload}),readBody:async req=>req.body||{}});
    const otherCustomer=Number(f.db.prepare("INSERT INTO customers(name) VALUES('Another customer')").run().lastInsertRowid);
    const otherVehicle=Number(f.db.prepare("INSERT INTO vehicles(customer_id,make) VALUES(?,'Sea-Doo')").run(otherCustomer).lastInsertRowid);
    const path='/api/pos/work-orders/'+f.order,version=f.revision('work_orders',f.order),res={};
    await route({method:'PATCH',headers:{'if-match':String(version)},body:{estimate_total:50,customer_id:otherCustomer,vehicle_id:otherVehicle}},res,path,new URL('http://test'+path));
    assert.equal(res.status,409);
    assert.equal(f.db.prepare('SELECT customer_id FROM work_orders WHERE id=?').get(f.order).customer_id,f.customer);
    assert.equal(f.revision('work_orders',f.order),version);
    const requirement=Number(f.db.prepare("INSERT INTO part_requirements(work_order_id,source,source_key,description,qty_needed) VALUES(?,'pos',?,'Existing requirement',1)").run(f.order,`pos-line-${f.line}`).lastInsertRowid);
    f.db.prepare("INSERT INTO pos_payments(work_order_id,method,amount_cents,idempotency_key,verified_by) VALUES(?,'cash',10000,'revision-paid-fixture',?)").run(f.order,f.owner.id);
    const linePath='/api/pos/lines/'+f.line,lineRes={};
    await route({method:'DELETE',headers:{'if-match':String(f.revision('work_order_lines',f.line))},body:{}},lineRes,linePath,new URL('http://test'+linePath));
    assert.equal(lineRes.status,409);
    assert.ok(f.db.prepare('SELECT id FROM part_requirements WHERE id=?').get(requirement));
    assert.ok(f.db.prepare('SELECT id FROM work_order_lines WHERE id=?').get(f.line));
  }finally{if(prior===undefined)delete process.env.REQUIRE_EDIT_REVISION;else process.env.REQUIRE_EDIT_REVISION=prior;f.db.close();}
});

test('a rendered form retains its original version despite a later background list refresh',()=>{
  const form={dataset:{}};
  rememberEditRevisions({customer:{id:431,revision:2}});
  captureEditRevision(form,'customers',{id:431,revision:2});
  rememberEditRevisions({customers:[{id:431,revision:3}]});
  const request=prepareRevisionRequest('/api/pos/customers/431',{method:'PATCH',body:JSON.stringify({name:'My change'})},{form});
  assert.equal(request.headers['if-match'],'"customers:431:2"');
  assert.equal(prepareRevisionRequest('/api/pos/customers/431',{method:'PATCH',body:'{}'}).headers['if-match'],'"customers:431:3"');
  assert.throws(()=>prepareRevisionRequest('/api/pos/customers/432',{method:'PATCH',body:'{}'}),/Reload/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {prepareRevisionRequest,rememberEditRevisions,editConflictMessage} from '../public/edit-revisions-ui.js';
import {createRequestAttempts,repairInvoiceDetails} from '../public/invoice-ui.js';

const source=fs.readFileSync(new URL('../public/billing.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({intercept=async()=>null,mount=async()=>{}}={}){
  const nodes=new Map(),requests=[];
  class Element {
    constructor(id='',tagName='DIV'){this.id=id;this.tagName=tagName;this.value='';this.checked=false;this.disabled=false;this.style={};this.dataset={};this.elements=[];this._html='';this.textContent='';}
    set innerHTML(value){this._html=value;if(this.id==='p1Invoice')this.value=value.match(/value="(\d+)"/)?.[1]||'';}
    get innerHTML(){return this._html;}
    reset(){for(const field of this.elements){field.value=field.defaultValue||'';field.checked=false;}}
    replaceChildren(){this.innerHTML='';this.textContent='';this.value='';}
    setAttribute(name,value){this[name]=value;}removeAttribute(name){delete this[name];}
    closest(){return {after:node=>nodes.set('#'+node.id,node)};}
    remove(){nodes.delete('#'+this.id);}
  }
  for(const id of ['jobs','jobinfo','intStatus','invoiceForm','payForm','p1Form','signForm','checkSign','pdfPreview','recipient','sendEmail','signer','signEmail','signScope','p1Invoice','payments','invoices','signHistory','invoiceResult','p1Result','signResult','invoiceMeaning','refresh','copyLink','mailto'])nodes.set('#'+id,new Element(id));
  const fields=(formId,spec)=>{
    const form=nodes.get('#'+formId);
    for(const [id,name,value='',type='text']of spec){const field=nodes.get('#'+id)||new Element(id,'INPUT');field.tagName='INPUT';field.name=name;field.value=value;field.defaultValue=value;field.type=type;nodes.set('#'+id,field);form.elements.push(field);form.elements[name]=field;}
    const button=new Element(formId+'Button','BUTTON');form.elements.push(button);nodes.set('#'+formId+' button',button);
  };
  fields('invoiceForm',[['recipient','email'],['sendEmail','sendEmail','','checkbox']]);
  fields('payForm',[['payMethod','method','cash'],['payAmount','amount'],['payReference','reference'],['payVerified','verified','','checkbox']]);
  fields('p1Form',[['p1Invoice','invoice'],['p1Method','method','dejavoo_p1_terminal'],['p1Amount','amount']]);
  fields('signForm',[['signer','name'],['signEmail','email'],['signScope','description']]);
  class FakeFormData {constructor(form){this.values=form.elements.filter(x=>x.name&&!x.disabled&&(x.type!=='checkbox'||x.checked)).map(x=>[x.name,x.type==='checkbox'?'on':x.value]);}[Symbol.iterator](){return this.values[Symbol.iterator]();}}
  const fetch=async(url,options)=>{
    const body=options.body?JSON.parse(options.body):undefined;requests.push({url,options,body});
    const custom=await intercept(url,options,body);if(custom)return custom;
    let result={};
    if(url==='/api/me')result={user:{role:'owner'}};
    else if(url==='/api/billing/integration-status')result={dejavoo:{},docusign:{},basePublicHttps:true};
    else if(url==='/api/work-orders')result={workOrders:[{id:1,source:'manual',customer_name:'First customer'},{id:2,source:'manual',customer_name:'Second customer'}]};
    else if(options.method==='POST')result={id:1,packetId:1,status:'prepared',notice:'Prepared',number:'INV-ONE',amount:100,link:'https://test/invoice/one',subject:'Invoice',customerEmail:'one@example.test',message:'Invoice one',deliveryStatus:'not_requested'};
    else if(/^\/api\/work-orders\/\d+$/.test(url)){const id=Number(url.split('/').at(-1));result={workOrder:{id,revision:id+4,source:'manual',customer_name:id===1?'First customer':'Second customer',email:`customer${id}@example.test`,complaint:'Repair pump',estimate_total:100}};}
    else if(url.endsWith('/payments'))result={totals:{paid:0,balance:100,pending:0,refundDue:0}};
    else if(url.endsWith('/invoices'))result={invoices:[]};
    else if(url.endsWith('/docusign'))result={packets:[]};
    return {ok:true,json:async()=>result};
  };
  const context=vm.createContext({document:{querySelector:selector=>nodes.get(selector)||null,createElement:tag=>new Element('',tag.toUpperCase())},location:{search:''},URLSearchParams,fetch,crypto,FormData:FakeFormData,prepareRevisionRequest,rememberEditRevisions,editConflictMessage,createRequestAttempts,repairInvoiceDetails,financePanel:()=>'<p>Payment history</p>',bindFinancePanel(){},mountAuthorizations:mount,confirm:()=>true,alert(){},navigator:{clipboard:{writeText:async()=>{}}},prompt(){},console});
  vm.runInContext(source,context);
  return {nodes,requests,async ready(){for(let i=0;i<5;i++)await tick();},select(id){nodes.get('#jobs').value=String(id);return nodes.get('#jobs').onchange();},submit(id){const form=nodes.get('#'+id);return form.onsubmit({preventDefault(){},currentTarget:form});}};
}

test('actual billing module immediately clears selection, amounts and actions and blocks old-job submissions',async()=>{
  const f=fixture();await f.ready();assert.match(f.nodes.get('#jobinfo').innerHTML,/First customer/);
  f.nodes.get('#payAmount').value='99.50';f.nodes.get('#signScope').value='Old scope';
  await f.select('');
  assert.equal(f.nodes.get('#payAmount').value,'');assert.equal(f.nodes.get('#signScope').value,'');assert.equal(f.nodes.get('#recipient').value,'');
  for(const id of ['invoiceForm','payForm','p1Form','signForm'])assert.ok(f.nodes.get('#'+id).elements.every(field=>field.disabled));
  assert.equal(f.nodes.get('#checkSign').disabled,true);assert.equal(f.nodes.get('#pdfPreview').href,undefined);
  for(const id of ['invoiceForm','payForm','p1Form','signForm'])await f.submit(id);
  await f.nodes.get('#checkSign').onclick();
  assert.equal(f.requests.filter(x=>x.options.method==='POST').length,0);
});

test('late job responses cannot overwrite the newest selection or enable stale actions',async()=>{
  let release;const stalled=new Promise(resolve=>release=resolve);
  const f=fixture({intercept:async(url,options)=>{if(url==='/api/work-orders/1'&&options.method==='GET')await stalled;}});
  await f.ready();assert.ok(f.nodes.get('#invoiceForm').elements.every(field=>field.disabled));
  await f.submit('invoiceForm');assert.equal(f.requests.filter(x=>x.options.method==='POST').length,0);
  await f.select(2);assert.match(f.nodes.get('#jobinfo').innerHTML,/Second customer/);
  release();await f.ready();assert.match(f.nodes.get('#jobinfo').innerHTML,/Second customer/);assert.equal(f.nodes.get('#recipient').value,'customer2@example.test');
  await f.submit('invoiceForm');const invoice=f.requests.find(x=>x.options.method==='POST');assert.equal(invoice.url,'/api/pos/work-orders/2/invoices');assert.equal(invoice.body.expectedRevision,6);
});

test('late authorization rendering stays detached when billing is deselected during load',async()=>{
  let release,entered;const started=new Promise(resolve=>entered=resolve),stalled=new Promise(resolve=>release=resolve);
  const f=fixture({mount:async(_container,id)=>{if(id===1){entered();await stalled;}}});await started;
  await f.select('');release();await f.ready();assert.equal(f.nodes.has('#billingAuthorizations'),false);
  assert.ok(f.nodes.get('#invoiceForm').elements.every(field=>field.disabled));await f.submit('signForm');assert.equal(f.requests.filter(x=>x.options.method==='POST').length,0);
});

test('invoice retry after a lost response retains request key and the originally reviewed revision',async()=>{
  let attempts=0;const f=fixture({intercept:async(_url,options)=>{if(options.method==='POST'&&attempts++===0)throw Error('Response lost');}});await f.ready();
  f.nodes.get('#recipient').value='reviewed@example.test';await f.submit('invoiceForm');await f.submit('invoiceForm');
  const posts=f.requests.filter(x=>x.options.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].body.idempotencyKey,posts[1].body.idempotencyKey);assert.equal(posts[1].body.email,'reviewed@example.test');
  assert.equal(posts[0].options.headers['if-match'],'"work_orders:1:5"');assert.equal(posts[1].body.expectedRevision,5);
});

test('payment fields remain serializable while busy and are bound to the currently loaded job',async()=>{
  const f=fixture();await f.ready();await f.select(2);f.nodes.get('#payAmount').value='10.50';f.nodes.get('#payVerified').checked=true;
  await f.submit('payForm');const post=f.requests.find(x=>x.options.method==='POST');assert.equal(post.url,'/api/pos/work-orders/2/payments');assert.equal(post.body.amount,'10.50');assert.equal(post.body.method,'cash');assert.equal(post.body.verified,true);assert.ok(post.body.idempotencyKey);
});

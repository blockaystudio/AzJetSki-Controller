// Capture the version shown to the employee; never fetch a fresh version during
// save, because doing so would silently authorize overwriting a newer edit.
const versions = new Map();
const forms = new WeakMap();
const tables = new Set(['customers','vehicles','work_orders','work_order_lines','retail_special_orders','retail_special_lines']);
const key = (table,id) => `${table}:${Number(id)}`;

function targetFor(method, pathname, body={}) {
  const verb=String(method||'GET').toUpperCase(),path=String(pathname).split('?')[0];let match;
  if (verb==='PATCH'||verb==='DELETE') for(const [pattern,table] of [
    [/^\/api\/pos\/customers\/(\d+)$/,'customers'],[/^\/api\/pos\/vehicles\/(\d+)$/,'vehicles'],
    [/^\/api\/(?:pos\/)?work-orders\/(\d+)$/,'work_orders'],[/^\/api\/pos\/lines\/(\d+)$/,'work_order_lines'],
    [/^\/api\/shop\/retail-orders\/(\d+)$/,'retail_special_orders'],[/^\/api\/shop\/retail-orders\/\d+\/lines\/(\d+)$/,'retail_special_lines']
  ])if((match=path.match(pattern)))return {table,id:Number(match[1])};
  if(verb==='POST'){
    if((match=path.match(/^\/api\/pos\/work-orders\/(\d+)\/lines$/)))return {table:'work_orders',id:Number(match[1])};
    if((match=path.match(/^\/api\/work-orders\/(\d+)\/(ready|request-approval)$/)))return {table:'work_orders',id:Number(match[1])};
    if((match=path.match(/^\/api\/work-orders\/(\d+)\/updates$/))&&Object.hasOwn(body,'stage'))return {table:'work_orders',id:Number(match[1])};
    if((match=path.match(/^\/api\/shop\/retail-orders\/(\d+)\/(lines|issue-invoice)$/)))return {table:'retail_special_orders',id:Number(match[1])};
    if((match=path.match(/^\/api\/shop\/retail-orders\/\d+\/lines\/(\d+)\/(verify|status)$/)))return {table:'retail_special_lines',id:Number(match[1])};
  }
  return null;
}

export function rememberEditRevisions(value, context='') {
  if(Array.isArray(value)){value.forEach(item=>rememberEditRevisions(item,context));return value;}
  if(!value||typeof value!=='object')return value;
  let table=({customer:'customers',customers:'customers',vehicle:'vehicles',vehicles:'vehicles',workOrder:'work_orders',workOrders:'work_orders',recent:'work_orders',line:'work_order_lines'})[context];
  if(context==='lines')table=Object.hasOwn(value,'retail_order_id')?'retail_special_lines':Object.hasOwn(value,'work_order_id')?'work_order_lines':null;
  if(context==='order'&&Object.hasOwn(value,'invoice_number'))table='retail_special_orders';
  if(table&&Number.isSafeInteger(value.id)&&Number.isSafeInteger(value.revision))versions.set(key(table,value.id),value.revision);
  for(const [name,item]of Object.entries(value))rememberEditRevisions(item,name);
  return value;
}

// Call once immediately after rendering an edit form, using that form's record.
// The captured revision survives unrelated list refreshes while it stays open.
export function captureEditRevision(form, table, record) {
  if(!tables.has(table)||!Number.isSafeInteger(Number(record?.id))||!Number.isSafeInteger(Number(record?.revision)))throw Error('Reload this record before editing.');
  forms.set(form,{table,id:Number(record.id),revision:Number(record.revision)});
  form.dataset.editRecord=key(table,record.id);
  form.dataset.editRevision=String(record.revision);
}

export function editRevisionHeaders(method, pathname, body={}, {form, record}={}) {
  const target=targetFor(method,pathname,body);
  if(!target)return {};
  const captured=form?forms.get(form):null;
  const explicit=record&&Number(record.id)===target.id?Number(record.revision):null;
  let revision=captured&&captured.table===target.table&&captured.id===target.id?captured.revision:explicit;
  if(!Number.isSafeInteger(revision))revision=versions.get(key(target.table,target.id));
  if(!Number.isSafeInteger(revision))throw Error('Reload this record before saving; no edit revision is available.');
  return {'if-match':`"${target.table}:${target.id}:${revision}"`};
}

export function prepareRevisionRequest(pathname, options={}, context={}) {
  let body={};
  if(typeof options.body==='string'&&options.body)try{body=JSON.parse(options.body);}catch{}
  const revisionHeaders=editRevisionHeaders(options.method||'GET',pathname,body,context);
  return {...options,headers:{...Object.fromEntries(new Headers(options.headers||{})),...revisionHeaders}};
}

export function editConflictMessage(response, result) {
  return response.status===409&&result?.currentRevision
    ? 'Another employee changed this record. Your changes have not been saved. Refresh the record and review your edits before saving again.'
    : response.status===428?'Refresh this record before editing; the original version is missing.':null;
}

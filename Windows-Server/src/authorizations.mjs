import {requireEditRevision} from './edit-revisions.mjs';
import {assertJobStageChange} from './job-policy.mjs';
// Retained, versioned customer authorizations. Records are local to the shop;
// email delivery and provider e-signatures are separate, explicitly configured services.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {makePdf} from './payment-docs.mjs';

const roles = new Set(['owner','manager','service_writer','advisor']);
const choices = new Set(['Approve Repairs','Diagnostics/Teardown Only','Decline Repairs']);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const text = (value,max=4000) => String(value ?? '').trim().slice(0,max);
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => (Number(value)/100).toLocaleString('en-US',{style:'currency',currency:'USD'});
const error = (status,message) => {const e=new Error(message);e.status=status;throw e;};
const defaultTerms = [
  'The customer authorizes only the selected option and work described in this authorization, up to the stated estimate.',
  'Additional work or an increased amount requires a separate authorization. Diagnostic and teardown charges authorized separately remain payable if repairs are declined.',
  'Customer-supplied parts are subject to the shop warranty policy. The shop may operate, road-test, water-test, or transport the unit as reasonably necessary for diagnosis and verification.',
  'Payment for authorized services is due before release. The signer confirms authority to authorize this work and consents to electronic records and the typed electronic signature.'
];

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {const value=fn();db.exec('COMMIT');return value;} catch(e){db.exec('ROLLBACK');throw e;}
}

export function installAuthorizations(db) {
  const current=new Set(db.prepare('PRAGMA table_info(approvals)').all().map(row=>row.name));
  for(const definition of [
    "snapshot_json TEXT NOT NULL DEFAULT ''", "snapshot_sha256 TEXT NOT NULL DEFAULT ''",
    "scope_sha256 TEXT NOT NULL DEFAULT ''", "terms_version TEXT NOT NULL DEFAULT ''",
    'expires_at TEXT', 'revoked_at TEXT', "revocation_reason TEXT NOT NULL DEFAULT ''", 'revoked_by INTEGER',
    'superseded_by INTEGER', 'previous_approval_id INTEGER', 'created_by INTEGER',
    "creator_username TEXT NOT NULL DEFAULT ''", "creator_role TEXT NOT NULL DEFAULT ''",
    "signed_record_json TEXT NOT NULL DEFAULT ''", "signed_record_sha256 TEXT NOT NULL DEFAULT ''",
    "document_name TEXT NOT NULL DEFAULT ''", "document_sha256 TEXT NOT NULL DEFAULT ''"
  ]) if(!current.has(definition.split(' ')[0]))db.exec(`ALTER TABLE approvals ADD COLUMN ${definition}`);
  db.exec(`CREATE TABLE IF NOT EXISTS authorization_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,approval_id INTEGER NOT NULL REFERENCES approvals(id),
    work_order_id INTEGER NOT NULL REFERENCES work_orders(id),action TEXT NOT NULL,
    actor TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TRIGGER IF NOT EXISTS authorization_events_no_update BEFORE UPDATE ON authorization_events
      BEGIN SELECT RAISE(ABORT,'Authorization events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS authorization_events_no_delete BEFORE DELETE ON authorization_events
      BEGIN SELECT RAISE(ABORT,'Authorization events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS retained_authorizations_no_delete BEFORE DELETE ON approvals
      WHEN OLD.snapshot_json<>'' BEGIN SELECT RAISE(ABORT,'Retained authorizations cannot be deleted'); END;
    CREATE TRIGGER IF NOT EXISTS retained_authorizations_snapshot_immutable BEFORE UPDATE ON approvals
      WHEN OLD.snapshot_json<>'' AND NOT (
        NEW.work_order_id IS OLD.work_order_id AND NEW.token_hash IS OLD.token_hash
        AND NEW.snapshot_json IS OLD.snapshot_json AND NEW.snapshot_sha256 IS OLD.snapshot_sha256
        AND NEW.scope_sha256 IS OLD.scope_sha256 AND NEW.terms_version IS OLD.terms_version
        AND NEW.authorized_description IS OLD.authorized_description AND NEW.expires_at IS OLD.expires_at
        AND NEW.created_by IS OLD.created_by AND NEW.creator_username IS OLD.creator_username
        AND NEW.creator_role IS OLD.creator_role AND NEW.created_at IS OLD.created_at
        AND NEW.previous_approval_id IS OLD.previous_approval_id)
      BEGIN SELECT RAISE(ABORT,'Authorization snapshot is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS retained_authorizations_signature_immutable BEFORE UPDATE ON approvals
      WHEN OLD.signed_record_json<>'' AND NOT (
        NEW.signed_record_json IS OLD.signed_record_json AND NEW.signed_record_sha256 IS OLD.signed_record_sha256
        AND NEW.choice IS OLD.choice AND NEW.signer_name IS OLD.signer_name AND NEW.signed_at IS OLD.signed_at
        AND NEW.document_name IS OLD.document_name AND NEW.document_sha256 IS OLD.document_sha256
        AND NEW.status IS OLD.status)
      BEGIN SELECT RAISE(ABORT,'Signed authorization cannot be rewritten'); END;`);
}

function order(db,id) {
  const row=db.prepare('SELECT * FROM work_orders WHERE id=?').get(id);
  if(!row)error(404,'Work order not found');
  return row;
}

function scopeRecord(db,id) {
  const wo=order(db,id);
  const columns=['id','source','ref_number','customer_id','vehicle_id','customer_name','unit_label','year','make','model','serial','complaint','authorized_work','estimate_total','parts_total','labor_total','tax_rate_bps','tax_total_cents'];
  return {workOrder:Object.fromEntries(columns.map(key=>[key,wo[key]??null])),
    items:db.prepare('SELECT * FROM work_order_lines WHERE work_order_id=? ORDER BY id').all(id).map(line=>({
      id:line.id,type:line.line_type,item:line.item_ref,description:line.description,
      quantity:line.qty,rate:line.rate,amount:line.amount,taxable:line.taxable??null
    }))};
}

export function hasCurrentAuthorization(db,id) {
  const rows=db.prepare("SELECT * FROM approvals WHERE work_order_id=? AND status='completed' AND choice='Approve Repairs' AND revoked_at IS NULL AND superseded_by IS NULL AND snapshot_json<>'' ORDER BY id DESC").all(id);
  if(!rows.length)return false;
  const hash=sha(JSON.stringify(scopeRecord(db,id)));
  return rows.some(row=>row.scope_sha256===hash && row.snapshot_sha256===sha(row.snapshot_json)
    && row.signed_record_json && row.signed_record_sha256===sha(row.signed_record_json));
}

function address(customer,prefix='') {
  return {line1:customer?.[`${prefix}address_line1`]||(!prefix?customer?.address:'')||'',
    line2:customer?.[`${prefix}address_line2`]||'',city:customer?.[`${prefix}city`]||'',
    state:customer?.[`${prefix}state`]||'',postalCode:customer?.[`${prefix}postal_code`]||''};
}
function safeFile(directory,name) {
  if(!name || path.basename(name)!==name || !/^[a-zA-Z0-9_.-]+$/.test(name))error(409,'Stored authorization file path is invalid');
  const file=path.join(directory,name);
  if(fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()))error(409,'Stored authorization file is not a regular file');
  return file;
}
function audit(db,approvalId,workOrderId,action,actor,detail) {
  db.prepare('INSERT INTO authorization_events(approval_id,work_order_id,action,actor,detail_json) VALUES(?,?,?,?,?)')
    .run(approvalId,workOrderId,action,actor,JSON.stringify(detail));
  db.prepare('INSERT INTO audit_log(work_order_id,actor,action,detail) VALUES(?,?,?,?)')
    .run(workOrderId,actor,action,JSON.stringify({approvalId,...detail}));
}
function decoded(row) {
  if(!row.snapshot_json)return null;
  if(sha(row.snapshot_json)!==row.snapshot_sha256)error(409,'Authorization snapshot integrity check failed');
  const snapshot=JSON.parse(row.snapshot_json);
  if(row.signed_record_json && sha(row.signed_record_json)!==row.signed_record_sha256)error(409,'Authorization signature record integrity check failed');
  return snapshot;
}

// Callers must first authenticate their own staff or scoped customer link. This
// helper verifies the requested authorization belongs to the expected work order.
export function readRetainedAuthorizationDocument(db,approvalId,workOrderId,uploadDir=path.resolve('data/uploads')) {
  const row=db.prepare('SELECT * FROM approvals WHERE id=? AND work_order_id=?').get(approvalId,workOrderId);
  if(!row)error(404,'Authorization not found');
  const snapshot=decoded(row);
  if(!snapshot)error(409,'Legacy authorization has no retained document');
  if(!row.signed_record_json||row.status!=='completed')error(409,'Signed authorization is not yet available');
  const file=safeFile(path.resolve(uploadDir),row.document_name);
  if(!fs.existsSync(file))error(409,'Retained signed document is missing; restore it from a verified backup');
  const bytes=fs.readFileSync(file);
  if(sha(bytes)!==row.document_sha256)error(409,'Retained signed document integrity check failed');
  return {bytes,filename:`WO-${row.work_order_id}-authorization-${row.id}.pdf`,sha256:row.document_sha256};
}

export function readRetainedAuthorizationRecord(db,approvalId,workOrderId) {
  const row=db.prepare('SELECT * FROM approvals WHERE id=? AND work_order_id=?').get(approvalId,workOrderId);
  if(!row)error(404,'Authorization not found');
  decoded(row);
  if(!row.signed_record_json||row.status!=='completed')error(409,'Signed authorization is not yet available');
  // Preserve exact Unicode names/terms, unlike the base-Helvetica convenience
  // PDF renderer. Both component hashes correspond to the immutable stored text.
  const archive=`{"snapshot":${row.snapshot_json},"signature":${row.signed_record_json},"snapshotSha256":${JSON.stringify(row.snapshot_sha256)},"signedRecordSha256":${JSON.stringify(row.signed_record_sha256)},"pdfSha256":${JSON.stringify(row.document_sha256)}}`;
  return {bytes:Buffer.from(archive,'utf8'),filename:`WO-${row.work_order_id}-authorization-${row.id}-record.json`};
}

function publicStatus(row,clock) {
  if(!row.snapshot_json)return {status:409,message:'This legacy approval has no retained snapshot. Ask the shop for a new authorization.'};
  if(row.revoked_at)return {status:410,message:'This authorization link has been revoked. Contact the shop.'};
  if(row.superseded_by || row.status==='superseded')return {status:410,message:'A newer authorization replaces this request. Contact the shop for the current link.'};
  if(!row.expires_at || Date.parse(row.expires_at)<=clock())return {status:410,message:'This authorization link has expired. Contact the shop for a new link.'};
  return null;
}

function documentLines(snapshot,record,recordHash) {
  return [snapshot.shopName.toUpperCase()+' - CUSTOMER AUTHORIZATION',
    'Work order: '+(snapshot.workOrder.ref_number||snapshot.workOrder.id),
    'Customer: '+snapshot.customer.name,'Unit: '+snapshot.unit.label,'Serial / VIN / HIN: '+snapshot.unit.serial,
    'Service address: '+Object.values(snapshot.addresses.service).filter(Boolean).join(', '),
    'Billing address: '+Object.values(snapshot.addresses.billing).filter(Boolean).join(', '),
    'Created: '+snapshot.createdAt,'Expires: '+snapshot.expiresAt,
    'Previous authorization: '+(snapshot.previousApprovalId||'None'),
    ...(snapshot.previousApprovalId?['This is a REPLACEMENT authorization. The estimate shown is the revised full total, not an amount to add to the prior authorization.']:[]),'',
    'AUTHORIZED WORK:',snapshot.description,'',
    'ITEMIZED ESTIMATE:',...snapshot.items.map(item=>`${item.quantity} x ${item.description||item.item||item.type} @ ${money(Math.round(item.rate*100))} = ${money(Math.round(item.amount*100))}${item.taxable===0?' (non-taxable)':''}`),
    'Estimate subtotal: '+money(snapshot.subtotalCents),'Tax: '+money(snapshot.taxCents),
    'Tax rate: '+(snapshot.taxRateBps/100).toFixed(2)+'%','TOTAL ESTIMATE: '+money(snapshot.estimateCents),'',
    'TERMS ('+snapshot.termsVersion+'):',...snapshot.terms,'',
    record?'CUSTOMER DECISION: '+record.choice:'UNSIGNED AUTHORIZATION PREVIEW',
    ...(record?['Typed electronic signature: '+record.signerName,'Signed: '+record.signedAt,
      'Electronic records and selected option explicitly accepted: Yes',
    'Snapshot SHA-256: '+record.snapshotSha256,'Signed record SHA-256: '+recordHash,
    'PDF uses a base Latin font. The retained UTF-8 JSON record preserves the exact customer name, signature text, scope and terms.']:[]),
    '', 'The retained record reflects the scope and amount stated here. Later changes require another authorization.'
  ];
}

function renderPage(snapshot,row,token,notice='') {
  const e=escape,complete=row.status==='completed';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Repair authorization</title><style>
  body{font:16px system-ui;background:#eef2f4;color:#182931;padding:20px}main{max-width:800px;background:white;border-radius:12px;padding:24px;margin:auto}h1{font-size:26px}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}fieldset{border:1px solid #ccd6da;padding:15px}label{display:block;margin:13px 0}input[type=text]{display:block;box-sizing:border-box;width:100%;padding:12px;font:inherit}button,a.button{background:#16604b;color:white;padding:12px 18px;border:0;border-radius:6px;font:inherit;cursor:pointer}.notice{padding:12px;background:#fff2ce}small{color:#52656b}img{max-width:100%}.photos{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}@media(max-width:500px){body{padding:8px}main{padding:15px}td,th{padding:5px;font-size:13px}}</style></head><body><main>
  <h1>${e(snapshot.shopName)} Repair Authorization</h1><p>Work order <strong>${e(snapshot.workOrder.ref_number||snapshot.workOrder.id)}</strong> · ${e(snapshot.customer.name)}</p><p>${e(snapshot.unit.label)} · ${e(snapshot.unit.serial)}</p>
  ${notice?`<p class="notice">${e(notice)}</p>`:''}${snapshot.previousApprovalId?`<p class="notice">This replaces authorization #${Number(snapshot.previousApprovalId)}. The estimate below is the revised full work-order total, not an amount to add to the previous estimate. Only the work described in this request is being authorized.</p>`:''}<h2>Work requested</h2><p>${e(snapshot.description)}</p>
  <table><thead><tr><th>Item</th><th>Qty</th><th>Amount</th></tr></thead><tbody>${snapshot.items.map(item=>`<tr><td>${e(item.description||item.item||item.type)}</td><td>${e(item.quantity)}</td><td>${e(money(Math.round(item.amount*100)))}</td></tr>`).join('')}</tbody></table>
  <p>Subtotal: ${e(money(snapshot.subtotalCents))} · Tax (${(snapshot.taxRateBps/100).toFixed(2)}%): ${e(money(snapshot.taxCents))}</p><p><strong>Total estimate: ${e(money(snapshot.estimateCents))}</strong></p>
  <h2>Authorization terms</h2>${snapshot.terms.map(term=>`<p>${e(term)}</p>`).join('')}
  ${snapshot.media.length?`<h2>Inspection photos included with this authorization</h2><div class="photos">${snapshot.media.map(media=>`<figure><img src="/approval/${e(token)}/media/${Number(media.id)}" alt="${e(media.caption||'Inspection photo')}"><figcaption>${e(media.caption)}</figcaption></figure>`).join('')}</div>`:''}
  ${complete?`<h2>Recorded decision</h2><p><strong>${e(row.choice)}</strong> · ${e(row.signer_name)} · ${e(row.signed_at)}</p><p><a class="button" href="/approval/${e(token)}/document">Download authorization PDF</a> <a href="/approval/${e(token)}/record">Download exact UTF-8 approval record</a></p><p><small>The PDF uses a base Latin font. Your retained UTF-8 approval record preserves the exact name, signature text and terms, including non-Latin characters. Record SHA-256: ${e(row.signed_record_sha256)}</small></p>`:
    notice?'<p>Contact the shop for a new authorization before signing.</p>':`<form method="post" id="signAuthorization"><fieldset><legend>Your decision</legend>${[...choices].map(choice=>`<label><input type="radio" name="choice" value="${e(choice)}" required> ${e(choice)}</label>`).join('')}<label>Full legal name<input type="text" name="signerName" autocomplete="name" maxlength="200" required minlength="2"></label><label><input type="checkbox" name="agree" required> I consent to electronic records and my typed electronic signature, confirm I have authority, and accept the selected option and terms shown above.</label></fieldset><button>Sign and retain authorization</button><p role="status" id="result"></p></form><script type="module" src="/authorizations-ui.js"></script>`}
  <p><small>Authorization version ${e(snapshot.termsVersion)} · Created ${e(snapshot.createdAt)} · Link expires ${e(snapshot.expiresAt)}. Keep your downloaded copy.</small></p></main></body></html>`;
}

export function authorizationRoutes({db,currentUser,json,readBody,publicBaseUrl='',shopName='Owner Tracker',uploadDir=path.resolve('data/uploads'),now=()=>Date.now(),notify=null}) {
  installAuthorizations(db);
  const directory=path.resolve(uploadDir);
  const publicBase=String(publicBaseUrl).replace(/\/$/,'');
  const send=(res,status,value)=>{json(res,status,value,{'cache-control':'no-store','referrer-policy':'no-referrer'});return true;};
  const html=(res,status,body,type='text/html; charset=utf-8')=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','x-frame-options':'DENY'});res.end(body);return true;};
  const staff=req=>{const user=currentUser(req);if(!user)error(401,'Login required');if(!roles.has(user.role))error(403,'Authorization staff permission required');return user;};
  const rowByToken=token=>db.prepare('SELECT * FROM approvals WHERE token_hash=?').get(sha(token));

  function buildRequest(id,input,user) {
    const description=text(input.authorizedDescription||input.description||order(db,id).authorized_work||order(db,id).complaint,4000);
    if(!description)error(400,'Authorized work description is required');
    const days=input.expiresDays===undefined?14:Number(input.expiresDays);
    if(!Number.isInteger(days)||days<1||days>30)error(400,'Authorization expiry must be from 1 to 30 days');
    const selected=Array.isArray(input.mediaIds)?[...new Set(input.mediaIds.map(Number))]:[];
    if(selected.length>30 || selected.some(value=>!Number.isSafeInteger(value)||value<=0))error(400,'Invalid approval photo selection');
    const previous=input.previousApprovalId===undefined?null:Number(input.previousApprovalId);
    if(previous!==null && (!Number.isSafeInteger(previous)||previous<=0||!db.prepare('SELECT id FROM approvals WHERE id=? AND work_order_id=?').get(previous,id)))error(400,'Previous authorization must belong to this work order');
    const files=[];
    try {
      const result=transaction(db,()=>{
        const wo=order(db,id);
        assertJobStageChange(wo,'Awaiting Approval');
        if(!Number.isFinite(wo.estimate_total)||wo.estimate_total<0)error(409,'Work order estimate is invalid');
        const active=db.prepare("SELECT * FROM approvals WHERE work_order_id=? AND revoked_at IS NULL AND superseded_by IS NULL AND snapshot_json<>'' ORDER BY id DESC").all(id);
        const prior=previous ?? active[0]?.id ?? null;
        db.prepare("UPDATE work_orders SET stage='Awaiting Approval',authorized_work=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(description,id);
        const current=scopeRecord(db,id),currentWo=order(db,id);
        const customer=currentWo.customer_id?db.prepare('SELECT * FROM customers WHERE id=?').get(currentWo.customer_id):null;
        const service=address(customer),billing=customer?.billing_same_as_service===0?address(customer,'billing_'):{...service};
        fs.mkdirSync(directory,{recursive:true,mode:0o700});
        if(fs.lstatSync(directory).isSymbolicLink())error(409,'Authorization storage must not be a symbolic link');
        const media=selected.map(mediaId=>{
          const image=db.prepare('SELECT * FROM media WHERE id=? AND work_order_id=? AND customer_visible=1').get(mediaId,id);
          if(!image||!['image/jpeg','image/png','image/webp'].includes(image.mime_type))error(409,'Only selected customer-visible images on this work order may be included');
          const source=safeFile(directory,image.stored_name);
          if(!fs.existsSync(source))error(409,'Selected inspection photo is missing');
          const bytes=fs.readFileSync(source);
          if(bytes.length>8000000)error(409,'Selected inspection photo is too large');
          const name=`authorization-${crypto.randomUUID()}-photo${path.extname(image.stored_name)}`;
          fs.writeFileSync(safeFile(directory,name),bytes,{flag:'wx',mode:0o600});files.push(name);
          return {id:image.id,caption:image.caption||'',name,mime:image.mime_type,size:bytes.length,sha256:sha(bytes)};
        });
        const createdAt=new Date(now()).toISOString(),expiresAt=new Date(now()+days*86400000).toISOString();
        const estimateCents=Math.round(currentWo.estimate_total*100),taxCents=Number(currentWo.tax_total_cents||0);
        if(!Number.isSafeInteger(estimateCents)||estimateCents<0||estimateCents>100000000||!Number.isSafeInteger(taxCents)||taxCents<0||taxCents>estimateCents)error(409,'The work-order total or tax amount is invalid');
        if(current.items.some(item=>![item.quantity,item.rate,item.amount].every(Number.isFinite)))error(409,'The itemized estimate contains an invalid quantity or price');
        const snapshot={version:1,authorizationMode:prior?'replacement_total':'initial_total',termsVersion:'AZJS-authorization-2026-10-25',createdAt,expiresAt,shopName,
          previousApprovalId:prior,workOrder:current.workOrder,customer:{id:currentWo.customer_id??null,name:customer?.name||currentWo.customer_name||'',email:customer?.email||currentWo.email||'',phone:customer?.phone||currentWo.phone||''},
          unit:{id:currentWo.vehicle_id??null,label:currentWo.unit_label||[currentWo.year,currentWo.make,currentWo.model].filter(Boolean).join(' '),serial:currentWo.serial||''},
          addresses:{service,billing},description,items:current.items,estimateCents,taxCents,subtotalCents:estimateCents-taxCents,taxRateBps:currentWo.tax_rate_bps||0,terms:defaultTerms,media};
        const serialized=JSON.stringify(snapshot),token=crypto.randomBytes(32).toString('base64url');
        const inserted=db.prepare(`INSERT INTO approvals(work_order_id,token_hash,status,authorized_description,snapshot_json,snapshot_sha256,scope_sha256,terms_version,expires_at,previous_approval_id,created_by,creator_username,creator_role)
          VALUES(?,?,'sent',?,?,?,?,?,?,?,?,?,?)`).run(id,sha(token),description,serialized,sha(serialized),sha(JSON.stringify(current)),snapshot.termsVersion,expiresAt,prior,user.id,user.username,user.role);
        const approvalId=Number(inserted.lastInsertRowid);
        for(const old of active) {
          db.prepare("UPDATE approvals SET superseded_by=?,status=CASE WHEN status='sent' THEN 'superseded' ELSE status END WHERE id=?").run(approvalId,old.id);
          audit(db,old.id,id,'Authorization superseded',user.username,{replacementApprovalId:approvalId});
        }
        audit(db,approvalId,id,'Authorization requested',user.username,{snapshotSha256:sha(serialized),estimateCents,previousApprovalId:prior,expiresAt});
        return {ok:true,approvalId,approvalUrl:`${publicBase}/approval/${token}`,snapshotSha256:sha(serialized),expiresAt,previousApprovalId:prior,docusign:{mode:'internal'},deliveryStatus:'not_sent'};
      });
      return result;
    } catch(e) {for(const name of files){try{fs.unlinkSync(safeFile(directory,name));}catch{}}throw e;}
  }

  function sign(row,input) {
    const createdFiles=[];
    try{return transaction(db,()=>{
      row=db.prepare('SELECT * FROM approvals WHERE id=?').get(row.id);
      const invalid=publicStatus(row,now);if(invalid)error(invalid.status,invalid.message);
      if(row.status==='completed')error(409,'Authorization already completed');
      if(row.status!=='sent')error(409,'Authorization is not available for signing');
      const snapshot=decoded(row),currentScope=sha(JSON.stringify(scopeRecord(db,row.work_order_id)));
      if(currentScope!==row.scope_sha256)error(409,'Work or estimate changed after this authorization was issued. Ask the shop for a new authorization.');
      for(const image of snapshot.media){
        const file=safeFile(directory,image.name);
        if(!fs.existsSync(file)||sha(fs.readFileSync(file))!==image.sha256)error(409,'An included inspection photo is missing or changed. Ask the shop for a new authorization.');
      }
      const signerName=text(input.signerName,200);
      if(!choices.has(input.choice)||input.agree!==true||signerName.length<2)error(400,'Choose an option, enter your full legal name, and explicitly accept electronic records and the terms');
      const stage=input.choice==='Approve Repairs'?'In Progress':input.choice==='Diagnostics/Teardown Only'?'Diagnosing':'Declined';
      assertJobStageChange(order(db,row.work_order_id),stage);
      const signedAt=new Date(now()).toISOString();
      const record={version:1,approvalId:row.id,workOrderId:row.work_order_id,snapshotSha256:row.snapshot_sha256,choice:input.choice,signerName,signedAt,electronicConsent:true,termsVersion:row.terms_version};
      const recordJson=JSON.stringify(record),recordHash=sha(recordJson);
      const bytes=makePdf(documentLines(snapshot,record,recordHash)),documentName=`authorization-signed-${row.id}-${crypto.randomUUID()}.pdf`;
      fs.mkdirSync(directory,{recursive:true,mode:0o700});
      fs.writeFileSync(safeFile(directory,documentName),bytes,{flag:'wx',mode:0o600});createdFiles.push(documentName);
      const updated=db.prepare(`UPDATE approvals SET status='completed',choice=?,signer_name=?,signed_at=?,signed_record_json=?,signed_record_sha256=?,document_name=?,document_sha256=? WHERE id=? AND status='sent'`)
        .run(input.choice,signerName,signedAt,recordJson,recordHash,documentName,sha(bytes),row.id);
      if(updated.changes!==1)error(409,'Authorization was already processed');
      const next=input.choice==='Approve Repairs'?'Begin work within the retained approved scope and amount':input.choice==='Diagnostics/Teardown Only'?'Diagnostics only; obtain another authorization for repairs':'Prepare unit for declined-work pickup';
      db.prepare('UPDATE work_orders SET stage=?,next_action=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(stage,next,row.work_order_id);
      audit(db,row.id,row.work_order_id,'Authorization completed','customer',{choice:input.choice,signerName,signedAt,snapshotSha256:row.snapshot_sha256,signedRecordSha256:recordHash,documentSha256:sha(bytes)});
      return {ok:true,approvalId:row.id,choice:input.choice,signedAt,signedRecordSha256:recordHash};
    });}catch(e){for(const name of createdFiles){try{fs.unlinkSync(safeFile(directory,name));}catch{}}throw e;}
  }

  function serveDocument(res,row) {
    const {bytes,filename}=readRetainedAuthorizationDocument(db,row.id,row.work_order_id,directory);
    res.writeHead(200,{'content-type':'application/pdf','content-length':bytes.length,'content-disposition':`attachment; filename="${filename}"`,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});res.end(bytes);return true;
  }

  function serveRecord(res,row) {
    const {bytes,filename}=readRetainedAuthorizationRecord(db,row.id,row.work_order_id);
    res.writeHead(200,{'content-type':'application/json; charset=utf-8','content-length':bytes.length,'content-disposition':`attachment; filename="${filename}"`,'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});res.end(bytes);return true;
  }

  return async function authorizationRouter(req,res,pathname) {
    const request=pathname.match(/^\/api\/work-orders\/(\d+)\/request-approval$/);
    const history=pathname.match(/^\/api\/work-orders\/(\d+)\/authorizations$/);
    const action=pathname.match(/^\/api\/work-orders\/(\d+)\/authorizations\/(\d+)\/(revoke|document|record)$/);
    const customer=pathname.match(/^\/approval\/([A-Za-z0-9_-]{32,100})(?:\/(document|record|media)(?:\/(\d+))?)?$/);
    if(!request&&!history&&!action&&!customer)return false;
    try {
      if(request||history||action) {
        const user=staff(req),id=Number((request||history||action)[1]);order(db,id);
        if((request||history)&&req.method==='POST'){
          const input=await readBody(req);requireEditRevision(db,req,pathname,input);const result=buildRequest(id,input,user);
          if(notify) {
            try {const delivery=await notify('approval_requested',order(db,id),{approvalUrl:result.approvalUrl,approvalId:result.approvalId});result.deliveryStatus=delivery?.status||'queued';}
            catch {result.deliveryStatus='failed';}
          }
          return send(res,200,result);
        }
        if(history&&req.method==='GET') {
          const rows=db.prepare('SELECT * FROM approvals WHERE work_order_id=? ORDER BY id DESC').all(id);
          return send(res,200,{authorizations:rows.map(row=>({id:row.id,status:row.status,choice:row.choice,signerName:row.signer_name,signedAt:row.signed_at,createdAt:row.created_at,expiresAt:row.expires_at,revokedAt:row.revoked_at,revocationReason:row.revocation_reason,supersededBy:row.superseded_by,previousApprovalId:row.previous_approval_id,creatorUsername:row.creator_username||null,creatorRole:row.creator_role||null,snapshotSha256:row.snapshot_sha256||null,signedRecordSha256:row.signed_record_sha256||null,legacy:!row.snapshot_json,snapshot:decoded(row),documentAvailable:!!row.document_name,documentUrl:row.document_name?`/api/work-orders/${id}/authorizations/${row.id}/document`:null})),hasCurrentRepairAuthorization:hasCurrentAuthorization(db,id)});
        }
        if(action) {
          const row=db.prepare('SELECT * FROM approvals WHERE id=? AND work_order_id=?').get(Number(action[2]),id);
          if(!row)error(404,'Authorization not found');
          if(action[3]==='document'&&req.method==='GET')return serveDocument(res,row);
          if(action[3]==='record'&&req.method==='GET')return serveRecord(res,row);
          if(action[3]==='revoke'&&req.method==='POST') {
            const input=await readBody(req),reason=text(input.reason,500);
            if(reason.length<5)error(400,'A reason of at least five characters is required');
            const revoked=transaction(db,()=>{
              const current=db.prepare('SELECT revoked_at FROM approvals WHERE id=?').get(row.id);
              if(current.revoked_at)return {ok:true,alreadyRevoked:true};
              db.prepare('UPDATE approvals SET revoked_at=?,revocation_reason=?,revoked_by=? WHERE id=? AND revoked_at IS NULL').run(new Date(now()).toISOString(),reason,user.id,row.id);
              audit(db,row.id,id,'Authorization revoked',user.username,{reason});
              return {ok:true};
            });
            return send(res,200,revoked);
          }
        }
        return send(res,405,{error:'Method not allowed'});
      }
      const token=customer[1],row=rowByToken(token);
      if(!row)error(404,'Authorization link not found');
      const invalid=publicStatus(row,now);if(invalid)error(invalid.status,invalid.message);
      const snapshot=decoded(row);
      if(customer[2]==='document'&&req.method==='GET')return serveDocument(res,row);
      if(customer[2]==='record'&&req.method==='GET')return serveRecord(res,row);
      if(customer[2]==='media'&&customer[3]&&req.method==='GET') {
        const image=snapshot.media.find(item=>item.id===Number(customer[3]));
        if(!image)error(404,'Image not included in this authorization');
        const file=safeFile(directory,image.name);
        if(!fs.existsSync(file))error(404,'Retained image unavailable');
        const bytes=fs.readFileSync(file);
        if(sha(bytes)!==image.sha256)error(409,'Retained inspection image integrity check failed');
        return html(res,200,bytes,image.mime);
      }
      if(customer[2])return send(res,405,{error:'Method not allowed'});
      if(req.method==='GET') {
        const stale=sha(JSON.stringify(scopeRecord(db,row.work_order_id)))!==row.scope_sha256;
        return html(res,200,renderPage(snapshot,row,token,stale&&row.status!=='completed'?'The work or estimate has changed. This request cannot be signed.':''));
      }
      if(req.method==='POST')return send(res,200,sign(row,await readBody(req)));
      return send(res,405,{error:'Method not allowed'});
    } catch(e) {return send(res,e.status||400,{error:e.status?e.message:'Authorization could not be processed. Contact the shop or review the server log.'});}
  };
}

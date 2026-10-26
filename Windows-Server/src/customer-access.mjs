// Work-order-scoped, revocable customer links. Tokens never grant staff access.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {jobIdentityFields,jobIdentityFingerprint} from './job-policy.mjs';

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => Number(value || 0).toLocaleString('en-US',{style:'currency',currency:'USD'});
const staffRoles = new Set(['owner','manager','service_writer','advisor']);

export function installCustomerAccess(db) {
  const columns=new Set(db.prepare('PRAGMA table_info(customer_portal_tokens)').all().map(column=>column.name));
  for(const definition of ["scope TEXT NOT NULL DEFAULT 'status'",'created_by INTEGER','revoked_at TEXT',"revocation_reason TEXT NOT NULL DEFAULT ''","identity_sha256 TEXT NOT NULL DEFAULT ''"]) {
    if(!columns.has(definition.split(' ')[0]))db.exec(`ALTER TABLE customer_portal_tokens ADD COLUMN ${definition}`);
  }
  // Never retain an unlimited legacy bearer link. Invalid expiry is expired.
  db.exec("UPDATE customer_portal_tokens SET expires_at=datetime(created_at,'+30 days') WHERE expires_at IS NULL");
  // Original recipients cannot be inferred for old, unbound links. Reissue them
  // instead of silently binding a potentially reassigned job to its new owner.
  db.exec("UPDATE customer_portal_tokens SET active=0,revoked_at=CURRENT_TIMESTAMP,revocation_reason='Legacy link requires identity-bound reissue' WHERE identity_sha256='' AND active=1");
  const jobColumns=new Set(db.prepare('PRAGMA table_info(work_orders)').all().map(column=>column.name));
  const changed=jobIdentityFields.filter(key=>jobColumns.has(key)).map(key=>`NEW.${key} IS NOT OLD.${key}`).join(' OR ');
  db.exec(`DROP TRIGGER IF EXISTS work_order_identity_revoke_links;
    CREATE TRIGGER work_order_identity_revoke_links AFTER UPDATE ON work_orders WHEN ${changed}
    BEGIN UPDATE customer_portal_tokens SET active=0,revoked_at=CURRENT_TIMESTAMP,revocation_reason='Work-order customer or unit identity changed'
      WHERE work_order_id=NEW.id AND active=1; END;`);
}

export function createCustomerAccess({db,currentUser,json,readBody,publicBaseUrl,shopName='Owner Tracker',shopPhone='',
  uploadDir=path.resolve('./data/uploads'),now=()=>Date.now(),authorizationDocument=null}) {
  installCustomerAccess(db);
  const base=String(publicBaseUrl || 'http://127.0.0.1:8787').replace(/\/$/,'');
  const send=(res,status,value)=>{json(res,status,value,{'cache-control':'no-store','referrer-policy':'no-referrer'});return true;};
  const stamp=()=>new Date(now()).toISOString();
  const audit=(user,action,detail,workOrderId)=>db.prepare('INSERT INTO audit_log(work_order_id,actor,action,detail) VALUES(?,?,?,?)').run(workOrderId,user?.username || 'system',action,JSON.stringify(detail));
  function mayManage(user,workOrderId) {
    if(!user)return false;
    if(staffRoles.has(user.role))return true;
    return user.role==='technician' && db.prepare('SELECT assigned_user_id FROM work_orders WHERE id=?').get(workOrderId)?.assigned_user_id===user.id;
  }
  function createLink(workOrderId,options={}) {
    // Legacy callers pass a day count; new callers specify scope and recorder.
    if(typeof options==='number')options={days:options};
    const days=Number(options.days ?? 30),scope=options.scope ?? 'status';
    if(!Number.isInteger(days)||days<1||days>90||!['status','documents'].includes(scope))throw new Error('Use a status/documents scope and expiry of 1 to 90 days');
    const job=db.prepare('SELECT * FROM work_orders WHERE id=?').get(workOrderId);
    if(!job)throw new Error('Work order not found');
    const token=crypto.randomBytes(32).toString('base64url'),expiresAt=new Date(now()+days*86400_000).toISOString();
    const result=db.prepare('INSERT INTO customer_portal_tokens(work_order_id,token_hash,expires_at,scope,created_by,identity_sha256) VALUES(?,?,?,?,?,?)').run(workOrderId,sha(token),expiresAt,scope,options.user?.id || null,jobIdentityFingerprint(job));
    audit(options.user,'Customer link created',{linkId:Number(result.lastInsertRowid),scope,expiresAt},workOrderId);
    return `${base}/portal/${token}`;
  }
  function record(token) {
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{40,}$/.test(token))return null;
    const link=db.prepare('SELECT * FROM customer_portal_tokens WHERE token_hash=? AND active=1 AND revoked_at IS NULL').get(sha(token));
    if(!link || !Number.isFinite(Date.parse(link.expires_at)) || Date.parse(link.expires_at)<=now())return null;
    const job=db.prepare('SELECT * FROM work_orders WHERE id=?').get(link.work_order_id);
    return job&&link.identity_sha256===jobIdentityFingerprint(job)?{link,job}:null;
  }
  function html(res,body,status=200) {
    res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end(body);return true;
  }
  function shell(title,body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/styles.css"></head><body class="customer-page"><main class="customer-card"><img src="/brand-logo.png" class="customer-logo" alt="${escapeHtml(shopName)}"><h1>${escapeHtml(title)}</h1>${body}<p>Questions? ${escapeHtml(shopPhone || shopName)}</p></main></body></html>`;
  }
  function portal(token,value) {
    const {link,job}=value,e=escapeHtml;
    const updates=db.prepare('SELECT title,body,stage,created_at FROM work_order_updates WHERE work_order_id=? AND customer_visible=1 ORDER BY id DESC').all(job.id);
    const media=db.prepare('SELECT id,caption FROM media WHERE work_order_id=? AND customer_visible=1 ORDER BY id DESC').all(job.id);
    const unit=job.unit_label || [job.year,job.make,job.model].filter(Boolean).join(' ');
    let documents='';
    if(link.scope==='documents') {
      const invoices=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ot_invoices'").get()
        ? db.prepare('SELECT id,number,issued_at FROM ot_invoices WHERE work_order_id=? AND voided_at IS NULL ORDER BY id DESC').all(job.id):[];
      const approvals=db.prepare("SELECT id,status,choice,signed_at FROM approvals WHERE work_order_id=? AND status='completed' ORDER BY id DESC").all(job.id);
      documents=`<section><h2>Your documents</h2>${invoices.map(invoice=>`<p><a href="/portal/${token}/invoices/${invoice.id}">${e(invoice.number)} — issued ${e(invoice.issued_at)}</a></p>`).join('')}${approvals.map(approval=>`<p>${e(approval.choice)} — ${e(approval.signed_at)}${authorizationDocument?` <a href="/portal/${token}/authorizations/${approval.id}">Authorization document</a>`:''}</p>`).join('')}${!invoices.length&&!approvals.length?'<p>No completed documents yet.</p>':''}</section>`;
    }
    return shell(`${shopName} repair status`,`<p>Work order <strong>${e(job.ref_number || job.id)}</strong><br>${e(job.customer_name)}<br>${e(unit)}</p><p class="badge big">${e(job.stage)}</p><section><h2>Updates from the shop</h2>${updates.map(update=>`<article class="customer-update"><div><small>${e(update.created_at)} · ${e(update.stage)}</small><h3>${e(update.title || 'Repair update')}</h3><p>${e(update.body)}</p></div></article>`).join('')||'<p>No customer updates have been posted yet.</p>'}</section>${media.length?`<section><h2>Photos</h2><div class="photo-grid customer-grid">${media.map(image=>`<figure><img src="/portal/${token}/media/${image.id}" alt="${e(image.caption || 'Repair photo')}"><figcaption>${e(image.caption)}</figcaption></figure>`).join('')}</div></section>`:''}${documents}<small>This private link expires ${e(link.expires_at)}. Keep it private.</small>`);
  }

  async function routes(req,res,p) {
    try {
      const manage=p.match(/^\/api\/work-orders\/(\d+)\/(customer-link|customer-links)$/);
      if(manage) {
        const workOrderId=Number(manage[1]),user=currentUser(req);
        if(!user)return send(res,401,{error:'Login required'});
        if(!mayManage(user,workOrderId))return send(res,403,{error:'Customer-link permission denied'});
        if(!db.prepare('SELECT id FROM work_orders WHERE id=?').get(workOrderId))return send(res,404,{error:'Work order not found'});
        if(req.method==='POST') {
          const body=await readBody(req),portalUrl=createLink(workOrderId,{days:body.days,scope:body.scope,user});
          return send(res,manage[2]==='customer-link'?200:201,{ok:true,portalUrl});
        }
        if(req.method==='GET')return send(res,200,{links:db.prepare('SELECT id,scope,active,expires_at,created_at,revoked_at,revocation_reason FROM customer_portal_tokens WHERE work_order_id=? ORDER BY id DESC').all(workOrderId)});
        return send(res,405,{error:'Method not allowed'});
      }
      const revoke=p.match(/^\/api\/work-orders\/(\d+)\/customer-links\/(\d+)\/revoke$/);
      if(revoke && req.method==='POST') {
        const workOrderId=Number(revoke[1]),user=currentUser(req);
        if(!user)return send(res,401,{error:'Login required'});
        if(!mayManage(user,workOrderId))return send(res,403,{error:'Customer-link permission denied'});
        const body=await readBody(req),reason=String(body.reason ?? '').trim().slice(0,500);
        if(body.confirm!==true || reason.length<5)return send(res,400,{error:'Confirm revocation and give a reason of at least five characters'});
        const result=db.prepare('UPDATE customer_portal_tokens SET active=0,revoked_at=?,revocation_reason=? WHERE id=? AND work_order_id=? AND active=1').run(stamp(),reason,Number(revoke[2]),workOrderId);
        if(!result.changes)return send(res,404,{error:'Active link not found'});
        audit(user,'Customer link revoked',{linkId:Number(revoke[2]),reason},workOrderId);return send(res,200,{ok:true});
      }
      const match=p.match(/^\/portal\/([A-Za-z0-9_-]+)(?:\/(media|invoices|authorizations)\/(\d+))?$/);
      if(!match)return p.startsWith('/portal/')?send(res,404,{error:'Customer link not found or expired'}):false;
      if(req.method!=='GET')return send(res,405,{error:'Read-only customer link'});
      const value=record(match[1]);
      if(!value)return html(res,shell('Link unavailable','<p>This customer link is invalid, expired, or has been revoked. Ask the shop for a new link.</p>'),404);
      if(!match[2])return html(res,portal(match[1],value));
      if(match[2]==='media') {
        const media=db.prepare('SELECT stored_name,mime_type FROM media WHERE id=? AND work_order_id=? AND customer_visible=1').get(Number(match[3]),value.job.id);
        if(!media || !['image/jpeg','image/png','image/webp'].includes(media.mime_type)||path.basename(media.stored_name)!==media.stored_name)return send(res,404,{error:'Image not found'});
        const file=path.join(uploadDir,media.stored_name);
        if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink()||!fs.statSync(file).isFile())return send(res,404,{error:'Image not found'});
        const buffer=fs.readFileSync(file);
        res.writeHead(200,{'content-type':media.mime_type,'content-length':buffer.length,'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});res.end(buffer);return true;
      }
      if(value.link.scope!=='documents')return send(res,404,{error:'Document not available through this link'});
      if(match[2]==='authorizations') {
        const approval=db.prepare("SELECT id FROM approvals WHERE id=? AND work_order_id=? AND status='completed'").get(Number(match[3]),value.job.id);
        if(!approval || !authorizationDocument)return send(res,404,{error:'Completed authorization document unavailable'});
        const document=await authorizationDocument(approval.id,value.job.id);
        if(!document)return send(res,404,{error:'Completed authorization document unavailable'});
        const bytes=Buffer.isBuffer(document)?document:document.bytes;
        res.writeHead(200,{'content-type':'application/pdf','cache-control':'no-store','content-disposition':`inline; filename="authorization-${approval.id}.pdf"`});res.end(bytes);return true;
      }
      if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ot_invoices'").get())return send(res,404,{error:'Invoice not found'});
      const invoice=db.prepare('SELECT id,number,snapshot_json,issued_at FROM ot_invoices WHERE id=? AND work_order_id=? AND voided_at IS NULL').get(Number(match[3]),value.job.id);
      if(!invoice)return send(res,404,{error:'Invoice not found'});
      const snapshot=JSON.parse(invoice.snapshot_json),e=escapeHtml;
      const rows=(snapshot.items || []).map(item=>`<tr><td>${e(item.description)}</td><td>${e(item.qty)}</td><td>${e(money(item.amount))}</td></tr>`).join('');
      return html(res,shell(`Invoice ${invoice.number}`,`<p>Issued ${e(invoice.issued_at)}<br>Work order ${e(snapshot.refNumber || value.job.ref_number)}</p><table><thead><tr><th>Item</th><th>Quantity</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table><p>Invoice total at issue: ${e(money(Number(snapshot.estimateCents)/100))}</p><p>Current work-order account balance: ${e(money(value.job.balance))}</p><p>Invoice figures above are the historical issued snapshot. The current account may include later approved work, payments, refunds, or credits.</p>`));
    } catch(error) { return send(res,400,{error:String(error.message).slice(0,200)}); }
  }
  return {routes,createLink,record,mayManage};
}

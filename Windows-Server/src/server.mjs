import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
import { openDb, ensureAdmin, verifyPassword, hashPassword } from './db.mjs';
import { posRoutes } from './pos-extension.mjs';
import { checkoutRoutes } from './payment-docs.mjs';
import { deviceRoutes } from './pos-devices.mjs';
import { shopOpsRoutes } from './shop-ops.mjs';
import { receiptRoutes } from './receipts.mjs';
import {createAccessSecurity} from './access-security.mjs';
import {createCustomerAccess} from './customer-access.mjs';
import {authorizationRoutes,readRetainedAuthorizationDocument} from './authorizations.mjs';
import {installEditRevisions,requireEditRevision,withEditRevisions} from './edit-revisions.mjs';
import {accountingRoutes} from './accounting.mjs';
import {shopManagementRoutes} from './shop-management.mjs';
import {createMaintenance} from './maintenance.mjs';
import {shopReportsRoutes} from './shop-reports.mjs';
import {syncAppointmentChange,calendarChangeRoutes} from './google-calendar.mjs';
import {createNotificationService,notificationRoutes} from './service-notifications.mjs';
import {assertJobIdentityChange,assertJobStageChange,jobIdentityFields} from './job-policy.mjs';
import {assertManualRepairAccount,repairFinancialFields} from './tax.mjs';

loadEnv();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const uploadDir = path.resolve(__dirname, '../data/uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const db = openDb(process.env.OWNERTRACKER_DB || './data/ownertracker.sqlite');
const ADMIN_USER = process.env.OWNERTRACKER_ADMIN_USER || 'owner';
ensureAdmin(db, ADMIN_USER, process.env.OWNERTRACKER_ADMIN_PASSWORD || '');
const SESSION_SECRET = process.env.OWNERTRACKER_SESSION_SECRET || '';
const BRIDGE_TOKEN = process.env.QBPOS_BRIDGE_TOKEN || '';
const AGENT_TOKEN = process.env.DESKTOP_AGENT_TOKEN || '';
if (!SESSION_SECRET || SESSION_SECRET.startsWith('CHANGE_ME')) throw new Error('Set OWNERTRACKER_SESSION_SECRET.');
if (!BRIDGE_TOKEN || BRIDGE_TOKEN.startsWith('CHANGE_ME')) throw new Error('Set QBPOS_BRIDGE_TOKEN.');
if (!AGENT_TOKEN || AGENT_TOKEN.startsWith('CHANGE_ME')) throw new Error('Set DESKTOP_AGENT_TOKEN.');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const SHOP_NAME = process.env.SHOP_NAME || 'Owner Tracker';
const SHOP_PHONE = process.env.SHOP_PHONE || '';
const SHOP_LOGO_URL = process.env.SHOP_LOGO_URL || '/brand-logo.png';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const LIVE_VENDOR_ORDERING = false; // V6: supplier orders require vetted connector + explicit desktop confirmation
const AUTO_BUILD_PROCUREMENT = String(process.env.AUTO_BUILD_PROCUREMENT || 'true').toLowerCase() !== 'false';
const AUTO_SUPPLIER_LOOKUP = String(process.env.AUTO_SUPPLIER_LOOKUP || 'false').toLowerCase() === 'true';
// Migration must be explicitly enabled. Imported records are insert-only; the
// legacy reconciler must never overwrite local account, identity or history.
const QBPOS_IMPORT_ENABLED = process.env.QBPOS_IMPORT_MODE === 'insert-only';
const STAGES = ['Intake','Diagnosing','Awaiting Approval','Parts Ordered','In Progress','Quality Check','Ready','Picked Up','Closed','Declined'];
const ROLES = ['owner','manager','service_writer','advisor','technician','parts','viewer'];
const PERMISSIONS = {
  owner: new Set(['read','edit_job','assign_job','notes','updates','media','approval','ready','parts','submit_orders','users','settings']),
  manager: new Set(['read','edit_job','assign_job','notes','updates','media','approval','ready','parts','submit_orders','users']),
  service_writer: new Set(['read','edit_job','assign_job','notes','updates','media','approval','ready','parts']),
  advisor: new Set(['read','edit_job','assign_job','notes','updates','media','approval','ready','parts','submit_orders']),
  technician: new Set(['read','edit_job','notes','updates','media']),
  parts: new Set(['read','notes','media','parts','submit_orders']),
  viewer: new Set(['read'])
};

const json = (res, status, value, headers = {}) => {
  const body = JSON.stringify(withEditRevisions(db,value));
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),...headers});
  res.end(body);
};
const text = (res, status, value, type = 'text/plain; charset=utf-8', headers={}) => { res.writeHead(status, {'content-type':type,...headers}); res.end(value); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const parseCookies = req => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(v => { const i=v.indexOf('='); return [v.slice(0,i).trim(), decodeURIComponent(v.slice(i+1))]; }));
const tokenHash = token => crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
const publicHash = token => crypto.createHash('sha256').update(token).digest('hex');
const readBody = async (req, max = 20_000_000) => {
  const chunks=[]; let size=0;
  for await (const c of req) { size += c.length; if (size > max) throw new Error('Body too large'); chunks.push(c); }
  const raw=Buffer.concat(chunks).toString('utf8');
  const parsed=raw ? JSON.parse(raw) : {};
  const pathname=new URL(req.url,'http://local').pathname;
  // Invoice creation validates after its idempotency lookup, so an exact retry
  // can return the retained document even if the job revision advanced.
  if(currentUser(req)&&!(req.method==='POST'&&/^\/api\/pos\/work-orders\/\d+\/(invoice|invoices|docusign\/send)$/.test(pathname)))requireEditRevision(db,req,pathname,parsed);
  return parsed;
};
function currentUser(req) { return accessSecurity.sessionUser(req); }
function requireUser(req,res) { const u=currentUser(req); if(!u){ json(res,401,{error:'Unauthorized'}); return null; } return u; }
function can(user, permission) { return !!user && (PERMISSIONS[user.role]?.has(permission) || false); }
function requirePermission(req,res,permission) { const u=requireUser(req,res); if(!u) return null; if(!can(u,permission)){ json(res,403,{error:'Permission denied'}); return null; } return u; }
function requireBridge(req,res) { if((req.headers.authorization||'') !== `Bearer ${BRIDGE_TOKEN}`){json(res,401,{error:'Invalid bridge token'});return false;} return true; }
function audit(workOrderId, actor, action, detail='') { db.prepare('INSERT INTO audit_log(work_order_id,actor,action,detail) VALUES(?,?,?,?)').run(workOrderId||null,actor,action,typeof detail==='string'?detail:JSON.stringify(detail)); }

const posRouter=posRoutes({db,currentUser,json,readBody,bridgeToken:AGENT_TOKEN});
const checkoutRouter=checkoutRoutes({db,currentUser,json,readBody,publicBaseUrl:PUBLIC_BASE_URL,shopName:SHOP_NAME,notify:(event,wo,extra)=>notifications.queueEvent(event,wo,extra)});
const deviceRouter=deviceRoutes({db,currentUser,json,readBody,shopName:SHOP_NAME,shopPhone:SHOP_PHONE});
const opsRouter=shopOpsRoutes({db,currentUser,json,readBody,bridgeToken:AGENT_TOKEN});
const receiptsRouter=receiptRoutes({db,currentUser,json,shopName:SHOP_NAME,shopPhone:SHOP_PHONE});
const accessSecurity=createAccessSecurity({db,json,readBody,publicBaseUrl:PUBLIC_BASE_URL,sessionSecret:SESSION_SECRET});
const authorizationsRouter=authorizationRoutes({db,currentUser,json,readBody,publicBaseUrl:PUBLIC_BASE_URL,shopName:SHOP_NAME,uploadDir,notify:(event,wo,extra)=>notifications.queueEvent(event,wo,extra)});
const customerAccess=createCustomerAccess({db,currentUser,json,readBody,publicBaseUrl:PUBLIC_BASE_URL,shopName:SHOP_NAME,shopPhone:SHOP_PHONE,uploadDir,authorizationDocument:(id,wo)=>readRetainedAuthorizationDocument(db,id,wo,uploadDir)});
const accountingRouter=accountingRoutes({db,currentUser,json,readBody});
const managementRouter=shopManagementRoutes({db,currentUser,json,readBody,calendarChange:appointment=>syncAppointmentChange(db,appointment),notify:(event,wo,extra)=>notifications.queueEvent(event,wo,extra)});
const notifications=createNotificationService({db,shopName:SHOP_NAME});
const notificationsRouter=notificationRoutes({service:notifications,currentUser,json,readBody});
const calendarChangesRouter=calendarChangeRoutes({db,currentUser,json,readBody});
notifications.start();
const reportsRouter=shopReportsRoutes({db,currentUser,json,readBody});
const maintenance=createMaintenance({db,currentUser,json,readBody});
installEditRevisions(db);
maintenance.start();

function canAccessJob(u,id) {
  if (!u) return false;
  if (u.role !== 'technician') return true;
  const w=db.prepare('SELECT assigned_user_id FROM work_orders WHERE id=?').get(Number(id));
  return !!w && Number(w.assigned_user_id)===Number(u.id);
}
function userView(u) { return {id:u.id,username:u.username,displayName:u.display_name||u.username,role:u.role,active:!!u.active,lastLoginAt:u.last_login_at,createdAt:u.created_at}; }
function isPartLine(l) {
  const t=String(l.lineType||l.line_type||'').toLowerCase();
  if (/labor|service|tax|discount|payment|subtotal|shipping/.test(t)) return false;
  return /part|item|inventory|noninventory/.test(t) || !!String(l.itemRef||l.item_ref||'').trim();
}
function partStatus(req) {
  const remaining=Math.max(0,Number(req.qty_needed||0)-Number(req.qty_on_hand||0)-Number(req.qty_received||0));
  if(remaining<=0) return 'received';
  if(Number(req.qty_ordered||0)>=remaining) return 'ordered';
  return req.status==='in_stock'?'in_stock':req.status||'needs_source';
}
function syncPartRequirements(workOrderId, lines) {
  db.prepare("UPDATE part_requirements SET active=0,updated_at=CURRENT_TIMESTAMP WHERE work_order_id=? AND source='qbpos'").run(workOrderId);
  const parts=lines.filter(isPartLine);
  const up=db.prepare(`INSERT INTO part_requirements(work_order_id,source,source_key,item_ref,description,qty_needed,sell_price,qb_cost,status,active)
    VALUES(?,?,?,?,?,?,?,?,?,1)
    ON CONFLICT(work_order_id,source_key) DO UPDATE SET item_ref=excluded.item_ref,description=excluded.description,qty_needed=excluded.qty_needed,sell_price=excluded.sell_price,qb_cost=excluded.qb_cost,active=1,updated_at=CURRENT_TIMESTAMP`);
  parts.forEach((l,i)=>{
    const itemRef=String(l.itemRef||l.item_ref||'').trim(); const desc=String(l.description||itemRef||'Part').trim();
    const key=`${itemRef}|${desc}|${i}`; const qty=Math.abs(Number(l.qty||1))||1; const sell=Math.abs(Number(l.amount||0)); const cost=Math.abs(Number(l.cost||0));
    up.run(workOrderId,'qbpos',key,itemRef,desc,qty,sell,cost,'needs_source');
  });
  const reqs=db.prepare("SELECT id,item_ref FROM part_requirements WHERE work_order_id=? AND active=1 AND item_ref<>'' AND preferred_vendor_id IS NULL").all(workOrderId);
  for(const r of reqs){
    const map=db.prepare('SELECT * FROM part_vendor_map WHERE shop_item_ref=? ORDER BY times_used DESC,last_used_at DESC LIMIT 1').get(r.item_ref);
    if(map) db.prepare("UPDATE part_requirements SET preferred_vendor_id=?,preferred_vendor_sku=?,status='sourced',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(map.vendor_id,map.vendor_sku,r.id);
  }
}
function workOrderView(id) {
  const wo=db.prepare(`SELECT w.*,u.username assigned_username,COALESCE(u.display_name,u.username) assigned_name FROM work_orders w LEFT JOIN users u ON u.id=w.assigned_user_id WHERE w.id=?`).get(id); if(!wo) return null;
  wo.lines=db.prepare('SELECT * FROM work_order_lines WHERE work_order_id=? ORDER BY id').all(id);
  wo.notes=db.prepare('SELECT * FROM notes WHERE work_order_id=? ORDER BY id DESC').all(id);
  wo.updates=db.prepare('SELECT * FROM work_order_updates WHERE work_order_id=? ORDER BY id DESC').all(id);
  wo.media=db.prepare('SELECT id,work_order_id,update_id,approval_id,scope,original_name,mime_type,size_bytes,caption,customer_visible,uploaded_by,created_at FROM media WHERE work_order_id=? ORDER BY id DESC').all(id);
  wo.approvals=db.prepare('SELECT id,status,choice,signer_name,signed_at,authorized_description,external_envelope_id,created_at FROM approvals WHERE work_order_id=? ORDER BY id DESC').all(id);
  wo.parts=db.prepare(`SELECT pr.*,v.code preferred_vendor_code,v.name preferred_vendor_name FROM part_requirements pr LEFT JOIN vendors v ON v.id=pr.preferred_vendor_id WHERE pr.work_order_id=? AND pr.active=1 ORDER BY pr.id`).all(id);
  for(const p of wo.parts) p.offers=db.prepare(`SELECT so.*,v.code vendor_code,v.name vendor_name FROM supplier_offers so JOIN vendors v ON v.id=so.vendor_id WHERE so.part_requirement_id=? ORDER BY so.available_qty DESC,so.unit_cost ASC`).all(p.id);
  wo.audit=db.prepare('SELECT * FROM audit_log WHERE work_order_id=? ORDER BY id DESC LIMIT 150').all(id);
  return wo;
}
function normalizeIncoming(x) {
  const n=v => {const value=Number(v??0);if(!Number.isFinite(value))throw new Error('Imported amounts must be finite');return value;};
  const lines=Array.isArray(x.lines)?x.lines:[];
  const inferredParts=lines.filter(isPartLine).reduce((s,l)=>s+n(l.amount),0);
  const inferredLabor=lines.filter(l=>String(l.lineType||l.line_type||'').toLowerCase().includes('labor')).reduce((s,l)=>s+n(l.amount),0);
  return {
    source:'qbpos', external_id:String(x.externalId||x.txnId||x.TxnID||''), ref_number:String(x.refNumber||x.RefNumber||''), customer_external_id:String(x.customerExternalId||''),
    customer_name:String(x.customerName||''), phone:String(x.phone||''), email:String(x.email||''), unit_label:String(x.unitLabel||''), year:String(x.year||''), make:String(x.make||''), model:String(x.model||''), serial:String(x.serial||''),
    complaint:String(x.complaint||x.memo||''), authorized_work:String(x.authorizedWork||''), qb_status:String(x.qbStatus||x.status||''), estimate_total:n(x.estimateTotal ?? x.total ?? lines.reduce((s,l)=>s+n(l.amount),0)),
    parts_total:n(x.partsTotal ?? inferredParts), labor_total:n(x.laborTotal ?? inferredLabor), paid_total:n(x.paidTotal), balance:n(x.balance), tech:String(x.tech||x.cashier||''), date_opened:String(x.dateOpened||x.txnDate||''), date_closed:String(x.dateClosed||''),
    time_modified:String(x.timeModified||''), raw_json:JSON.stringify(x), lines
  };
}
function upsertImported(x, actor='qbpos-bridge') {
  if(!QBPOS_IMPORT_ENABLED)throw new Error('QuickBooks import is disabled');
  const v=normalizeIncoming(x); if(!v.external_id) throw new Error('externalId/TxnID is required');
  const old=db.prepare('SELECT * FROM work_orders WHERE source=? AND external_id=?').get('qbpos',v.external_id); let id;
  if(old){
    if(old.raw_json===v.raw_json)return {id:old.id,created:false,duplicate:true};
    throw new Error('QuickBooks migration is insert-only; existing work orders require reviewed reconciliation');
  }
  for(const value of [v.estimate_total,v.parts_total,v.labor_total,v.paid_total,v.balance])if(!Number.isFinite(value)||value<0)throw new Error('Imported amounts must be finite and nonnegative');
  if(Math.round(v.paid_total*100)>Math.round(v.estimate_total*100))throw new Error('Imported payments exceed the estimate; reconcile before migration');
  const expectedBalance=Math.round(v.estimate_total*100)-Math.round(v.paid_total*100);
  if(x.balance!==undefined&&Math.round(v.balance*100)!==expectedBalance)throw new Error('Imported balance does not reconcile with estimate less payments');
  v.balance=expectedBalance/100;
  for(const line of v.lines)for(const field of ['qty','rate','amount','cost'])if(line[field]!==undefined&&!Number.isFinite(Number(line[field])))throw new Error('Imported line values must be finite');
  {
    const r=db.prepare(`INSERT INTO work_orders(source,external_id,ref_number,customer_external_id,customer_name,phone,email,unit_label,year,make,model,serial,complaint,authorized_work,qb_status,stage,estimate_total,parts_total,labor_total,paid_total,balance,tech,date_opened,date_closed,time_modified,raw_json,next_action) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(v.source,v.external_id,v.ref_number,v.customer_external_id,v.customer_name,v.phone,v.email,v.unit_label,v.year,v.make,v.model,v.serial,v.complaint,v.authorized_work,v.qb_status,'Intake',v.estimate_total,v.parts_total,v.labor_total,v.paid_total,v.balance,v.tech,v.date_opened,v.date_closed,v.time_modified,v.raw_json,'Review intake and assign technician'); id=Number(r.lastInsertRowid);
  }
  const ins=db.prepare('INSERT INTO work_order_lines(work_order_id,line_type,item_ref,description,qty,rate,amount,cost) VALUES(?,?,?,?,?,?,?,?)');
  for(const l of v.lines) ins.run(id,String(l.lineType||l.line_type||''),String(l.itemRef||l.item_ref||''),String(l.description||''),Number(l.qty||0),Number(l.rate||0),Number(l.amount||0),Number(l.cost||0));
  syncPartRequirements(id,v.lines);
  audit(id,actor,'QuickBooks work order imported',{externalId:v.external_id,refNumber:v.ref_number});
  return {id,created:true};
}

async function notify(event,wo,extra={}){return notifications.queueEvent(event,wo,extra);}

function createPortalLink(workOrderId,days=30){return customerAccess.createLink(workOrderId,{days});}

function portalRecord(token) { const record=customerAccess.record(token);return record?{...record.link,...record.job,work_order_id:record.job.id}:null; }
function saveImage({workOrderId,updateId=null,approvalId=null,scope='progress',filename,mimeType,dataBase64,caption='',customerVisible=true,userId}) {
  const allowed=new Set(['image/jpeg','image/png','image/webp']); if(!allowed.has(mimeType)) throw new Error('Only JPEG, PNG, and WebP images are accepted');
  const buf=Buffer.from(String(dataBase64||'').replace(/^data:[^;]+;base64,/,''),'base64'); if(!buf.length) throw new Error('Image data is empty'); if(buf.length>8_000_000) throw new Error('Image exceeds 8 MB');
  const ext=mimeType==='image/png'?'.png':mimeType==='image/webp'?'.webp':'.jpg'; const stored=`${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`; fs.writeFileSync(path.join(uploadDir,stored),buf,{mode:0o600});
  const r=db.prepare(`INSERT INTO media(work_order_id,update_id,approval_id,scope,original_name,stored_name,mime_type,size_bytes,caption,customer_visible,uploaded_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(workOrderId,updateId||null,approvalId||null,scope,String(filename||'photo'+ext).slice(0,200),stored,mimeType,buf.length,String(caption||'').slice(0,500),customerVisible?1:0,userId||null); return Number(r.lastInsertRowid);
}
function serveMediaRecord(res,m) { const f=path.join(uploadDir,m.stored_name); if(!fs.existsSync(f)) return text(res,404,'Image not found'); res.writeHead(200,{'content-type':m.mime_type,'content-length':fs.statSync(f).size,'cache-control':'private,max-age=3600','x-content-type-options':'nosniff'}); fs.createReadStream(f).pipe(res); }

function chooseOffer(req) {
  const offers=db.prepare(`SELECT so.*,v.code vendor_code,v.name vendor_name,v.enabled FROM supplier_offers so JOIN vendors v ON v.id=so.vendor_id WHERE so.part_requirement_id=? AND v.enabled=1 ORDER BY CASE WHEN so.vendor_id=? THEN 0 ELSE 1 END, CASE WHEN so.available_qty>=? THEN 0 ELSE 1 END, so.unit_cost ASC`).all(req.id,req.preferred_vendor_id||-1,Math.max(0,Number(req.qty_needed)-Number(req.qty_on_hand)-Number(req.qty_received)-Number(req.qty_ordered)));
  return offers.find(o=>Number(o.available_qty)>0)||null;
}
function buildProcurementCarts(workOrderId,userId) {
  const reqs=db.prepare(`SELECT * FROM part_requirements WHERE work_order_id=? AND active=1 AND status!='received' ORDER BY id`).all(workOrderId); const missing=[]; const groups=new Map();
  for(const req of reqs){
    const need=Math.max(0,Number(req.qty_needed)-Number(req.qty_on_hand)-Number(req.qty_received)-Number(req.qty_ordered)); if(need<=0) continue;
    const already=db.prepare(`SELECT pcl.id FROM procurement_cart_lines pcl JOIN procurement_carts pc ON pc.id=pcl.cart_id WHERE pcl.part_requirement_id=? AND pc.status NOT IN ('cancelled','received') LIMIT 1`).get(req.id); if(already) continue;
    let offer=chooseOffer(req);
    if(!offer && req.preferred_vendor_id) offer={vendor_id:req.preferred_vendor_id,vendor_sku:req.preferred_vendor_sku||req.item_ref,available_qty:0,unit_cost:req.qb_cost||0,eta_text:'Availability not checked'};
    if(!offer){missing.push({id:req.id,itemRef:req.item_ref,description:req.description,qtyNeeded:need,reason:'No supplier match or offer'});continue;}
    if(!groups.has(offer.vendor_id))groups.set(offer.vendor_id,[]); groups.get(offer.vendor_id).push({req,offer,qty:need});
  }
  const carts=[];
  for(const [vendorId,items] of groups){
    const v=db.prepare('SELECT * FROM vendors WHERE id=?').get(vendorId); if(!v)continue;
    let cart=db.prepare(`SELECT * FROM procurement_carts WHERE vendor_id=? AND status IN ('draft','waiting_threshold','ready_to_submit') ORDER BY id DESC LIMIT 1`).get(vendorId);
    if(!cart){const r=db.prepare('INSERT INTO procurement_carts(vendor_id,status,threshold_snapshot,auto_submit_snapshot,created_by) VALUES(?,?,?,?,?)').run(vendorId,'draft',v.order_threshold,v.auto_submit,userId);cart=db.prepare('SELECT * FROM procurement_carts WHERE id=?').get(Number(r.lastInsertRowid));}
    const ins=db.prepare(`INSERT OR IGNORE INTO procurement_cart_lines(cart_id,part_requirement_id,work_order_id,vendor_sku,description,qty,unit_cost,available_qty,eta_text) VALUES(?,?,?,?,?,?,?,?,?)`);
    for(const x of items) ins.run(cart.id,x.req.id,workOrderId,x.offer.vendor_sku||x.req.item_ref,x.req.description,x.qty,Number(x.offer.unit_cost||0),Number(x.offer.available_qty||0),x.offer.eta_text||'');
    const total=db.prepare('SELECT COALESCE(SUM(qty*unit_cost),0) total FROM procurement_cart_lines WHERE cart_id=?').get(cart.id).total; const threshold=Number(v.order_threshold||0); const status=Number(total)>=threshold?'ready_to_submit':'waiting_threshold';
    db.prepare('UPDATE procurement_carts SET total=?,threshold_snapshot=?,auto_submit_snapshot=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(total,threshold,v.auto_submit,status,cart.id);
    db.prepare(`UPDATE part_requirements SET status='in_cart',updated_at=CURRENT_TIMESTAMP WHERE id IN (SELECT part_requirement_id FROM procurement_cart_lines WHERE cart_id=?)`).run(cart.id);
    carts.push(db.prepare(`SELECT pc.*,v.code vendor_code,v.name vendor_name,v.integration_mode,v.portal_url FROM procurement_carts pc JOIN vendors v ON v.id=pc.vendor_id WHERE pc.id=?`).get(cart.id));
  }
  return {carts,missing};
}
async function submitCart(cartId,user,{force=false}={}) {
  const cart=db.prepare(`SELECT pc.*,v.code vendor_code,v.name vendor_name,v.integration_mode,v.portal_url,v.order_threshold,v.auto_submit FROM procurement_carts pc JOIN vendors v ON v.id=pc.vendor_id WHERE pc.id=?`).get(cartId); if(!cart) throw new Error('Cart not found');
  if(Number(cart.total)<Number(cart.order_threshold||0) && !force) return {status:'waiting_threshold',message:`Cart is below ${cart.vendor_name} threshold`};
  const lines=db.prepare('SELECT * FROM procurement_cart_lines WHERE cart_id=?').all(cartId);
  if(!LIVE_VENDOR_ORDERING){db.prepare("UPDATE procurement_carts SET status='manual_action_required',integration_result=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run('Live vendor ordering disabled. Cart is ready for portal/API submission.',cartId);return {status:'manual_action_required',portalUrl:cart.portal_url,lines};}
  const webhook=process.env.VENDOR_ORDER_WEBHOOK_URL;
  if(!webhook){db.prepare("UPDATE procurement_carts SET status='manual_action_required',integration_result=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run('No VENDOR_ORDER_WEBHOOK_URL configured for live order submission.',cartId);return {status:'manual_action_required',portalUrl:cart.portal_url,lines};}
  const r=await fetch(webhook,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${process.env.VENDOR_ORDER_WEBHOOK_TOKEN||''}`},body:JSON.stringify({vendor:{code:cart.vendor_code,name:cart.vendor_name},cart:{id:cart.id,total:cart.total},lines})}); const body=await r.text();
  if(!r.ok){db.prepare("UPDATE procurement_carts SET status='error',integration_result=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(body.slice(0,4000),cartId);return {status:'error',httpStatus:r.status,detail:body};}
  let parsed={}; try{parsed=JSON.parse(body)}catch{}
  db.prepare("UPDATE procurement_carts SET status='ordered',external_order_id=?,order_reference=?,integration_result=?,submitted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(parsed.externalOrderId||'',parsed.orderReference||'',body.slice(0,4000),cartId);
  for(const l of lines) db.prepare("UPDATE part_requirements SET qty_ordered=qty_ordered+?,status='ordered',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(l.qty,l.part_requirement_id);
  return {status:'ordered',externalOrderId:parsed.externalOrderId||'',orderReference:parsed.orderReference||''};
}
function procurementSummary() {
  const carts=db.prepare(`SELECT pc.*,v.code vendor_code,v.name vendor_name,v.integration_mode,v.portal_url FROM procurement_carts pc JOIN vendors v ON v.id=pc.vendor_id ORDER BY CASE pc.status WHEN 'ready_to_submit' THEN 0 WHEN 'manual_action_required' THEN 1 WHEN 'waiting_threshold' THEN 2 WHEN 'ordered' THEN 3 ELSE 4 END,pc.id DESC LIMIT 200`).all();
  for(const c of carts)c.lines=db.prepare(`SELECT pcl.*,w.ref_number,w.unit_label,w.year,w.make,w.model,pr.item_ref requested_item_ref FROM procurement_cart_lines pcl JOIN work_orders w ON w.id=pcl.work_order_id JOIN part_requirements pr ON pr.id=pcl.part_requirement_id WHERE pcl.cart_id=? ORDER BY pcl.id`).all(c.id);
  const missing=db.prepare(`SELECT pr.*,w.ref_number,w.customer_name FROM part_requirements pr JOIN work_orders w ON w.id=pr.work_order_id WHERE pr.active=1 AND pr.status='needs_source' AND NOT EXISTS (SELECT 1 FROM supplier_offers so WHERE so.part_requirement_id=pr.id AND so.available_qty>0) ORDER BY pr.updated_at`).all();
  const vendors=db.prepare('SELECT * FROM vendors ORDER BY name').all(); return {carts,missing,vendors,liveVendorOrdering:LIVE_VENDOR_ORDERING};
}

async function lookupSuppliersForWorkOrder(workOrderId) {
  const hook=process.env.SUPPLIER_LOOKUP_WEBHOOK_URL;
  if(!hook) return {status:'not_configured',offers:0};
  const requirements=db.prepare(`SELECT pr.id,pr.item_ref,pr.description,pr.qty_needed,pr.qty_on_hand,pr.qty_ordered,pr.qty_received,pr.preferred_vendor_id,pr.preferred_vendor_sku,w.ref_number,w.year,w.make,w.model,w.unit_label FROM part_requirements pr JOIN work_orders w ON w.id=pr.work_order_id WHERE pr.work_order_id=? AND pr.active=1`).all(workOrderId);
  const vendors=db.prepare('SELECT id,code,name FROM vendors WHERE enabled=1 ORDER BY name').all();
  const r=await fetch(hook,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${process.env.SUPPLIER_LOOKUP_WEBHOOK_TOKEN||''}`},body:JSON.stringify({workOrderId,requirements,vendors})});
  const body=await r.json().catch(()=>({})); if(!r.ok) throw new Error(`Supplier lookup ${r.status}: ${JSON.stringify(body)}`);
  let count=0;
  for(const o of Array.isArray(body.offers)?body.offers:[]){
    const partId=Number(o.partRequirementId),v=db.prepare('SELECT * FROM vendors WHERE code=? COLLATE NOCASE').get(String(o.vendorCode||'')); if(!partId||!v)continue;
    const reqp=db.prepare('SELECT * FROM part_requirements WHERE id=? AND work_order_id=?').get(partId,workOrderId); if(!reqp)continue;
    const sku=String(o.vendorSku||reqp.item_ref||''); db.prepare(`INSERT INTO supplier_offers(part_requirement_id,vendor_id,vendor_sku,available_qty,unit_cost,eta_text,source) VALUES(?,?,?,?,?,?,?) ON CONFLICT(part_requirement_id,vendor_id,vendor_sku) DO UPDATE SET available_qty=excluded.available_qty,unit_cost=excluded.unit_cost,eta_text=excluded.eta_text,source=excluded.source,checked_at=CURRENT_TIMESTAMP`).run(partId,v.id,sku,Number(o.availableQty||0),Number(o.unitCost||0),String(o.eta||''),'supplier_webhook');
    db.prepare("UPDATE part_requirements SET status=CASE WHEN ? > 0 THEN 'sourced' ELSE status END,preferred_vendor_id=COALESCE(preferred_vendor_id,?),preferred_vendor_sku=COALESCE(preferred_vendor_sku,?),updated_at=CURRENT_TIMESTAMP WHERE id=?").run(Number(o.availableQty||0),v.id,sku,partId); count++;
  }
  return {status:'ok',offers:count};
}
async function autoSubmitReady(carts) {
  const results=[];
  for(const c of carts||[]){ if(c.status==='ready_to_submit' && Number(c.auto_submit_snapshot||0)===1 && LIVE_VENDOR_ORDERING) results.push({cartId:c.id,...await submitCart(c.id,null)}); }
  return results;
}
async function refreshOrderStatuses() {
  const hook=process.env.VENDOR_STATUS_WEBHOOK_URL; if(!hook)return {status:'not_configured',updated:0};
  const carts=db.prepare(`SELECT pc.*,v.code vendor_code,v.name vendor_name FROM procurement_carts pc JOIN vendors v ON v.id=pc.vendor_id WHERE pc.status IN ('ordered','partially_shipped','shipped','backordered')`).all();
  const r=await fetch(hook,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${process.env.VENDOR_STATUS_WEBHOOK_TOKEN||''}`},body:JSON.stringify({carts})}); const body=await r.json().catch(()=>({})); if(!r.ok)throw new Error(`Vendor status ${r.status}: ${JSON.stringify(body)}`); let updated=0;
  for(const x of Array.isArray(body.updates)?body.updates:[]){const id=Number(x.cartId);if(!id)continue;db.prepare(`UPDATE procurement_carts SET status=COALESCE(?,status),tracking_number=COALESCE(?,tracking_number),eta_text=COALESCE(?,eta_text),external_order_id=COALESCE(?,external_order_id),updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(x.status||null,x.trackingNumber||null,x.eta||null,x.externalOrderId||null,id);updated++;}
  return {status:'ok',updated};
}

function serveStatic(req,res,pathname) {
  const rel=pathname==='/'?'index.html':pathname.slice(1),target=path.resolve(publicDir,rel); if(!target.startsWith(publicDir)||!fs.existsSync(target)||fs.statSync(target).isDirectory())return false;
  const ext=path.extname(target),types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};res.writeHead(200,{'content-type':types[ext]||'application/octet-stream','cache-control':ext==='.html'?'no-store':['.js','.css'].includes(ext)?'no-cache':'public,max-age=3600','x-content-type-options':'nosniff'});fs.createReadStream(target).pipe(res);return true;
}
function portalHtml(token,p) {
  const updates=db.prepare(`SELECT * FROM work_order_updates WHERE work_order_id=? AND customer_visible=1 ORDER BY id DESC`).all(p.work_order_id); const media=db.prepare(`SELECT id,scope,caption,created_at FROM media WHERE work_order_id=? AND customer_visible=1 ORDER BY id DESC`).all(p.work_order_id); const unit=p.unit_label||[p.year,p.make,p.model].filter(Boolean).join(' ');
  const updateHtml=updates.map(u=>`<article class="customer-update"><div class="update-dot"></div><div><div class="muted">${esc(u.created_at)} • ${esc(u.stage||'Update')}</div><h3>${esc(u.title||u.stage||'Shop update')}</h3><p>${esc(u.body||'')}</p></div></article>`).join('')||'<div class="empty">No customer updates have been posted yet.</div>';
  const mediaHtml=media.map(m=>`<figure class="customer-photo"><img src="/portal/${encodeURIComponent(token)}/media/${m.id}" alt="${esc(m.caption||'Repair update photo')}"><figcaption>${esc(m.caption||'')}</figcaption></figure>`).join('');
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(SHOP_NAME)} Repair Status</title><link rel="stylesheet" href="/styles.css"></head><body class="customer-page"><main class="customer-card"><img src="${esc(SHOP_LOGO_URL)}" class="customer-logo"><div class="portal-head"><div><div class="muted">Work Order ${esc(p.ref_number||p.work_order_id)}</div><h1>${esc(unit||'Your repair')}</h1><p>${esc(p.customer_name||'')}</p></div><span class="badge big">${esc(p.stage)}</span></div><div class="portal-progress">${STAGES.filter(s=>!['Declined'].includes(s)).map(s=>`<span class="${s===p.stage?'current':''}">${esc(s)}</span>`).join('')}</div><section><h2>Updates from the shop</h2>${updateHtml}</section>${mediaHtml?`<section><h2>Photos</h2><div class="photo-grid customer-grid">${mediaHtml}</div></section>`:''}<div class="authorized"><strong>Questions?</strong><p>Call ${esc(SHOP_PHONE||SHOP_NAME)} and reference work order ${esc(p.ref_number||p.work_order_id)}.</p></div></main></body></html>`;
}
function approvalHtml(token,a) {
  const media=db.prepare(`SELECT id,caption FROM media WHERE work_order_id=? AND customer_visible=1 AND (scope='approval' OR approval_id=?) ORDER BY id DESC`).all(a.work_order_id,a.id); const unit=a.unit_label||[a.year,a.make,a.model].filter(Boolean).join(' ');
  const photos=media.map(m=>`<figure class="customer-photo"><img src="/approval/${encodeURIComponent(token)}/media/${m.id}" alt="${esc(m.caption||'Repair photo')}"><figcaption>${esc(m.caption||'')}</figcaption></figure>`).join('');
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Repair Authorization</title><link rel="stylesheet" href="/styles.css"></head><body class="approval-page"><main class="approval-card"><img src="${esc(SHOP_LOGO_URL)}" alt="${esc(SHOP_NAME)}" class="customer-logo"><h1>${esc(SHOP_NAME)} Repair Authorization</h1><p><strong>Work Order:</strong> ${esc(a.ref_number||a.work_order_id)}</p><p><strong>Customer:</strong> ${esc(a.customer_name)}</p><p><strong>Unit:</strong> ${esc(unit)}</p>${photos?`<h2>Inspection / approval photos</h2><div class="photo-grid customer-grid">${photos}</div>`:''}<div class="authorized"><strong>Authorized work / estimate description</strong><p>${esc(a.authorized_description)}</p><p><strong>Current estimate:</strong> ${esc(new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(a.estimate_total||0)))}</p></div><div class="authorized"><strong>Authorization terms</strong><p>By signing, the customer authorizes the option selected below and agrees to pay authorized diagnostic, labor, parts, materials, taxes, sublet, and other charges. Diagnostic and teardown charges remain due if repairs are declined. Work beyond the authorized description or approved amount requires additional authorization. Customer-supplied parts are not warranted by the shop. The shop may operate, road-test, water-test, or transport the unit as reasonably necessary for diagnosis and verification. Payment is due before release. The customer consents to electronic records and signature and confirms authority to authorize this work.</p></div>${a.status==='completed'?`<div class="success"><strong>Completed:</strong> ${esc(a.choice)} by ${esc(a.signer_name)} on ${esc(a.signed_at)}</div>`:`<form id="approvalForm"><label><input type="radio" name="choice" value="Approve Repairs" required> Approve repairs described above</label><label><input type="radio" name="choice" value="Diagnostics/Teardown Only"> Diagnostics/teardown only; no additional repair without further approval</label><label><input type="radio" name="choice" value="Decline Repairs"> Decline repairs</label><label>Full legal name<input name="signerName" required autocomplete="name"></label><label class="check"><input type="checkbox" name="agree" required> I authorize the selected option and understand I am responsible for authorized charges.</label><button>Sign & Submit</button></form><script>document.getElementById('approvalForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({choice:f.get('choice'),signerName:f.get('signerName'),agree:f.get('agree')==='on'})});const j=await r.json();if(!r.ok)alert(j.error||'Unable to submit');else location.reload();});</script>`}</main></body></html>`;
}

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`),p=url.pathname;
    if(accessSecurity.middleware(req,res))return;
    if(await accessSecurity.routes(req,res,p,url))return;
    if(await customerAccess.routes(req,res,p,url))return;
    if(await authorizationsRouter(req,res,p,url))return;
    if(await reportsRouter(req,res,p,url))return;
    if(await accountingRouter(req,res,p,url))return;
    if(await notificationsRouter(req,res,p,url))return;
    if(await calendarChangesRouter(req,res,p,url))return;
    if(await managementRouter(req,res,p,url))return;
    if(await maintenance.routes(req,res,p,url))return;
    if(await receiptsRouter(req,res,p,url))return;
    if(await opsRouter(req,res,p,url))return;
    if(await deviceRouter(req,res,p,url))return;
    if(await checkoutRouter(req,res,p,url))return;
    if(await posRouter(req,res,p,url))return;
    if(p==='/health')return json(res,200,{ok:true,name:'Owner Tracker V11'});
    if(p==='/api/login'&&req.method==='POST'){
      const b=await readBody(req),u=db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(String(b.username||'').trim()); const secret=String(b.password||b.pin||'');
      const valid=u&&(verifyPassword(secret,u.salt,u.password_hash)||verifyPassword(secret,u.pin_salt,u.pin_hash)); if(!valid)return json(res,401,{error:'Invalid credentials'});
      const token=crypto.randomBytes(32).toString('base64url'),expires=new Date(Date.now()+12*3600e3).toISOString(); db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(tokenHash(token),u.id,expires); db.prepare('UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?').run(u.id);
      return json(res,200,{ok:true,user:userView(u)},{'set-cookie':`ot_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${PUBLIC_BASE_URL.startsWith('https://')?'; Secure':''}`});
    }
    if(p==='/api/logout'&&req.method==='POST'){const t=parseCookies(req).ot_session;if(t)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(t));return json(res,200,{ok:true},{'set-cookie':'ot_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
    if(p==='/api/me'&&req.method==='GET'){const u=currentUser(req);return json(res,200,{reviewMode:process.env.OWNERTRACKER_REVIEW==='true',user:u?userView(u):null,shop:{name:SHOP_NAME,phone:SHOP_PHONE},stages:STAGES,roles:ROLES,permissions:u?[...PERMISSIONS[u.role]||[]]:[]});}

    if(p==='/api/integrations/qbpos/work-orders/bulk'&&req.method==='POST'){
      if(!requireBridge(req,res))return;
      if(!QBPOS_IMPORT_ENABLED)return json(res,409,{error:'QuickBooks import is disabled. Reviewed migrations may explicitly set QBPOS_IMPORT_MODE=insert-only; existing jobs are never overwritten.'});
      const b=await readBody(req,20_000_000),items=Array.isArray(b)?b:(b.workOrders||[]);
      if(!Array.isArray(items))return json(res,400,{error:'workOrders must be an array'});
      let created=0,updated=0,duplicates=0,errors=[],changedIds=[];
      db.exec('BEGIN IMMEDIATE');try{for(const item of items){db.exec('SAVEPOINT qbpos_item');try{const r=upsertImported(item);if(r.duplicate)duplicates++;else{changedIds.push(r.id);created++;}db.exec('RELEASE qbpos_item');}catch(e){db.exec('ROLLBACK TO qbpos_item; RELEASE qbpos_item');errors.push({externalId:item?.externalId||item?.txnId||'',error:String(e.message||e)});}}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
      const procurement=[]; if(AUTO_BUILD_PROCUREMENT){for(const id of [...new Set(changedIds)]){try{if(AUTO_SUPPLIER_LOOKUP)await lookupSuppliersForWorkOrder(id);const built=buildProcurementCarts(id,null);const autoOrders=await autoSubmitReady(built.carts);procurement.push({workOrderId:id,...built,autoOrders});}catch(e){procurement.push({workOrderId:id,error:String(e.message||e)});}}}
      db.prepare('INSERT INTO sync_runs(source,status,imported_count,updated_count,detail) VALUES(?,?,?,?,?)').run('qbpos',errors.length?'partial':'ok',created,updated,JSON.stringify({errors,procurement,duplicates}).slice(0,5000));return json(res,200,{ok:true,created,updated,duplicates,errors,procurement});
    }
    if(p==='/api/integrations/qbpos/sync-log'&&req.method==='POST'){if(!requireBridge(req,res))return;const b=await readBody(req);db.prepare('INSERT INTO sync_runs(source,status,imported_count,updated_count,detail) VALUES(?,?,?,?,?)').run('qbpos',String(b.status||'info'),Number(b.imported||0),Number(b.updated||0),String(b.detail||''));return json(res,200,{ok:true});}

    if(p==='/api/dashboard'&&req.method==='GET'){
      const u=requirePermission(req,res,'read');if(!u)return;if(u.role==='technician')return json(res,403,{error:'Use the assigned-work queue'});const summary=db.prepare(`SELECT COUNT(*) open_jobs,COALESCE(SUM(estimate_total),0) pipeline,COALESCE(SUM(balance),0) unpaid,COALESCE(SUM(labor_total),0) labor_sold,SUM(CASE WHEN stage='Awaiting Approval' THEN 1 ELSE 0 END) approvals,SUM(CASE WHEN julianday('now')-julianday(COALESCE(date_opened,created_at))>=7 AND stage NOT IN ('Closed','Picked Up','Declined') THEN 1 ELSE 0 END) aging FROM work_orders WHERE stage NOT IN ('Closed','Picked Up','Declined')`).get();
      summary.parts_missing=db.prepare(`SELECT COUNT(*) c FROM part_requirements pr WHERE pr.active=1 AND pr.status='needs_source' AND NOT EXISTS(SELECT 1 FROM supplier_offers so WHERE so.part_requirement_id=pr.id AND so.available_qty>0)`).get().c; summary.orders_ready=db.prepare("SELECT COUNT(*) c FROM procurement_carts WHERE status IN ('ready_to_submit','manual_action_required')").get().c;
      const pipeline=db.prepare(`SELECT stage,COUNT(*) count,COALESCE(SUM(estimate_total),0) total FROM work_orders GROUP BY stage ORDER BY CASE stage ${STAGES.map((s,i)=>`WHEN '${s.replaceAll("'","''")}' THEN ${i}`).join(' ')} ELSE 99 END`).all(); const recent=db.prepare(`SELECT w.id,w.ref_number,w.customer_name,w.unit_label,w.year,w.make,w.model,w.stage,w.estimate_total,w.balance,w.updated_at,w.date_opened,w.assigned_user_id,COALESCE(u.display_name,u.username) assigned_name,w.next_action,w.priority FROM work_orders w LEFT JOIN users u ON u.id=w.assigned_user_id ORDER BY datetime(w.updated_at) DESC LIMIT 30`).all(); const sync=db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 5').all();return json(res,200,{summary,pipeline,recent,sync});
    }
    if(p==='/api/my-work'&&req.method==='GET'){
      const u=requirePermission(req,res,'read');if(!u)return;let rows;if(['owner','manager','service_writer'].includes(u.role))rows=db.prepare(`SELECT w.id,w.ref_number,w.customer_name,w.unit_label,w.year,w.make,w.model,w.stage,w.priority,w.next_action,w.next_action_due,COALESCE(us.display_name,us.username) assigned_name FROM work_orders w LEFT JOIN users us ON us.id=w.assigned_user_id WHERE w.stage NOT IN ('Closed','Picked Up','Declined') ORDER BY CASE w.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,COALESCE(w.next_action_due,'9999')`).all();else rows=db.prepare(`SELECT w.id,w.ref_number,w.customer_name,w.unit_label,w.year,w.make,w.model,w.stage,w.priority,w.next_action,w.next_action_due,COALESCE(us.display_name,us.username) assigned_name FROM work_orders w LEFT JOIN users us ON us.id=w.assigned_user_id WHERE w.stage NOT IN ('Closed','Picked Up','Declined') AND (w.assigned_user_id=? OR (?='advisor' AND w.service_advisor_id=?)) ORDER BY CASE w.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,COALESCE(w.next_action_due,'9999')`).all(u.id,u.role,u.id);return json(res,200,{workOrders:rows});
    }
    if(p==='/api/work-orders'&&req.method==='GET'){
      const u=requirePermission(req,res,'read');if(!u)return;const stage=url.searchParams.get('stage')||'',q=url.searchParams.get('q')||'';let sql=`SELECT w.id,w.source,w.external_id,w.ref_number,w.customer_name,w.phone,w.unit_label,w.year,w.make,w.model,w.stage,w.estimate_total,w.parts_total,w.labor_total,w.paid_total,w.balance,w.tech,w.date_opened,w.updated_at,w.priority,w.next_action,w.assigned_user_id,COALESCE(u.display_name,u.username) assigned_name FROM work_orders w LEFT JOIN users u ON u.id=w.assigned_user_id WHERE 1=1`;const params=[];if(u.role==='technician'){sql+=' AND w.assigned_user_id=?';params.push(u.id)}if(stage){sql+=' AND w.stage=?';params.push(stage);}if(q){sql+=' AND (w.ref_number LIKE ? OR w.customer_name LIKE ? OR w.phone LIKE ? OR w.unit_label LIKE ? OR w.make LIKE ? OR w.model LIKE ?)';for(let i=0;i<6;i++)params.push(`%${q}%`);}sql+=' ORDER BY datetime(w.updated_at) DESC LIMIT 500';return json(res,200,{workOrders:db.prepare(sql).all(...params)});
    }
    const wm=p.match(/^\/api\/work-orders\/(\d+)$/);
    if(wm&&req.method==='GET'){const u=requirePermission(req,res,'read');if(!u)return;if(!canAccessJob(u,Number(wm[1])))return json(res,403,{error:'Not assigned to this work order'});const wo=workOrderView(Number(wm[1]));return wo?json(res,200,{workOrder:wo}):json(res,404,{error:'Not found'});}
    if(wm&&req.method==='PATCH'){
      const u=requirePermission(req,res,'edit_job');if(!u)return;if(!canAccessJob(u,Number(wm[1])))return json(res,403,{error:'Not assigned to this work order'});const id=Number(wm[1]),b=await readBody(req);requireEditRevision(db,req,p,b);const before=workOrderView(id);if(repairFinancialFields.some(key=>Object.hasOwn(b,key))){assertManualRepairAccount(db,id);return json(res,400,{error:'Financial changes must use the POS sale-line and payment routes'});}assertJobStageChange(before,b.stage);const identityChanged=assertJobIdentityChange(db,before,b);const allowed=(u.role==='technician'?['stage','next_action','next_action_due']:['stage','authorized_work','tech','unit_label','year','make','model','serial','complaint','assigned_user_id','priority','promised_date','next_action','next_action_due']),sets=[],params=[];for(const k of allowed)if(Object.hasOwn(b,k)){if(k==='stage'&&!STAGES.includes(b[k]))return json(res,400,{error:'Invalid stage'});if(k==='assigned_user_id'&&!can(u,'assign_job'))return json(res,403,{error:'Only service writers/managers can reassign jobs'});if(k==='assigned_user_id'){sets.push(`${k}=?`);params.push(b[k]?Number(b[k]):null);}else{sets.push(`${k}=?`);params.push(String(b[k]??''));}}if(!sets.length)return json(res,400,{error:'No editable fields'});sets.push('updated_at=CURRENT_TIMESTAMP');params.push(id);db.exec('BEGIN IMMEDIATE');try{db.prepare(`UPDATE work_orders SET ${sets.join(',')} WHERE id=?`).run(...params);audit(id,u.username,'Work order updated',b);if(identityChanged)audit(id,u.username,'Job identity corrected',{before:Object.fromEntries(jobIdentityFields.map(key=>[key,before[key]??null])),after:Object.fromEntries(jobIdentityFields.map(key=>[key,workOrderView(id)[key]??null]))});db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}return json(res,200,{ok:true,workOrder:workOrderView(id)});
    }
    const noteM=p.match(/^\/api\/work-orders\/(\d+)\/notes$/);
    if(noteM&&req.method==='POST'){const u=requirePermission(req,res,'notes');if(!u)return;if(!canAccessJob(u,Number(noteM[1])))return json(res,403,{error:'Not assigned to this work order'});const id=Number(noteM[1]),b=await readBody(req),body=String(b.body||'').trim();if(!body)return json(res,400,{error:'Note required'});db.prepare('INSERT INTO notes(work_order_id,body,author) VALUES(?,?,?)').run(id,body,u.display_name||u.username);audit(id,u.username,'Internal note added');return json(res,200,{ok:true});}
    const updateM=p.match(/^\/api\/work-orders\/(\d+)\/updates$/);
    if(updateM&&req.method==='POST'){
      const u=requirePermission(req,res,'updates');if(!u)return;if(!canAccessJob(u,Number(updateM[1])))return json(res,403,{error:'Not assigned to this work order'});const id=Number(updateM[1]),b=await readBody(req);requireEditRevision(db,req,p,b);const wo=workOrderView(id);if(!wo)return json(res,404,{error:'Not found'});if(b.stage&&!STAGES.includes(b.stage))return json(res,400,{error:'Invalid stage'});assertJobStageChange(wo,b.stage);const title=String(b.title||'').trim(),body=String(b.body||'').trim(),visible=b.customerVisible!==false,notifyCustomer=!!b.notifyCustomer; if(!title&&!body)return json(res,400,{error:'Update title or body required'});
      const r=db.prepare(`INSERT INTO work_order_updates(work_order_id,author_user_id,author_name,title,body,stage,customer_visible,notify_customer) VALUES(?,?,?,?,?,?,?,?)`).run(id,u.id,u.display_name||u.username,title,body,String(b.stage||wo.stage),visible?1:0,notifyCustomer?1:0); const updateId=Number(r.lastInsertRowid); const mediaIds=Array.isArray(b.mediaIds)?b.mediaIds.map(Number).filter(Boolean):[]; if(mediaIds.length){const marks=mediaIds.map(()=>'?').join(',');db.prepare(`UPDATE media SET update_id=? WHERE work_order_id=? AND id IN (${marks})`).run(updateId,id,...mediaIds);}
      if(b.stage&&STAGES.includes(b.stage))db.prepare('UPDATE work_orders SET stage=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(b.stage,id);let portalUrl=null,notification=null;if(visible&&notifyCustomer){portalUrl=createPortalLink(id);notification=await notify('customer_progress_update',workOrderView(id),{portalUrl,title,body,stage:b.stage||wo.stage});}audit(id,u.username,'Customer progress update posted',{title,visible,notifyCustomer,mediaIds});return json(res,200,{ok:true,updateId,portalUrl,notification});
    }
    const mediaM=p.match(/^\/api\/work-orders\/(\d+)\/media$/);
    if(mediaM&&req.method==='POST'){const u=requirePermission(req,res,'media');if(!u)return;if(!canAccessJob(u,Number(mediaM[1])))return json(res,403,{error:'Not assigned to this work order'});const id=Number(mediaM[1]);if(!db.prepare('SELECT id FROM work_orders WHERE id=?').get(id))return json(res,404,{error:'Not found'});const b=await readBody(req,12_000_000),mediaId=saveImage({workOrderId:id,updateId:b.updateId?Number(b.updateId):null,approvalId:b.approvalId?Number(b.approvalId):null,scope:String(b.scope||'progress'),filename:b.filename,mimeType:String(b.mimeType||''),dataBase64:b.dataBase64,caption:b.caption,customerVisible:b.customerVisible!==false,userId:u.id});audit(id,u.username,'Photo uploaded',{mediaId,scope:b.scope||'progress',customerVisible:b.customerVisible!==false});return json(res,200,{ok:true,mediaId,url:`/api/media/${mediaId}`});}
    const portalM=p.match(/^\/api\/work-orders\/(\d+)\/customer-link$/);
    if(portalM&&req.method==='POST'){const u=requirePermission(req,res,'updates');if(!u)return;const id=Number(portalM[1]);if(!db.prepare('SELECT id FROM work_orders WHERE id=?').get(id))return json(res,404,{error:'Not found'});const portalUrl=createPortalLink(id);audit(id,u.username,'Customer portal link created');return json(res,200,{ok:true,portalUrl});}
    const approvalM=p.match(/^\/api\/work-orders\/(\d+)\/request-approval$/);
    if(approvalM&&req.method==='POST'){
      const u=requirePermission(req,res,'approval');if(!u)return;const id=Number(approvalM[1]),wo=workOrderView(id);if(!wo)return json(res,404,{error:'Not found'});const b=await readBody(req),desc=String(b.authorizedDescription||wo.authorized_work||wo.complaint||'').trim();if(!desc)return json(res,400,{error:'Authorized work description is required'});const token=crypto.randomBytes(32).toString('base64url');const r=db.prepare('INSERT INTO approvals(work_order_id,token_hash,status,authorized_description) VALUES(?,?,?,?)').run(id,publicHash(token),'sent',desc);const approvalId=Number(r.lastInsertRowid);const mediaIds=Array.isArray(b.mediaIds)?b.mediaIds.map(Number).filter(Boolean):[];if(mediaIds.length){const marks=mediaIds.map(()=>'?').join(',');db.prepare(`UPDATE media SET approval_id=?,scope='approval',customer_visible=1 WHERE work_order_id=? AND id IN (${marks})`).run(approvalId,id,...mediaIds);}let ds={mode:'internal'};try{ds=await docusignEnvelope(wo,token);if(ds.envelopeId)db.prepare('UPDATE approvals SET external_envelope_id=? WHERE id=?').run(ds.envelopeId,approvalId);}catch(e){return json(res,502,{error:String(e.message||e)});}db.prepare("UPDATE work_orders SET stage='Awaiting Approval',authorized_work=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(desc,id);const approvalUrl=`${PUBLIC_BASE_URL}/approval/${token}`;await notify('approval_requested',workOrderView(id),{approvalUrl,authorizedDescription:desc,docusign:ds});audit(id,u.username,'Approval requested',{approvalUrl,docusign:ds,mediaIds});return json(res,200,{ok:true,approvalUrl,approvalId,docusign:ds});
    }
    const readyM=p.match(/^\/api\/work-orders\/(\d+)\/ready$/);
    if(readyM&&req.method==='POST'){const u=requirePermission(req,res,'ready');if(!u)return;const readyInput=await readBody(req);requireEditRevision(db,req,p,readyInput);const id=Number(readyM[1]),wo=workOrderView(id);if(!wo)return json(res,404,{error:'Not found'});assertJobStageChange(wo,'Ready');db.prepare("UPDATE work_orders SET stage='Ready',next_action='Customer pickup',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);const portalUrl=createPortalLink(id);const notification=await notify('ready_for_pickup',workOrderView(id),{shop:{name:SHOP_NAME,phone:SHOP_PHONE},portalUrl});audit(id,u.username,'Marked ready and pickup notification triggered',notification);return json(res,200,{ok:true,notification,portalUrl});}

    if(p==='/api/staff'&&req.method==='GET'){const u=requirePermission(req,res,'read');if(!u)return;const rows=db.prepare("SELECT id,username,display_name,role,active,last_login_at,created_at FROM users WHERE active=1 AND role!='viewer' ORDER BY display_name,username").all();return json(res,200,{users:rows.map(userView)});}
    if(p==='/api/users'&&req.method==='GET'){const u=requirePermission(req,res,'users');if(!u)return;const rows=db.prepare('SELECT id,username,display_name,role,active,last_login_at,created_at FROM users ORDER BY active DESC,display_name,username').all();return json(res,200,{users:rows.map(userView)});}
    if(p==='/api/users'&&req.method==='POST'){
      const u=requirePermission(req,res,'users');if(!u)return;const b=await readBody(req),username=String(b.username||'').trim().toLowerCase(),displayName=String(b.displayName||username).trim(),role=String(b.role||'technician'),password=String(b.password||''),pin=String(b.pin||'');if(u.role!=='owner'&&role==='owner')return json(res,403,{error:'Only an owner may create another owner'});if(!username||!ROLES.includes(role)||password.length<8)return json(res,400,{error:'Username, valid role, and password of at least 8 characters required'});if(pin&&(!/^\d{4,8}$/.test(pin)))return json(res,400,{error:'PIN must be 4-8 digits'});const ph=hashPassword(password),pinh=pin?hashPassword(pin):{salt:null,hash:null};try{const r=db.prepare('INSERT INTO users(username,display_name,password_hash,salt,role,active,pin_hash,pin_salt) VALUES(?,?,?,?,?,1,?,?)').run(username,displayName,ph.hash,ph.salt,role,pinh.hash,pinh.salt);return json(res,201,{ok:true,user:userView(db.prepare('SELECT * FROM users WHERE id=?').get(Number(r.lastInsertRowid)))});}catch(e){if(String(e).includes('UNIQUE'))return json(res,409,{error:'Username already exists'});throw e;}
    }
    const userM=p.match(/^\/api\/users\/(\d+)$/);
    if(userM&&req.method==='PATCH'){const u=requirePermission(req,res,'users');if(!u)return;const id=Number(userM[1]),b=await readBody(req),sets=[],vals=[];const target=db.prepare('SELECT id,role,active FROM users WHERE id=?').get(id);if(!target)return json(res,404,{error:'Employee not found'});if(u.role!=='owner'&&(target.role==='owner'||b.role==='owner'))return json(res,403,{error:'Only an owner may change owner accounts or assign owner access'});if(Object.hasOwn(b,'active')&&typeof b.active!=='boolean')return json(res,400,{error:'Active must be true or false'});if(target.role==='owner'&&target.active&&((b.role&&b.role!=='owner')||b.active===false)&&db.prepare("SELECT COUNT(*) n FROM users WHERE role='owner' AND active=1").get().n<=1)return json(res,409,{error:'Keep at least one active owner account'});if(Object.hasOwn(b,'displayName')){sets.push('display_name=?');vals.push(String(b.displayName||''));}if(Object.hasOwn(b,'role')){if(!ROLES.includes(b.role))return json(res,400,{error:'Invalid role'});sets.push('role=?');vals.push(b.role);}if(Object.hasOwn(b,'active')){sets.push('active=?');vals.push(b.active?1:0);}if(b.password){if(String(b.password).length<8)return json(res,400,{error:'Password must be at least 8 characters'});const x=hashPassword(b.password);sets.push('password_hash=?','salt=?');vals.push(x.hash,x.salt);}if(Object.hasOwn(b,'pin')){if(b.pin&&!/^\d{4,8}$/.test(String(b.pin)))return json(res,400,{error:'PIN must be 4-8 digits'});const x=b.pin?hashPassword(b.pin):{hash:null,salt:null};sets.push('pin_hash=?','pin_salt=?');vals.push(x.hash,x.salt);}if(!sets.length)return json(res,400,{error:'No changes'});sets.push('updated_at=CURRENT_TIMESTAMP');vals.push(id);db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...vals);audit(null,u.username,'Employee account updated',{userId:id,changedFields:Object.keys(b)});return json(res,200,{ok:true,user:userView(db.prepare('SELECT * FROM users WHERE id=?').get(id))});}

    if(p==='/api/vendors'&&req.method==='GET'){const u=requirePermission(req,res,'parts');if(!u)return;return json(res,200,{vendors:db.prepare('SELECT * FROM vendors ORDER BY name').all(),liveVendorOrdering:LIVE_VENDOR_ORDERING});}
    const vendorM=p.match(/^\/api\/vendors\/(\d+)$/);
    if(vendorM&&req.method==='PATCH'){const u=requirePermission(req,res,'settings');if(!u)return;const id=Number(vendorM[1]),b=await readBody(req),sets=[],vals=[];for(const k of ['name','integration_mode','portal_url'])if(Object.hasOwn(b,k)){sets.push(`${k}=?`);vals.push(String(b[k]??''));}for(const k of ['order_threshold'])if(Object.hasOwn(b,k)){sets.push(`${k}=?`);vals.push(Number(b[k]||0));}for(const k of ['auto_submit','enabled'])if(Object.hasOwn(b,k)){sets.push(`${k}=?`);vals.push(b[k]?1:0);}if(!sets.length)return json(res,400,{error:'No changes'});sets.push('updated_at=CURRENT_TIMESTAMP');vals.push(id);db.prepare(`UPDATE vendors SET ${sets.join(',')} WHERE id=?`).run(...vals);return json(res,200,{ok:true});}
    const partsM=p.match(/^\/api\/work-orders\/(\d+)\/parts\/build-carts$/);
    if(partsM&&req.method==='POST'){const u=requirePermission(req,res,'parts');if(!u)return;const id=Number(partsM[1]),result=buildProcurementCarts(id,u.id);audit(id,u.username,'Procurement carts built',result);return json(res,200,{ok:true,...result});}
    const offerM=p.match(/^\/api\/parts\/(\d+)\/offers$/);
    if(offerM&&req.method==='POST'){const u=requirePermission(req,res,'parts');if(!u)return;const partId=Number(offerM[1]),b=await readBody(req),vendorId=Number(b.vendorId),vendor=db.prepare('SELECT * FROM vendors WHERE id=?').get(vendorId);if(!vendor)return json(res,400,{error:'Vendor required'});const reqp=db.prepare('SELECT * FROM part_requirements WHERE id=?').get(partId);if(!reqp)return json(res,404,{error:'Part requirement not found'});const sku=String(b.vendorSku||reqp.item_ref||'');const unitCost=Number(b.unitCost||0);db.prepare(`INSERT INTO supplier_offers(part_requirement_id,vendor_id,vendor_sku,available_qty,unit_cost,eta_text,source) VALUES(?,?,?,?,?,?,?) ON CONFLICT(part_requirement_id,vendor_id,vendor_sku) DO UPDATE SET available_qty=excluded.available_qty,unit_cost=excluded.unit_cost,eta_text=excluded.eta_text,source=excluded.source,checked_at=CURRENT_TIMESTAMP`).run(partId,vendorId,sku,Number(b.availableQty||0),unitCost,String(b.eta||''),String(b.source||'manual'));db.prepare("UPDATE part_requirements SET status='sourced',preferred_vendor_id=COALESCE(preferred_vendor_id,?),preferred_vendor_sku=COALESCE(preferred_vendor_sku,?),updated_at=CURRENT_TIMESTAMP WHERE id=?").run(vendorId,sku,partId);if(reqp.item_ref)db.prepare(`INSERT INTO part_vendor_map(shop_item_ref,vendor_id,vendor_sku,last_unit_cost,times_used) VALUES(?,?,?,?,1) ON CONFLICT(shop_item_ref,vendor_id,vendor_sku) DO UPDATE SET last_unit_cost=excluded.last_unit_cost,times_used=part_vendor_map.times_used+1,last_used_at=CURRENT_TIMESTAMP`).run(reqp.item_ref,vendorId,sku,unitCost);return json(res,200,{ok:true});}
    const reqPartM=p.match(/^\/api\/parts\/(\d+)$/);
    if(reqPartM&&req.method==='PATCH'){const u=requirePermission(req,res,'parts');if(!u)return;const id=Number(reqPartM[1]),b=await readBody(req),sets=[],vals=[];for(const k of ['preferred_vendor_id'])if(Object.hasOwn(b,k)){sets.push(`${k}=?`);vals.push(b[k]?Number(b[k]):null);}for(const k of ['preferred_vendor_sku','notes','status'])if(Object.hasOwn(b,k)){sets.push(`${k}=?`);vals.push(String(b[k]??''));}for(const k of ['qty_on_hand','qty_received','qty_ordered'])if(Object.hasOwn(b,k)){sets.push(`${k}=?`);vals.push(Number(b[k]||0));}if(!sets.length)return json(res,400,{error:'No changes'});sets.push('updated_at=CURRENT_TIMESTAMP');vals.push(id);db.prepare(`UPDATE part_requirements SET ${sets.join(',')} WHERE id=?`).run(...vals);const r=db.prepare('SELECT * FROM part_requirements WHERE id=?').get(id);db.prepare('UPDATE part_requirements SET status=? WHERE id=?').run(partStatus(r),id);return json(res,200,{ok:true});}
    if(p==='/api/procurement/build-all'&&req.method==='POST'){const u=requirePermission(req,res,'parts');if(!u)return;const ids=db.prepare("SELECT id FROM work_orders WHERE stage NOT IN ('Closed','Picked Up','Declined') ORDER BY id").all().map(x=>x.id);const results=[];for(const id of ids){try{if(AUTO_SUPPLIER_LOOKUP)await lookupSuppliersForWorkOrder(id);const built=buildProcurementCarts(id,u.id);const autoOrders=await autoSubmitReady(built.carts);results.push({workOrderId:id,...built,autoOrders});}catch(e){results.push({workOrderId:id,error:String(e.message||e)});}}return json(res,200,{ok:true,results});}
    if(p==='/api/procurement/refresh-suppliers'&&req.method==='POST'){const u=requirePermission(req,res,'parts');if(!u)return;const ids=db.prepare("SELECT DISTINCT work_order_id id FROM part_requirements WHERE active=1 AND status NOT IN ('received')").all().map(x=>x.id);const results=[];for(const id of ids){try{results.push({workOrderId:id,...await lookupSuppliersForWorkOrder(id)});}catch(e){results.push({workOrderId:id,status:'error',error:String(e.message||e)});}}return json(res,200,{ok:true,results});}
    if(p==='/api/procurement/refresh-status'&&req.method==='POST'){const u=requirePermission(req,res,'parts');if(!u)return;return json(res,200,{ok:true,...await refreshOrderStatuses()});}
    if(p==='/api/procurement'&&req.method==='GET'){const u=requirePermission(req,res,'parts');if(!u)return;return json(res,200,procurementSummary());}
    const cartM=p.match(/^\/api\/procurement\/carts\/(\d+)$/);
    if(cartM&&req.method==='PATCH'){
      const u=requirePermission(req,res,'parts');if(!u)return;
      const id=Number(cartM[1]),input=await readBody(req),existing=db.prepare('SELECT * FROM procurement_carts WHERE id=?').get(id);
      if(!existing)return json(res,404,{error:'Cart not found'});
      if(Object.hasOwn(input,'status')&&(typeof input.status!=='string'||!['draft','waiting_threshold','ready_to_submit','manual_action_required','ordered','backordered','partially_shipped','shipped','received','cancelled','error'].includes(input.status)))return json(res,400,{error:'Invalid order status'});
      const next=String(input.status||existing.status),ordered=new Set(['ordered','backordered','partially_shipped','shipped','received']);
      const transitions={draft:['waiting_threshold','ready_to_submit','cancelled'],waiting_threshold:['draft','ready_to_submit','cancelled'],ready_to_submit:['draft','waiting_threshold','cancelled'],manual_action_required:['ordered','backordered','partially_shipped','shipped','received','cancelled'],ordered:['backordered','partially_shipped','shipped','received','cancelled'],backordered:['ordered','partially_shipped','shipped','received','cancelled'],partially_shipped:['backordered','shipped','received','cancelled'],shipped:['partially_shipped','received'],received:[],cancelled:[],error:['draft','cancelled']};
      if(next!==existing.status&&!transitions[existing.status]?.includes(next))return json(res,409,{error:'This order status transition requires reviewed purchasing or a new record'});
      const reference=String(input.order_reference||existing.order_reference||'').trim();
      if(ordered.has(existing.status)&&Object.hasOwn(input,'order_reference')&&String(input.order_reference).trim()!==String(existing.order_reference||'').trim())return json(res,409,{error:'Retain the original supplier confirmation; record corrections in an audited receiving record'});
      if(ordered.has(next)){
        if(!db.prepare('SELECT id FROM purchase_commands WHERE cart_id=? LIMIT 1').get(id))return json(res,409,{error:'Review and queue the exact supplier cart before recording an actual supplier order'});
        if(reference.length<3)return json(res,409,{error:'A real supplier order/confirmation reference is required'});
      }
      if(next==='cancelled'&&ordered.has(existing.status)&&String(input.reason||'').trim().length<5)return json(res,400,{error:'Record the supplier cancellation reason'});
      const fields=['status','order_reference','tracking_number','eta_text'].filter(key=>Object.hasOwn(input,key));
      if(!fields.length)return json(res,400,{error:'No editable order fields'});
      const lines=db.prepare('SELECT * FROM procurement_cart_lines WHERE cart_id=?').all(id);
      db.exec('BEGIN IMMEDIATE');try{
        if(ordered.has(next)&&!ordered.has(existing.status))for(const line of lines)db.prepare("UPDATE part_requirements SET qty_ordered=qty_ordered+?,status='ordered',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(line.qty,line.part_requirement_id);
        if(next==='received'&&existing.status!=='received')for(const line of lines)db.prepare("UPDATE part_requirements SET qty_received=qty_received+?,status='received',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(line.qty,line.part_requirement_id);
        if(next==='cancelled'&&ordered.has(existing.status))for(const line of lines)db.prepare("UPDATE part_requirements SET qty_ordered=MAX(0,qty_ordered-?),status='needs_source',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(line.qty,line.part_requirement_id);
        db.prepare(`UPDATE procurement_carts SET ${fields.map(key=>key+'=?').join(',')},updated_at=CURRENT_TIMESTAMP${next==='received'?",received_at=CURRENT_TIMESTAMP":''} WHERE id=?`).run(...fields.map(key=>String(input[key]??'').slice(0,500)),id);
        audit(null,u.username,'Supplier order status updated',{cartId:id,status:next,reference,reason:String(input.reason||'').slice(0,500)});db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      return json(res,200,{ok:true});
    }

    const submitM=p.match(/^\/api\/procurement\/carts\/(\d+)\/submit$/);
    if(submitM&&req.method==='POST'){const u=requirePermission(req,res,'submit_orders');if(!u)return;return json(res,409,{error:'Direct submission disabled. Review all lines with /review to queue an audited desktop command.'});}

    const mediaGet=p.match(/^\/api\/media\/(\d+)$/);
    if(mediaGet&&req.method==='GET'){const u=requirePermission(req,res,'read');if(!u)return;const m=db.prepare('SELECT * FROM media WHERE id=?').get(Number(mediaGet[1]));if(!m)return text(res,404,'Not found');if(!canAccessJob(u,m.work_order_id))return text(res,403,'Not assigned to work order');return serveMediaRecord(res,m);}

    const portal=p.match(/^\/portal\/([A-Za-z0-9_-]+)$/);
    if(portal&&req.method==='GET'){const pr=portalRecord(portal[1]);if(!pr)return text(res,404,'Customer portal link not found or expired');return text(res,200,portalHtml(portal[1],pr),'text/html; charset=utf-8');}
    const portalMedia=p.match(/^\/portal\/([A-Za-z0-9_-]+)\/media\/(\d+)$/);
    if(portalMedia&&req.method==='GET'){const pr=portalRecord(portalMedia[1]);if(!pr)return text(res,404,'Not found');const m=db.prepare('SELECT * FROM media WHERE id=? AND work_order_id=? AND customer_visible=1').get(Number(portalMedia[2]),pr.work_order_id);if(!m)return text(res,404,'Not found');return serveMediaRecord(res,m);}

    const ap=p.match(/^\/approval\/([A-Za-z0-9_-]+)$/);
    if(ap&&req.method==='GET'){const a=db.prepare(`SELECT a.id,a.status,a.choice,a.signer_name,a.signed_at,a.authorized_description,w.id work_order_id,w.ref_number,w.customer_name,w.unit_label,w.year,w.make,w.model,w.estimate_total FROM approvals a JOIN work_orders w ON w.id=a.work_order_id WHERE a.token_hash=?`).get(publicHash(ap[1]));if(!a)return text(res,404,'Approval link not found');return text(res,200,approvalHtml(ap[1],a),'text/html; charset=utf-8');}
    const apMedia=p.match(/^\/approval\/([A-Za-z0-9_-]+)\/media\/(\d+)$/);
    if(apMedia&&req.method==='GET'){const a=db.prepare('SELECT * FROM approvals WHERE token_hash=?').get(publicHash(apMedia[1]));if(!a)return text(res,404,'Not found');const m=db.prepare("SELECT * FROM media WHERE id=? AND work_order_id=? AND customer_visible=1 AND (scope='approval' OR approval_id=?)").get(Number(apMedia[2]),a.work_order_id,a.id);if(!m)return text(res,404,'Not found');return serveMediaRecord(res,m);}
    if(ap&&req.method==='POST'){const a=db.prepare(`SELECT a.*,w.ref_number,w.customer_name,w.phone,w.email FROM approvals a JOIN work_orders w ON w.id=a.work_order_id WHERE a.token_hash=?`).get(publicHash(ap[1]));if(!a)return json(res,404,{error:'Approval link not found'});if(a.status==='completed')return json(res,409,{error:'Approval already completed'});const b=await readBody(req),choices=['Approve Repairs','Diagnostics/Teardown Only','Decline Repairs'];if(!choices.includes(b.choice)||!b.agree||!String(b.signerName||'').trim())return json(res,400,{error:'Choice, legal name, and agreement are required'});const signed=new Date().toISOString();db.prepare('UPDATE approvals SET status=?,choice=?,signer_name=?,signed_at=? WHERE id=?').run('completed',b.choice,String(b.signerName).trim(),signed,a.id);const stage=b.choice==='Approve Repairs'?'In Progress':b.choice==='Diagnostics/Teardown Only'?'Diagnosing':'Declined';db.prepare('UPDATE work_orders SET stage=?,next_action=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(stage,b.choice==='Approve Repairs'?'Order required parts / begin authorized work':b.choice==='Diagnostics/Teardown Only'?'Complete diagnostic findings':'Prepare unit for declined-work pickup',a.work_order_id);const wo=workOrderView(a.work_order_id);await notify('approval_completed',wo,{choice:b.choice,signerName:String(b.signerName).trim(),signedAt:signed});audit(a.work_order_id,'customer','Approval completed',{choice:b.choice,signerName:String(b.signerName).trim()});return json(res,200,{ok:true});}

    if(p.startsWith('/api/'))return json(res,404,{error:'API route not found'});if(serveStatic(req,res,p))return;return serveStatic(req,res,'/')||text(res,404,'Not found');
  }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'Internal server error',...(e.currentRevision?{currentRevision:e.currentRevision}:{}),detail:process.env.NODE_ENV==='production'?undefined:String(e.message||e)});else res.end();}
});
server.listen(PORT,HOST,()=>console.log(`Owner Tracker V11 listening on http://${HOST}:${PORT}`));
let closing=false;
function shutdown(){
 if(closing)return;closing=true;
 maintenance.stop();notifications.stop();
 server.close(()=>{try{db.close();}finally{process.exit(0);}});
 setTimeout(()=>process.exit(1),5000).unref();
}
process.once('SIGTERM',shutdown);
process.once('SIGINT',shutdown);

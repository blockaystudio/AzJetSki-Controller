// Owner Tracker V9 billing & work-order DocuSign extension.
// Does not process raw card data. Provider transaction flows require merchant onboarding.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {sendInvoiceMail, smtpConfigured} from './shop-mail.mjs';
const t=(v,n=2000)=>String(v??'').trim().slice(0,n);
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cents=x=>{ if(typeof x==='string'&&!/^\d+(?:\.\d{1,2})?$/.test(x.trim()))throw Error('Invalid money precision'); const n=Number(x);if(!Number.isFinite(n)||n<=0||n>1000000)throw Error('Invalid amount');return Math.round(n*100); };
const dollar=n=>(Number(n)/100).toLocaleString('en-US',{style:'currency',currency:'USD'});
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const safeUrl=u=>{try{const a=new URL(u);return a.protocol==='https:'?a.toString():null}catch{return null}};
const roles=new Set(['owner','manager','service_writer','advisor']);
function pdfEscape(s){return t(s,2000).replace(/[^\x20-\x7e]/g,' ').replace(/[()\\]/g,'\\$&');}
// Minimal valid PDF writer with base Helvetica font, supporting multiple pages.
export function makePdf(lines){
 const pages=[];let current=[];for(const l of lines){if(current.length>=50){pages.push(current);current=[];}let s=String(l);while(s.length>93){current.push(s.slice(0,93));s=s.slice(93);if(current.length>=50){pages.push(current);current=[];}}current.push(s);}if(current.length)pages.push(current);
 const objects=[''];const add=s=>{objects.push(s);return objects.length-1};const catalog=add(''),tree=add('');const font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');const pids=[];
 for(const pageLines of pages){let content='BT /F1 10 Tf 12 TL 50 750 Td\n';for(let i=0;i<pageLines.length;i++){content+=`(${pdfEscape(pageLines[i])}) Tj T*\n`;}content+='ET\n';const byteLength=Buffer.byteLength(content,'latin1');const stream=add(`<< /Length ${byteLength} >>\nstream\n${content}endstream`);pids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`));}
 objects[tree]=`<< /Type /Pages /Kids [${pids.map(x=>x+' 0 R').join(' ')}] /Count ${pids.length} >>`;objects[catalog]=`<< /Type /Catalog /Pages ${tree} 0 R >>`;let out='%PDF-1.4\n';const offsets=[0];for(let i=1;i<objects.length;i++){offsets[i]=Buffer.byteLength(out,'latin1');out+=`${i} 0 obj\n${objects[i]}\nendobj\n`;}const pos=Buffer.byteLength(out,'latin1');out+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`;for(let i=1;i<objects.length;i++)out+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;out+=`trailer\n<< /Size ${objects.length} /Root ${catalog} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;return Buffer.from(out,'latin1');
}
export function installCheckout(db){db.exec(`
 CREATE TABLE IF NOT EXISTS ot_invoices(id INTEGER PRIMARY KEY AUTOINCREMENT,work_order_id INTEGER NOT NULL REFERENCES work_orders(id),number TEXT NOT NULL UNIQUE,token_hash TEXT NOT NULL UNIQUE,amount_cents INTEGER NOT NULL,issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,valid_until TEXT NOT NULL,recipient_name TEXT NOT NULL,recipient_email TEXT NOT NULL DEFAULT '',recipient_phone TEXT NOT NULL DEFAULT '',snapshot_json TEXT NOT NULL,created_by INTEGER REFERENCES users(id),voided_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS ot_payment_requests(id INTEGER PRIMARY KEY AUTOINCREMENT,invoice_id INTEGER NOT NULL REFERENCES ot_invoices(id),method TEXT NOT NULL CHECK(method IN ('dejavoo_p1_terminal','dejavoo_hpp')),amount_cents INTEGER NOT NULL,request_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'prepared',external_transaction_id TEXT,external_checkout_url TEXT,created_by INTEGER REFERENCES users(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,verified_at TEXT,notes TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS ot_signature_packets(id INTEGER PRIMARY KEY AUTOINCREMENT,work_order_id INTEGER NOT NULL REFERENCES work_orders(id),amount_cents INTEGER NOT NULL,recipient_email TEXT NOT NULL,recipient_name TEXT NOT NULL,description TEXT NOT NULL,pdf_sha256 TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'prepared',envelope_id TEXT UNIQUE,created_by INTEGER REFERENCES users(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,verified_at TEXT,locked_snapshot TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ot_invoice_deliveries(id INTEGER PRIMARY KEY AUTOINCREMENT,invoice_id INTEGER NOT NULL REFERENCES ot_invoices(id),recipient_email TEXT NOT NULL,status TEXT NOT NULL,provider TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE INDEX IF NOT EXISTS idx_ot_invoice_wo ON ot_invoices(work_order_id,id);
 CREATE INDEX IF NOT EXISTS idx_ot_sig_wo ON ot_signature_packets(work_order_id,id);
 `);
 if(!db.prepare('PRAGMA table_info(ot_signature_packets)').all().some(x=>x.name==='signed_pdf_name'))db.exec('ALTER TABLE ot_signature_packets ADD COLUMN signed_pdf_name TEXT');
}
function work(db,id){const wo=db.prepare('SELECT * FROM work_orders WHERE id=?').get(id);if(!wo)throw Error('Work order not found');return wo;}
function lines(db,id){return db.prepare('SELECT item_ref,description,line_type,qty,rate,amount FROM work_order_lines WHERE work_order_id=? ORDER BY id').all(id);}
function payments(db,id){return db.prepare("SELECT method,direction,status,amount_cents,reference,created_at FROM pos_payments WHERE work_order_id=? ORDER BY id").all(id);}
function currentBalance(db,id){const w=work(db,id);const p=db.prepare("SELECT COALESCE(SUM(CASE WHEN status='confirmed' THEN CASE WHEN direction='payment' THEN amount_cents ELSE -amount_cents END ELSE 0 END),0) paid FROM pos_payments WHERE work_order_id=?").get(id);const total=Math.round(Number(w.estimate_total||0)*100);return {total,paid:p.paid,balance:Math.max(0,total-p.paid)};}
function addressRecord(db,w){
 const c=w.customer_id?db.prepare('SELECT * FROM customers WHERE id=?').get(w.customer_id):null;
 if(!c)return {service:null,billing:null};
 const service={line1:c.address_line1||c.address||'',line2:c.address_line2||'',city:c.city||'',state:c.state||'',postalCode:c.postal_code||''};
 const billing=Number(c.billing_same_as_service)!==0?{...service}:{line1:c.billing_address_line1||'',line2:c.billing_address_line2||'',city:c.billing_city||'',state:c.billing_state||'',postalCode:c.billing_postal_code||''};
 return {service,billing};
}
function formatAddress(a){return a?[a.line1,a.line2,[a.city,a.state,a.postalCode].filter(Boolean).join(' ')].filter(Boolean):[];}
function packetLines(w,details){return [
 'AZ JET SKI, BOATS & POWERSPORTS - REPAIR AUTHORIZATION',
 'Work Order: '+(w.ref_number||w.id),'Customer: '+t(w.customer_name),'Email: '+t(w.email),
 'Customer address:',...formatAddress(details.addresses?.service),
 'Unit: '+[w.year,w.make,w.model].filter(Boolean).join(' ')+' '+t(w.unit_label),
 'HIN / VIN / Serial: '+t(w.serial),'',
 'AUTHORIZED REPAIRS / SCOPE:',...t(details.description,3000).split(/\n/),
 '','Work Order Estimate: '+dollar(details.amount_cents),'',
 'APPROVAL TERMS: Customer authorizes the described work up to the stated',
 'estimate. Any additional work or increased amount requires new authorization.',
 'Diagnostics and teardown authorized separately remain payable if declined.',
 'Customer-supplied parts are subject to separate shop policy.',
 'Payment for completed authorized services is due before unit release.',
 'Customer confirms they have authority to approve repair on this unit.',
 'Customer agrees to electronic signatures and document delivery.',
 '','Work order / estimate is a snapshot as of authorization creation.',
 'Changes to this work order require a separate authorization.',
 '','CUSTOMER SIGNATURE:','/ot_sig/','',
 'SIGNING DATE:','/ot_date/','',
 'Authorization is limited to the scope and amount stated above.'
 ];}
function authDocument(db,w,params){const l=packetLines(w,{...params,addresses:addressRecord(db,w)});return makePdf(l);}
export function checkoutRoutes({db,currentUser,json,readBody,publicBaseUrl,shopName='Arizona Jet Ski',requestTimeoutMs=12000}){
 installCheckout(db);
 const base=(publicBaseUrl||'').replace(/\/$/,'');
 const send=(res,code,data)=>{json(res,code,data);return true};
 const error=(res,code,msg)=>send(res,code,{error:msg});
 const owner=(req)=>{const u=currentUser(req);return u&&roles.has(u.role)?u:null;};
 const idno=()=>crypto.randomUUID();
 const hppConfig=()=>({terminalConfigured:Boolean(process.env.DEJAVOO_SPIN_AUTH_KEY&&process.env.DEJAVOO_SPIN_REGISTER_ID),hppConfigured:Boolean(process.env.DEJAVOO_HPP_API_KEY&&process.env.DEJAVOO_HPP_ENDPOINT),mode:'manual-handoff',note:'No unattended Dejavoo processing is enabled until the certified request/response format and merchant configuration are validated.'});
 const docConfig=()=>({accountConnectedExternal:true,appTokenConfigured:Boolean(process.env.DOCUSIGN_ACCESS_TOKEN&&process.env.DOCUSIGN_ACCOUNT_ID&&process.env.DOCUSIGN_BASE_URL),sendEnabled:process.env.DOCUSIGN_ENABLE_SEND==='true',note:'Connected ChatGPT account does not automatically provide app OAuth. Explicit app OAuth or supported token refresh is required.'});
 return async function route(req,res,p,url){
 try{
  if(p==='/api/billing/integration-status'&&req.method==='GET'){if(!owner(req))return error(res,403,'Staff permission required');return send(res,200,{dejavoo:hppConfig(),docusign:docConfig(),basePublicHttps:!!safeUrl(base)});}
  const inv=p.match(/^\/api\/pos\/work-orders\/(\d+)\/invoice(?:s)?$/);
  if(inv&&req.method==='GET'){if(!owner(req))return error(res,403,'Staff permission required');const rows=db.prepare('SELECT id,number,amount_cents,recipient_name,recipient_email,issued_at,valid_until,voided_at FROM ot_invoices WHERE work_order_id=? ORDER BY id DESC').all(Number(inv[1]));return send(res,200,{invoices:rows});}
  if(inv&&req.method==='POST'){
   const u=owner(req);if(!u)return error(res,403,'Staff permission required');const w=work(db,Number(inv[1]));if(w.source!=='manual')return error(res,409,'Historical imported balances must be reconciled before invoicing');const b=await readBody(req);const total=currentBalance(db,w.id),cust=t(w.customer_name,200),email=t(b.email??w.email,240);if(!total.balance)return error(res,409,'This work order has no balance to invoice');
   const publicBase=safeUrl(base);if(!publicBase)return error(res,409,'Configure a public HTTPS URL before creating customer links');
   const token=crypto.randomBytes(32).toString('base64url'),number=`INV-${String(w.id).padStart(6,'0')}-${Date.now().toString(36).toUpperCase()}`;
   const snapshot={refNumber:w.ref_number,unit:w.unit_label||[w.year,w.make,w.model].filter(Boolean).join(' '),estimateCents:total.total,paidCents:total.paid,balanceCents:total.balance,addresses:addressRecord(db,w),taxRateBps:Number(w.tax_rate_bps||0),taxCents:Number(w.tax_total_cents||0),items:lines(db,w.id),createdAt:new Date().toISOString()};
   const r=db.prepare('INSERT INTO ot_invoices(work_order_id,number,token_hash,amount_cents,valid_until,recipient_name,recipient_email,recipient_phone,snapshot_json,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)').run(w.id,number,sha(token),total.balance,new Date(Date.now()+30*86400000).toISOString(),cust,email,t(w.phone,80),JSON.stringify(snapshot),u.id);
   const link=`${base}/invoice/${token}`,subject=`Invoice ${number} - ${shopName}`;
   let deliveryStatus='not_requested',mailProvider='none';if(b.sendEmail===true){
    if(!email.includes('@'))deliveryStatus='not_sent_missing_recipient';
    else if(process.env.SENDGRID_API_KEY&&process.env.INVOICE_FROM_EMAIL){
     mailProvider='sendgrid';try{
      const mail={personalizations:[{to:[{email,name:cust}],subject}],from:{email:process.env.INVOICE_FROM_EMAIL,name:shopName},content:[{type:'text/plain',value:`${cust},\n\nYour invoice ${number} from ${shopName} has a balance of ${dollar(total.balance)}.\nReview your invoice: ${link}\n\nThank you.`}]};
      const posted=await fetch('https://api.sendgrid.com/v3/mail/send',{method:'POST',headers:{Authorization:`Bearer ${process.env.SENDGRID_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(mail),signal:AbortSignal.timeout(12000)});
      deliveryStatus=posted.status===202?'accepted_by_email_provider':`not_sent_provider_http_${posted.status}`;
     }catch{deliveryStatus='not_sent_provider_error';}
    }else if(smtpConfigured()){
     mailProvider='smtp';try{const m=await sendInvoiceMail({to:email,name:cust,shop:shopName,subject,message:`${cust},\n\nYour invoice ${number} has a balance of ${dollar(total.balance)}.\nReview the invoice using the secure link below.`,link});deliveryStatus=m.status;}catch{deliveryStatus='not_sent_smtp_error';}
    }else deliveryStatus='not_sent_email_provider_unconfigured';
    db.prepare('INSERT INTO ot_invoice_deliveries(invoice_id,recipient_email,status,provider) VALUES(?,?,?,?)').run(Number(r.lastInsertRowid),email,deliveryStatus,mailProvider);
   }
   return send(res,201,{deliveryStatus,id:Number(r.lastInsertRowid),number,amount:total.balance/100,link,subject,customerEmail:email,message:`${cust}, your ${shopName} invoice ${number} has a remaining balance of ${dollar(total.balance)}. Review the invoice securely: ${link} . Card payment options will appear once the Dejavoo Hosted Payment Page is activated.`});
  }
  const pubInv=p.match(/^\/invoice\/([A-Za-z0-9_-]{32,80})$/);
  if(pubInv&&req.method==='GET'){
   const invoice=db.prepare('SELECT * FROM ot_invoices WHERE token_hash=? AND voided_at IS NULL').get(sha(pubInv[1]));
   if(!invoice)return error(res,404,'Invoice not found');if(new Date(invoice.valid_until).getTime()<Date.now())return error(res,410,'Invoice link expired');
   const data=JSON.parse(invoice.snapshot_json),balance=currentBalance(db,invoice.work_order_id),requests=db.prepare("SELECT amount_cents,method,status,external_checkout_url FROM ot_payment_requests WHERE invoice_id=? AND status IN ('verified','prepared','awaiting_provider','pending') ORDER BY id DESC").all(invoice.id);
   const html=`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>${esc(invoice.number)}</title><style>body{font:16px system-ui;background:#f4f7fa;color:#1b2832;padding:20px}main{max-width:700px;margin:auto;background:white;border-radius:14px;padding:24px;box-shadow:0 3px 18px #0001}table{width:100%;border-collapse:collapse}td{padding:10px;border-bottom:1px solid #eee}.primary{color:#14624a;font-size:28px;font-weight:800}a.button{display:inline-block;background:#126e50;color:white;padding:12px;border-radius:8px;text-decoration:none}</style><main><img src="/brand-logo.png" alt="AZ Jet Ski + Powersports" style="max-width:185px;height:auto;display:block"><h2>${esc(shopName)}</h2><h1>Invoice ${esc(invoice.number)}</h1><p>Customer: ${esc(invoice.recipient_name)} · WO ${esc(data.refNumber)}</p><p>${esc(data.unit)}</p><p><strong>Bill to</strong><br>${formatAddress(data.addresses?.billing).map(esc).join('<br>')||'Billing address not on file'}</p><table>${(data.items||[]).map(x=>`<tr><td>${esc(x.description)}</td><td>${esc(x.qty)}</td><td style="text-align:right">${dollar(Math.round(Number(x.amount)*100))}</td></tr>`).join('')}</table><p>Original total: ${dollar(data.estimateCents)}</p><p>Verified payments and refunds: ${dollar(balance.paid)}</p><p>Currently due:</p><div class="primary">${dollar(balance.balance)}</div><p>Cash or Zelle payments may be arranged with the shop. Zelle is credited only after verification.</p>${requests.filter(x=>x.method==='dejavoo_hpp'&&x.external_checkout_url&&safeUrl(x.external_checkout_url)&&x.status==='awaiting_provider').map(x=>`<p><a class="button" rel="noopener noreferrer" href="${esc(x.external_checkout_url)}">Pay ${dollar(x.amount_cents)} securely by card</a></p>`).join('')}<p><small>Owner Tracker does not collect credit card numbers. In-person transactions are processed on the Dejavoo P1.</small></p></main></html>`;
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});res.end(html);return true;
  }
  const payReq=p.match(/^\/api\/billing\/invoices\/(\d+)\/payment-requests$/);
  if(payReq&&req.method==='GET'){
   if(!owner(req))return error(res,403,'Staff permission required');return send(res,200,{requests:db.prepare('SELECT id,invoice_id,method,amount_cents,status,created_at,notes,external_checkout_url FROM ot_payment_requests WHERE invoice_id=? ORDER BY id DESC').all(Number(payReq[1]))});
  }
  if(payReq&&req.method==='POST'){
   const u=owner(req);if(!u)return error(res,403,'Staff permission required');const invoice=db.prepare('SELECT * FROM ot_invoices WHERE id=? AND voided_at IS NULL').get(Number(payReq[1]));if(!invoice)return error(res,404,'Invoice unavailable');const b=await readBody(req),method=t(b.method,32),key=t(b.requestKey,100);
   if(!['dejavoo_p1_terminal','dejavoo_hpp'].includes(method))return error(res,400,'Invalid payment request method');if(key.length<8)return error(res,400,'Request key required');const prev=db.prepare('SELECT * FROM ot_payment_requests WHERE request_key=?').get(key);if(prev)return prev.invoice_id===invoice.id?send(res,200,{duplicate:true,request:prev}):error(res,409,'Request key was previously used');
   const amt=cents(b.amount),total=currentBalance(db,invoice.work_order_id);if(amt>total.balance)return error(res,409,'Requested amount exceeds current unpaid balance');
   const result=db.prepare('INSERT INTO ot_payment_requests(invoice_id,method,amount_cents,request_key,status,created_by,notes) VALUES(?,?,?,?,?,?,?)').run(invoice.id,method,amt,key,'prepared',u.id,'Requires authenticated Dejavoo account integration or manual P1 settlement');
   return send(res,201,{id:Number(result.lastInsertRowid),method,amount:amt/100,status:'prepared',chargeProcessed:false,notice:'Payment is not charged or sent to P1. Confirm merchant SPIn/HPP credentials to activate the connector.'});
  }
  const sig=p.match(/^\/api\/pos\/work-orders\/(\d+)\/docusign(?:\/(preview|send|sync|document))?$/);
  if(sig){const u=owner(req);if(!u)return error(res,403,'Staff permission required');const w=work(db,Number(sig[1]));const op=sig[2]||'status';
   if(req.method==='GET'&&op==='status'){return send(res,200,{packets:db.prepare('SELECT id,work_order_id,recipient_email,amount_cents,status,envelope_id,created_at,verified_at FROM ot_signature_packets WHERE work_order_id=? ORDER BY id DESC').all(w.id)});}
   if(req.method==='GET'&&op==='preview'){const doc=authDocument(db,w,{description:w.authorized_work||w.complaint||'Repair work as described in work order',amount_cents:Math.round(Number(w.estimate_total)*100)});res.writeHead(200,{'content-type':'application/pdf','content-length':doc.length,'content-disposition':`inline; filename="WO-${w.id}-authorization.pdf"`,'cache-control':'no-store'});res.end(doc);return true;}
   if(req.method==='POST'&&op==='send'){
    const b=await readBody(req),email=t(b.email??w.email,255),name=t(b.name??w.customer_name,200),desc=t(b.description??w.authorized_work??w.complaint,3000),amount=Math.round(Number(w.estimate_total)*100);if(!email.includes('@')||!name||!desc||amount<=0)return error(res,400,'Valid recipient, work description and estimate are required');if(b.confirmSend!==true)return error(res,400,'Explicit send confirmation required');
    const pdf=authDocument(db,w,{description:desc,amount_cents:amount}),hash=sha(pdf),locked={refNumber:w.ref_number,customerName:w.customer_name,unit:w.unit_label,addresses:addressRecord(db,w),description:desc,estimateCents:amount,createdAt:new Date().toISOString()};
    const existing=db.prepare("SELECT * FROM ot_signature_packets WHERE work_order_id=? AND status IN ('sent','completed') ORDER BY id DESC LIMIT 1").get(w.id);if(existing&&existing.status==='sent'&&existing.pdf_sha256===hash)return error(res,409,'An identical DocuSign envelope is already pending for this work order');
    const r=db.prepare('INSERT INTO ot_signature_packets(work_order_id,amount_cents,recipient_email,recipient_name,description,pdf_sha256,status,created_by,locked_snapshot) VALUES(?,?,?,?,?,?,?,?,?)').run(w.id,amount,email,name,desc,hash,'prepared',u.id,JSON.stringify(locked));const id=Number(r.lastInsertRowid);
    if(process.env.DOCUSIGN_ENABLE_SEND!=='true'||process.env.DOCUSIGN_POLICY_APPROVED!=='true')return send(res,202,{packetId:id,status:'prepared',pdfReady:true,notice:'Work-order-specific document prepared. Activate DocuSign OAuth and DOCUSIGN_ENABLE_SEND=true to send from the app.'});
    const apiBase=safeUrl(process.env.DOCUSIGN_BASE_URL);const account=t(process.env.DOCUSIGN_ACCOUNT_ID,80),bearer=process.env.DOCUSIGN_ACCESS_TOKEN;
    if(!apiBase||!account||!bearer)return error(res,503,'DocuSign app credentials unavailable. Packet saved as prepared.');
    // Anchor tabs target literal tokens placed in the PDF. Never store the OAuth token in DB/logs.
    const envelope={emailSubject:`WO ${w.ref_number||w.id}: Repair Authorization`,status:'sent',documents:[{documentBase64:pdf.toString('base64'),name:`WO-${w.ref_number||w.id}-Repair-Authorization.pdf`,fileExtension:'pdf',documentId:'1'}],recipients:{signers:[{email,name,recipientId:'1',routingOrder:'1',tabs:{signHereTabs:[{anchorString:'/ot_sig/',anchorUnits:'pixels',anchorXOffset:'0',anchorYOffset:'0'}],dateSignedTabs:[{anchorString:'/ot_date/',anchorUnits:'pixels',anchorXOffset:'0',anchorYOffset:'0'}]}}]},customFields:{textCustomFields:[{name:'OwnerTrackerWorkOrderId',value:String(w.id),show:'false'},{name:'OwnerTrackerPacketId',value:String(id),show:'false'}]}};
    const call=await fetch(new URL(`/restapi/v2.1/accounts/${encodeURIComponent(account)}/envelopes`,apiBase),{method:'POST',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},body:JSON.stringify(envelope),signal:AbortSignal.timeout(requestTimeoutMs)});
    if(!call.ok)return error(res,502,`DocuSign request failed (HTTP ${call.status}); packet remains prepared`);const info=await call.json();if(!info.envelopeId)return error(res,502,'DocuSign did not return envelope ID');db.prepare("UPDATE ot_signature_packets SET status='sent',envelope_id=? WHERE id=?").run(info.envelopeId,id);db.prepare("UPDATE work_orders SET stage='Awaiting Approval',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(w.id);
    return send(res,201,{packetId:id,status:'sent',envelopeId:info.envelopeId,recipient:email});
   }
   if(req.method==='GET'&&op==='document'){
    const packet=db.prepare("SELECT * FROM ot_signature_packets WHERE work_order_id=? AND status='completed' AND signed_pdf_name IS NOT NULL ORDER BY id DESC LIMIT 1").get(w.id);
    if(!packet)return error(res,404,'Signed authorization not yet available');const filename=path.resolve('./data/uploads',packet.signed_pdf_name);if(!fs.existsSync(filename))return error(res,404,'Signed document missing from storage');const bytes=fs.readFileSync(filename);res.writeHead(200,{'content-type':'application/pdf','content-length':bytes.length,'cache-control':'no-store','content-disposition':`attachment; filename=WO-${w.id}-signed-authorization.pdf`});res.end(bytes);return true;
   }
   if(req.method==='POST'&&op==='sync'){
    const packet=db.prepare("SELECT * FROM ot_signature_packets WHERE work_order_id=? AND envelope_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(w.id);if(!packet)return error(res,404,'No sent envelope to verify');const apiBase=safeUrl(process.env.DOCUSIGN_BASE_URL),account=t(process.env.DOCUSIGN_ACCOUNT_ID,80),bearer=process.env.DOCUSIGN_ACCESS_TOKEN;if(!apiBase||!account||!bearer)return error(res,503,'DocuSign credentials unavailable');
    const call=await fetch(new URL(`/restapi/v2.1/accounts/${encodeURIComponent(account)}/envelopes/${encodeURIComponent(packet.envelope_id)}`,apiBase),{headers:{Authorization:`Bearer ${bearer}`},signal:AbortSignal.timeout(requestTimeoutMs)});if(!call.ok)return error(res,502,`Verification failed (${call.status})`);const info=await call.json();
    const state=String(info.status||'').toLowerCase();if(state==='completed'&&packet.status!=='completed'){
     // Docusign is authoritative: persist the signed combined document locally for the repair history.
     let signedFile='';try{
      const docResponse=await fetch(new URL(`/restapi/v2.1/accounts/${encodeURIComponent(account)}/envelopes/${encodeURIComponent(packet.envelope_id)}/documents/combined`,apiBase),{headers:{Authorization:`Bearer ${bearer}`},signal:AbortSignal.timeout(requestTimeoutMs)});
      if(!docResponse.ok)return error(res,502,`Signature complete but signed-document retrieval failed (${docResponse.status}). Retry sync.`);
      const data=Buffer.from(await docResponse.arrayBuffer());if(data.length>10_000_000||data.subarray(0,5).toString()!=='%PDF-')return error(res,502,'Signature document response is not a supported PDF; retry');
      const dir=path.resolve('./data/uploads');fs.mkdirSync(dir,{recursive:true});signedFile=`ot-docsign-${packet.id}-${crypto.randomBytes(6).toString('hex')}.pdf`;fs.writeFileSync(path.join(dir,signedFile),data,{flag:'wx',mode:0o600});
     }catch{return error(res,502,'Signature complete but signed PDF could not be secured locally; retry');}
     db.exec('BEGIN');try{db.prepare("UPDATE ot_signature_packets SET status='completed',verified_at=CURRENT_TIMESTAMP,signed_pdf_name=? WHERE id=?").run(signedFile,packet.id);db.prepare("UPDATE work_orders SET stage='In Progress',authorized_work=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(packet.description,w.id);db.prepare('INSERT INTO audit_log(work_order_id,actor,action,detail) VALUES(?,?,?,?)').run(w.id,u.username,'DocuSign signature verified',JSON.stringify({envelopeId:packet.envelope_id,packetId:packet.id,estimatedCents:packet.amount_cents}));db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    } else if(['declined','voided'].includes(state))db.prepare('UPDATE ot_signature_packets SET status=? WHERE id=?').run(state,packet.id);
    return send(res,200,{status:state,completed:state==='completed',source:'DocuSign API verification'});
   }
  }
  return false;
 }catch(e){const code=/not found/i.test(String(e.message))?404:400;return error(res,code,t(e.message,400));}
 };
}

import {makePurchaseTarget} from '../public/purchase-target.js';
import {assertPurchaseAuthorized} from './shop-management.mjs';
import {requireEditRevision} from './edit-revisions.mjs';
// Owner Tracker V11: physical custody, counter queues, scheduling, and invoiced retail special orders.
// All purchase submissions remain manual connector handoffs. Never represent a queued command as a completed purchase.
import crypto from 'node:crypto';
import {accountBalance} from './accounting.mjs';
import {installFinancialControls,recordPayment,confirmPayment,voidPayment,financialEvents,paymentRows,canAuthorizeFinance} from './finance-controls.mjs';
import {installReceiptSnapshots,captureRetailReceiptSnapshot} from './receipts.mjs';
import {installGoogleCalendar,googleStatus,startGoogleAuth,completeGoogleAuth,pushAppointment,markSyncFailed,disconnectGoogle} from './google-calendar.mjs';

const str=(v,n=600)=>String(v??'').trim().slice(0,n);
const priceCents=(v)=>{if(!/^\d+(\.\d{1,2})?$/.test(String(v)))throw Error('Money must have at most two decimal places');const c=Math.round(Number(v)*100);if(!Number.isSafeInteger(c)||c<0||c>100000000)throw Error('Invalid amount');return c;};
const allowedRoles=new Set(['owner','manager','service_writer','advisor']);
const purchaserRoles=new Set(['owner','manager','advisor','parts']);
function audit(db,user,action,detail='',wo=null){db.prepare('INSERT INTO audit_log(work_order_id,actor,action,detail) VALUES(?,?,?,?)').run(wo,user.username,action,JSON.stringify(detail).slice(0,6000));}
export function installShopOps(db){
  db.exec(`
  CREATE TABLE IF NOT EXISTS unit_custody (
    vehicle_id INTEGER PRIMARY KEY REFERENCES vehicles(id),
    work_order_id INTEGER REFERENCES work_orders(id),
    status TEXT NOT NULL CHECK(status IN ('in_lot','checked_out')),
    checked_in_at TEXT, checked_out_at TEXT,
    lot_location TEXT NOT NULL DEFAULT '', keys_tag TEXT NOT NULL DEFAULT '',
    checked_in_by INTEGER REFERENCES users(id), checked_out_by INTEGER REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS custody_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
    work_order_id INTEGER REFERENCES work_orders(id), action TEXT NOT NULL,
    actor_id INTEGER REFERENCES users(id), location TEXT DEFAULT '', keys_tag TEXT DEFAULT '',
    notes TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_custody_status ON unit_custody(status);
  CREATE TABLE IF NOT EXISTS shop_appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER REFERENCES customers(id),
    vehicle_id INTEGER REFERENCES vehicles(id), title TEXT NOT NULL,
    starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
    notes TEXT DEFAULT '', created_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_appts_time ON shop_appointments(starts_at);
  CREATE TABLE IF NOT EXISTS retail_special_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id),
    invoice_number TEXT UNIQUE NOT NULL, invoice_issued_at TEXT, status TEXT NOT NULL DEFAULT 'draft',
    notes TEXT DEFAULT '', tax_bps INTEGER NOT NULL DEFAULT 910,
    subtotal_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL DEFAULT 0, deposit_cents INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    invoice_address_snapshot_json TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS retail_special_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, retail_order_id INTEGER NOT NULL REFERENCES retail_special_orders(id),
    requested_sku TEXT DEFAULT '', description TEXT NOT NULL,
    vendor_id INTEGER REFERENCES vendors(id), vendor_sku TEXT DEFAULT '',
    quantity INTEGER NOT NULL CHECK(quantity>0), unit_cost_cents INTEGER NOT NULL DEFAULT 0,
    unit_price_cents INTEGER NOT NULL DEFAULT 0, taxable INTEGER NOT NULL DEFAULT 1,
    verified_available INTEGER NOT NULL DEFAULT 0, verified_fitment INTEGER NOT NULL DEFAULT 0,
    eta_text TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'needs_source',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS retail_purchase_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT, command_uuid TEXT UNIQUE NOT NULL,
    vendor_id INTEGER NOT NULL REFERENCES vendors(id),
    snapshot_json TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', reviewed_by INTEGER REFERENCES users(id),
    agent_message TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_retail_lines_order ON retail_special_lines(retail_order_id);
  CREATE TABLE IF NOT EXISTS retail_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, retail_order_id INTEGER NOT NULL REFERENCES retail_special_orders(id),
    method TEXT NOT NULL CHECK(method IN ('cash','card_dejavoo','zelle')),
    direction TEXT NOT NULL DEFAULT 'payment' CHECK(direction IN ('payment','refund')),
    amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
    status TEXT NOT NULL CHECK(status IN ('confirmed','pending')),
    reference TEXT NOT NULL DEFAULT '', idempotency_key TEXT UNIQUE NOT NULL,
    recorded_by INTEGER REFERENCES users(id),created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_retail_payments_order ON retail_payments(retail_order_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_payments_confirmed_reference ON retail_payments(method,reference)
    WHERE method IN ('card_dejavoo','zelle') AND reference<>'' AND status='confirmed' AND direction='payment';
  CREATE TABLE IF NOT EXISTS stock_restock_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, item_sku TEXT NOT NULL,
    quantity_requested INTEGER NOT NULL CHECK(quantity_requested>0),
    reason TEXT NOT NULL, approved_by INTEGER REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'approved_waiting_purchase',
    purchase_reference TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS inventory_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, item_sku TEXT NOT NULL, quantity_delta INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN ('received','sold','return','damage','cycle_count')),
    reference_type TEXT NOT NULL, reference_id TEXT NOT NULL,
    actor_id INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  `);
  installFinancialControls(db,'retail');
  installReceiptSnapshots(db);
  installGoogleCalendar(db);
}
const receipt=(db,id)=>db.prepare(`SELECT r.*,c.name customer_name,c.phone,c.email FROM retail_special_orders r JOIN customers c ON c.id=r.customer_id WHERE r.id=?`).get(id);
const lines=(db,id)=>db.prepare(`SELECT l.*,v.name vendor_name,v.code vendor_code FROM retail_special_lines l LEFT JOIN vendors v ON v.id=l.vendor_id WHERE l.retail_order_id=? ORDER BY l.id`).all(id);
export function retailTotals(items,bps){let subtotal=0,taxable=0;for(const l of items){const ext=l.quantity*l.unit_price_cents;subtotal+=ext;if(l.taxable)taxable+=ext}const tax=Math.round(taxable*bps/10000);return {subtotal_cents:subtotal,tax_cents:tax,total_cents:subtotal+tax};}
function recalc(db,id){const r=receipt(db,id);const t=retailTotals(lines(db,id),r.tax_bps);db.prepare('UPDATE retail_special_orders SET subtotal_cents=?,tax_cents=?,total_cents=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(t.subtotal_cents,t.tax_cents,t.total_cents,id);return t;}
function retailPaymentTotals(db,id){const r=receipt(db,id);if(!r)throw Error('Retail order not found');const t=accountBalance(db,'retail',id,r.total_cents);return {paid:t.netPaidCents,pending:t.pendingCents,due:t.dueCents,total:t.effectiveTotalCents,originalTotal:t.rawTotalCents,credits:t.creditCents,refundDue:t.refundDueCents};}
function queues(db){
  const rows=db.prepare(`SELECT uc.status custody_status,uc.lot_location,uc.keys_tag,uc.checked_in_at,
    v.id vehicle_id,v.customer_id,v.year,v.make,v.model,v.vin,v.hin,c.name customer_name,c.phone,
    w.id work_order_id,w.ref_number,w.stage,w.balance,w.estimate_total,w.promised_date,w.source work_order_source
    FROM unit_custody uc JOIN vehicles v ON v.id=uc.vehicle_id JOIN customers c ON c.id=v.customer_id
    LEFT JOIN work_orders w ON w.id=uc.work_order_id WHERE uc.status='in_lot'
    ORDER BY uc.checked_in_at ASC`).all().map(row=>row.work_order_id&&row.work_order_source==='manual'?{...row,balance:accountBalance(db,'repair',row.work_order_id,Math.round(Number(row.estimate_total)*100)).dueCents/100,refundDue:accountBalance(db,'repair',row.work_order_id,Math.round(Number(row.estimate_total)*100)).refundDueCents/100}:row);
  const pending=rows.filter(r=>r.stage==='Ready'&&(Number(r.balance||0)>0.005||Number(r.refundDue||0)>0.005));
  const pickup=rows.filter(r=>r.stage==='Ready'&&Number(r.balance||0)<=0.005&&Number(r.refundDue||0)<=0.005);
  const retail=db.prepare(`SELECT r.id,r.invoice_number,r.status,r.total_cents,c.name customer_name,c.phone
     FROM retail_special_orders r JOIN customers c ON c.id=r.customer_id WHERE r.invoice_issued_at IS NOT NULL ORDER BY r.id DESC LIMIT 100`).all();
  const retailReady=retail.filter(r=>r.status==='ready_for_pickup').map(r=>({...r,payment:retailPaymentTotals(db,r.id)}));
  return {inLot:rows,paymentPending:pending,readyForPickup:pickup,
    retailReadyForPickup:retailReady.filter(r=>r.payment.due===0&&r.payment.refundDue===0),retailPaymentPending:retailReady.filter(r=>r.payment.due>0||r.payment.refundDue>0),checkedInCustomers:[...new Map(rows.map(r=>[r.customer_id,{id:r.customer_id,name:r.customer_name,phone:r.phone,vehicleCount:rows.filter(x=>x.customer_id===r.customer_id).length}])).values()]};
}
function icsEscape(s){return str(s,500).replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');}
const utcStamp=x=>new Date(x).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z/,'Z');
export function appointmentICS(a){const start=utcStamp(a.starts_at),end=utcStamp(a.ends_at),stamp=utcStamp(new Date());return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//AZ Jet Ski//Owner Tracker V11//EN','BEGIN:VEVENT',`UID:ownertracker-${a.id}@azjetski.com`,`DTSTAMP:${stamp}`,`DTSTART:${start}`,`DTEND:${end}`,`SUMMARY:${icsEscape(a.title)}`,`DESCRIPTION:${icsEscape(a.notes)}`,'END:VEVENT','END:VCALENDAR',''].join('\r\n');}
export function shopOpsRoutes({db,currentUser,json,readBody,bridgeToken}){
 installShopOps(db);
 return async function route(req,res,p,url){
  if(!p.startsWith('/api/shop/')&&!p.startsWith('/api/desktop-agent/retail-'))return false;
  const respond=(status,v)=>{json(res,status,v);return true;};
  const u=currentUser(req),deny=(permission='read')=>respond(u?403:401,{error:u?'Permission denied':'Unauthorized',permission});
  const b=async()=>readBody(req);
  const staff=()=>u&&allowedRoles.has(u.role);
  const purchasing=()=>u&&purchaserRoles.has(u.role);
  try{
    if(p.startsWith('/api/shop/')&&p!=='/api/shop/google-calendar/callback'&&u&&!staff()&&!purchasing())return deny('shop_operations');
    if(p==='/api/shop/readiness'&&req.method==='GET'){
      if(!u||!['owner','manager'].includes(u.role))return deny('readiness');
      const pending=db.prepare("SELECT COUNT(*) n FROM retail_purchase_commands WHERE status='queued'").get().n;
      const flagged=db.prepare("SELECT COUNT(*) n FROM stock_restock_requests WHERE status='approved_waiting_purchase'").get().n;
      const google=googleStatus(db);
      const checks=[
       {id:'core',label:'Customer / vehicle / work order database',state:'implemented',next:'Run one real shop-day parallel test; verify backups before go-live'},
       {id:'google_calendar',label:'Google Calendar appointments',state:google.connected?'connected':'needs_setup',next:google.configured?'Authorize jetskiarizona@gmail.com through Shop Operations':'Configure Google Cloud OAuth web client and HTTPS callback; authorize Google account'},
       {id:'email',label:'Direct customer invoice emails',state:(process.env.SENDGRID_API_KEY||process.env.SMTP_HOST)?'configured_untested':'needs_setup',next:'Verify sender domain and test delivery to a real inbox'},
       {id:'dejavoo',label:'Dejavoo P1 SPIn and hosted payment links',state:'requires_live_certification',next:'Get merchant/P1 integration access; certify capture, refund, decline and duplicate handling'},
       {id:'docusign',label:'DocuSign signed authorizations',state:'requires_live_certification',next:'Connect standalone DocuSign OAuth application, test signed PDF retention and envelope webhooks'},
       {id:'epson',label:'Epson printer and drawer',state:process.env.EPSON_PRINTER_IP?'configured_untested':'needs_setup',next:'Confirm TM printer model, Ethernet/USB, cash drawer wiring; test real printing and controlled drawer opening'},
       {id:'supplier',label:'WSM / PU / TMS / BRP direct ordering',state:'review_queue_only',next:'Verify each dealer-supported API or portal handoff and order confirmation before switching live purchasing on'},
       {id:'mobile',label:'iPhone owner and technician remote access',state:'needs_https_device_test',next:'Deploy authenticated HTTPS; verify role permissions and camera uploads on physical phones'},
       {id:'finance',label:'POS tax / end-of-day reconciliation',state:'needs_accountant_and_terminal_validation',next:'Confirm 9.1% classification with accountant; run daily close with actual card/cash/Zelle totals'},
       {id:'inventory',label:'Shop inventory chain of custody',state:'partially_implemented',next:'Conduct physical opening stock count; barcode receive; regular cycle-count approval'},
       {id:'marketing',label:'Review requests and seasonal maintenance marketing',state:'planned',next:'Implement opt-in capture, unsubscribes, appointment reminders, customer recall sequences and ROI tracking'},
      ];
      return respond(200,{checks,pendingRetailDesktopCommands:pending,approvedRestocksNotPurchased:flagged,productionCertified:false});
    }
    if(p==='/api/shop/queues'&&req.method==='GET'){if(!u)return deny();return respond(200,queues(db));}
    const custody=p.match(/^\/api\/shop\/vehicles\/(\d+)\/(check-in|check-out)$/);
    if(custody&&req.method==='POST'){
      if(!staff())return deny('custody_management');const id=Number(custody[1]),action=custody[2],v=db.prepare('SELECT * FROM vehicles WHERE id=? AND archived=0').get(id);
      if(!v)return respond(404,{error:'Vehicle not found'});const data=await b();const current=db.prepare('SELECT * FROM unit_custody WHERE vehicle_id=?').get(id);
      if(action==='check-in'){
        if(current?.status==='in_lot')return respond(409,{error:'Vehicle already checked in'});
        const woId=Number(data.workOrderId||0);const w=woId?db.prepare('SELECT customer_id,vehicle_id FROM work_orders WHERE id=?').get(woId):null;
        if(woId&&(!w||w.vehicle_id!==id||w.customer_id!==v.customer_id))return respond(409,{error:'Work order must be for this exact customer and vehicle'});
        db.exec('BEGIN');try{
          db.prepare(`INSERT INTO unit_custody(vehicle_id,work_order_id,status,checked_in_at,checked_out_at,lot_location,keys_tag,checked_in_by,checked_out_by)
            VALUES(?,?,'in_lot',CURRENT_TIMESTAMP,NULL,?,?,?,NULL)
            ON CONFLICT(vehicle_id) DO UPDATE SET work_order_id=excluded.work_order_id,status='in_lot',checked_in_at=CURRENT_TIMESTAMP,checked_out_at=NULL,lot_location=excluded.lot_location,keys_tag=excluded.keys_tag,checked_in_by=excluded.checked_in_by,checked_out_by=NULL`).run(id,woId||null,str(data.lotLocation,80),str(data.keysTag,80),u.id);
          db.prepare('INSERT INTO custody_events(vehicle_id,work_order_id,action,actor_id,location,keys_tag,notes) VALUES(?,?,?,?,?,?,?)').run(id,woId||null,'check_in',u.id,str(data.lotLocation,80),str(data.keysTag,80),str(data.notes));
          audit(db,u,'Vehicle checked in',{vehicle:id,woId,lotLocation:data.lotLocation},woId||null);db.exec('COMMIT');
        }catch(e){db.exec('ROLLBACK');throw e;}
        return respond(200,{ok:true,status:'in_lot'});
      }
      if(current?.status!=='in_lot')return respond(409,{error:'Vehicle is not checked in'});
      const wo=current.work_order_id?db.prepare('SELECT stage,balance,estimate_total,source FROM work_orders WHERE id=?').get(current.work_order_id):null;
      const account=wo?.source==='manual'?accountBalance(db,'repair',current.work_order_id,Math.round(Number(wo.estimate_total)*100)):null;
      if(wo&&((account?(account.dueCents>0||account.refundDueCents>0):Number(wo.balance)>0.005)||!['Ready','Picked Up','Closed'].includes(wo.stage)))return respond(409,{error:'Pickup blocked: repair must be Ready and payment settled'});
      db.exec('BEGIN');try{
        db.prepare("UPDATE unit_custody SET status='checked_out',checked_out_at=CURRENT_TIMESTAMP,checked_out_by=? WHERE vehicle_id=?").run(u.id,id);
        db.prepare('INSERT INTO custody_events(vehicle_id,work_order_id,action,actor_id,notes) VALUES(?,?,?,?,?)').run(id,current.work_order_id,'check_out',u.id,str(data.notes));
        if(current.work_order_id)db.prepare("UPDATE work_orders SET stage='Picked Up',updated_at=CURRENT_TIMESTAMP WHERE id=? AND stage='Ready'").run(current.work_order_id);
        audit(db,u,'Vehicle checked out',{vehicle:id},current.work_order_id);db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
      return respond(200,{ok:true,status:'checked_out'});
    }
    if(p==='/api/shop/google-calendar/status'&&req.method==='GET'){if(!u)return deny();return respond(200,googleStatus(db));}
    if(p==='/api/shop/google-calendar/connect'&&req.method==='GET'){
      if(!u||!['owner','manager'].includes(u.role))return deny('calendar_admin');return respond(200,{url:startGoogleAuth(db,u.id)});
    }
    if(p==='/api/shop/google-calendar/callback'&&req.method==='GET'){
      // Google cross-site redirect will not carry our strict session cookie; one-time OAuth state is authorization.
      try{const c=await completeGoogleAuth(db,url.searchParams.get('code'),url.searchParams.get('state'));res.writeHead(302,{location:'/shop-ops.html?calendar=connected'});res.end();return true}
      catch(e){res.writeHead(302,{location:'/shop-ops.html?calendar=failed'});res.end();return true}
    }
    if(p==='/api/shop/google-calendar/disconnect'&&req.method==='POST'){
      if(!u||!['owner','manager'].includes(u.role))return deny('calendar_admin');return respond(200,disconnectGoogle(db));
    }
    const retrySync=p.match(/^\/api\/shop\/schedule\/(\d+)\/push-google$/);
    if(retrySync&&req.method==='POST'){
      if(!staff())return deny('scheduling');const id=Number(retrySync[1]);
      try{return respond(200,await pushAppointment(db,id))}catch(e){markSyncFailed(db,id,e.message);return respond(503,{error:e.message,calendarSync:'error'})}
    }
    if(p==='/api/shop/schedule'&&req.method==='GET'){
      if(!u)return deny();return respond(200,{appointments:db.prepare(`SELECT a.*,c.name customer_name FROM shop_appointments a LEFT JOIN customers c ON c.id=a.customer_id WHERE a.starts_at>=datetime('now','-60 days') ORDER BY a.starts_at LIMIT 500`).all(),googleCalendar:googleStatus(db),mode:'local-calendar-and-ics-with-optional-google-sync'});
    }
    if(p==='/api/shop/schedule'&&req.method==='POST'){
      if(!staff())return deny('scheduling');const d=await b(),title=str(d.title,150),start=Date.parse(d.startsAt),end=Date.parse(d.endsAt);
      if(!title||!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>86400000)return respond(400,{error:'Valid title, start and end required'});
      if(d.customerId&&!db.prepare('SELECT id FROM customers WHERE id=?').get(Number(d.customerId)))return respond(400,{error:'Customer missing'});
      if(d.vehicleId&&(!d.customerId||!db.prepare('SELECT id FROM vehicles WHERE id=? AND customer_id=?').get(Number(d.vehicleId),Number(d.customerId))))return respond(400,{error:'Vehicle not owned by customer'});
      const conflict=db.prepare("SELECT id FROM shop_appointments WHERE status='scheduled' AND starts_at<? AND ends_at>? LIMIT 1").get(new Date(end).toISOString(),new Date(start).toISOString());
      const r=db.prepare('INSERT INTO shop_appointments(customer_id,vehicle_id,title,starts_at,ends_at,notes,created_by) VALUES(?,?,?,?,?,?,?)').run(d.customerId?Number(d.customerId):null,d.vehicleId?Number(d.vehicleId):null,title,new Date(start).toISOString(),new Date(end).toISOString(),str(d.notes),u.id);
      const id=Number(r.lastInsertRowid);
      if(googleStatus(db).connected){try{const sync=await pushAppointment(db,id);return respond(201,{id,possibleOverlap:!!conflict,calendarSync:sync.synced?'synced':sync.status})}catch(e){markSyncFailed(db,id,e.message);return respond(201,{id,possibleOverlap:!!conflict,calendarSync:'error',syncError:e.message})}}
      return respond(201,{id,possibleOverlap:!!conflict,calendarSync:'not_connected'});
    }
    const cal=p.match(/^\/api\/shop\/schedule\/(\d+)\/ics$/);
    if(cal&&req.method==='GET'){
      if(!u)return deny();const row=db.prepare('SELECT * FROM shop_appointments WHERE id=?').get(Number(cal[1]));if(!row)return respond(404,{error:'Missing appointment'});
      const body=appointmentICS(row);res.writeHead(200,{'content-type':'text/calendar; charset=utf-8','content-disposition':`attachment; filename="ownertracker-${row.id}.ics"`});res.end(body);return true;
    }
    if(p==='/api/shop/retail-orders'&&req.method==='GET'){
      if(!u)return deny();const rs=db.prepare(`SELECT r.*,c.name customer_name,c.phone FROM retail_special_orders r JOIN customers c ON c.id=r.customer_id ORDER BY r.id DESC LIMIT 200`).all();return respond(200,{orders:rs.map(r=>({...r,lines:lines(db,r.id)}))});
    }
    if(p==='/api/shop/retail-orders'&&req.method==='POST'){
      if(!staff())return deny('retail_sales');const d=await b(),customerId=Number(d.customerId),customer=db.prepare('SELECT * FROM customers WHERE id=? AND archived=0').get(customerId);
      if(!customer)return respond(404,{error:'Customer not found'});
      const invoice=`PART-${new Date().getUTCFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const tax=db.prepare("SELECT value FROM ot_shop_settings WHERE key='tax_rate_bps'").get();
      const rate=tax?Number(tax.value):910;
      const r=db.prepare('INSERT INTO retail_special_orders(customer_id,invoice_number,tax_bps,created_by,notes) VALUES(?,?,?,?,?)').run(customerId,invoice,Number.isInteger(rate)?rate:910,u.id,str(d.notes));
      audit(db,u,'Retail special order opened',{invoice,customerId});return respond(201,{order:receipt(db,Number(r.lastInsertRowid))});
    }
    const ro=p.match(/^\/api\/shop\/retail-orders\/(\d+)$/);
    if(ro&&req.method==='GET'){
      if(!staff()&&!purchasing())return deny('retail_read');const r=receipt(db,Number(ro[1]));return r?respond(200,{order:{...r,lines:lines(db,r.id),payments:paymentRows(db,'retail',r.id),paymentTotals:retailPaymentTotals(db,r.id),financialEvents:financialEvents(db,'retail',r.id),canRefund:canAuthorizeFinance(u),canVoid:canAuthorizeFinance(u)}}):respond(404,{error:'Not found'});
    }
    const line=p.match(/^\/api\/shop\/retail-orders\/(\d+)\/lines$/);
    if(line&&req.method==='POST'){
      if(!staff())return deny('retail_sales');const id=Number(line[1]),r=receipt(db,id),d=await b();requireEditRevision(db,req,p,d);if(!r)return respond(404,{error:'Order not found'});
      if(r.invoice_issued_at)return respond(409,{error:'Invoice already issued; create a supplemental order instead of silently changing an invoice'});
      const qty=Number(d.quantity),description=str(d.description,350),cost=priceCents(d.unitCost??0),sell=priceCents(d.unitPrice??0);
      if(!Number.isInteger(qty)||qty<1||qty>1000||!description)return respond(400,{error:'Valid quantity and description required'});
      const vendor=d.vendorId?db.prepare('SELECT id FROM vendors WHERE id=? AND enabled=1').get(Number(d.vendorId)):null;
      if(d.vendorId&&!vendor)return respond(400,{error:'Unknown supplier'});
      const x=db.prepare('INSERT INTO retail_special_lines(retail_order_id,requested_sku,description,vendor_id,vendor_sku,quantity,unit_cost_cents,unit_price_cents,taxable,eta_text) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,str(d.requestedSku,100),description,vendor?.id||null,str(d.vendorSku,100),qty,cost,sell,d.taxable===false?0:1,str(d.eta,180));
      return respond(201,{lineId:Number(x.lastInsertRowid),totals:recalc(db,id)});
    }
    const invoice=p.match(/^\/api\/shop\/retail-orders\/(\d+)\/issue-invoice$/);
    if(invoice&&req.method==='POST'){
      if(!staff())return deny('retail_sales');const editInput=await b();requireEditRevision(db,req,p,editInput);const id=Number(invoice[1]),r=receipt(db,id);if(!r)return respond(404,{error:'Not found'});
      if(r.invoice_issued_at)return respond(409,{error:'Invoice already issued'});
      if(!lines(db,id).length||r.total_cents<=0)return respond(409,{error:'A priced item is required'});
      const c=db.prepare('SELECT * FROM customers WHERE id=?').get(r.customer_id);
      const a=Number(c.billing_same_as_service)!==0?{street:c.address_line1,suite:c.address_line2,city:c.city,state:c.state,zip:c.postal_code}:{street:c.billing_address_line1,suite:c.billing_address_line2,city:c.billing_city,state:c.billing_state,zip:c.billing_postal_code};
      db.exec('BEGIN IMMEDIATE');
      try{
        const issued=db.prepare("UPDATE retail_special_orders SET invoice_issued_at=CURRENT_TIMESTAMP,status='invoiced',invoice_address_snapshot_json=? WHERE id=? AND invoice_issued_at IS NULL").run(JSON.stringify(a),id);
        if(!issued.changes){db.exec('ROLLBACK');return respond(409,{error:'Invoice already issued'});}
        captureRetailReceiptSnapshot(db,id);
        audit(db,u,'Retail invoice issued',{invoice:r.invoice_number,total:r.total_cents});
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
      return respond(200,{order:receipt(db,id)});
    }
    const verify=p.match(/^\/api\/shop\/retail-orders\/(\d+)\/lines\/(\d+)\/verify$/);
    if(verify&&req.method==='POST'){
      if(!purchasing())return deny('retail_purchase_review');const id=Number(verify[1]),lid=Number(verify[2]),d=await b(),r=receipt(db,id),l=lines(db,id).find(x=>x.id===lid);
      if(!r||!l)return respond(404,{error:'Order line not found'});
      if(!r.invoice_issued_at)return respond(409,{error:'Issue a customer invoice before purchasing'});
      if(!l.vendor_id||!l.vendor_sku||l.unit_cost_cents<=0||!d.available||!d.fitment)return respond(409,{error:'Supplier, exact SKU, cost, availability and fitment are required'});
      if(l.vendor_sku.startsWith('DEMO-'))return respond(409,{error:'Demo SKUs cannot be ordered'});
      requireEditRevision(db,req,p,d);
      db.prepare("UPDATE retail_special_lines SET verified_available=1,verified_fitment=1,status='verified' WHERE id=?").run(lid);
      audit(db,u,'Retail part verified',{invoice:r.invoice_number,lineId:lid,sku:l.vendor_sku});return respond(200,{ok:true});
    }
    const retailPay=p.match(/^\/api\/shop\/retail-orders\/(\d+)\/payments$/);
    if(retailPay&&req.method==='POST'){
      if(!staff())return deny('retail_payment');const id=Number(retailPay[1]),d=await b();
      const result=recordPayment(db,'retail',id,u,d,()=>retailPaymentTotals(db,id));
      return respond(result.duplicate?200:201,result);
    }
    const retailConfirm=p.match(/^\/api\/shop\/retail-payments\/(\d+)\/confirm$/);
    if(retailConfirm&&req.method==='POST'){
      if(!staff())return deny('retail_payment');
      return respond(200,confirmPayment(db,'retail',Number(retailConfirm[1]),u,await b(),id=>retailPaymentTotals(db,id)));
    }
    const retailVoid=p.match(/^\/api\/shop\/retail-payments\/(\d+)\/void$/);
    if(retailVoid&&req.method==='POST'){
      if(!staff())return deny('retail_payment');
      return respond(200,voidPayment(db,'retail',Number(retailVoid[1]),u,await b(),id=>retailPaymentTotals(db,id)));
    }
    const fulfill=p.match(/^\/api\/shop\/retail-orders\/(\d+)\/lines\/(\d+)\/status$/);
    if(fulfill&&req.method==='POST'){
      if(!purchasing())return deny('retail_fulfillment');const id=Number(fulfill[1]),lid=Number(fulfill[2]),d=await b(),r=receipt(db,id),l=lines(db,id).find(x=>x.id===lid);
      if(!r||!l)return respond(404,{error:'Part line not found'});
      const next=str(d.status,40),allowed={queued:['ordered','backordered','cancelled'],ordered:['backordered','shipped','received'],backordered:['ordered','cancelled'],shipped:['received'],received:['picked_up']};
      if(!allowed[l.status]?.includes(next))return respond(409,{error:`Cannot change ${l.status} to ${next}`});
      if(['ordered','shipped','received'].includes(next)&&!str(d.supplierReference))return respond(409,{error:'Supplier order or receiving confirmation required'});
      if(next==='picked_up'&&(retailPaymentTotals(db,id).due>0||retailPaymentTotals(db,id).refundDue>0))return respond(409,{error:'Cannot release customer parts with an unpaid balance'});
      requireEditRevision(db,req,p,d);
      db.prepare("UPDATE retail_special_lines SET status=?,eta_text=COALESCE(NULLIF(?,''),eta_text) WHERE id=?").run(next,str(d.eta,180),lid);
      const statuses=lines(db,id).map(x=>x.status);
      if(statuses.every(x=>x==='received'||x==='picked_up'))db.prepare("UPDATE retail_special_orders SET status='ready_for_pickup',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
      if(statuses.every(x=>x==='picked_up'))db.prepare("UPDATE retail_special_orders SET status='picked_up',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
      audit(db,u,'Retail line fulfilled',{id,lid,next,supplierReference:d.supplierReference});return respond(200,{ok:true});
    }
    if(p==='/api/shop/retail-carts'&&req.method==='GET'){
      if(!u)return deny();const v=db.prepare('SELECT id,name,code,order_threshold FROM vendors WHERE enabled=1 ORDER BY name').all();
      const all=db.prepare(`SELECT l.*,r.invoice_number,r.customer_id,c.name customer_name,v.code vendor_code
        FROM retail_special_lines l JOIN retail_special_orders r ON r.id=l.retail_order_id
        JOIN customers c ON c.id=r.customer_id JOIN vendors v ON v.id=l.vendor_id
        WHERE r.invoice_issued_at IS NOT NULL AND l.status='verified' ORDER BY l.id`).all();
      return respond(200,{carts:v.map(vendor=>{const items=all.filter(l=>l.vendor_id===vendor.id),total=items.reduce((n,l)=>n+l.quantity*l.unit_cost_cents,0);return {...vendor,items,total_cents:total,eligible:items.length>0&&total>=Math.round(vendor.order_threshold*100),remaining_cents:Math.max(0,Math.round(vendor.order_threshold*100)-total)};})});
    }
    const order=p.match(/^\/api\/shop\/retail-carts\/(\d+)\/queue$/);
    if(order&&req.method==='POST'){
      if(!purchasing())return deny('retail_purchase_review');const vendorId=Number(order[1]);const d=await b(),vendor=db.prepare('SELECT * FROM vendors WHERE id=? AND enabled=1').get(vendorId);
      if(!vendor)return respond(404,{error:'Vendor not found'});
      const rs=db.prepare(`SELECT l.*,r.invoice_number FROM retail_special_lines l JOIN retail_special_orders r ON r.id=l.retail_order_id WHERE l.vendor_id=? AND l.status='verified' AND r.invoice_issued_at IS NOT NULL ORDER BY l.id`).all(vendorId);
      if(!rs.length)return respond(409,{error:'No verified invoice-backed parts in cart'});
      const total=rs.reduce((x,l)=>x+l.unit_cost_cents*l.quantity,0);
      if(total<Math.round(Number(vendor.order_threshold)*100))return respond(409,{error:'Cart is below supplier minimum'});
      if(d.confirmText!==`ORDER ${vendor.code}`||!Array.isArray(d.lines)||d.lines.length!==rs.length)return respond(409,{error:'Review each line and type the required confirmation'});
      for(const l of rs){const supplied=d.lines.find(x=>Number(x.id)===l.id);if(!supplied||supplied.confirmed!==true||str(supplied.sku)!==l.vendor_sku||Number(supplied.quantity)!==l.quantity||Number(supplied.unitCostCents)!==l.unit_cost_cents)return respond(409,{error:'Order lines changed; refresh and reverify'});}
      const snapshot={vendor:vendor.code,total_cents:total,reviewedBy:u.username,reviewedAt:new Date().toISOString(),lines:rs.map(l=>({lineId:l.id,invoiceNumber:l.invoice_number,orderId:l.retail_order_id,sku:l.vendor_sku,requestedSku:l.requested_sku,description:l.description,quantity:l.quantity,unitCostCents:l.unit_cost_cents}))};
      const raw=JSON.stringify(snapshot),sha=crypto.createHash('sha256').update(raw).digest('hex'),uuid=crypto.randomUUID();
      db.exec('BEGIN');try{
        assertPurchaseAuthorized(db,u,total,[],d.purchaseApprovalId,'purchase',makePurchaseTarget('retail',vendorId,vendorId,rs));
        db.prepare('INSERT INTO retail_purchase_commands(command_uuid,vendor_id,snapshot_json,snapshot_sha256,reviewed_by) VALUES(?,?,?,?,?)').run(uuid,vendorId,raw,sha,u.id);
        db.prepare(`UPDATE retail_special_lines SET status='queued' WHERE id IN (${rs.map(()=>'?').join(',')})`).run(...rs.map(x=>x.id));
        audit(db,u,'Invoice-backed retail supplier cart queued',{uuid,vendor:vendor.code,total});db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
      return respond(202,{commandId:uuid,status:'queued_not_purchased',total_cents:total});
    }
    if(p==='/api/shop/purchase-exceptions'&&req.method==='GET'){
      if(!u)return deny();
      const repair=db.prepare(`SELECT pcl.id cart_line_id,pc.id cart_id,pcl.work_order_id,w.ref_number,w.customer_name,pcl.description,pcl.vendor_sku
        FROM procurement_cart_lines pcl JOIN procurement_carts pc ON pc.id=pcl.cart_id JOIN work_orders w ON w.id=pcl.work_order_id
        WHERE pc.status NOT IN ('cancelled','received') AND NOT EXISTS (SELECT 1 FROM ot_invoices i WHERE i.work_order_id=w.id AND i.voided_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.work_order_id=w.id AND a.status='completed' AND a.choice='Approve Repairs')
        ORDER BY pcl.id DESC LIMIT 300`).all();
      const retail=db.prepare(`SELECT l.id line_id,r.invoice_number,c.name customer_name,l.description FROM retail_special_lines l JOIN retail_special_orders r ON r.id=l.retail_order_id JOIN customers c ON c.id=r.customer_id WHERE r.invoice_issued_at IS NULL AND l.vendor_id IS NOT NULL`).all();
      return respond(200,{repairWithoutInvoiceOrApproval:repair,retailWithoutInvoice:retail,total:repair.length+retail.length,policy:'All purchases require an issued invoice, signed repair approval, or explicit approved stock-replenishment record.'});
    }
    if(p==='/api/shop/inventory'&&req.method==='GET'){
      if(!u)return deny();
      const stock=db.prepare('SELECT item_sku sku,SUM(quantity_delta) on_hand FROM inventory_adjustments GROUP BY item_sku ORDER BY item_sku LIMIT 500').all();
      const history=db.prepare('SELECT item_sku,quantity_delta,reason,reference_type,reference_id,created_at FROM inventory_adjustments ORDER BY id DESC LIMIT 100').all();
      const restock=db.prepare('SELECT * FROM stock_restock_requests ORDER BY id DESC LIMIT 100').all();
      return respond(200,{stock,history,restock,note:'Approved restock requests do not increase stock. Goods require a separate receiving event.'});
    }
    if(p==='/api/shop/stock-restock'&&req.method==='POST'){
      if(!u||!['owner','manager'].includes(u.role))return deny('restock_approval');
      const d=await b(),sku=str(d.sku,100),qty=Number(d.quantity),reason=str(d.reason,500);
      if(!sku||!Number.isInteger(qty)||qty<1||qty>10000||!reason)return respond(400,{error:'SKU, positive quantity and business justification required'});
      const x=db.prepare('INSERT INTO stock_restock_requests(item_sku,quantity_requested,reason,approved_by) VALUES(?,?,?,?)').run(sku,qty,reason,u.id);
      audit(db,u,'Stock replenishment approved, not purchased or received',{id:Number(x.lastInsertRowid),sku,qty});
      return respond(201,{id:Number(x.lastInsertRowid),status:'approved_waiting_purchase',stockAdded:0});
    }
    if(p==='/api/shop/inventory-adjustments'&&req.method==='POST'){
      if(!purchasing())return deny('inventory_adjustment');const d=await b(),delta=Number(d.quantityDelta),reason=str(d.reason,80),sku=str(d.sku,100),refType=str(d.referenceType,40),refId=str(d.referenceId,100);
      if(!sku||!Number.isInteger(delta)||delta===0||!['received','sold','return','damage','cycle_count'].includes(reason)||!refType||!refId)return respond(400,{error:'SKU, signed quantity, reason, and documented reference required'});
      if(reason==='return')return respond(409,{error:'Receive customer returns through Accounting with the original stock sale and credit note; manual return adjustments are disabled'});
      if(['damage','cycle_count'].includes(reason)&&!['owner','manager'].includes(u.role))return deny('inventory_writeoff_or_stock_count');
      if(reason==='received'&&(refType!=='supplier_order'||delta<0))return respond(409,{error:'Receiving stock requires positive quantities and a supplier order confirmation reference'});
      if(reason==='sold'){
        if(refType!=='invoice'||delta>=0)return respond(409,{error:'Stock sales require a negative quantity against an issued customer invoice'});
        const linkedRetail=db.prepare('SELECT id FROM retail_special_orders WHERE invoice_number=? AND invoice_issued_at IS NOT NULL').get(refId);
        const linkedRepair=db.prepare('SELECT id FROM ot_invoices WHERE number=? AND voided_at IS NULL').get(refId);
        if(!linkedRetail&&!linkedRepair)return respond(409,{error:'Inventory sale blocked: invoice reference is not an issued customer invoice'});
      }
      const existing=db.prepare('SELECT COALESCE(SUM(quantity_delta),0) on_hand FROM inventory_adjustments WHERE item_sku=?').get(sku).on_hand;
      if(existing+delta<0)return respond(409,{error:'Inventory cannot go negative; investigate missing stock first'});
      const x=db.prepare('INSERT INTO inventory_adjustments(item_sku,quantity_delta,reason,reference_type,reference_id,actor_id) VALUES(?,?,?,?,?,?)').run(sku,delta,reason,refType,refId,u.id);
      audit(db,u,'Inventory adjustment',{sku,delta,reason,refType,refId});return respond(201,{id:Number(x.lastInsertRowid)});
    }
    if(p==='/api/desktop-agent/retail-commands'&&req.method==='GET'){
      if(!bridgeToken||req.headers.authorization!==`Bearer ${bridgeToken}`)return respond(401,{error:'Invalid desktop token'});
      const c=db.prepare("SELECT command_uuid,snapshot_json,snapshot_sha256 FROM retail_purchase_commands WHERE status='queued' ORDER BY id LIMIT 10").all();
      return respond(200,{commands:c.map(x=>({id:x.command_uuid,...JSON.parse(x.snapshot_json),sha256:x.snapshot_sha256}))});
    }
    const ack=p.match(/^\/api\/desktop-agent\/retail-commands\/([a-f0-9-]+)\/ack$/);
    if(ack&&req.method==='POST'){
      if(!bridgeToken||req.headers.authorization!==`Bearer ${bridgeToken}`)return respond(401,{error:'Invalid desktop token'});
      const d=await b();if(!['needs_connector','failed'].includes(d.status))return respond(400,{error:'Supplier order confirmation is disabled without a validated provider connector'});
      const cmd=db.prepare('SELECT * FROM retail_purchase_commands WHERE command_uuid=?').get(ack[1]);if(!cmd)return respond(404,{error:'Command not found'});
      if(cmd.status!=='queued')return respond(409,{error:'Already acknowledged'});
      db.prepare('UPDATE retail_purchase_commands SET status=?,agent_message=?,finished_at=CURRENT_TIMESTAMP WHERE id=?').run(d.status,str(d.message),cmd.id);
      return respond(200,{status:d.status});
    }
  }catch(e){return respond(e.status||400,{error:String(e.message||e)});}
  return false;
 };
}

// Device routes: local-only ESC/POS receipt printing, deliberate cash drawer actions.
import {receiptBytes,drawerPulse,sendEpson,printerHost} from './epson.mjs';
import {installTax,shopTaxBps,setShopTaxBps,applyOrderTax} from './tax.mjs';
export function deviceRoutes({db,currentUser,json,readBody,shopName,shopPhone}){
 installTax(db);
 const respond=(res,s,v)=>{json(res,s,v);return true};
 const roles=new Set(['owner','manager','service_writer']);
 return async (req,res,p)=>{
  if(!p.startsWith('/api/pos/devices')&&!p.startsWith('/api/pos/settings/tax'))return false;
  const user=currentUser(req);if(!user)return respond(res,401,{error:'Login required'});
  try{
   if(p==='/api/pos/settings/tax'){
    if(req.method==='GET')return respond(res,200,{ratePercent:shopTaxBps(db)/100,rateBasisPoints:shopTaxBps(db),taxableDefault:['part','other'],laborTaxableDefault:false,notice:'9.1% is the shop-requested configuration. Accountant must confirm applicable retail classification and taxable categories before live collection.'});
    if(req.method==='PATCH'){
      if(!['owner','manager'].includes(user.role))return respond(res,403,{error:'Only manager/owner may change tax rate'});
      const b=await readBody(req),n=Number(b.ratePercent);if(!Number.isFinite(n)||n<0||n>25||Math.round(n*100)!==n*100)return respond(res,400,{error:'Rate must be a number with at most two decimals'});
      const bps=setShopTaxBps(db,Math.round(n*100));return respond(res,200,{ratePercent:bps/100,notice:'New rate applies to newly created work orders; existing jobs and finalized invoices retain their prior rate.'});
    }
   }
   if(p==='/api/pos/devices/status'&&req.method==='GET')return respond(res,200,{printerConfigured:!!printerHost(),type:'ESC/POS local TCP 9100',drawerPin:Number(process.env.EPSON_DRAWER_PIN||0),emailConfigured:Boolean(process.env.SMTP_USER&&process.env.SMTP_APP_PASSWORD),notice:'Confirm exact Epson TM model, RJ drawer compatibility, and network connection before live printing.'});
   if(!roles.has(user.role))return respond(res,403,{error:'POS device controls restricted'});
   const receipt=p.match(/^\/api\/pos\/devices\/receipt\/(\d+)$/);
   if(receipt&&req.method==='POST'){
    const id=Number(receipt[1]),w=db.prepare('SELECT * FROM work_orders WHERE id=?').get(id);if(!w)return respond(res,404,{error:'Work order not found'});
    const lines=db.prepare('SELECT * FROM work_order_lines WHERE work_order_id=? ORDER BY id').all(id),payments=db.prepare('SELECT * FROM pos_payments WHERE work_order_id=? ORDER BY id').all(id);
    const cust=w.customer_id?db.prepare('SELECT * FROM customers WHERE id=?').get(w.customer_id):null;const address=cust?[cust.address_line1||cust.address,cust.address_line2,[cust.city,cust.state,cust.postal_code].filter(Boolean).join(' ')].filter(Boolean):[];
    const bytes=receiptBytes({shop:shopName,phone:shopPhone,job:w,lines,payments,taxRateBps:w.tax_rate_bps||0,customerAddress:address});
    if(!printerHost())return respond(res,409,{error:'Set EPSON_PRINTER_IP to the printer LAN address'});
    const outcome=await sendEpson(bytes);db.prepare('INSERT INTO audit_log(work_order_id,actor,action,detail) VALUES(?,?,?,?)').run(id,user.username,'Printed receipt',JSON.stringify(outcome));return respond(res,200,outcome);
   }
   if(p==='/api/pos/devices/drawer/open'&&req.method==='POST'){
    const b=await readBody(req);if(b.confirm!==true||String(b.reason||'').trim().length<5)return respond(res,400,{error:'Confirm and provide a reason before opening cash drawer'});
    if(!printerHost())return respond(res,409,{error:'Epson network printer not configured'});
    const outcome=await sendEpson(drawerPulse({pin:Number(process.env.EPSON_DRAWER_PIN||0)}));db.prepare('INSERT INTO audit_log(work_order_id,actor,action,detail) VALUES(?,?,?,?)').run(null,user.username,'Cash drawer kick pulse',JSON.stringify({reason:String(b.reason).slice(0,150),...outcome}));return respond(res,200,outcome);
   }
   return respond(res,404,{error:'Unknown device route'});
  }catch(e){return respond(res,400,{error:String(e.message).slice(0,200)})}
 }
}

import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
export function legacyArchiveRoutes({currentUser,json,archivePath=process.env.OWNERTRACKER_LEGACY_ARCHIVE}) {
 return async(req,res,p)=>{
  if(!p.startsWith('/api/legacy/'))return false;
  const send=(status,data)=>{json(res,status,data,{'cache-control':'no-store'});return true;};
  const user=currentUser(req);
  if(!user)return send(401,{error:'Sign in required'});
  if(!['owner','manager','advisor','service_writer'].includes(user.role))return send(403,{error:'Customer and receipt archive permission required'});
  if(req.method!=='GET')return send(405,{error:'Historical records are read-only'});
  if(!archivePath)return send(200,{configured:false,customers:[],receipts:[],notice:'Recovered archive not installed yet. Add the recovery ZIP to Drive for migration.'});
  let db;
  try{
   db=new DatabaseSync(path.resolve(archivePath),{readOnly:true});db.exec('PRAGMA query_only=ON');
   const url=new URL(req.url,'http://local'),q=String(url.searchParams.get('q')||'').trim().slice(0,180),like='%'+q+'%';
   if(p==='/api/legacy/status')return send(200,{configured:true,customers:db.prepare('SELECT COUNT(*) n FROM customers').get().n,receipts:db.prepare('SELECT COUNT(*) n FROM sales_receipts').get().n,items:db.prepare('SELECT COUNT(*) n FROM receipt_line_items').get().n});
   if(p==='/api/legacy/customers')return send(200,{configured:true,customers:db.prepare('SELECT ListID,FullName,Phone,EMail,BillAddress_Street,BillAddress_City,BillAddress_State,BillAddress_PostalCode FROM customers WHERE FullName LIKE ? OR Phone LIKE ? OR EMail LIKE ? ORDER BY FullName LIMIT 50').all(like,like,like)});
   if(p==='/api/legacy/receipts'){
    const customer=url.searchParams.get('customerId');
    const where=customer?'r.CustomerListID=?':`(r.SalesReceiptNumber LIKE ? OR r.TxnDate LIKE ? OR c.FullName LIKE ? OR c.Phone LIKE ? OR EXISTS(SELECT 1 FROM receipt_line_items i WHERE i.ReceiptTxnID=r.TxnID AND (i.Desc1 LIKE ? OR i.Desc2 LIKE ? OR i.ALU LIKE ? OR i.ItemNumber LIKE ?)))`;
    const args=customer?[customer]:Array(8).fill(like);
    const receipts=db.prepare(`SELECT r.TxnID,r.SalesReceiptNumber,r.TxnDate,r.CustomerListID,r.SalesReceiptType,r.Total,r.TaxAmount,c.FullName customer_name FROM sales_receipts r LEFT JOIN customers c ON c.ListID=r.CustomerListID WHERE ${where} ORDER BY r.TxnDate DESC,r.TxnID LIMIT 50`).all(...args);
    return send(200,{configured:true,receipts});
   }
   const match=p.match(/^\/api\/legacy\/receipts\/([^/]+)$/);
   if(match){const id=decodeURIComponent(match[1]),receipt=db.prepare('SELECT TxnID,SalesReceiptNumber,TxnDate,CustomerListID,SalesReceiptType,Total,Subtotal,TaxAmount,Discount,Comments,TenderType,ItemsCount FROM sales_receipts WHERE TxnID=?').get(id);if(!receipt)return send(404,{error:'Historical receipt not found'});return send(200,{configured:true,receipt,customer:db.prepare('SELECT ListID,FullName,Phone,EMail,BillAddress_Street,BillAddress_City,BillAddress_State,BillAddress_PostalCode FROM customers WHERE ListID=?').get(receipt.CustomerListID)||null,items:db.prepare('SELECT ReceiptTxnID,LineNumber,ItemNumber,Desc1,Desc2,Qty,Price,ExtendedPrice,TaxAmount,ALU FROM receipt_line_items WHERE ReceiptTxnID=? ORDER BY rowid').all(id),tenders:db.prepare('SELECT ReceiptTxnID,TenderKind,TenderAmount,TipAmount,CardName,CheckNumber FROM receipt_tenders WHERE ReceiptTxnID=? ORDER BY rowid').all(id),notice:'Reconstructed historical receipt from recovered POS data. Payment details reflect only the recovered export; this view creates no current sale, charge or stock movement.'});}
   return send(404,{error:'Archive route not found'});
  }catch(error){return send(503,{configured:false,error:'Historical archive unavailable or schema requires migration review. Original data was not modified.'});}
  finally{db?.close();}
 };
}

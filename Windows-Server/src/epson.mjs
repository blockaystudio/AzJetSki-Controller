// Epson ESC/POS Ethernet adapter. Requires ESC/POS-compatible TM printer with RJ drawer port.
// Never listen for arbitrary network print destinations. Printer host comes only from shop config.
import net from 'node:net';
const money=v=>(Math.round(Number(v)*100)/100).toFixed(2);
const ascii=s=>String(s??'').replace(/[^\x20-\x7E]/g,'?');
const line=(left,right='',cols=42)=>{left=ascii(left);right=ascii(right);const budget=Math.max(1,cols-right.length-1);return left.slice(0,budget).padEnd(cols-right.length)+right+'\n';};
export function receiptBytes({shop,phone,job,lines,payments,date=new Date().toISOString(),taxRateBps=910,customerAddress=[]}){
 const subtotalC=Number(job.subtotal_cents||0)||Math.round(Number(job.estimate_total||0)*100)-Number(job.tax_total_cents||0);
 const paidC=Math.round(Number(job.paid_total||0)*100),totalC=Math.round(Number(job.estimate_total||0)*100);
 let txt='\x1b@'+ascii(shop).slice(0,40)+'\n'+ascii(phone)+'\n'+date.slice(0,19)+'\n'+`WO ${ascii(job.ref_number||job.id)}\n`+`${ascii(job.customer_name)}\n`+`${ascii(job.unit_label)}\n`+customerAddress.map(ascii).join('\n')+'\n'+'------------------------------------------\n';
 for(const x of lines){const q=Number(x.qty||1),name=ascii(x.description||'Item');txt+=name.slice(0,42)+'\n'+line('  '+q+' x '+money(x.rate),money(x.amount));}
 txt+='------------------------------------------\n'+line('Subtotal',money(subtotalC/100))+line(`Sales tax (${(taxRateBps/100).toFixed(2)}%)`,money(Number(job.tax_total_cents||0)/100))+line('TOTAL',money(totalC/100));
 for(const p of payments){if(p.status==='confirmed')txt+=line((p.direction==='refund'?'REFUND ':'PAID ')+String(p.method).toUpperCase(),money((p.direction==='refund'?-1:1)*p.amount_cents/100));}
 txt+=line('PAID TOTAL',money(paidC/100))+line('BALANCE',money(Math.max(0,totalC-paidC)/100))+'\nTHANK YOU!\n\n\n';
 return Buffer.concat([Buffer.from(txt,'ascii'),Buffer.from([0x1d,0x56,0x00])]); // Cut paper; no drawer pulse on receipts.
}
export function drawerPulse({pin=0}={}){if(![0,1].includes(Number(pin)))throw Error('Invalid drawer pin');return Buffer.from([0x1b,0x70,Number(pin),25,125]);}
export function printerHost(){const host=String(process.env.EPSON_PRINTER_IP||'').trim();if(!host)return null;
 if(net.isIP(host)!==4)throw Error('EPSON_PRINTER_IP must be an IPv4 address');const x=host.split('.').map(Number);
 if(!(x[0]===10||(x[0]===172&&x[1]>=16&&x[1]<=31)||(x[0]===192&&x[1]===168)||(x[0]===127)))throw Error('Printer must be on local private network');return host;
}
export function sendEpson(data,{host=printerHost(),port=Number(process.env.EPSON_PRINTER_PORT||9100),timeout=2500}={}){
 if(!host||net.isIP(host)!==4||!Number.isInteger(port)||port<1||port>65535)throw Error('Epson local-network printer not configured');
 return new Promise((resolve,reject)=>{const socket=net.createConnection({host,port});let done=false;const finish=(error)=>{if(done)return;done=true;socket.destroy();error?reject(error):resolve({transmitted:true,host,bytes:data.length,notice:'Bytes sent to printer socket. Physical printing/drawer action must be confirmed at shop.'})};socket.setTimeout(timeout,()=>finish(Error('Printer timeout')));socket.on('error',finish);socket.on('connect',()=>socket.end(data));socket.on('close',hadError=>{if(!hadError)finish();});});
}

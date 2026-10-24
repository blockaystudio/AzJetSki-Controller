// Direct invoice email via authenticated SMTP/SSL (e.g. Gmail smtp.gmail.com:465).
// SMTP accepted != delivered. Never put merchant passwords in source or browser.
import tls from 'node:tls';
const header=s=>String(s??'').replace(/[\r\n\x00-\x1f]/g,' ').trim().slice(0,200);
const addr=s=>{const v=header(s);if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v))throw Error('Valid email address required');return v};
export function smtpConfigured(){return Boolean(process.env.SMTP_USER&&process.env.SMTP_APP_PASSWORD&&process.env.INVOICE_FROM_EMAIL)}
export async function sendInvoiceMail({to,name,shop,subject,message,link}){
 if(!smtpConfigured())return {status:'not_sent_smtp_not_configured'};
 const host=process.env.SMTP_HOST||'smtp.gmail.com',port=Number(process.env.SMTP_PORT||465);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid SMTP port');
 const user=addr(process.env.SMTP_USER),from=addr(process.env.INVOICE_FROM_EMAIL),recipient=addr(to);
 const safeSubject=header(subject),shopName=header(shop),customer=header(name);const text=[message,'',link,'','Thank you,',shopName].join('\n');
 const msg=`From: "${shopName.replace(/"/g,'')}" <${from}>\r\nTo: "${customer.replace(/"/g,'')}" <${recipient}>\r\nSubject: ${safeSubject}\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(text,'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n')||''}\r\n`;
 const sock=tls.connect({host,port,servername:host,rejectUnauthorized:true});sock.setTimeout(12000);let buffer='',waiter=null;
 function consume(){if(!waiter)return;const match=buffer.match(/(?:^|\r\n)(\d{3}) ([^\r\n]*)\r\n/);if(!match)return;const data=buffer.slice(0,match.index+match[0].length);buffer=buffer.slice(match.index+match[0].length);const resolve=waiter;waiter=null;resolve({code:Number(match[1]),data});}
 sock.on('data',d=>{buffer+=d.toString('utf8');consume()});
 const receive=()=>new Promise((resolve,reject)=>{waiter=resolve;const timer=setTimeout(()=>{if(waiter===resolve){waiter=null;reject(Error('SMTP response timeout'));}},12000);waiter=(x)=>{clearTimeout(timer);resolve(x)};consume()});
 const cmd=async(s,want)=>{sock.write(s+'\r\n');const resp=await receive();if(resp.code!==want)throw Error(`SMTP ${resp.code} during ${s.split(' ')[0]}`);return resp};
 try{const hello=await receive();if(hello.code!==220)throw Error('SMTP greeting failed');await cmd('EHLO ownertracker.local',250);await cmd('AUTH PLAIN '+Buffer.from('\0'+user+'\0'+process.env.SMTP_APP_PASSWORD).toString('base64'),235);await cmd(`MAIL FROM:<${from}>`,250);await cmd(`RCPT TO:<${recipient}>`,250);await cmd('DATA',354);sock.write(msg.replace(/(^|\r\n)\./g,'$1..')+'\r\n.\r\n');const r=await receive();if(r.code!==250)throw Error(`SMTP rejected email ${r.code}`);await cmd('QUIT',221);return {status:'accepted_by_smtp',recipient};}
 finally{sock.destroy()}
}

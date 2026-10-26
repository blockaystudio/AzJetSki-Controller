// Direct invoice email via authenticated SMTP/SSL (e.g. Gmail smtp.gmail.com:465).
// SMTP acceptance is not inbox delivery. Never log credentials or SMTP AUTH data.
import tls from 'node:tls';
const header=s=>String(s??'').replace(/[\r\n\x00-\x1f]/g,' ').trim().slice(0,200);
const addr=s=>{const v=header(s);if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v))throw Error('Valid email address required');return v};
export function smtpConfigured(){return Boolean(process.env.SMTP_USER&&process.env.SMTP_APP_PASSWORD&&process.env.INVOICE_FROM_EMAIL)}
export async function sendInvoiceMail({to,name,shop,subject,message,link},{connect=tls.connect,timeoutMs=12000}={}){
 if(!smtpConfigured())return {status:'not_sent_smtp_not_configured'};
 const host=process.env.SMTP_HOST||'smtp.gmail.com',port=Number(process.env.SMTP_PORT||465);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid SMTP port');
 const user=addr(process.env.SMTP_USER),from=addr(process.env.INVOICE_FROM_EMAIL),recipient=addr(to);
 const safeSubject=header(subject),shopName=header(shop),customer=header(name);const text=[message,'',link,'','Thank you,',shopName].join('\n');
 const msg=`From: "${shopName.replace(/"/g,'')}" <${from}>\r\nTo: "${customer.replace(/"/g,'')}" <${recipient}>\r\nSubject: ${safeSubject}\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(text,'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n')||''}\r\n`;
 let sock,buffer='',waiter=null,failure=null,bodyStarted=false,accepted=false,finished=false;
 const stop=error=>{
   if(finished||failure)return;
   failure=error;
   if(waiter){const pending=waiter;waiter=null;clearTimeout(pending.timer);pending.reject(error);}
 };
 function consume(){
   if(!waiter)return;
   const match=buffer.match(/(?:^|\r\n)(\d{3}) ([^\r\n]*)\r\n/);if(!match)return;
   const pending=waiter;waiter=null;clearTimeout(pending.timer);
   buffer=buffer.slice(match.index+match[0].length);pending.resolve({code:Number(match[1])});
 }
 const receive=()=>new Promise((resolve,reject)=>{
   if(failure)return reject(failure);
   const pending={resolve,reject,timer:null};
   pending.timer=setTimeout(()=>stop(Error('SMTP response timeout')),timeoutMs);
   waiter=pending;consume();
 });
 const expect=(response,want,stage)=>{
   if(response.code!==want){const error=Error(`SMTP ${response.code} during ${stage}`);error.smtpCode=response.code;throw error;}
   return response;
 };
 const cmd=async(command,want,stage)=>{
   if(failure)throw failure;
   sock.write(command+'\r\n');
   return expect(await receive(),want,stage);
 };
 try{
   sock=connect({host,port,servername:host,rejectUnauthorized:true});
   // Retain error handling through destroy: sockets can emit a final error after
   // a response or close. Only the first failure settles the current waiter.
   sock.on('error',()=>stop(Error('SMTP connection error')));
   sock.on('close',()=>stop(Error('SMTP connection closed')));
   sock.on('end',()=>stop(Error('SMTP connection ended')));
   sock.on('timeout',()=>stop(Error('SMTP connection timeout')));
   sock.on('data',data=>{if(finished||failure)return;buffer+=data.toString('utf8');if(buffer.length>65536)stop(Error('SMTP response too large'));else consume();});
   sock.setTimeout(timeoutMs);
   expect(await receive(),220,'greeting');
   await cmd('EHLO ownertracker.local',250,'EHLO');
   await cmd('AUTH PLAIN '+Buffer.from('\0'+user+'\0'+process.env.SMTP_APP_PASSWORD).toString('base64'),235,'AUTH');
   await cmd(`MAIL FROM:<${from}>`,250,'MAIL');
   await cmd(`RCPT TO:<${recipient}>`,250,'RCPT');
   await cmd('DATA',354,'DATA');
   if(failure)throw failure;
   // From this write onward the remote server may have received the complete
   // message. A lost final response must never enter automatic retry.
   bodyStarted=true;
   sock.write(msg.replace(/(^|\r\n)\./g,'$1..')+'\r\n.\r\n');
   expect(await receive(),250,'message acceptance');accepted=true;
   await cmd('QUIT',221,'QUIT');
   return {status:'accepted_by_smtp',recipient};
 }catch(error){
   if(accepted)return {status:'accepted_by_smtp',recipient};
   const definitive=error.smtpCode>=400&&error.smtpCode<600;
   if(bodyStarted&&!definitive)return {status:'delivery_unknown',retryable:false,error:'SMTP connection ended without a definitive acceptance response. Review the provider before retrying.'};
   return {status:'provider_failed',retryable:!error.smtpCode||(error.smtpCode>=400&&error.smtpCode<500),error:header(error.message)};
 }finally{
   finished=true;
   if(waiter){clearTimeout(waiter.timer);waiter=null;}
   sock?.destroy();
 }
}

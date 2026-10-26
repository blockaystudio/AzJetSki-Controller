import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import tls from 'node:tls';
import {sendInvoiceMail} from '../src/shop-mail.mjs';
import {openDb} from '../src/db.mjs';
import {extendDatabase} from '../src/pos-extension.mjs';
import {installShopOps} from '../src/shop-ops.mjs';
import {recordContactConsent,enqueueCustomerMessage,dispatchDueOutbox} from '../src/shop-management.mjs';
import {installShopManagement} from '../src/shop-management.mjs';

const message={to:'customer@example.test',name:'Customer',shop:'Test shop',subject:'Test',message:'Test only',link:''};
function environment(t){
  for(const [key,value] of Object.entries({SMTP_USER:'smtp@example.test',SMTP_APP_PASSWORD:'fake-test-password',INVOICE_FROM_EMAIL:'shop@example.test',SMTP_HOST:'smtp.example.test',SMTP_PORT:'465',SENDGRID_API_KEY:''})){
    const previous=process.env[key];process.env[key]=value;t.after(()=>previous===undefined?delete process.env[key]:process.env[key]=previous);
  }
}
function connection({failAt,kind='error',rejectAt,rejection=451,immediateClose=false}={}){
  const socket=new EventEmitter();socket.writes=[];socket.destroyed=false;socket.setTimeout=()=>{};
  const respond=(stage,code)=>queueMicrotask(()=>{
    if(stage===failAt){
      if(kind==='silent')return;
      if(kind==='error'){socket.emit('error',Error('injected socket failure'));socket.emit('close');socket.emit('timeout');}
      else socket.emit(kind);
      return;
    }
    const reply=`${stage===rejectAt?rejection:code} response\r\n`;
    if(stage==='EHLO'){socket.emit('data',Buffer.from('250-first line\r\n'));socket.emit('data',Buffer.from(reply.slice(0,5)));socket.emit('data',Buffer.from(reply.slice(5)));}
    else socket.emit('data',Buffer.from(reply));
    if(stage==='body'&&immediateClose)socket.emit('close');
  });
  socket.write=data=>{
    socket.writes.push(data);
    const stage=data.startsWith('From:')?'body':data.split(' ')[0].trim();
    const codes={EHLO:250,AUTH:235,MAIL:250,RCPT:250,DATA:354,body:250,QUIT:221};
    respond(stage,codes[stage]);return true;
  };
  socket.destroy=()=>{socket.destroyed=true;queueMicrotask(()=>{socket.emit('error',Error('late destroy failure'));socket.emit('close');});};
  return {socket,connect:()=>{respond('greeting',220);return socket;}};
}

test('SMTP socket error, close, end, socket timeout and response deadline settle before DATA without crashing',async t=>{
  environment(t);
  for(const kind of ['error','close','end','timeout','silent'])await t.test(kind,async()=>{
    const mock=connection({failAt:'greeting',kind});
    const result=await sendInvoiceMail(message,{connect:mock.connect,timeoutMs:20});
    assert.equal(result.status,'provider_failed');assert.equal(result.retryable,true);
    assert.equal(mock.socket.destroyed,true);assert.equal(mock.socket.writes.length,0);
    await new Promise(resolve=>setImmediate(resolve));
  });
});

test('SMTP failures before message data are retryable; definitive 4xx/5xx rejection is distinguished',async t=>{
  environment(t);
  for(const stage of ['EHLO','AUTH','MAIL','RCPT','DATA']){
    const mock=connection({failAt:stage});
    const result=await sendInvoiceMail(message,{connect:mock.connect,timeoutMs:20});
    assert.equal(result.status,'provider_failed',stage);assert.equal(result.retryable,true);
    assert.equal(mock.socket.writes.some(write=>write.startsWith('From:')),false);
  }
  for(const rejection of [451,550]){
    const mock=connection({rejectAt:'body',rejection});
    const result=await sendInvoiceMail(message,{connect:mock.connect,timeoutMs:20});
    assert.equal(result.status,'provider_failed');assert.equal(result.retryable,rejection===451);
  }
});

test('SMTP loses certainty after DATA write and retains acceptance if QUIT fails',async t=>{
  environment(t);
  for(const kind of ['error','close','end','timeout','silent']){
    const unknown=connection({failAt:'body',kind});
    const result=await sendInvoiceMail(message,{connect:unknown.connect,timeoutMs:20});
    assert.equal(result.status,'delivery_unknown',kind);assert.equal(result.retryable,false);
    const accepted=connection({failAt:'QUIT',kind});
    assert.equal((await sendInvoiceMail(message,{connect:accepted.connect,timeoutMs:20})).status,'accepted_by_smtp',kind);
  }
  const acceptedThenClose=connection({immediateClose:true});
  assert.equal((await sendInvoiceMail(message,{connect:acceptedThenClose.connect,timeoutMs:20})).status,'accepted_by_smtp');
  const success=connection();assert.equal((await sendInvoiceMail(message,{connect:success.connect,timeoutMs:20})).status,'accepted_by_smtp');
  assert.equal(success.socket.destroyed,true);
});

test('actual outbox SMTP adapter retries known refusal but never automatically resends uncertain acceptance',async t=>{
  environment(t);
  const db=openDb(':memory:');extendDatabase(db);installShopOps(db);installShopManagement(db);t.after(()=>db.close());
  const user={id:Number(db.prepare("INSERT INTO users(username,password_hash,salt,role) VALUES('owner','unused','unused','owner')").run().lastInsertRowid),username:'owner',role:'owner'};
  const customerId=Number(db.prepare("INSERT INTO customers(name,email) VALUES('Test','customer@example.test')").run().lastInsertRowid);
  recordContactConsent(db,user,customerId,{serviceEmail:true,marketingEmail:false,source:'Test explicit consent'});
  const queued=enqueueCustomerMessage(db,user,{customerId,category:'service',subject:'Test',message:'Test only',idempotencyKey:'smtp-outbox-test'});
  let calls=0;const first=connection({failAt:'greeting'}),uncertain=connection({failAt:'body'});
  t.mock.method(tls,'connect',()=>{calls++;return (calls===1?first:uncertain).connect();});
  const now=new Date('2030-01-01T00:00:00Z');
  assert.equal((await dispatchDueOutbox(db,user,{now:()=>now})).results[0].status,'retry_wait');
  assert.equal((await dispatchDueOutbox(db,user,{now:()=>now})).results.length,0);
  assert.equal((await dispatchDueOutbox(db,user,{now:()=>new Date(now.getTime()+61000)})).results[0].status,'delivery_unknown');
  assert.equal((await dispatchDueOutbox(db,user,{now:()=>new Date(now.getTime()+3600000)})).results.length,0);
  assert.equal(calls,2);
  assert.deepEqual(db.prepare('SELECT outcome FROM notification_attempts WHERE message_id=? ORDER BY id').all(queued.id).map(row=>row.outcome),['retry_wait','delivery_unknown']);
  assert.equal(db.prepare('SELECT status,attempts FROM customer_message_outbox WHERE id=?').get(queued.id).attempts,2);
});

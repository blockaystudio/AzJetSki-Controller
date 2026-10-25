import test from 'node:test';
import assert from 'node:assert/strict';
import {financePanel, postFinancialForm, bindPaymentForm, ledgerSummary} from '../public/finance-ui.js';

test('financial controls escape ledger values and hide privileged controls for ordinary staff', () => {
  const html = financePanel({kind:'repair', id:7, payments:[{id:1,method:'zelle',direction:'payment',status:'pending',amount_cents:1200,reference:'<img src=x onerror=alert(1)>',actor_username:'<script>bad()</script>',actor_role:'advisor'}]});
  assert.doesNotMatch(html, /<script>|<img|data-finance-refund|data-finance-void=/);
  assert.match(html, /&lt;img/);
  assert.match(html, /data-finance-confirm="1"/);
});

test('voided pending deposits cannot be confirmed or refunded in the payment controls', () => {
  const html = financePanel({kind:'retail',id:4,canRefund:true,canVoid:true,payments:[{id:1,method:'zelle',direction:'payment',status:'pending',amount_cents:1200,voided_at:'2026-10-25',void_reason:'Customer cancelled',refund_remaining_cents:1200}]});
  assert.doesNotMatch(html, /data-finance-confirm=|data-finance-void=|data-finance-refund/);
  assert.match(html, /Customer cancelled/);
});

test('retrying after a lost response reuses the payment key; changed details use a new key', async t => {
  const priorFetch = globalThis.fetch;
  t.after(() => globalThis.fetch = priorFetch);
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) throw new Error('Response lost after server recorded payment');
    return {ok:true,json:async()=>({id:1})};
  };
  const form = {};
  const payload = {method:'cash',amount:'10.00',verified:true};
  await assert.rejects(postFinancialForm(form,'/payments',payload), /Response lost/);
  await postFinancialForm(form,'/payments',payload);
  await postFinancialForm(form,'/payments',{...payload,amount:'12.00'});
  await postFinancialForm(form,'/other-account',{...payload,amount:'12.00'});
  assert.equal(requests[0].idempotencyKey,requests[1].idempotencyKey);
  assert.equal(requests[1].idempotency_key,requests[1].idempotencyKey);
  assert.notEqual(requests[1].idempotencyKey,requests[2].idempotencyKey);
  assert.notEqual(requests[2].idempotencyKey,requests[3].idempotencyKey);
});

test('an in-flight payment blocks a second submit and resolves the current account URL', async t => {
  const priorFetch = globalThis.fetch;
  t.after(() => globalThis.fetch = priorFetch);
  let complete, count=0, reloads=0, account=9;
  const wait = new Promise(resolve => complete=resolve);
  const button = {disabled:false};
  const form = {elements:{},dataset:{},querySelectorAll:()=>[button],reset(){}};
  globalThis.fetch = async url => {
    count++;
    assert.equal(url,'/payments/10');
    await wait;
    return {ok:true,json:async()=>({id:1})};
  };
  bindPaymentForm(form,()=>`/payments/${account}`,()=>({method:'cash',amount:'10',verified:true}),async()=>reloads++);
  account=10;
  const first = form.onsubmit({preventDefault(){}});
  await form.onsubmit({preventDefault(){}});
  assert.equal(count,1);
  assert.equal(button.disabled,true);
  complete();
  await first;
  assert.equal(reloads,1);
  assert.equal(button.disabled,false);
});

test('acknowledged payments clear the persistent form and give a new intentional equal payment a fresh key', async t => {
  const priorFetch=globalThis.fetch;
  t.after(()=>globalThis.fetch=priorFetch);
  const requests=[];
  globalThis.fetch=async (_url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({id:requests.length})};};
  let resets=0;
  const form={elements:{},dataset:{},querySelectorAll:()=>[],reset(){resets++;}};
  bindPaymentForm(form,'/payments/1',()=>({method:'cash',amount:'10',verified:true}),async()=>{});
  await form.onsubmit({preventDefault(){}});
  await form.onsubmit({preventDefault(){}});
  assert.equal(resets,2);
  assert.notEqual(requests[0].idempotencyKey,requests[1].idempotencyKey);
});

test('an acknowledged payment clears inputs even if the account refresh fails', async t => {
  const priorFetch=globalThis.fetch;
  t.after(()=>globalThis.fetch=priorFetch);
  globalThis.fetch=async()=>({ok:true,json:async()=>({id:1})});
  let cleared=false,message='';
  const form={elements:{},dataset:{},querySelectorAll:()=>[],reset(){cleared=true;}};
  bindPaymentForm(form,'/payments/1',()=>({amount:'10'}),async()=>{throw Error('Offline');},error=>message=error.message);
  await form.onsubmit({preventDefault(){}});
  assert.equal(cleared,true);
  assert.match(message,/Payment saved.*refresh failed/);
});

test('global ledger totals exclude voided entries and pending cash while subtracting confirmed refunds',()=>{
  const totals=ledgerSummary([
    {method:'cash',direction:'payment',status:'confirmed',amount_cents:10000},
    {method:'cash',direction:'refund',status:'confirmed',amount_cents:1500},
    {method:'zelle',direction:'payment',status:'pending',amount_cents:3000,voided_at:'2026-10-25'},
    {method:'zelle',direction:'payment',status:'pending',amount_cents:2000},
    {method:'cash',direction:'payment',status:'pending',amount_cents:1000}
  ]);
  assert.deepEqual(totals,{net:8500,pending:2000});
});

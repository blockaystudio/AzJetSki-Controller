import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {mountAccountWorkspace, renderAccountWorkspace, accountCorrections, returnableStockSales} from '../public/account-workspace.js';
import {rememberEditRevisions} from '../public/edit-revisions-ui.js';

const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return {promise, resolve}; };
const tick = () => new Promise(resolve => setImmediate(resolve));

// Small DOM fixture exercises the actual mounting/binding code. No browser,
// database or provider is shared with the review runtime.
class Container {
  constructor() { this.nodes = new Map(); this.isConnected = true; this.events = []; }
  set innerHTML(html) {
    this.html = html; this.nodes.clear();
    const node = (selector, values = {}) => {
      const element = {dataset:{}, disabled:false, textContent:'', ...values};
      Object.defineProperty(element, 'isConnected', {get:() => this.isConnected});
      element.addEventListener = (type, listener) => { element['on' + type] = listener; };
      element.dispatchEvent = event => { this.events.push({type:event.type, target:element, amount:element.elements?.amount?.value}); return true; };
      this.nodes.set(selector, element); return element;
    };
    for (const match of html.matchAll(/\b(data-[a-z-]+)(?:="[^"]*")?/g)) if (!this.nodes.has(`[${match[1]}]`)) node(`[${match[1]}]`);
    for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
      const attribute = match[1].match(/\b(data-[a-z-]+)(?:="([^"]*)")?/);
      if (!attribute) continue;
      const fields = {};
      for (const input of match[2].matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
        const name = input[2].match(/\bname="([^"]*)"/)?.[1];
        if (!name) continue;
        const content = match[2].slice(input.index + input[0].length).split('</select>')[0];
        const value = input[1] === 'select' ? content.match(/value="([^"]*)"/)?.[1] || '' : input[2].match(/\bvalue="([^"]*)"/)?.[1] || '';
        fields[name] = {name, value, defaultValue:value, checked:false, disabled:false, addEventListener(){}, dispatchEvent(){}, querySelector(){return null;}, selectedOptions:[{dataset:{method:'cash'}}]};
      }
      fields[Symbol.iterator] = function* () { yield* Object.values(fields); };
      const buttons = [{disabled:false}];
      const form = node(`[${attribute[1]}]`, {elements:fields, querySelectorAll:() => buttons, reset(){ for (const field of Object.values(fields)) { field.value = field.defaultValue; field.checked = false; } }});
      if (attribute[2]) form.dataset[attribute[1].slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = attribute[2];
    }
    const finance = this.nodes.get('[data-finance-panel]');
    if (finance) { finance.querySelector = selector => this.querySelector(selector); finance.querySelectorAll = selector => this.querySelectorAll(selector); }
  }
  get innerHTML() { return this.html; }
  querySelector(selector) { return this.nodes.get(selector) || null; }
  querySelectorAll(selector) {
    if (selector === '[data-finance-void]') { const form = this.nodes.get(selector); return form ? [form] : []; }
    if (selector === '[data-finance-confirm]') return [];
    return [];
  }
}

function fixture(t, {intercept = async () => null, role = 'owner', source = 'manual', invoices = [], accountPatch = {}, ledgerPatch = {}, onChange = () => {}} = {}) {
  const prior = globalThis.fetch, requests = [], container = new Container();
  t.after(() => { globalThis.fetch = prior; });
  const account = (scope, id) => ({scope, id, balance:{rawTotalCents:10910, creditCents:0, effectiveTotalCents:10910, netPaidCents:0, dueCents:10910, pendingCents:0, refundDueCents:0}, invoices:scope === 'repair' ? invoices : [{id, number:`PART-${id}`, issued_at:'2026-10-26'}], credits:[], returns:[], stockSales:[], canAuthorize:role === 'owner', ...accountPatch});
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({url, options, method, body});
    const custom = await intercept(url, options, body);
    if (custom) return custom;
    let data;
    const id = Number(url.match(/\/(\d+)(?:\/[^/]+)?$/)?.[1]);
    if (method === 'POST') data = {number:'INV-RESULT', link:'https://invoice.example.test/current', deliveryStatus:'not_requested', id:91};
    else if (url === '/api/me') data = {user:{role}};
    else if (/^\/api\/work-orders\//.test(url)) data = {workOrder:{id, source, revision:id + 4, customer_name:`Customer ${id}`, ref_number:`REPAIR-${id}`, email:`customer${id}@example.test`}};
    else if (/^\/api\/shop\/retail-orders\//.test(url)) data = {order:{id, revision:id + 10, invoice_number:`PART-${id}`, invoice_issued_at:'2026-10-26', customer_name:`Retail ${id}`, payments:[], financialEvents:[], paymentTotals:{total:10910, originalTotal:10910, due:10910}, canRefund:role === 'owner', canVoid:role === 'owner'}};
    else if (/^\/api\/accounting\/accounts\//.test(url)) data = account(url.includes('/retail/') ? 'retail' : 'repair', id);
    else if (url.endsWith('/payments')) data = {payments:[], financialEvents:[], totals:{}, canRefund:role === 'owner', canVoid:role === 'owner', ...ledgerPatch};
    else if (url.endsWith('/invoices')) data = {invoices};
    else throw Error('Unmocked request ' + url);
    return {ok:true, json:async () => data};
  };
  return {container, requests, mount:(scope = 'repair', id = 1) => mountAccountWorkspace(container, {scope, id, user:{role}, onChange}), submit:selector => container.querySelector(selector).onsubmit({preventDefault(){}})};
}

test('late account loads cannot replace the newest job or restore old forms', async t => {
  const wait = deferred();
  const f = fixture(t, {intercept:async url => { if (url === '/api/work-orders/1') await wait.promise; }});
  const first = f.mount('repair', 1); await tick();
  const second = f.mount('repair', 2); await second.ready;
  assert.match(f.container.innerHTML, /REPAIR-2/);
  wait.resolve(); await first.ready;
  assert.match(f.container.innerHTML, /data-account-id="2"/);
  assert.doesNotMatch(f.container.innerHTML, /REPAIR-1/);
  assert.equal(f.requests.some(request => request.url === '/api/accounting/accounts/repair/1'), false);
});

test('a replaced or detached form cannot submit; a late saved payment cannot refresh another account', async t => {
  const wait = deferred(); let changes = 0;
  const f = fixture(t, {onChange:() => changes++, intercept:async (url, options) => { if (url === '/api/pos/work-orders/1/payments' && options.method === 'POST') await wait.promise; }});
  await f.mount().ready;
  const oldInvoice = f.container.querySelector('[data-account-invoice]'), oldPayment = f.container.querySelector('[data-account-payment]');
  oldPayment.elements.amount.value = '15.50'; oldPayment.elements.verified.checked = true;
  const pending = oldPayment.onsubmit({preventDefault(){}});
  await tick();
  await f.mount('retail', 1).ready;
  await oldInvoice.onsubmit({preventDefault(){}});
  wait.resolve(); await pending;
  assert.equal(changes, 0);
  assert.match(f.container.innerHTML, /data-scope="retail"/);
  const posts = f.requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/pos/work-orders/1/payments');
  const currentPayment = f.container.querySelector('[data-account-payment]');
  f.container.isConnected = false;
  await currentPayment.onsubmit({preventDefault(){}});
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
});

test('invoice retries retain reviewed revision and key; changed details get a fresh key', async t => {
  const f = fixture(t, {invoices:[{id:4, number:'INV-OLD', amount_cents:10910, issued_at:'2026-10-25'}], intercept:async (_url, options) => { if (options.method === 'POST') throw Error('Response lost'); }});
  await f.mount().ready;
  const form = f.container.querySelector('[data-account-invoice]');
  form.elements.email.value = 'reviewed@example.test';
  rememberEditRevisions({workOrder:{id:1, revision:44}});
  await f.submit('[data-account-invoice]');
  await f.submit('[data-account-invoice]');
  form.elements.email.value = 'changed@example.test';
  await f.submit('[data-account-invoice]');
  const posts = f.requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, 3);
  assert.equal(posts[0].body.idempotencyKey, posts[1].body.idempotencyKey);
  assert.notEqual(posts[1].body.idempotencyKey, posts[2].body.idempotencyKey);
  for (const request of posts) {
    assert.equal(request.body.expectedRevision, 5);
    assert.equal(request.options.headers['if-match'], '"work_orders:1:5"');
    assert.equal(request.body.documentKind, 'revised_invoice');
    assert.equal(request.body.supersedesInvoiceId, 4);
  }
});

test('in-flight invoice is serialized and successful payment announces clean form before refresh', async t => {
  const wait = deferred(); let changes = 0;
  const f = fixture(t, {onChange:() => changes++, intercept:async (url, options) => { if (url.endsWith('/invoices') && options.method === 'POST') await wait.promise; }});
  await f.mount().ready;
  const form = f.container.querySelector('[data-account-invoice]');
  const first = f.submit('[data-account-invoice]');
  await f.submit('[data-account-invoice]');
  assert.equal(form.dataset.busy, 'true');
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  wait.resolve(); await first;
  const payment = f.container.querySelector('[data-account-payment]');
  payment.elements.amount.value = '20.25'; payment.elements.verified.checked = true;
  await f.submit('[data-account-payment]');
  assert.equal(changes, 2);
  const event = f.container.events.find(event => event.target === payment && event.type === 'workspace:saved');
  assert.equal(event.amount, '20.25');
  assert.equal(payment.elements.amount.value, '');
  assert.equal(f.requests.filter(request => request.method === 'POST').at(-1).body.amount, '20.25');
});

test('unrelated financial drafts survive a successful save and remain marked as unsaved', async t => {
  const f = fixture(t, {invoices:[{id:4, number:'INV-OLD', issued_at:'2026-10-25'}]});
  await f.mount().ready;
  const credit = f.container.querySelector('[data-account-credit]');
  credit.elements.subtotal.value = '9.50'; credit.elements.reason.value = 'A draft credit reason';
  const payment = f.container.querySelector('[data-account-payment]');
  payment.elements.amount.value = '20.00'; payment.elements.verified.checked = true;
  await f.submit('[data-account-payment]');
  const restored = f.container.querySelector('[data-account-credit]');
  assert.notEqual(restored, credit);
  assert.equal(restored.elements.subtotal.value, '9.50');
  assert.equal(restored.elements.reason.value, 'A draft credit reason');
  assert.ok(f.container.events.some(event => event.type === 'workspace:restored' && event.target === restored));
  assert.equal(f.container.querySelector('[data-account-payment]').elements.amount.value, '');
});

test('refresh and another financial action stay blocked while a payment response is pending', async t => {
  const wait = deferred();
  const f = fixture(t, {intercept:async (url, options) => { if (url.endsWith('/payments') && options.method === 'POST') await wait.promise; }});
  const workspace = f.mount(); await workspace.ready;
  const form = f.container.querySelector('[data-account-payment]');
  form.elements.amount.value = '7.25'; form.elements.verified.checked = true;
  const request = f.submit('[data-account-payment]');
  await workspace.refresh();
  await f.submit('[data-account-invoice]');
  assert.equal(f.container.querySelector('[data-account-payment]'), form);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  wait.resolve(); await request;
});

test('credit retries keep the original scoped key and changed amounts get a different key', async t => {
  const f = fixture(t, {invoices:[{id:4, number:'INV-OLD', issued_at:'2026-10-25'}], intercept:async (_url, options) => { if (options.method === 'POST') throw Error('Lost credit response'); }});
  await f.mount('repair', 8).ready;
  const credit = f.container.querySelector('[data-account-credit]');
  credit.elements.subtotal.value = '10.15'; credit.elements.tax.value = '0.92'; credit.elements.reason.value = 'Returned unused part';
  await f.submit('[data-account-credit]');
  await f.submit('[data-account-credit]');
  credit.elements.subtotal.value = '11.15';
  await f.submit('[data-account-credit]');
  const posts = f.requests.filter(request => request.method === 'POST');
  assert.equal(posts[0].url, '/api/accounting/accounts/repair/8/credits');
  assert.equal(posts[0].body.subtotalCents, 1015);
  assert.equal(posts[0].body.taxCents, 92);
  assert.equal(posts[0].body.idempotencyKey, posts[1].body.idempotencyKey);
  assert.notEqual(posts[1].body.idempotencyKey, posts[2].body.idempotencyKey);
});

test('a retained refund form cannot record against the previous account after switching', async t => {
  const f = fixture(t, {ledgerPatch:{payments:[{id:12, method:'cash', direction:'payment', status:'confirmed', amount_cents:5000, refund_remaining_cents:5000}]}});
  await f.mount('repair', 1).ready;
  const refund = f.container.querySelector('[data-finance-refund]');
  assert.ok(refund);
  await f.mount('repair', 2).ready;
  await refund.onsubmit({preventDefault(){}});
  assert.equal(f.requests.some(request => request.method === 'POST'), false);
});

test('retail payment uses its own scope and parts users see read-only permitted financial history', async t => {
  const f = fixture(t);
  await f.mount('retail', 7).ready;
  const payment = f.container.querySelector('[data-account-payment]');
  payment.elements.amount.value = '12.00'; payment.elements.method.value = 'zelle';
  await f.submit('[data-account-payment]');
  const post = f.requests.find(request => request.method === 'POST');
  assert.equal(post.url, '/api/shop/retail-orders/7/payments');
  assert.equal(post.body.status, 'pending');
  assert.equal(f.requests.some(request => request.url.includes('/repair/') || request.url.includes('/work-orders/')), false);
});

test('restricted roles never request inaccessible accounting or render actionable financial forms', async t => {
  const f = fixture(t, {role:'parts'});
  await f.mount('retail', 3).ready;
  assert.match(f.container.innerHTML, /Payment history and controls/);
  assert.doesNotMatch(f.container.innerHTML, /<form\b|data-finance-confirm/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/api/shop/retail-orders/3');
  await f.mount('repair', 3).ready;
  assert.match(f.container.innerHTML, /authorized shop staff/);
  assert.equal(f.requests.length, 1);
});

test('imported accounts retain their protected ledger without requesting local finance mutations', async t => {
  const f = fixture(t, {source:'import'});
  await f.mount().ready;
  assert.match(f.container.innerHTML, /migration reconciliation/);
  assert.doesNotMatch(f.container.innerHTML, /<form\b/);
  assert.equal(f.requests.length, 1);
});

test('corrections retain labeled documents and owner permissions, cancellation excludes superseded invoices', () => {
  const account = {canAuthorize:true, invoices:[{id:1, number:'INV-OLD', issued_at:'Yesterday', superseded_by:2}, {id:2, number:'INV-NEW', issued_at:'Today'}], credits:[{id:6, number:'CR-SAFE', invoice_number:'INV-OLD', reason:'<script>bad</script>'}], stockSales:[{id:9, item_sku:'SKU-SAFE', reference_id:'INV-OLD', quantity_delta:-2}], returns:[]};
  const html = accountCorrections({scope:'repair', id:1, account});
  assert.match(html, /<select name="invoiceId"/);
  assert.match(html, /SKU-SAFE/);
  assert.match(html, /\/api\/accounting\/credits\/6\/document/);
  assert.doesNotMatch(html, /<script>/);
  const cancellation = html.match(/<form[^>]*data-account-void>([\s\S]*?)<\/form>/)[1];
  assert.doesNotMatch(cancellation, /INV-OLD/);
  assert.match(cancellation, /INV-NEW/);
  const ordinary = accountCorrections({scope:'repair', id:1, account:{...account, canAuthorize:false}});
  assert.doesNotMatch(ordinary, /<form\b/);
  assert.match(ordinary, /CR-SAFE/);
  const output = renderAccountWorkspace({scope:'repair', id:1, record:{id:1}, account, ledger:{payments:[]}, invoices:account.invoices, user:{role:'advisor'}});
  assert.match(output, /\/api\/billing\/invoices\/1\/document/);
  assert.match(output, /\/api\/receipts\/repair\/1/);
  assert.doesNotMatch(output, /<form[^>]*data-account-credit|<form[^>]*data-account-return/);
});

test('cancelled retail accounts retain cancellation evidence and hide unavailable receipts and payment entry', () => {
  const html = renderAccountWorkspace({scope:'retail', id:1, record:{invoice_issued_at:'Yesterday', invoice_voided_at:'Today', invoice_number:'PART-CANCELLED'}, account:{balance:{}, invoices:[], credits:[], returns:[]}, ledger:{payments:[], canRefund:true}, user:{role:'owner'}});
  assert.match(html, /Cancelled — retained document/);
  assert.doesNotMatch(html, /data-account-payment|href="\/api\/receipts\/retail/);
});

test('physical returns offer only unreturned stock from the selected credit invoice', () => {
  const account = {canAuthorize:true, invoices:[], credits:[{id:1, number:'CR-OLD', invoice_number:'INV-OLD'}, {id:2, number:'CR-NEW', invoice_number:'INV-NEW'}], stockSales:[{id:9, reference_id:'INV-OLD', item_sku:'OLD-SKU', quantity_delta:-4}, {id:10, reference_id:'INV-NEW', item_sku:'NEW-SKU', quantity_delta:-2}, {id:11, reference_id:'INV-OLD', item_sku:'FULLY-RETURNED', quantity_delta:-1}], returns:[{sale_adjustment_id:9, quantity:1}, {sale_adjustment_id:11, quantity:1}]};
  assert.deepEqual(returnableStockSales(account, 1).map(row => [row.id, row.remainingQuantity]), [[9, 3]]);
  assert.deepEqual(returnableStockSales(account, 2).map(row => [row.id, row.remainingQuantity]), [[10, 2]]);
  const html = accountCorrections({scope:'repair', id:1, account});
  const saleSelect = html.match(/<select name="saleAdjustmentId"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.match(saleSelect, /OLD-SKU.*3 remaining to return/);
  assert.doesNotMatch(saleSelect, /NEW-SKU|FULLY-RETURNED/);
});

const accountingSource = fs.readFileSync(new URL('../public/accounting-ui.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
function dailyCloseFixture({intercept = async () => null} = {}) {
  const nodes = new Map(), requests = [];
  class Node {
    constructor(id) { this.id = id; this.elements = {}; this.dataset = {}; this.value = ''; this.checked = false; this.disabled = false; this.textContent = ''; }
    set innerHTML(html) {
      this.html = html;
      if (this.id !== 'day') return;
      nodes.delete('#closeForm');
      if (html.includes('id="closeForm"')) {
        const form = new Node('closeForm');
        for (const [name, value] of Object.entries({cashCounted:'50.25', openingFloat:'0.00', cashPaidOut:'0.00', cardVerified:'-10.00', zelleVerified:'12.75', notes:'Verified close details', verified:'', taxReview:''})) form.elements[name] = {value, checked:['verified', 'taxReview'].includes(name)};
        nodes.set('#closeForm', form);
      }
    }
    get innerHTML() { return this.html; }
    querySelectorAll() { return []; }
    reset() {}
    removeAttribute(name) { delete this[name]; }
  }
  for (const id of ['day', 'account', 'message', 'exportCsv', 'login', 'workspace', 'signOut', 'loginForm', 'selectAccount', 'selectDay']) nodes.set('#' + id, new Node(id));
  nodes.get('#selectAccount').elements = {scope:{value:'repair'}, account:new Node('accountSelect')};
  nodes.get('#selectDay').elements = {date:{value:''}};
  const context = vm.createContext({document:{querySelector:selector => nodes.get(selector) || null}, location:{search:''}, URLSearchParams, Intl, Date, crypto:globalThis.crypto, mountAccountWorkspace(){throw Error('Unexpected account mount');}, fetch:async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({url, method:options.method, body});
    const custom = await intercept(url, options, body);
    if (custom) return custom;
    const data = url === '/api/me' ? {user:{role:'owner', username:'Fictional owner'}} : url === '/api/work-orders' ? {workOrders:[]} : options.method === 'POST' ? {id:1} : {date:new URL(url, 'http://fixture.test').searchParams.get('date'), basis:'Confirmed combined funds', methods:{cash:{receivedCents:5025, refundCents:0, netCents:5025, count:2}}, creditedTaxCents:0, invoiceReview:[], priorCloses:[]};
    return {ok:true, json:async () => data};
  }});
  vm.runInContext(accountingSource, context);
  return {nodes, requests, context, async ready(){for(let i=0;i<5;i++)await tick();}, date(value){const field=nodes.get('#selectDay').elements.date;field.value=value;field.oninput();}, submit(form=nodes.get('#closeForm')){return form.onsubmit({preventDefault(){}});}};
}

test('daily close invalidates old-date forms before a newly selected business day is loaded', async () => {
  const f = dailyCloseFixture(); await f.ready();
  const prior = f.nodes.get('#closeForm'); assert.ok(prior);
  f.date('2026-10-23');
  assert.equal(f.nodes.has('#closeForm'), false);
  assert.equal(f.nodes.get('#exportCsv').href, undefined);
  await f.submit(prior);
  assert.equal(f.requests.some(request => request.method === 'POST'), false);
  await f.context.loadDay();
  assert.match(f.nodes.get('#day').innerHTML, /2026-10-23 · repair and counter sales combined/);
  await f.submit();
  const post = f.requests.find(request => request.method === 'POST');
  assert.equal(post.body.date, '2026-10-23');
  assert.equal(post.body.cardVerifiedCents, -1000);
  assert.equal(post.body.cashCountedCents, 5025);
});

test('a late same-day report cannot replace the latest daily close form', async () => {
  const wait = deferred(); let stalled = false, reads = 0;
  const f = dailyCloseFixture({intercept:async (url, options) => { if (url.includes('/daily-close?') && options.method === 'GET' && stalled && ++reads === 1) await wait.promise; }});
  await f.ready(); stalled = true;
  const first = f.context.loadDay(); await tick();
  await f.context.loadDay(); const currentForm = f.nodes.get('#closeForm');
  wait.resolve(); await first;
  assert.equal(f.nodes.get('#closeForm'), currentForm);
});

test('daily close retry keeps its key and date while changed counts get a fresh key', async () => {
  const f = dailyCloseFixture({intercept:async (_url, options) => { if (options.method === 'POST') throw Error('Lost close response'); }});
  await f.ready();
  await f.submit(); await f.submit();
  f.nodes.get('#closeForm').elements.cashCounted.value = '51.25';
  await f.submit();
  const posts = f.requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, 3);
  assert.equal(posts[0].body.idempotencyKey, posts[1].body.idempotencyKey);
  assert.equal(posts[0].body.date, posts[1].body.date);
  assert.notEqual(posts[1].body.idempotencyKey, posts[2].body.idempotencyKey);
});

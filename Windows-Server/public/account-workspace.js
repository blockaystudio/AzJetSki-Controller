import {prepareRevisionRequest, rememberEditRevisions, editConflictMessage} from './edit-revisions-ui.js';
import {financePanel, bindFinancePanel, bindPaymentForm} from './finance-ui.js';
import {createRequestAttempts, repairInvoiceDetails} from './invoice-ui.js';

const mounts = new WeakMap();
const staffRoles = new Set(['owner', 'manager', 'advisor', 'service_writer']);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const money = value => (Number(value || 0) / 100).toLocaleString('en-US', {style:'currency', currency:'USD'});

async function api(path, method = 'GET', body, record) {
  const options = prepareRevisionRequest(path, {method, credentials:'same-origin', headers:{'content-type':'application/json'}, body:body === undefined ? undefined : JSON.stringify(body)}, {record});
  const response = await fetch(path, options), value = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(editConflictMessage(response, value) || value.error || `HTTP ${response.status}`);
  return rememberEditRevisions(value);
}

function cents(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw Error(`${label}: enter dollars with at most two decimals`);
  const amount = Math.round(Number(raw) * 100);
  if (!Number.isSafeInteger(amount)) throw Error(`${label}: invalid amount`);
  return amount;
}

function invoiceOptions(invoices) {
  return invoices.map(row => `<option value="${Number(row.id)}">${esc(row.number)}${row.superseded_by ? ' · retained earlier invoice' : ''} · ${esc(row.issued_at)}</option>`).join('');
}

export function returnableStockSales(account, creditNoteId) {
  const credit = (account.credits || []).find(row => Number(row.id) === Number(creditNoteId));
  if (!credit) return [];
  return (account.stockSales || []).filter(sale => sale.reference_id === credit.invoice_number).map(sale => ({...sale,
    remainingQuantity:-Number(sale.quantity_delta) - (account.returns || []).filter(row => Number(row.sale_adjustment_id) === Number(sale.id)).reduce((sum, row) => sum + Number(row.quantity), 0)
  })).filter(sale => sale.remainingQuantity > 0);
}

function returnSaleOptions(sales) {
  return sales.map(row => `<option value="${Number(row.id)}">${esc(row.item_sku)} · ${row.remainingQuantity} remaining to return · invoice ${esc(row.reference_id)} · ${esc(row.created_at)}</option>`).join('');
}

export function accountCorrections({scope, id, account}) {
  if (!account) return '<section class="card section"><h3>Credits and returns</h3><p>An owner, manager, advisor or service writer can review retained accounting documents.</p></section>';
  const {invoices = [], credits = [], returns = [], canAuthorize = false} = account;
  const issued = invoices.filter(row => row.issued_at && !row.voided_at);
  const current = issued.filter(row => !row.superseded_by);
  const returnCredits = credits.filter(credit => returnableStockSales(account, credit.id).length);
  return `<section class="card section account-actions"><h3>Credits, cancellations and physical returns</h3>
    ${canAuthorize ? `<div class="accounting-grid">
      ${issued.length ? `<details><summary>Issue a credit note</summary><form class="billing-form" data-account-credit>
        <label>Issued invoice<select name="invoiceId" required>${invoiceOptions(issued)}</select></label>
        <label>Credited charges before tax ($)<input name="subtotal" type="number" inputmode="decimal" min="0" step="0.01" required></label>
        <label>Credited tax ($)<input name="tax" type="number" inputmode="decimal" min="0" step="0.01" value="0.00" required></label>
        <label>Reason<textarea name="reason" minlength="5" maxlength="600" required></textarea></label>
        <p class="muted">Use the original invoice's tax allocation. The account checks remaining charges and tax before retaining the credit. A credit does not send money.</p>
        <button class="btn primary">Issue permanent credit note</button></form></details>` : '<p>No active issued invoice is available to credit.</p>'}
      ${current.length ? `<details><summary>Cancel an unpaid invoice</summary><form class="billing-form" data-account-void>
        <label>Current issued invoice<select name="invoiceId" required>${invoiceOptions(current)}</select></label>
        <label>Reason<textarea name="reason" minlength="5" maxlength="600" required></textarea></label>
        <label class="check"><input name="confirm" type="checkbox" required>I checked payments and supplier activity.</label>
        <p class="muted">Cancellation requires an unpaid account without confirmed payment history, pending funds or supplier progress. Other corrections require a credit note and, where needed, a separately recorded refund.</p>
        <button class="btn">Cancel unpaid invoice</button></form></details>` : ''}
    </div>` : '<p>Owner or manager authorization is required to change invoice charges or record physical returns.</p>'}
    <h3>Retained credit notes</h3><div class="accounting-table"><table><thead><tr><th>Document</th><th>Invoice</th><th>Credit</th><th>Tax</th><th>Reason</th><th>Authorized</th></tr></thead><tbody>
      ${credits.map(row => `<tr><td><a href="/api/accounting/credits/${Number(row.id)}/document" target="_blank" rel="noopener">${esc(row.number)}</a><br>${esc(row.kind)}</td><td>${esc(row.invoice_number)}</td><td>${money(row.total_cents)}</td><td>${money(row.tax_cents)}</td><td>${esc(row.reason)}</td><td>${esc(row.actor_username)} (${esc(row.actor_role)})<br>${esc(row.created_at)}</td></tr>`).join('') || '<tr><td colspan="6">No credits.</td></tr>'}
    </tbody></table></div>
    ${canAuthorize && returnCredits.length ? `<details><summary>Receive a customer part return</summary><form class="billing-form" data-account-return>
      <label>Credit note<select name="creditNoteId" required>${returnCredits.map(row => `<option value="${Number(row.id)}">${esc(row.number)} · ${esc(row.invoice_number)}</option>`).join('')}</select></label>
      <label>Original recorded stock sale<select name="saleAdjustmentId" required>${returnSaleOptions(returnableStockSales(account, returnCredits[0].id))}</select></label>
      <label>Quantity received<input name="quantity" type="number" inputmode="numeric" min="1" step="1" required></label>
      <label>Condition<select name="disposition"><option value="resellable">Resellable — add to on-hand</option><option value="damaged">Damaged — do not add sellable stock</option></select></label>
      <label>Receiving notes<textarea name="reason" minlength="5" maxlength="600" required></textarea></label>
      <label class="check"><input name="received" type="checkbox" required>I physically received these parts.</label>
      <button class="btn primary">Record received return</button></form></details>` : ''}
    <h3>Physical returns</h3>${returns.map(row => `<p>${esc(row.sku)} · ${Number(row.quantity)} · ${esc(row.disposition)} · ${esc(row.reason)} · ${esc(row.actor_username)} · ${esc(row.created_at)}</p>`).join('') || '<p>No physical returns recorded.</p>'}
  </section>`;
}

function documents({scope, id, record, invoices, canRecord}) {
  if (scope === 'retail') return `<section class="card section account-documents"><h3>Retail invoice</h3>
    ${record.invoice_issued_at ? `<p><strong>${esc(record.invoice_number)}</strong> · ${record.invoice_voided_at ? 'Cancelled — retained document' : 'Issued and locked'} · ${esc(record.invoice_issued_at)}</p>${record.invoice_voided_at ? '<p>The original invoice is retained with its cancellation credit note below.</p>' : `<p><a class="btn" href="/api/receipts/retail/${id}" target="_blank" rel="noopener">Open issued retail invoice and receipt</a></p><p class="muted">The receipt includes the original itemized invoice and the current account totals. Corrections remain in retained credit notes below.</p>`}` : `<p>Review the priced items before issuing this invoice. Issuing locks the original invoice details.</p>${canRecord ? '<form data-account-invoice class="billing-form"><button class="btn primary">Issue retail invoice</button></form>' : ''}`}
  </section>`;
  const latest = [...invoices].sort((a, b) => Number(b.id) - Number(a.id))[0];
  const number = invoiceId => invoices.find(row => Number(row.id) === Number(invoiceId))?.number || 'a previous invoice';
  return `<section class="card section account-documents"><h3>Customer invoice</h3>
    <p>${latest ? `A revised invoice replaces ${esc(latest.number)} with the full current account balance. Earlier documents remain in history; the revision adds no new debt.` : 'The invoice records this work order’s current account balance. Verified payments reduce the same account.'}</p>
    ${canRecord ? `<form data-account-invoice class="billing-form"><label>Recipient email<input name="email" type="email" value="${esc(record.email)}"></label><label class="check"><input name="sendEmail" type="checkbox">Send invoice directly using the configured email provider</label><button class="btn primary">${latest ? 'Issue revised invoice' : 'Issue invoice'}</button></form>` : ''}
    <div data-account-invoice-result role="status"></div><h3>Retained invoices</h3>
    ${invoices.map(row => `<div class="status-line"><a href="/api/billing/invoices/${Number(row.id)}/document" target="_blank" rel="noopener">${esc(row.number)}</a> · ${money(row.amount_cents)} balance at issue<br><small>${row.voided_at ? 'Cancelled — retained document' : row.superseded_by ? 'Historical — replaced' : row.document_kind === 'revised_invoice' ? 'Current revised invoice' : 'Current invoice'}${row.supersedes_invoice_id ? ` · replaces ${esc(number(row.supersedes_invoice_id))}` : ''} · ${esc(row.recipient_email)} · ${esc(row.issued_at)}</small></div>`).join('') || '<p>No issued invoices.</p>'}
  </section>`;
}

export function renderAccountWorkspace({scope, id, record, account, ledger, invoices = [], user}) {
  const canRecord = staffRoles.has(user?.role);
  const canAuthorize = ['owner', 'manager'].includes(user?.role);
  const t = ledger.totals || record.paymentTotals || {};
  const balance = account?.balance || {rawTotalCents:t.originalTotal, creditCents:t.credits, effectiveTotalCents:t.total, netPaidCents:t.paid, dueCents:t.due, pendingCents:t.pending, refundDueCents:t.refundDue};
  const canTransact = canRecord && !(scope === 'retail' && record.invoice_voided_at);
  const canPay = canTransact && !balance.refundDueCents && (scope === 'repair' || Boolean(record.invoice_issued_at));
  return `<div class="account-workspace" data-account-workspace data-scope="${scope}" data-account-id="${id}">
    <section class="card section account-summary"><div class="actions"><h3>${scope === 'repair' ? `WO ${esc(record.ref_number || id)}` : esc(record.invoice_number)} · ${esc(record.customer_name)}</h3><button type="button" class="btn" data-account-refresh>Refresh account</button></div>
      <div class="accounting-totals">${[['Original account charge', balance.rawTotalCents], ['Credits', balance.creditCents], ['Adjusted charge', balance.effectiveTotalCents], ['Net confirmed funds', balance.netPaidCents], ['Still due', balance.dueCents], ['Pending Zelle', balance.pendingCents], ['Refund due', balance.refundDueCents]].map(([label, amount]) => `<div class="accounting-total"><span>${label}</span><strong>${money(amount)}</strong></div>`).join('')}</div>
      ${balance.refundDueCents ? '<p class="accounting-warning">Refund owed to the customer. An owner or manager must return the money externally and record the refund against its original payment below.</p>' : ''}
      ${scope === 'repair' || record.invoice_issued_at && !record.invoice_voided_at ? `<p><a class="btn" href="/api/receipts/${scope}/${id}" target="_blank" rel="noopener">Print current account receipt</a></p>` : ''}
      <p role="status" aria-live="polite" data-account-message></p>
    </section>
    ${documents({scope, id, record, invoices, canRecord})}
    ${canPay ? `<section class="card section"><h3>Record payment</h3><p class="muted">Record card payments after terminal approval and cash after counting it. Unverified Zelle remains pending until verified with the bank.</p><form class="billing-form" data-account-payment>
      <label>Method<select name="method"><option value="cash">Cash</option><option value="card_dejavoo">Dejavoo P1 — approved externally</option><option value="zelle">Zelle</option></select></label>
      <label>Amount ($)<input name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required></label>
      <label>Transaction / bank reference<input name="reference" maxlength="130"></label>
      <label class="check"><input name="verified" type="checkbox">Funds verified / card approved / cash counted</label><button class="btn primary">Record payment portion</button></form></section>` : ''}
    ${financePanel({kind:scope, id, ...ledger, canRecord:canTransact, canRefund:canTransact && canAuthorize && ledger.canRefund === true, canVoid:canTransact && canAuthorize && ledger.canVoid === true, showReceipt:false, receiptElsewhere:true})}
    ${accountCorrections({scope, id, account:account ? {...account, canAuthorize:canAuthorize && account.canAuthorize === true} : null})}
  </div>`;
}

// Every mount owns one immutable account. Replacing a mount invalidates its
// pending reads, form handlers and callbacks, even when account IDs coincide.
export function mountAccountWorkspace(container, {scope, id, user, onChange = () => {}, onError = () => {}} = {}) {
  if (!container || !['repair', 'retail'].includes(scope) || !Number.isSafeInteger(Number(id)) || Number(id) < 1) throw Error('Choose a valid repair or retail account.');
  id = Number(id);
  mounts.get(container)?.destroy();
  let destroyed = false, generation = 0, notice = '', lastInvoice = null, busy = false;
  let drafts = new Map();
  const formBaselines = new WeakMap();
  const attempts = createRequestAttempts();
  const controller = {ready:null, refresh, destroy() { destroyed = true; generation++; if (mounts.get(container) === controller) mounts.delete(container); }};
  mounts.set(container, controller);
  const live = () => !destroyed && mounts.get(container) === controller;
  const message = value => { if (live()) { const node = container.querySelector('[data-account-message]'); if (node) node.textContent = value; } };
  function setBusy(value) {
    busy = value;
    if (!live()) return;
    container.querySelectorAll('button').forEach(button => button.disabled = value);
  }
  const formState = form => Array.from(form.elements).filter(field => field.name).map(field => ({name:field.name, value:field.value, checked:field.checked === true}));
  function accountForms() {
    const forms = new Map();
    for (const name of ['invoice', 'payment', 'credit', 'void', 'return']) {
      const form = container.querySelector(`[data-account-${name}]`);
      if (form) forms.set(name, form);
    }
    const refund = container.querySelector('[data-finance-refund]');
    if (refund) forms.set('refund', refund);
    container.querySelectorAll('[data-finance-void]').forEach(form => forms.set(`pending-void-${form.dataset.financeVoid}`, form));
    return forms;
  }
  function retainDrafts() {
    const forms = accountForms();
    if (!forms.size) return;
    drafts = new Map();
    for (const [name, form] of forms) {
      const values = formState(form);
      if (formBaselines.has(form) && JSON.stringify(values) !== formBaselines.get(form)) drafts.set(name, values);
    }
  }
  function restoreDrafts() {
    const forms = accountForms();
    for (const form of forms.values()) formBaselines.set(form, JSON.stringify(formState(form)));
    for (const [name, values] of drafts) {
      const form = forms.get(name);
      if (!form) continue;
      for (const value of values) {
        const field = form.elements[value.name];
        if (field) {
          field.value = value.value; field.checked = value.checked;
          if (name === 'return' && value.name === 'creditNoteId') field.onchange?.();
        }
      }
      const details = form.closest?.('details');
      if (details) details.open = true;
      form.dispatchEvent(new CustomEvent('workspace:restored', {bubbles:true, detail:{scope, id}}));
    }
  }
  function acknowledge(form, result) {
    if (!live()) return;
    form.dispatchEvent(new CustomEvent('workspace:saved', {bubbles:true, detail:{scope, id, result}}));
  }
  async function changed(result) {
    if (!live()) return;
    notice = 'Saved and refreshed.';
    await refresh({afterSave:true});
    if (live()) await onChange({scope, id, result, hasDrafts:drafts.size > 0});
  }
  async function refresh({afterSave = false} = {}) {
    if (!live()) return null;
    if (busy && !afterSave) { message('Wait for the current financial action to finish before refreshing.'); return null; }
    const epoch = ++generation;
    const current = () => live() && generation === epoch;
    retainDrafts();
    container.innerHTML = '<p role="status">Loading payments and documents…</p>';
    try {
      if (!user) user = (await api('/api/me')).user;
      if (!current()) return null;
      if (!user) throw Error('Sign in to review this account.');
      const canRead = staffRoles.has(user.role) || scope === 'retail' && user.role === 'parts';
      if (!canRead) { container.innerHTML = '<p>Payments and documents are available to authorized shop staff.</p>'; return null; }
      const record = scope === 'repair' ? (await api(`/api/work-orders/${id}`)).workOrder : (await api(`/api/shop/retail-orders/${id}`)).order;
      if (!current()) return null;
      if (Number(record?.id) !== id) throw Error('The loaded account does not match this selection. Refresh and try again.');
      if (scope === 'repair' && record.source !== 'manual') {
        container.innerHTML = '<p class="accounting-warning">This imported account retains its original financial records. Reviewed migration reconciliation is required before local invoices, payments or credits can be recorded.</p>';
        return null;
      }
      const [account, ledger, invoiceData] = await Promise.all([
        staffRoles.has(user.role) ? api(`/api/accounting/accounts/${scope}/${id}`) : null,
        scope === 'repair' ? api(`/api/pos/work-orders/${id}/payments`) : record,
        scope === 'repair' ? api(`/api/pos/work-orders/${id}/invoices`) : {invoices:[]}
      ]);
      if (!current()) return null;
      if (account && (account.scope !== scope || Number(account.id) !== id)) throw Error('The loaded accounting records do not match this selection.');
      const invoices = invoiceData.invoices || [];
      if (account && scope === 'repair') account.invoices = (account.invoices || []).map(row => ({...row, ...invoices.find(invoice => Number(invoice.id) === Number(row.id))}));
      // Permissions reported by the server remain authoritative. Ordinary staff
      // see retained documents; privilege controls also require the session role.
      if (account) account.canAuthorize = account.canAuthorize === true && ['owner', 'manager'].includes(user.role);
      const data = {scope, id, record, account, ledger, invoices, user};
      container.innerHTML = renderAccountWorkspace(data);
      const root = container.querySelector('[data-account-workspace]');
      const active = () => current() && container.querySelector('[data-account-workspace]') === root && root.isConnected !== false;
      const canSubmit = () => active() && !busy;
      message(notice);
      const errorMessage = error => { if (active()) { message(error.message); onError(error); } };
      container.querySelector('[data-account-refresh]').onclick = () => { notice = ''; return refresh(); };
      if (lastInvoice && scope === 'repair') {
        const result = container.querySelector('[data-account-invoice-result]');
        const url = String(lastInvoice.link || '');
        result.innerHTML = `<p><strong>${esc(lastInvoice.number)}</strong> · delivery: ${esc(lastInvoice.deliveryStatus)}</p>${/^https:\/\//.test(url) ? `<p><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open customer invoice</a></p>` : ''}`;
      }
      function bind(selector, action, path, read, {record:reviewedRecord} = {}) {
        const form = container.querySelector(selector);
        if (!form) return;
        form.onsubmit = async event => {
          event.preventDefault();
          if (!canSubmit() || form.dataset.busy) return;
          let saved = false;
          try {
            const payload = attempts.payload(action, path, read(form));
            setBusy(true);
            form.dataset.busy = 'true';
            form.querySelectorAll('button').forEach(button => button.disabled = true);
            const result = await api(path, 'POST', payload, reviewedRecord);
            attempts.clear(action);
            saved = true;
            if (!active()) return;
            acknowledge(form, result);
            form.reset();
            if (action === 'invoice' && scope === 'repair') lastInvoice = result;
            await changed(result);
          } catch (error) {
            if (saved ? live() : active()) { if (saved) notice = `Saved, but refreshing the account failed. ${error.message}`; message(saved ? notice : error.message); onError(error); }
          } finally {
            delete form.dataset.busy;
            if (active()) form.querySelectorAll('button').forEach(button => button.disabled = false);
            setBusy(false);
          }
        };
      }
      bind('[data-account-invoice]', 'invoice', scope === 'repair' ? `/api/pos/work-orders/${id}/invoices` : `/api/shop/retail-orders/${id}/issue-invoice`, form => scope === 'repair' ? repairInvoiceDetails(record, invoices, {email:form.elements.email.value, sendEmail:form.elements.sendEmail.checked}) : {expectedRevision:record.revision}, {record});
      const payment = container.querySelector('[data-account-payment]');
      if (payment) bindPaymentForm(payment, scope === 'repair' ? `/api/pos/work-orders/${id}/payments` : `/api/shop/retail-orders/${id}/payments`, form => ({method:form.elements.method.value, amount:form.elements.amount.value, reference:form.elements.reference.value.trim(), verified:form.elements.verified.checked, status:form.elements.method.value === 'zelle' && !form.elements.verified.checked ? 'pending' : 'confirmed'}), changed, errorMessage, {isCurrent:active, canSubmit, onSaved:acknowledge, onBusy:setBusy});
      bindFinancePanel(container, {kind:scope, id, reload:changed, isCurrent:active, canSubmit, onSaved:acknowledge, onBusy:setBusy});
      const accountPath = `/api/accounting/accounts/${scope}/${id}`;
      bind('[data-account-credit]', 'credit', `${accountPath}/credits`, form => ({invoiceId:Number(form.elements.invoiceId.value), subtotalCents:cents(form.elements.subtotal.value, 'Credit charges'), taxCents:cents(form.elements.tax.value, 'Credit tax'), reason:form.elements.reason.value.trim()}));
      bind('[data-account-void]', 'void', `${accountPath}/void`, form => { if (!form.elements.confirm.checked) throw Error('Check the payment and supplier activity confirmation.'); return {invoiceId:Number(form.elements.invoiceId.value), reason:form.elements.reason.value.trim()}; });
      bind('[data-account-return]', 'return', `${accountPath}/returns`, form => ({creditNoteId:Number(form.elements.creditNoteId.value), saleAdjustmentId:Number(form.elements.saleAdjustmentId.value), quantity:Number(form.elements.quantity.value), disposition:form.elements.disposition.value, received:form.elements.received.checked, reason:form.elements.reason.value.trim()}));
      const returnForm = container.querySelector('[data-account-return]');
      if (returnForm) {
        const setSaleLimit = () => {
          const sale = returnableStockSales(account, returnForm.elements.creditNoteId.value).find(row => Number(row.id) === Number(returnForm.elements.saleAdjustmentId.value));
          returnForm.elements.quantity.max = sale ? String(sale.remainingQuantity) : '';
        };
        const setReturnSales = () => {
          const selected = returnForm.elements.saleAdjustmentId.value;
          const sales = returnableStockSales(account, returnForm.elements.creditNoteId.value);
          returnForm.elements.saleAdjustmentId.innerHTML = returnSaleOptions(sales);
          if (sales.some(row => Number(row.id) === Number(selected))) returnForm.elements.saleAdjustmentId.value = selected;
          setSaleLimit();
        };
        returnForm.elements.creditNoteId.onchange = setReturnSales;
        returnForm.elements.saleAdjustmentId.onchange = setSaleLimit;
        // Restored drafts may select another original invoice, so refresh its
        // labeled stock choices only after restoring the selected credit.
        restoreDrafts();
        setReturnSales();
      } else restoreDrafts();
      setBusy(busy);
      return data;
    } catch (error) {
      if (current()) {
        container.innerHTML = `<p role="alert">${notice ? 'The action was saved. ' : ''}Unable to refresh this account: ${esc(error.message)}</p><button type="button" class="btn" data-account-retry>Refresh account</button>`;
        container.querySelector('[data-account-retry]').onclick = () => refresh();
        onError(error);
      }
      return null;
    }
  }
  controller.ready = refresh();
  return controller;
}

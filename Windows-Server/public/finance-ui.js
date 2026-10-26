const escapeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = cents => (Number(cents || 0) / 100).toLocaleString('en-US', {style:'currency',currency:'USD'});
const requestKeys = new WeakMap();

export function ledgerSummary(payments) {
  return payments.reduce((totals, payment) => {
    if (payment.voided_at) return totals;
    if (payment.status === 'confirmed') totals.net += (payment.direction === 'refund' ? -1 : 1) * payment.amount_cents;
    if (payment.status === 'pending' && payment.method === 'zelle' && payment.direction === 'payment') totals.pending += payment.amount_cents;
    return totals;
  }, {net:0, pending:0});
}

// Keep a key while a form is retried after a lost response. Changed details get a
// new key; double clicks are blocked while the original request is in flight.
export async function postFinancialForm(form, url, payload) {
  const fingerprint = JSON.stringify({url, payload});
  let prior = requestKeys.get(form);
  if (!prior || prior.fingerprint !== fingerprint) {
    prior = {fingerprint, key: crypto.randomUUID()};
    requestKeys.set(form, prior);
  }
  const response = await fetch(url, {
    method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'},
    body:JSON.stringify({...payload, idempotencyKey:prior.key, idempotency_key:prior.key})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export function bindPaymentForm(form, url, readPayload, reload, onError = error => alert(error.message), {isCurrent = () => true, canSubmit = isCurrent, onSaved = () => {}, onBusy = () => {}} = {}) {
  const method = form.elements.method;
  const status = form.elements.status;
  if (method && status) {
    const setStatus = () => {
      const pending = status.querySelector('option[value="pending"]');
      if (pending) pending.disabled = method.value !== 'zelle';
      if (method.value !== 'zelle') status.value = 'confirmed';
    };
    method.addEventListener('change', setStatus);
    setStatus();
  }
  form.onsubmit = async event => {
    event.preventDefault();
    if (form.dataset.busy || !isCurrent() || !canSubmit()) return;
    onBusy(true);
    form.dataset.busy = 'true';
    const buttons = form.querySelectorAll('button');
    buttons.forEach(button => button.disabled = true);
    let saved = false;
    try {
      const result = await postFinancialForm(form, typeof url === 'function' ? url() : url, readPayload(form));
      if (isCurrent()) onSaved(form, result);
      // Acknowledged entries are complete. Clear the fields before refreshing so
      // a refresh failure cannot leave an apparently unsaved payment to repeat.
      form.reset();
      requestKeys.delete(form);
      method?.dispatchEvent(new Event('change'));
      saved = true;
      if (isCurrent()) await reload(result);
    } catch (error) {
      if (isCurrent()) onError(saved ? new Error(`Payment saved, but account refresh failed. Refresh the account before recording another entry. ${error.message}`) : error);
    } finally {
      delete form.dataset.busy;
      buttons.forEach(button => button.disabled = false);
      onBusy(false);
    }
  };
}

export function financePanel({kind, id, payments = [], financialEvents = [], canRefund = false, canVoid = false, canRecord = true, showReceipt = false, receiptElsewhere = false}) {
  const refundable = payments.filter(p => p.direction === 'payment' && p.status === 'confirmed' && !p.voided_at && p.refund_remaining_cents > 0);
  return `<section class="card section ops-card" data-finance-panel>
    <h3>Payment history and controls</h3>
    ${showReceipt ? `<p><a class="btn ops-button ops-secondary" href="/api/receipts/${kind}/${Number(id)}" target="_blank" rel="noopener">Print account receipt</a></p>` : receiptElsewhere ? '' : '<p>An authorized staff member can print this account receipt.</p>'}
    ${payments.map(p => `<div class="status-line ops-row"><div><strong>${escapeText(p.method)} · ${p.direction === 'refund' ? 'Refund −' : ''}${money(p.amount_cents)}</strong> · ${escapeText(p.voided_at ? 'voided' : p.status)}<br>
      <small>${escapeText(p.created_at)} · ${escapeText(p.reference || 'No external reference')}${p.original_payment_id ? ` · Original payment #${Number(p.original_payment_id)}` : ''}${p.reason ? ` · ${escapeText(p.reason)}` : ''}${p.actor_username ? ` · ${escapeText(p.actor_username)} (${escapeText(p.actor_role)})` : ''}</small>
      ${p.voided_at ? `<p>Void reason: ${escapeText(p.void_reason || '')}</p>` : ''}
      ${canRecord && !p.voided_at && p.method === 'zelle' && p.status === 'pending' ? `<button type="button" class="btn ops-button ops-secondary" data-finance-confirm="${Number(p.id)}">Confirm bank deposit</button>${canVoid ? `<form data-finance-void="${Number(p.id)}"><label>Reason for voiding pending entry <input class="ops-input" name="reason" required minlength="5" maxlength="500"></label><button class="btn ops-button ops-secondary">Void pending entry</button></form>` : ''}` : ''}
    </div></div>`).join('') || '<p>No payments recorded.</p>'}
    ${canRefund && refundable.length ? `<form data-finance-refund><h3>Record an externally completed refund</h3>
      <p>Return the funds using the original payment method first. This records the result; it does not send money.</p>
      <label class="field ops-field">Original payment <select class="ops-select" name="originalPaymentId" required>${refundable.map(p => `<option value="${Number(p.id)}" data-method="${escapeText(p.method)}">#${Number(p.id)} · ${escapeText(p.method)} · ${money(p.refund_remaining_cents)} refundable · ${escapeText(p.reference || p.created_at)}</option>`).join('')}</select></label>
      <label class="field ops-field">Refund amount ($) <input class="ops-input" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required></label>
      <label class="field ops-field">Refund transaction reference <input class="ops-input" name="reference" maxlength="130" required></label>
      <label class="field ops-field">Reason <textarea class="ops-textarea" name="reason" minlength="5" maxlength="500" required></textarea></label>
      <label class="field ops-field"><input type="checkbox" name="verified" required> I verified the completed refund.</label>
      <button class="btn primary ops-button">Record refund</button></form>` : '<p>Only owners and managers may record refunds or void pending entries. Confirmed payments remain in the ledger.</p>'}
    <h3>Financial audit history</h3>
    ${financialEvents.map(event => `<div class="status-line"><strong>${escapeText(event.action || event.event_type || event.operation)}</strong> · ${escapeText(event.actor_username)} (${escapeText(event.actor_role)}) · ${escapeText(event.created_at)}${event.reason ? `<p>${escapeText(event.reason)}</p>` : ''}</div>`).join('') || '<p>No new financial audit events. Historical entries retain their original recorded details.</p>'}
    <p role="status" data-finance-message></p>
  </section>`;
}

export function bindFinancePanel(container, {kind, id, reload, isCurrent = () => true, canSubmit = isCurrent, onSaved = () => {}, onBusy = () => {}}) {
  const panel = container.querySelector('[data-finance-panel]');
  if (!panel) return;
  const prefix = kind === 'repair' ? '/api/pos/payments' : '/api/shop/retail-payments';
  const paymentsUrl = kind === 'repair' ? `/api/pos/work-orders/${id}/payments` : `/api/shop/retail-orders/${id}/payments`;
  async function submit(form, url, payload) {
    if (form.dataset.busy || !isCurrent() || !canSubmit()) return;
    onBusy(true);
    form.dataset.busy = 'true';
    const buttons = form.querySelectorAll('button');
    buttons.forEach(button => button.disabled = true);
    const message = panel.querySelector('[data-finance-message]');
    let saved = false;
    try {
      const result = await postFinancialForm(form, url, payload);
      saved = true;
      if (isCurrent()) onSaved(form, result);
      form.reset();
      requestKeys.delete(form);
      if (isCurrent()) {
        message.textContent = 'Saved. Refreshing account…';
        await reload(result);
      }
    } catch (error) {
      if (isCurrent()) message.textContent = saved ? `Saved, but account refresh failed. Refresh before recording another entry. ${error.message}` : error.message;
    } finally {
      delete form.dataset.busy;
      buttons.forEach(button => button.disabled = false);
      onBusy(false);
    }
  }
  panel.querySelectorAll('[data-finance-void]').forEach(form => form.addEventListener('submit', event => {
    event.preventDefault();
    if (!isCurrent() || !canSubmit()) return;
    return submit(form, `${prefix}/${Number(form.dataset.financeVoid)}/void`, {reason:form.elements.reason.value.trim()});
  }));
  const refund = panel.querySelector('[data-finance-refund]');
  if (refund) refund.addEventListener('submit', event => {
    event.preventDefault();
    if (!isCurrent() || !canSubmit()) return;
    const original = refund.elements.originalPaymentId;
    return submit(refund, paymentsUrl, {direction:'refund', status:'confirmed', originalPaymentId:Number(original.value), method:original.selectedOptions[0].dataset.method, amount:refund.elements.amount.value, reference:refund.elements.reference.value.trim(), reason:refund.elements.reason.value.trim(), verified:refund.elements.verified.checked});
  });
  panel.querySelectorAll('[data-finance-confirm]').forEach(button => button.addEventListener('click', async () => {
    if (!isCurrent() || !canSubmit() || button.disabled) return;
    const reference = prompt('Verify the Zelle deposit in your receiving bank, then enter its transaction reference:');
    if (!reference?.trim() || !isCurrent() || !canSubmit()) return;
    onBusy(true);
    button.disabled = true;
    try {
      const response = await fetch(`${prefix}/${Number(button.dataset.financeConfirm)}/confirm`, {method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({verified:true,reference:reference.trim()})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to confirm deposit');
      if (isCurrent()) { onSaved(button, result); await reload(result); }
    } catch (error) {
      if (isCurrent()) panel.querySelector('[data-finance-message]').textContent = error.message;
      button.disabled = false;
    } finally {
      onBusy(false);
    }
  }));
}

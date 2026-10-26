// Authenticated, printable receipts. GET never changes a payment, invoice, or job.
import crypto from 'node:crypto';
import {accountBalance} from './accounting.mjs';

const staffRoles = new Set(['owner', 'manager', 'service_writer', 'advisor', 'parts']);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const money = cents => (Number(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

export function installReceiptSnapshots(db) {
  if (!db.prepare('PRAGMA table_info(retail_special_orders)').all().some(column => column.name === 'receipt_snapshot_json')) {
    db.exec("ALTER TABLE retail_special_orders ADD COLUMN receipt_snapshot_json TEXT NOT NULL DEFAULT ''");
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS retail_receipt_snapshot_immutable
    BEFORE UPDATE OF receipt_snapshot_json ON retail_special_orders
    WHEN OLD.receipt_snapshot_json<>'' AND NEW.receipt_snapshot_json IS NOT OLD.receipt_snapshot_json
    BEGIN SELECT RAISE(ABORT, 'Issued receipt snapshot is immutable'); END;`);
}

export function captureRetailReceiptSnapshot(db, id) {
  const order = db.prepare(`SELECT r.*, c.name customer_name FROM retail_special_orders r
    JOIN customers c ON c.id=r.customer_id WHERE r.id=?`).get(id);
  if (!order?.invoice_issued_at) throw new Error('Issue invoice before capturing a receipt snapshot');
  if (order.receipt_snapshot_json) return JSON.parse(order.receipt_snapshot_json);
  const snapshot = {
    version: 1,
    invoiceNumber: order.invoice_number,
    issuedAt: order.invoice_issued_at,
    customerName: order.customer_name,
    billingAddress: parseObject(order.invoice_address_snapshot_json),
    subtotalCents: order.subtotal_cents,
    taxCents: order.tax_cents,
    totalCents: order.total_cents,
    taxRateBps: order.tax_bps,
    items: db.prepare(`SELECT id, description, requested_sku, vendor_sku, quantity, unit_price_cents, taxable
      FROM retail_special_lines WHERE retail_order_id=? ORDER BY id`).all(id)
  };
  db.prepare("UPDATE retail_special_orders SET receipt_snapshot_json=? WHERE id=? AND receipt_snapshot_json=''")
    .run(JSON.stringify(snapshot), id);
  return snapshot;
}

function parseObject(value) {
  if (!value) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid invoice snapshot');
  return parsed;
}

function cents(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid invoice amount');
  return number;
}

function taxRate(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 2500) throw new Error('Invalid invoice tax rate');
  return number;
}

function ledgerTotals(payments) {
  let received = 0, refunded = 0, pending = 0;
  for (const payment of payments) {
    if (payment.voided_at) continue;
    const amount = cents(payment.amount_cents);
    if (payment.status === 'confirmed') {
      if (payment.direction === 'refund') refunded += amount;
      else received += amount;
    } else if (payment.status === 'pending' && payment.direction === 'payment') pending += amount;
  }
  return { received, refunded, net: received - refunded, pending };
}

function billingLines(address = {}) {
  address ||= {};
  return [address.line1 ?? address.street, address.line2 ?? address.suite,
    [address.city, address.state, address.postalCode ?? address.zip].filter(Boolean).join(' ')].filter(Boolean);
}

function repairReceipt(db, id) {
  const job = db.prepare('SELECT * FROM work_orders WHERE id=?').get(id);
  if (!job) return { status: 404, error: 'Work order not found' };
  const invoice = db.prepare(`SELECT * FROM ot_invoices WHERE work_order_id=? AND voided_at IS NULL
    ORDER BY id DESC LIMIT 1`).get(id);
  if (!invoice) {
    const total = cents(Math.round(Number(job.estimate_total) * 100)), tax = cents(job.tax_total_cents ?? 0);
    if (tax > total) throw new Error('Invalid work order total');
    const customer = job.customer_id ? db.prepare('SELECT * FROM customers WHERE id=?').get(job.customer_id) : null;
    const billing = customer ? Number(customer.billing_same_as_service) === 0 ? {
      line1: customer.billing_address_line1, line2: customer.billing_address_line2,
      city: customer.billing_city, state: customer.billing_state, postalCode: customer.billing_postal_code
    } : {
      line1: customer.address_line1 || customer.address, line2: customer.address_line2,
      city: customer.city, state: customer.state, postalCode: customer.postal_code
    } : {};
    return {
      type: 'Work order account', isRepair: true, hasIssuedInvoice: false,
      invoiceNumber: null, preparedAt: new Date().toISOString(), ref: job.ref_number || `#${job.id}`,
      customerName: customer?.name || job.customer_name || '', unit: job.unit_label,
      address: billingLines(billing), total, tax, subtotal: total - tax,
      taxRateBps: taxRate(job.tax_rate_bps ?? 0), currentTotal: total,
      items: db.prepare(`SELECT description,item_ref,qty,rate,amount FROM work_order_lines
        WHERE work_order_id=? ORDER BY id`).all(id).map(item => ({
        description: item.description, sku: item.item_ref, quantity: item.qty,
        rate: cents(Math.round(Number(item.rate) * 100)), amount: cents(Math.round(Number(item.amount) * 100))
      })),
      payments: db.prepare('SELECT * FROM pos_payments WHERE work_order_id=? ORDER BY id').all(id)
    };
  }
  const snapshot = parseObject(invoice.snapshot_json);
  if (!Array.isArray(snapshot.items)) throw new Error('Invoice items missing from snapshot');
  const total = cents(snapshot.estimateCents), tax = cents(snapshot.taxCents ?? 0);
  const currentTotal = Math.round(Number(job.estimate_total) * 100);
  if (!Number.isSafeInteger(currentTotal) || currentTotal < 0 || tax > total) throw new Error('Invalid invoice total');
  return {
    type: 'Repair work order account', invoiceNumber: invoice.number, issuedAt: invoice.issued_at,
    customerName: invoice.recipient_name, ref: snapshot.refNumber, unit: snapshot.unit,
    address: billingLines(snapshot.addresses?.billing), total, tax, subtotal: total - tax,
    taxRateBps: taxRate(snapshot.taxRateBps ?? 0), currentTotal, isRepair: true,
    creditsAtIssue: cents(snapshot.creditCents ?? 0), effectiveAtIssue: cents(snapshot.effectiveCents ?? total), paidAtIssue: cents(snapshot.paidCents ?? 0), dueAtIssue: cents(snapshot.balanceCents ?? invoice.amount_cents),
    items: snapshot.items.map(item => ({
      description: item.description, sku: item.item_ref, quantity: item.qty,
      rate: cents(Math.round(Number(item.rate) * 100)), amount: cents(Math.round(Number(item.amount) * 100))
    })),
    payments: db.prepare('SELECT * FROM pos_payments WHERE work_order_id=? ORDER BY id').all(id)
  };
}

function retailReceipt(db, id) {
  const order = db.prepare(`SELECT r.*,c.name customer_name FROM retail_special_orders r
    JOIN customers c ON c.id=r.customer_id WHERE r.id=?`).get(id);
  if (!order) return { status: 404, error: 'Retail order not found' };
  if (!order.invoice_issued_at || order.voided_at || order.invoice_voided_at) {
    return { status: 409, error: 'Issue an active retail invoice before printing a receipt' };
  }
  // Older issued orders did not snapshot names or item descriptions. Do not pretend
  // their current values are historical, and do not mutate the order during a GET.
  const legacy = !order.receipt_snapshot_json;
  const snapshot = legacy ? {
    invoiceNumber: order.invoice_number, issuedAt: order.invoice_issued_at,
    customerName: order.customer_name, billingAddress: parseObject(order.invoice_address_snapshot_json),
    subtotalCents: order.subtotal_cents, taxCents: order.tax_cents,
    totalCents: order.total_cents, taxRateBps: order.tax_bps,
    items: db.prepare(`SELECT description,requested_sku,quantity,unit_price_cents,taxable
      FROM retail_special_lines WHERE retail_order_id=? ORDER BY id`).all(id)
  } : parseObject(order.receipt_snapshot_json);
  if (!Array.isArray(snapshot.items)) throw new Error('Invoice items missing from snapshot');
  const total = cents(snapshot.totalCents), tax = cents(snapshot.taxCents), subtotal = cents(snapshot.subtotalCents);
  if (subtotal + tax !== total) throw new Error('Invalid invoice total');
  return {
    type: 'Retail parts', invoiceNumber: snapshot.invoiceNumber, issuedAt: snapshot.issuedAt,
    customerName: snapshot.customerName, address: billingLines(snapshot.billingAddress),
    total, tax, subtotal, taxRateBps: taxRate(snapshot.taxRateBps), legacy,
    currentTotal: cents(order.total_cents),
    items: snapshot.items.map(item => ({ description: item.description, sku: item.requested_sku,
      quantity: item.quantity, rate: cents(item.unit_price_cents),
      amount: cents(item.quantity * item.unit_price_cents) })),
    payments: db.prepare('SELECT * FROM retail_payments WHERE retail_order_id=? ORDER BY id').all(id)
  };
}

function receiptHtml(receipt, { shopName, shopPhone, nonce }) {
  const e = escapeHtml, totals = ledgerTotals(receipt.payments);
  const changed = receipt.currentTotal !== receipt.total;
  const localAccount = receipt.hasIssuedInvoice === false;
  const due = receipt.accounting?.dueCents ?? Math.max(0, receipt.currentTotal - totals.net);
  const credit = receipt.accounting?.creditCents || 0, refundDue = receipt.accounting?.refundDueCents || 0;
  const amountRow = (label, amount, strong = false) => `<tr${strong ? ' class="total"' : ''}><th>${e(label)}</th><td>${e(money(amount))}</td></tr>`;
  const methods = { cash: 'Cash', card_dejavoo: 'Dejavoo card (external)', zelle: 'Zelle' };
  const paymentRows = receipt.payments.map(payment => {
    const status = payment.voided_at ? 'VOID — excluded' : payment.status === 'pending' ? 'Pending — excluded' : 'Confirmed';
    const amount = (payment.direction === 'refund' ? -1 : 1) * payment.amount_cents;
    // Authorization reasons and employee snapshots are internal, not customer receipt text.
    const note = [payment.original_payment_id ? `Original payment #${payment.original_payment_id}` : '',
      payment.voided_at ? `Voided ${payment.voided_at}` : ''].filter(Boolean).join(' · ');
    return `<tr><td>${e(payment.created_at)}<br><small>#${e(payment.id)}</small></td><td>${e(methods[payment.method] || payment.method)}<br>${payment.direction === 'refund' ? 'Refund' : 'Payment'}<br><small>${e(status)}</small></td><td>${e(payment.reference || '—')}<br><small>${e(note)}</small></td><td>${e(money(amount))}</td></tr>`;
  }).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(localAccount ? receipt.ref : receipt.invoiceNumber)} receipt</title>
<style>body{font:15px system-ui,sans-serif;line-height:1.5;color:#17252c;margin:24px}main{max-width:800px;margin:auto}header{border-bottom:2px solid #243c42;margin-bottom:20px}h1{font-size:26px}h2{font-size:19px;margin-top:26px}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{text-align:left;padding:9px;border-bottom:1px solid #ddd;vertical-align:top}td:last-child,th:last-child{text-align:right;white-space:nowrap}.summary th{font-weight:500}.summary .total{font-weight:750;border-top:2px solid #243c42}small{color:#485b63}button{padding:10px 18px;cursor:pointer}.notice{padding:12px;border:1px solid #a26513;background:#fff7e8}.status{font-size:20px;font-weight:750}address{font-style:normal}@media print{body{margin:0;font-size:11pt}button{display:none}tr{break-inside:avoid}h2{break-after:avoid}.notice{background:none}}@media(max-width:500px){body{margin:12px}th,td{padding:6px;font-size:13px}td:last-child,th:last-child{white-space:normal}}</style></head>
<body><main><button type="button" id="print">Print receipt</button><header><h1>${e(shopName)}</h1>${shopPhone ? `<p>${e(shopPhone)}</p>` : ''}<h2>${e(receipt.type)} receipt${localAccount ? '' : ` · ${e(receipt.invoiceNumber)}`}</h2><p>${localAccount ? 'Prepared ' + e(receipt.preparedAt) : 'Issued ' + e(receipt.issuedAt)}</p></header>
<p><strong>${e(receipt.customerName)}</strong>${receipt.ref ? `<br>Work order ${e(receipt.ref)}` : ''}${receipt.unit ? `<br>${e(receipt.unit)}` : ''}</p><address>${receipt.address.map(e).join('<br>')}</address>
${receipt.legacy ? '<p class="notice">Legacy invoice: the customer name and item details below were not snapshotted when this invoice was issued. The billing address and invoice totals are recorded values. Review the original invoice if historical details are needed.</p>' : ''}
${localAccount ? '<p class="notice">This is a current work order account receipt, not an issued tax invoice. There is no active issued customer invoice attached to this statement. Customer details, item descriptions and amounts below are current work order records.</p>' : ''}
${changed ? '<p class="notice"><strong>The current order total differs from this issued invoice.</strong> Current account activity and balance appear separately from the historical invoice below. Review the current order and any supplemental invoice before releasing a vehicle or parts.</p>' : ''}
<h2>${receipt.isRepair ? 'Current work order account' : 'Current retail invoice account'}</h2><p class="status">${refundDue ? 'Customer refund due' : due ? 'Payment pending' : receipt.isRepair ? 'Work order account paid' : 'Retail invoice paid'}</p>
<table class="summary"><tbody>${amountRow(receipt.isRepair ? 'Current work order total' : 'Retail invoice total', receipt.currentTotal, true)}${credit?amountRow('Retained invoice credits',-credit)+amountRow('Adjusted account charge',receipt.currentTotal-credit,true):''}${amountRow('Confirmed receipts / deposits', totals.received)}${amountRow('Confirmed refunds', -totals.refunded)}${amountRow('Net confirmed payments', totals.net)}${amountRow('Pending payments — not credited', totals.pending)}${refundDue?amountRow('Refund due to customer',refundDue,true):''}${amountRow(receipt.isRepair ? 'Current work order balance' : 'Retail invoice balance', due, true)}</tbody></table>
<p><small>Deposits are included in confirmed payments above; they are not added twice. Pending or voided entries do not reduce the balance. Card and bank references record funds verified by shop staff; this receipt does not certify processor settlement or execute a charge or refund.</small></p>
${localAccount ? '<h2>Current work order detail</h2>' : `<h2>Invoice at issue · ${e(receipt.invoiceNumber)}</h2><p>Historical invoice issued ${e(receipt.issuedAt)}. The itemized amounts in this section are the issued snapshot${receipt.legacy ? ' where available; see the legacy notice above' : ''}.</p>`}<table><thead><tr><th>Item</th><th>Quantity</th><th>Unit price</th><th>Amount</th></tr></thead><tbody>${receipt.items.map(item => `<tr><td>${e(item.description)}${item.sku ? `<br><small>${e(item.sku)}</small>` : ''}</td><td>${e(item.quantity)}</td><td>${e(money(item.rate))}</td><td>${e(money(item.amount))}</td></tr>`).join('')}</tbody></table>
<table class="summary"><tbody>${amountRow(localAccount ? 'Current subtotal' : 'Invoice subtotal at issue', receipt.subtotal)}${amountRow(`${localAccount ? 'Current sales tax' : 'Invoice sales tax'} (${(Number(receipt.taxRateBps) / 100).toFixed(2)}%)`, receipt.tax)}${amountRow(localAccount ? 'Current work order total' : 'Invoice total at issue', receipt.total, true)}${receipt.isRepair && !localAccount ? (receipt.creditsAtIssue?amountRow('Retained credits at issue', -receipt.creditsAtIssue)+amountRow('Adjusted invoice charge at issue',receipt.effectiveAtIssue):'')+amountRow('Confirmed payments at issue', receipt.paidAtIssue) + amountRow('Invoice balance at issue', receipt.dueAtIssue) : ''}</tbody></table>
<h2>${receipt.isRepair ? 'Work order' : 'Retail invoice'} payment history</h2><table><thead><tr><th>Date / ID</th><th>Method / status</th><th>Reference</th><th>Amount</th></tr></thead><tbody>${paymentRows || '<tr><td colspan="4">No payments recorded.</td></tr>'}</tbody></table><p><small>Payment status does not by itself authorize vehicle or parts release.</small></p><p>Thank you.</p></main>
<script nonce="${nonce}">document.getElementById('print').addEventListener('click',()=>window.print());</script></body></html>`;
}

export function receiptRoutes({ db, currentUser, json, shopName = 'Owner Tracker', shopPhone = '' }) {
  return async function handleReceipt(req, res, pathname) {
    const match = pathname.match(/^\/api\/receipts\/(repair|retail)\/(\d+)$/);
    if (!match) return false;
    const error = (status, message) => {
      json(res, status, { error: message }, { 'cache-control': 'no-store' });
      return true;
    };
    const user = currentUser(req);
    if (!user) return error(401, 'Login required');
    if (!staffRoles.has(user.role)) return error(403, 'Staff receipt permission required');
    if (req.method !== 'GET') return error(405, 'Receipt views support GET only');
    const id = Number(match[2]);
    if (!Number.isSafeInteger(id) || id < 1) return error(404, 'Order not found');
    try {
      if (!hasTable(db, match[1] === 'repair' ? 'ot_invoices' : 'retail_special_orders')) return error(409, 'Invoice records are not available');
      const receipt = match[1] === 'repair' ? repairReceipt(db, id) : retailReceipt(db, id);
      if (receipt.error) return error(receipt.status, receipt.error);
      receipt.accounting=accountBalance(db,match[1],id,receipt.currentTotal);
      const nonce = crypto.randomBytes(18).toString('base64');
      const html = receiptHtml(receipt, { shopName, shopPhone, nonce });
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`
      });
      res.end(html);
      return true;
    } catch {
      return error(409, 'Receipt snapshot is unavailable or invalid; review the invoice before printing');
    }
  };
}

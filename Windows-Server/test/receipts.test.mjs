import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { receiptRoutes, installReceiptSnapshots, captureRetailReceiptSnapshot } from '../src/receipts.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE work_orders(id INTEGER PRIMARY KEY,estimate_total REAL,ref_number TEXT,
      customer_id INTEGER,customer_name TEXT,unit_label TEXT,tax_total_cents INTEGER,tax_rate_bps INTEGER);
    CREATE TABLE work_order_lines(id INTEGER PRIMARY KEY,work_order_id INTEGER,description TEXT,
      item_ref TEXT,qty REAL,rate REAL,amount REAL);
    CREATE TABLE ot_invoices(id INTEGER PRIMARY KEY,work_order_id INTEGER,number TEXT,issued_at TEXT,
      recipient_name TEXT,snapshot_json TEXT,amount_cents INTEGER,voided_at TEXT);
    CREATE TABLE pos_payments(id INTEGER PRIMARY KEY,work_order_id INTEGER,method TEXT,direction TEXT,
      amount_cents INTEGER,reference TEXT,status TEXT,created_at TEXT,voided_at TEXT,void_reason TEXT,
      reason TEXT,original_payment_id INTEGER,idempotency_key TEXT);
    CREATE TABLE retail_special_orders(id INTEGER PRIMARY KEY,customer_id INTEGER,invoice_number TEXT,
      invoice_issued_at TEXT,invoice_address_snapshot_json TEXT,tax_bps INTEGER,subtotal_cents INTEGER,
      tax_cents INTEGER,total_cents INTEGER,voided_at TEXT);
    CREATE TABLE retail_special_lines(id INTEGER PRIMARY KEY,retail_order_id INTEGER,description TEXT,
      requested_sku TEXT,quantity INTEGER,unit_price_cents INTEGER,taxable INTEGER,vendor_sku TEXT);
    CREATE TABLE retail_payments(id INTEGER PRIMARY KEY,retail_order_id INTEGER,method TEXT,direction TEXT,
      amount_cents INTEGER,reference TEXT,status TEXT,created_at TEXT,voided_at TEXT,reason TEXT,
      void_reason TEXT,original_payment_id INTEGER,idempotency_key TEXT);
    INSERT INTO customers VALUES(1,'Original Customer');
    INSERT INTO work_orders VALUES(1,100,'WO-LOCAL',1,'Original Customer','Yamaha',0,0);
    INSERT INTO work_order_lines VALUES(1,1,'Current local repair','LABOR',1,100,100);
    INSERT INTO retail_special_orders VALUES(1,1,'PART-TEST','2026-10-25 10:00:00',
      '{"street":"100 Original Way","city":"Phoenix","state":"AZ","zip":"85001"}',910,10000,910,10910,NULL);
    INSERT INTO retail_special_lines VALUES(1,1,'Original drive belt','BELT-1',1,10000,1,'VENDOR-BELT-1');`);
  installReceiptSnapshots(db);
  const snapshot = {
    refNumber: 'WO-ORIGINAL', unit: '2024 Yamaha', estimateCents: 10000,
    paidCents: 2500, balanceCents: 7500, taxCents: 0, taxRateBps: 0,
    addresses: { billing: { line1: '100 Original Way', city: 'Phoenix', state: 'AZ', postalCode: '85001' } },
    items: [{ description: 'Original repair scope', item_ref: 'LABOR', qty: 1, rate: 100, amount: 100 }]
  };
  db.prepare('INSERT INTO ot_invoices VALUES(1,1,?,?,?,?,?,NULL)').run(
    'INV-ORIGINAL', '2026-10-25 10:00:00', 'Original Customer', JSON.stringify(snapshot), 7500);
  const route = receiptRoutes({ db, currentUser: req => req.user, shopName: 'Test Shop', shopPhone: '555-0000',
    json(res, status, value, headers) { res.writeHead(status, headers); res.end(JSON.stringify(value)); } });
  async function request(path = '/api/receipts/repair/1', role = 'owner', method = 'GET') {
    const result = { status: null, headers: {}, body: '' };
    const response = { writeHead(status, headers) { result.status = status; result.headers = headers || {}; },
      end(body) { result.body = String(body); } };
    result.handled = await route({ method, user: role ? { id: 1, username: 'owner', role } : null }, response, path);
    return result;
  }
  return { db, request };
}

test('receipt routes enforce staff permissions without disclosing invoice existence', async t => {
  const { db, request } = fixture(); t.after(() => db.close());
  assert.equal((await request('/api/receipts/repair/999', null)).status, 401);
  for (const role of ['viewer', 'technician']) assert.equal((await request('/api/receipts/repair/1', role)).status, 403);
  for (const role of ['owner', 'manager', 'service_writer', 'advisor', 'parts']) {
    const response = await request('/api/receipts/repair/1', role);
    assert.equal(response.status, 200);
    assert.match(response.headers['cache-control'], /no-store/);
    assert.match(response.headers['content-security-policy'], /default-src 'none'/);
  }
  assert.equal((await request('/api/receipts/repair/1', 'owner', 'POST')).status, 405);
  assert.equal((await request('/api/receipts/repair/9007199254740992')).status, 404);
  assert.equal((await request('/api/something-else')).handled, false);
});

test('repair receipt separates issued invoice snapshot from live work order account', async t => {
  const { db, request } = fixture(); t.after(() => db.close());
  db.exec(`UPDATE work_orders SET estimate_total=150;
    INSERT INTO pos_payments VALUES(1,1,'cash','payment',8000,'cash-1','confirmed','2026-10-25',NULL,'','',NULL,'private-key-1');
    INSERT INTO pos_payments VALUES(2,1,'cash','refund',1000,'refund-1','confirmed','2026-10-25',NULL,'','PRIVATE REFUND REASON',1,'private-key-2');
    INSERT INTO pos_payments VALUES(3,1,'zelle','payment',2000,'pending-bank','pending','2026-10-25',NULL,'','',NULL,'private-key-3');
    INSERT INTO pos_payments VALUES(4,1,'zelle','payment',3000,'void-bank','pending','2026-10-25','2026-10-25','PRIVATE VOID REASON','',NULL,'private-key-4');`);
  const before = db.prepare('SELECT total_changes() n').get().n;
  const result = await request();
  assert.equal(result.status, 200);
  assert.match(result.body, /Current work order total<\/th><td>\$150\.00/);
  assert.match(result.body, /Net confirmed payments<\/th><td>\$70\.00/);
  assert.match(result.body, /Current work order balance<\/th><td>\$80\.00/);
  assert.match(result.body, /Invoice total at issue<\/th><td>\$100\.00/);
  assert.match(result.body, /Confirmed payments at issue<\/th><td>\$25\.00/);
  assert.match(result.body, /Invoice balance at issue<\/th><td>\$75\.00/);
  assert.match(result.body, /Pending payments — not credited<\/th><td>\$20\.00/);
  assert.match(result.body, /Original repair scope/);
  assert.match(result.body, /VOID — excluded/);
  assert.match(result.body, /Original payment #1/);
  assert.match(result.body, /-\$10\.00/);
  assert.match(result.body, /current order total differs/);
  assert.ok(result.body.indexOf('Current work order account') < result.body.indexOf('Invoice at issue'));
  assert.doesNotMatch(result.body, /private-key|PRIVATE REFUND REASON|PRIVATE VOID REASON|Paid against this invoice/);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before, 'GET must not change balances or audit rows');
});

test('retail receipts preserve issued customer/address/items and tax after customer changes', async t => {
  const { db, request } = fixture(); t.after(() => db.close());
  captureRetailReceiptSnapshot(db, 1);
  assert.deepEqual(captureRetailReceiptSnapshot(db, 1), JSON.parse(db.prepare('SELECT receipt_snapshot_json FROM retail_special_orders').get().receipt_snapshot_json));
  db.exec(`UPDATE customers SET name='Changed Customer';
    UPDATE retail_special_lines SET description='Changed item';
    INSERT INTO retail_payments VALUES(1,1,'cash','payment',5000,'cash','confirmed','2026-10-25',NULL,'','',NULL,'private-key');`);
  const result = await request('/api/receipts/retail/1');
  assert.equal(result.status, 200);
  assert.match(result.body, /Original Customer/);
  assert.match(result.body, /Original drive belt/);
  assert.match(result.body, /100 Original Way/);
  assert.match(result.body, /Invoice sales tax \(9\.10%\)<\/th><td>\$9\.10/);
  assert.match(result.body, /Retail invoice balance<\/th><td>\$59\.10/);
  assert.doesNotMatch(result.body, /Changed Customer|Changed item|Legacy invoice/);
  assert.throws(() => db.exec("UPDATE retail_special_orders SET receipt_snapshot_json='{}' WHERE id=1"), /immutable/);
});

test('legacy retail receipts disclose snapshot limitations without writing a fake historical snapshot', async t => {
  const { db, request } = fixture(); t.after(() => db.close());
  const before = db.prepare('SELECT total_changes() n').get().n;
  const result = await request('/api/receipts/retail/1');
  assert.equal(result.status, 200);
  assert.match(result.body, /Legacy invoice/);
  assert.equal(db.prepare('SELECT receipt_snapshot_json FROM retail_special_orders').get().receipt_snapshot_json, '');
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
});

test('draft retail, voided retail, missing and corrupt invoices cannot produce a misleading invoice receipt', async t => {
  const { db, request } = fixture(); t.after(() => db.close());
  assert.equal((await request('/api/receipts/repair/999')).status, 404);
  db.exec("UPDATE ot_invoices SET voided_at='2026-10-25'");
  const local = await request();
  assert.equal(local.status, 200);
  assert.match(local.body, /not an issued tax invoice/);
  assert.doesNotMatch(local.body, /INV-ORIGINAL/);
  db.exec("UPDATE ot_invoices SET voided_at=NULL,snapshot_json='not-json'");
  assert.equal((await request()).status, 409);
  db.exec('UPDATE retail_special_orders SET invoice_issued_at=NULL');
  assert.equal((await request('/api/receipts/retail/1')).status, 409);
  db.exec("UPDATE retail_special_orders SET invoice_issued_at='2026-10-25',voided_at='2026-10-25'");
  assert.equal((await request('/api/receipts/retail/1')).status, 409);
});

test('local repair account receipt prints without an issued invoice or HTTPS configuration', async t => {
  const { db, request } = fixture(); t.after(() => db.close());
  db.exec('DELETE FROM ot_invoices');
  db.exec("INSERT INTO pos_payments VALUES(1,1,'cash','payment',2500,'cash-1','confirmed','2026-10-25',NULL,'','',NULL,'private-key')");
  const before = db.prepare('SELECT total_changes() n').get().n;
  const result = await request();
  assert.equal(result.status, 200);
  assert.match(result.body, /Work order account receipt/);
  assert.match(result.body, /not an issued tax invoice/);
  assert.match(result.body, /Current work order detail/);
  assert.match(result.body, /Current local repair/);
  assert.match(result.body, /Current work order balance<\/th><td>\$75\.00/);
  assert.match(result.body, /WO-LOCAL/);
  assert.doesNotMatch(result.body, /INV-|Invoice at issue|Invoice total at issue|Issued undefined/);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
});

test('untrusted receipt fields are escaped and internal credentials never rendered', async t => {
  const { db, request } = fixture(); t.after(() => db.close());
  const payload = '<img src=x onerror=alert(1)>';
  const invoice = db.prepare('SELECT snapshot_json FROM ot_invoices').get();
  const snapshot = JSON.parse(invoice.snapshot_json);
  snapshot.items[0].description = payload;
  snapshot.addresses.billing.line1 = payload;
  db.prepare('UPDATE ot_invoices SET recipient_name=?,snapshot_json=?').run(payload, JSON.stringify(snapshot));
  db.prepare('INSERT INTO pos_payments VALUES(1,1,?,?,100,?,?,?,NULL,?,?,NULL,?)').run(
    'cash', 'payment', payload, 'confirmed', '2026-10-25', '', 'internal secret', 'TOKEN-DO-NOT-PRINT');
  const result = await request();
  assert.equal(result.status, 200);
  assert.match(result.body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(result.body, /<img src=x|internal secret|TOKEN-DO-NOT-PRINT/);
  assert.match(result.body, /id="print"/);
});

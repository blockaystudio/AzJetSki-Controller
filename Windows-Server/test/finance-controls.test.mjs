import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../src/db.mjs';
import { extendDatabase, posRoutes } from '../src/pos-extension.mjs';
import { installShopOps, shopOpsRoutes } from '../src/shop-ops.mjs';
import { installFinancialControls, recordPayment, confirmPayment, voidPayment, financialEvents, paymentRows } from '../src/finance-controls.mjs';

function fixture() {
  const db = openDb(':memory:');
  extendDatabase(db); installShopOps(db);
  const users = {};
  for (const role of ['owner', 'manager', 'advisor', 'service_writer', 'technician', 'parts', 'viewer']) {
    const r = db.prepare('INSERT INTO users(username,password_hash,salt,role) VALUES(?,?,?,?)').run(role, 'not-used', 'not-used', role);
    users[role] = { id: Number(r.lastInsertRowid), username: role, role };
  }
  const customer = Number(db.prepare("INSERT INTO customers(name) VALUES('Finance QA')").run().lastInsertRowid);
  const repair = Number(db.prepare("INSERT INTO work_orders(source,estimate_total,balance) VALUES('manual',200,200)").run().lastInsertRowid);
  const otherRepair = Number(db.prepare("INSERT INTO work_orders(source,estimate_total,balance) VALUES('manual',200,200)").run().lastInsertRowid);
  const retail = Number(db.prepare("INSERT INTO retail_special_orders(customer_id,invoice_number,invoice_issued_at,total_cents) VALUES(?,'PART-QA',CURRENT_TIMESTAMP,20000)").run(customer).lastInsertRowid);
  const ids = { repair, retail };
  const table = scope => scope === 'repair' ? 'pos_payments' : 'retail_payments';
  const totals = scope => () => {
    const parent = scope === 'repair' ? 'work_order_id' : 'retail_order_id';
    return db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='confirmed' THEN CASE WHEN direction='payment' THEN amount_cents ELSE -amount_cents END ELSE 0 END),0) paid,
      COALESCE(SUM(CASE WHEN status='pending' THEN amount_cents ELSE 0 END),0) pending FROM ${table(scope)} WHERE ${parent}=? AND voided_at IS NULL`).get(ids[scope]);
  };
  const pay = (scope, body, user = users.owner) => recordPayment(db, scope, ids[scope], user,
    { method: 'cash', amount: '100', verified: true, idempotencyKey: crypto.randomUUID(), ...body }, totals(scope));
  const refund = (scope, original, body = {}, user = users.owner) => pay(scope,
    { direction: 'refund', amount: '20', reason: 'Returned unused deposit', reference: crypto.randomUUID(), originalPaymentId: original, ...body }, user);
  return { db, users, ids, otherRepair, table, totals, pay, refund };
}
const rejects = (fn, status) => assert.throws(fn, error => error.status === status);

for (const scope of ['repair', 'retail']) {
  test(`${scope}: only owner/manager authorize original-linked refunds with immutable reason/role snapshots`, () => {
    const f = fixture();
    try {
      const original = f.pay(scope, {});
      for (const role of ['advisor', 'service_writer', 'technician', 'parts', 'viewer']) rejects(() => f.refund(scope, original.id, {}, f.users[role]), 403);
      rejects(() => f.refund(scope, original.id, { reason: '' }), 400);
      rejects(() => f.refund(scope, original.id, { originalPaymentId: undefined }), 400);
      const refund = f.refund(scope, original.id, {}, f.users.manager);
      rejects(() => f.refund(scope, refund.id), 409);
      rejects(() => f.refund(scope, original.id, { method: 'card_dejavoo' }), 409);
      rejects(() => f.refund(scope, original.id, { amount: '81' }), 409);
      const row = paymentRows(f.db, scope, f.ids[scope]).find(x => x.id === refund.id);
      assert.equal(row.reason, 'Returned unused deposit'); assert.equal(row.actor_role, 'manager'); assert.equal(row.original_payment_id, original.id);
      f.db.prepare("UPDATE users SET username='renamed',role='viewer' WHERE id=?").run(f.users.manager.id);
      const events = financialEvents(f.db, scope, f.ids[scope]);
      assert.equal(events[1].actor_role, 'manager'); assert.equal(events[1].actor_username, 'manager');
      assert.throws(() => f.db.prepare('UPDATE finance_events SET reason=? WHERE id=?').run('changed', events[1].id), /immutable/);
      assert.throws(() => f.db.prepare('DELETE FROM finance_events WHERE id=?').run(events[1].id), /immutable/);
      assert.throws(() => f.db.prepare(`UPDATE ${f.table(scope)} SET amount_cents=1 WHERE id=?`).run(refund.id), /immutable/);
      assert.throws(() => f.db.prepare(`DELETE FROM ${f.table(scope)} WHERE id=?`).run(original.id), /deleted/);
      assert.equal(paymentRows(f.db, scope, f.ids[scope])[0].refund_remaining_cents, 8000);
    } finally { f.db.close(); }
  });

  test(`${scope}: idempotent replays preserve original payload after confirmation/void and reject changed operations`, () => {
    const f = fixture();
    try {
      const pending = { method: 'zelle', amount: '50', status: 'pending', idempotencyKey: 'pending-replay-key' };
      const p = f.pay(scope, pending);
      confirmPayment(f.db, scope, p.id, f.users.manager, { verified: true, reference: 'BANK-ONE' }, f.totals(scope));
      const recorded = paymentRows(f.db, scope, f.ids[scope])[0];
      assert.equal(recorded.actor_username, 'owner'); assert.equal(recorded.actor_role, 'owner');
      if (scope === 'retail') assert.equal(recorded.recorded_by, f.users.owner.id);
      assert.equal(financialEvents(f.db, scope, f.ids[scope])[1].actor_username, 'manager');
      assert.equal(f.pay(scope, { ...pending, amount: '50.00' }).duplicate, true);
      assert.equal(confirmPayment(f.db, scope, p.id, f.users.manager, { verified: true, reference: 'BANK-ONE' }, f.totals(scope)).alreadyConfirmed, true);
      rejects(() => confirmPayment(f.db, scope, p.id, f.users.manager, { verified: true, reference: 'DIFFERENT-BANK' }, f.totals(scope)), 409);
      rejects(() => f.pay(scope, { ...pending, amount: '51' }), 409);
      const r = f.refund(scope, p.id, { method: 'zelle', idempotencyKey: 'refund-replay-key', reference: 'BANK-REFUND' });
      assert.equal(f.refund(scope, p.id, { method: 'zelle', idempotencyKey: 'refund-replay-key', reference: 'BANK-REFUND' }).duplicate, true);
      rejects(() => f.refund(scope, p.id, { method: 'zelle', idempotencyKey: 'refund-replay-key', reference: 'BANK-REFUND', reason: 'Changed explanation' }), 409);
      const p2 = f.pay(scope, { ...pending, idempotencyKey: 'pending-void-key' });
      rejects(() => voidPayment(f.db, scope, p2.id, f.users.advisor, { reason: 'Never arrived', idempotencyKey: 'void-replay-key' }, f.totals(scope)), 403);
      voidPayment(f.db, scope, p2.id, f.users.manager, { reason: 'Never arrived', idempotencyKey: 'void-replay-key' }, f.totals(scope));
      assert.equal(f.totals(scope)().pending, 0);
      assert.equal(f.pay(scope, { ...pending, idempotencyKey: 'pending-void-key' }).duplicate, true);
      assert.equal(voidPayment(f.db, scope, p2.id, f.users.manager, { reason: 'Never arrived', idempotencyKey: 'void-replay-key' }, f.totals(scope)).duplicate, true);
      rejects(() => voidPayment(f.db, scope, p2.id, f.users.manager, { reason: 'Changed reason', idempotencyKey: 'void-replay-key' }, f.totals(scope)), 409);
      rejects(() => confirmPayment(f.db, scope, p2.id, f.users.owner, { verified: true, reference: 'LATE-BANK' }, f.totals(scope)), 409);
      rejects(() => voidPayment(f.db, scope, p.id, f.users.owner, { reason: 'Confirmed cannot void', idempotencyKey: 'confirmed-void-key' }, f.totals(scope)), 409);
      assert.equal(financialEvents(f.db, scope, f.ids[scope]).length, 5);
      assert.equal(r.totals.paid, 3000);
    } finally { f.db.close(); }
  });

  test(`${scope}: strict money/verification, atomic rollback and repeatable migrations`, () => {
    const f = fixture();
    try {
      for (const amount of [1.001, '1.001', Infinity, -1, 0]) rejects(() => f.pay(scope, { amount }), 400);
      rejects(() => f.pay(scope, { method: 'cash', status: 'pending' }), 400);
      const pending = f.pay(scope, { method: 'zelle', status: 'pending', amount: '10' });
      rejects(() => confirmPayment(f.db, scope, pending.id, f.users.owner, { verified: 'false', reference: 'NOT-VERIFIED' }, f.totals(scope)), 400);
      const beforeEvents = financialEvents(f.db, scope, f.ids[scope]).length;
      assert.throws(() => recordPayment(f.db, scope, f.ids[scope], f.users.owner, { method: 'cash', amount: '25', verified: true, idempotencyKey: 'rollback-key-1' }, () => { throw new Error('Injected balance write failure'); }), /Injected/);
      assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${f.table(scope)}`).get().n, 1);
      assert.equal(financialEvents(f.db, scope, f.ids[scope]).length, beforeEvents);
      assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='Financial payment'").get().n, 1);
      installFinancialControls(f.db, scope); installFinancialControls(f.db, scope);
      assert.equal(financialEvents(f.db, scope, f.ids[scope]).length, beforeEvents);
      assert.equal(f.totals(scope)().pending, 1000);
    } finally { f.db.close(); }
  });
}

test('card/bank references cannot be reused across repair and retail, including refund receipts', () => {
  const f = fixture();
  try {
    const repair = f.pay('repair', { method: 'card_dejavoo', reference: 'CARD-ONE' });
    rejects(() => f.pay('retail', { method: 'card_dejavoo', reference: 'CARD-ONE' }), 409);
    const retail = f.pay('retail', { method: 'card_dejavoo', reference: 'CARD-TWO' });
    f.refund('repair', repair.id, { method: 'card_dejavoo', reference: 'REFUND-ONE' });
    rejects(() => f.refund('retail', retail.id, { method: 'card_dejavoo', reference: 'REFUND-ONE' }), 409);
    rejects(() => recordPayment(f.db, 'repair', f.otherRepair, f.users.owner, { method: 'card_dejavoo', direction: 'refund', amount: '1', verified: true, reference: 'REFUND-CROSS', originalPaymentId: repair.id, reason: 'Wrong order', idempotencyKey: crypto.randomUUID() }, f.totals('repair')), 409);
  } finally { f.db.close(); }
});

test('API permission policy is enforced and new event/refund fields are available to the UI', async () => {
  const f = fixture();
  try {
    let current = f.users.owner;
    const handlers = [posRoutes({ db: f.db, currentUser: () => current, readBody: async req => req.body, json: (res, status, body) => Object.assign(res, { status, body }) }),
      shopOpsRoutes({ db: f.db, currentUser: () => current, readBody: async req => req.body, json: (res, status, body) => Object.assign(res, { status, body }) })];
    async function call(path, method = 'GET', body = {}) {
      const req = { method, body, headers: {} }, res = {}, url = new URL(path, 'http://local.test');
      for (const handle of handlers) if (await handle(req, res, url.pathname, url)) return res;
      throw new Error('No route');
    }
    for (const [scope, uri] of [['repair', `/api/pos/work-orders/${f.ids.repair}/payments`], ['retail', `/api/shop/retail-orders/${f.ids.retail}/payments`]]) {
      const payment = await call(uri, 'POST', { method: 'cash', amount: 20, verified: true, idempotencyKey: crypto.randomUUID() });
      assert.equal(payment.status, 201);
      current = f.users.advisor;
      const denied = await call(uri, 'POST', { method: 'cash', direction: 'refund', amount: 1, reason: 'Unauthorized', originalPaymentId: payment.body.id, reference: 'UNAUTHORIZED', verified: true, idempotencyKey: crypto.randomUUID() });
      assert.equal(denied.status, 403);
      current = f.users.owner;
      const view = await call(scope === 'repair' ? uri : `/api/shop/retail-orders/${f.ids.retail}`);
      const data = scope === 'repair' ? view.body : view.body.order;
      assert.equal(data.canRefund, true); assert.equal(data.financialEvents.length, 1); assert.equal(data.payments[0].refund_remaining_cents, 2000);
    }
  } finally { f.db.close(); }
});

test('legacy migration preserves unknown authorization history and requires unlinked-refund reconciliation', () => {
  const f = fixture();
  try {
    // These are the fields available in the previous release. No historical role
    // is inferred from the user's current mutable role during migration.
    const id = Number(f.db.prepare(`INSERT INTO pos_payments(work_order_id,method,direction,amount_cents,reference,idempotency_key,status,verified_by)
      VALUES(?,'cash','payment',10000,'','legacy-cash-key','confirmed',?)`).run(f.ids.repair, f.users.owner.id).lastInsertRowid);
    f.db.prepare(`INSERT INTO pos_payments(work_order_id,method,direction,amount_cents,reference,idempotency_key,status,verified_by)
      VALUES(?,'cash','refund',1000,'LEGACY-REFUND','legacy-refund-key','confirmed',?)`).run(f.ids.repair, f.users.owner.id);
    installFinancialControls(f.db, 'repair'); installFinancialControls(f.db, 'repair');
    assert.equal(f.db.prepare('SELECT actor_role FROM pos_payments WHERE id=?').get(id).actor_role, '');
    assert.equal(financialEvents(f.db, 'repair', f.ids.repair).length, 0);
    assert.equal(paymentRows(f.db, 'repair', f.ids.repair)[0].refund_remaining_cents, null);
    assert.equal(f.pay('repair', { amount: '100.00', idempotencyKey: 'legacy-cash-key' }).duplicate, true);
    rejects(() => f.refund('repair', id), 409);
    assert.equal(f.totals('repair')().paid, 9000);
  } finally { f.db.close(); }
});

// Local ledger controls. These operations record externally completed transactions;
// they never call a merchant, bank or payment terminal.
import crypto from 'node:crypto';

const config = {
  repair: { table: 'pos_payments', parent: 'work_order_id', actor: 'verified_by' },
  retail: { table: 'retail_payments', parent: 'retail_order_id', actor: 'recorded_by' }
};
const text = (value, max = 600) => String(value ?? '').trim().slice(0, max);
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
export const canAuthorizeFinance = user => !!user && ['owner', 'manager'].includes(user.role);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exists = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
const actor = user => ({ id: user.id, username: user.username, role: user.role });

export function installFinancialControls(db, scope) {
  const { table, parent, actor: actorColumn } = config[scope];
  db.exec(`CREATE TABLE IF NOT EXISTS finance_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL CHECK(scope IN ('repair','retail')),
    entity_id INTEGER NOT NULL, payment_id INTEGER NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('payment','refund','confirm','void')),
    operation_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
    actor_id INTEGER NOT NULL, actor_username TEXT NOT NULL, actor_role TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '', original_payment_id INTEGER,
    detail_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(scope,operation_key)
  );
  CREATE TRIGGER IF NOT EXISTS finance_events_no_update BEFORE UPDATE ON finance_events
    BEGIN SELECT RAISE(ABORT,'Financial events are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS finance_events_no_delete BEFORE DELETE ON finance_events
    BEGIN SELECT RAISE(ABORT,'Financial events are immutable'); END;`);
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name));
  for (const definition of [
    'original_payment_id INTEGER', "reason TEXT NOT NULL DEFAULT ''",
    "actor_username TEXT NOT NULL DEFAULT ''", "actor_role TEXT NOT NULL DEFAULT ''",
    "request_fingerprint TEXT NOT NULL DEFAULT ''", 'voided_at TEXT', 'voided_by INTEGER',
    "void_reason TEXT NOT NULL DEFAULT ''", "voided_by_username TEXT NOT NULL DEFAULT ''",
    "voided_by_role TEXT NOT NULL DEFAULT ''"
  ]) if (!columns.has(definition.split(' ')[0])) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  const immutable = ['id', parent, 'method', 'direction', 'amount_cents', 'idempotency_key',
    'original_payment_id', 'reason', 'actor_username', 'actor_role', 'request_fingerprint', 'created_at',
    ...(scope === 'repair' ? ['notes'] : [])];
  const unchanged = immutable.map(name => `NEW.${name} IS OLD.${name}`).join(' AND ');
  // Pending bank receipts may only be confirmed, or explicitly voided. Neither
  // transition rewrites the original recorder's name/role or request fingerprint.
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT,'Payment history cannot be deleted'); END;
  CREATE TRIGGER IF NOT EXISTS ${table}_controlled_update BEFORE UPDATE ON ${table}
  WHEN NOT (
    OLD.status='pending' AND OLD.direction='payment' AND OLD.voided_at IS NULL AND ${unchanged} AND (
      (OLD.method='zelle' AND NEW.status='confirmed' AND NEW.reference<>'' AND NEW.voided_at IS NULL
        ${scope === 'retail' ? 'AND NEW.recorded_by IS OLD.recorded_by' : ''}
        AND NEW.voided_by IS OLD.voided_by AND NEW.void_reason IS OLD.void_reason
        AND NEW.voided_by_username IS OLD.voided_by_username AND NEW.voided_by_role IS OLD.voided_by_role)
      OR (NEW.status IS OLD.status AND NEW.reference IS OLD.reference AND NEW.${actorColumn} IS OLD.${actorColumn}
        AND NEW.voided_at IS NOT NULL AND NEW.voided_by IS NOT NULL AND NEW.void_reason<>''
        AND NEW.voided_by_username<>'' AND NEW.voided_by_role IN ('owner','manager'))
    )
  ) BEGIN SELECT RAISE(ABORT,'Payment history is immutable except pending confirmation or authorized void'); END;`);
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function parseMoney(value) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value))) fail(400, 'Amount must have at most two decimal places');
  const amount = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000000) fail(400, 'Amount must be positive and at most $1,000,000');
  return amount;
}

function normalize(scope, entityId, input) {
  const verificationStatus = scope === 'retail' ? 409 : 400;
  const method = text(input.method, 24), direction = text(input.direction || 'payment', 24);
  const status = text(input.status || 'confirmed', 24), reference = text(input.reference, 160);
  const key = text(input.idempotencyKey ?? input.idempotency_key, 120);
  if (!['cash', 'card_dejavoo', 'zelle'].includes(method) || !['payment', 'refund'].includes(direction) || !['confirmed', 'pending'].includes(status)) fail(400, 'Invalid payment method, direction or status');
  if (key.length < 8) fail(400, 'Unique idempotency key of at least eight characters required');
  if (status === 'pending' && (method !== 'zelle' || direction !== 'payment')) fail(400, 'Only incoming Zelle payments may be pending');
  if (status === 'confirmed' && input.verified !== true) fail(verificationStatus, 'Confirm externally completed funds with verified=true');
  if (status === 'confirmed' && (method !== 'cash' || direction === 'refund') && !reference) fail(verificationStatus, 'External receipt or refund reference required');
  const reason = direction === 'refund' ? text(input.reason) : '';
  const originalPaymentId = direction === 'refund' ? Number(input.originalPaymentId ?? input.original_payment_id) : null;
  if (direction === 'refund' && (!reason || !Number.isSafeInteger(originalPaymentId) || originalPaymentId <= 0)) fail(400, 'Refund reason and originalPaymentId are required');
  const value = { scope, entityId, method, direction, amount: parseMoney(input.amount), status, reference,
    notes: scope === 'repair' ? text(input.notes, 500) : '', reason, originalPaymentId };
  return { ...value, key, fingerprint: digest(value) };
}

function entity(db, scope, id) {
  const row = scope === 'repair'
    ? db.prepare("SELECT estimate_total FROM work_orders WHERE id=? AND source='manual'").get(id)
    : db.prepare('SELECT total_cents,invoice_issued_at FROM retail_special_orders WHERE id=?').get(id);
  if (!row) fail(404, 'Order not found');
  if (scope === 'retail' && !row.invoice_issued_at) fail(409, 'Issue the retail invoice before recording payments');
  return scope === 'repair' ? Math.round(row.estimate_total * 100) : row.total_cents;
}

function net(db, scope, entityId) {
  const { table, parent } = config[scope];
  return db.prepare(`SELECT COALESCE(SUM(CASE WHEN direction='payment' THEN amount_cents ELSE -amount_cents END),0) paid
    FROM ${table} WHERE ${parent}=? AND status='confirmed' AND voided_at IS NULL`).get(entityId).paid;
}

function assertReferenceUnused(db, value, excludeId = null) {
  if (value.status !== 'confirmed' || !['card_dejavoo', 'zelle'].includes(value.method) || !value.reference) return;
  for (const [scope, { table }] of Object.entries(config)) {
    if (!exists(db, table)) continue;
    const hasVoid = db.prepare(`PRAGMA table_info(${table})`).all().some(x => x.name === 'voided_at');
    const row = db.prepare(`SELECT id FROM ${table} WHERE method=? AND direction=? AND status='confirmed' AND reference=? ${hasVoid ? 'AND voided_at IS NULL' : ''} LIMIT 1`).get(value.method, value.direction, value.reference);
    if (row && !(scope === value.scope && row.id === excludeId)) fail(409, 'This external receipt/reference is already recorded in a repair or retail ledger');
  }
}

function event(db, scope, entityId, paymentId, operation, key, fingerprint, user, reason, original, detail) {
  db.prepare(`INSERT INTO finance_events(scope,entity_id,payment_id,operation,operation_key,request_fingerprint,
    actor_id,actor_username,actor_role,reason,original_payment_id,detail_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(scope, entityId, paymentId, operation, key, fingerprint, user.id, user.username, user.role, reason, original, JSON.stringify(detail));
  db.prepare('INSERT INTO audit_log(work_order_id,actor,action,detail) VALUES(?,?,?,?)')
    .run(scope === 'repair' ? entityId : null, user.username, `Financial ${operation}`, JSON.stringify({ scope, entityId, paymentId, reason, originalPaymentId: original, actor: actor(user), ...detail }));
}

function matchesLegacy(old, value, parent) {
  return old[parent] === value.entityId && old.method === value.method && old.direction === value.direction
    && old.amount_cents === value.amount && old.status === value.status && old.reference === value.reference
    && (old.notes || '') === value.notes && (old.reason || '') === value.reason
    && old.original_payment_id === value.originalPaymentId;
}

export function recordPayment(db, scope, entityId, user, input, totals) {
  if (input.direction === 'refund' && !canAuthorizeFinance(user)) fail(403, 'Only an owner or manager may authorize a refund');
  const value = normalize(scope, entityId, input), { table, parent, actor: actorColumn } = config[scope];
  if (value.direction === 'refund' && !canAuthorizeFinance(user)) fail(403, 'Only an owner or manager may authorize a refund');
  return transaction(db, () => {
    const prior = db.prepare(`SELECT * FROM ${table} WHERE idempotency_key=?`).get(value.key);
    if (prior) {
      if (prior[parent] !== entityId || (prior.request_fingerprint ? prior.request_fingerprint !== value.fingerprint : !matchesLegacy(prior, value, parent))) fail(409, 'Idempotency key was used with different payment details');
      return { duplicate: true, id: prior.id, status: prior.status, totals: totals() };
    }
    const total = entity(db, scope, entityId), paid = net(db, scope, entityId);
    const next = paid + (value.status === 'confirmed' ? (value.direction === 'payment' ? value.amount : -value.amount) : 0);
    if (next < 0 || next > total) fail(409, 'Overpayment or excessive refund');
    if (value.direction === 'refund') {
      const original = db.prepare(`SELECT * FROM ${table} WHERE id=? AND ${parent}=?`).get(value.originalPaymentId, entityId);
      if (!original || original.direction !== 'payment' || original.status !== 'confirmed' || original.voided_at || original.method !== value.method) fail(409, 'Refund must link to an original confirmed payment with the same method and order');
      if (db.prepare(`SELECT id FROM ${table} WHERE ${parent}=? AND method=? AND direction='refund' AND original_payment_id IS NULL LIMIT 1`).get(entityId, value.method)) fail(409, 'Legacy unlinked refunds require reconciliation before another refund');
      const refunded = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) n FROM ${table} WHERE original_payment_id=? AND direction='refund'`).get(original.id).n;
      if (value.amount > original.amount_cents - refunded) fail(409, 'Refund exceeds the original payment remaining refundable amount');
    }
    assertReferenceUnused(db, value);
    const columns = [parent, 'method', 'direction', 'amount_cents', 'reference', 'idempotency_key', 'status', actorColumn,
      'original_payment_id', 'reason', 'actor_username', 'actor_role', 'request_fingerprint'];
    const values = [entityId, value.method, value.direction, value.amount, value.reference, value.key, value.status, user.id,
      value.originalPaymentId, value.reason, user.username, user.role, value.fingerprint];
    if (scope === 'repair') { columns.push('notes'); values.push(value.notes); }
    const result = db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...values);
    const id = Number(result.lastInsertRowid);
    event(db, scope, entityId, id, value.direction, `record:${value.key}`, value.fingerprint, user, value.reason, value.originalPaymentId,
      { method: value.method, amountCents: value.amount, reference: value.reference, status: value.status });
    return { id, status: value.status, totals: totals() };
  });
}

export function confirmPayment(db, scope, paymentId, user, input, totals) {
  const { table, parent, actor: actorColumn } = config[scope], reference = text(input.reference, 160);
  if (input.verified !== true || !reference) fail(400, 'Verify funds arrived in the receiving bank and enter the reference');
  return transaction(db, () => {
    const pay = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(paymentId);
    if (!pay) fail(404, 'Payment not found');
    if (pay.voided_at) fail(409, 'A voided pending payment cannot be confirmed');
    if (pay.status === 'confirmed') {
      if (pay.reference !== reference || pay.method !== 'zelle') fail(409, 'Confirmation does not match the recorded bank receipt');
      return { alreadyConfirmed: true, totals: totals(pay[parent]) };
    }
    if (pay.method !== 'zelle' || pay.direction !== 'payment') fail(409, 'Only pending incoming Zelle payments can be confirmed');
    if (net(db, scope, pay[parent]) + pay.amount_cents > entity(db, scope, pay[parent])) fail(409, 'Bank payment exceeds the remaining invoice balance');
    assertReferenceUnused(db, { scope, method: pay.method, direction: pay.direction, reference, status: 'confirmed' }, paymentId);
    if (scope === 'repair') db.prepare(`UPDATE ${table} SET status='confirmed',reference=?,${actorColumn}=? WHERE id=?`).run(reference, user.id, paymentId);
    else db.prepare(`UPDATE ${table} SET status='confirmed',reference=? WHERE id=?`).run(reference, paymentId);
    event(db, scope, pay[parent], paymentId, 'confirm', `confirm:${paymentId}`, digest({ paymentId, reference }), user, '', null,
      { method: pay.method, amountCents: pay.amount_cents, reference });
    return { ok: true, totals: totals(pay[parent]) };
  });
}

export function voidPayment(db, scope, paymentId, user, input, totals) {
  if (!canAuthorizeFinance(user)) fail(403, 'Only an owner or manager may void a pending payment');
  const { table, parent } = config[scope], reason = text(input.reason), key = text(input.idempotencyKey ?? input.idempotency_key, 120);
  if (!reason || key.length < 8) fail(400, 'Void reason and unique idempotency key are required');
  const fingerprint = digest({ paymentId, reason });
  return transaction(db, () => {
    const prior = db.prepare("SELECT * FROM finance_events WHERE scope=? AND operation_key=?").get(scope, `void:${key}`);
    if (prior) {
      if (prior.payment_id !== paymentId || prior.request_fingerprint !== fingerprint) fail(409, 'Idempotency key was used with different void details');
      return { duplicate: true, id: paymentId, totals: totals(prior.entity_id) };
    }
    const pay = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(paymentId);
    if (!pay) fail(404, 'Payment not found');
    if (pay.voided_at || pay.status !== 'pending' || pay.direction !== 'payment') fail(409, 'Only an unconfirmed pending payment can be voided; confirmed funds require an authorized refund');
    db.prepare(`UPDATE ${table} SET voided_at=CURRENT_TIMESTAMP,voided_by=?,void_reason=?,voided_by_username=?,voided_by_role=? WHERE id=?`)
      .run(user.id, reason, user.username, user.role, paymentId);
    event(db, scope, pay[parent], paymentId, 'void', `void:${key}`, fingerprint, user, reason, null,
      { method: pay.method, amountCents: pay.amount_cents, status: 'voided' });
    return { id: paymentId, status: 'voided', totals: totals(pay[parent]) };
  });
}

export function financialEvents(db, scope, entityId) {
  return db.prepare('SELECT * FROM finance_events WHERE scope=? AND entity_id=? ORDER BY id').all(scope, entityId);
}

export function paymentRows(db, scope, entityId) {
  const { table, parent } = config[scope];
  const rows = db.prepare(`SELECT * FROM ${table} WHERE ${parent}=? ORDER BY id`).all(entityId);
  return rows.map(row => ({ ...row, refund_remaining_cents: row.direction === 'payment' && row.status === 'confirmed' && !row.voided_at
    ? (rows.some(x => x.direction === 'refund' && x.method === row.method && !x.original_payment_id) ? null
      : row.amount_cents - rows.filter(x => x.direction === 'refund' && x.original_payment_id === row.id).reduce((n, x) => n + x.amount_cents, 0))
    : 0 }));
}

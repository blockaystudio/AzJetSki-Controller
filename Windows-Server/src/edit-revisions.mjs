// Monotonic edit versions belong to records, not timestamps. Database triggers
// also invalidate an open editor when payments, custody, imports or tax writers
// change the same record outside its ordinary PATCH endpoint.
export const revisionTables = Object.freeze([
  'customers', 'vehicles', 'work_orders', 'work_order_lines',
  'retail_special_orders', 'retail_special_lines'
]);
const quote = name => `"${name.replaceAll('"', '""')}"`;
const tableExists = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const changed = columns => columns.filter(name => !['revision', 'updated_at'].includes(name))
  .map(name => `NEW.${quote(name)} IS NOT OLD.${quote(name)}`).join(' OR ') || '0';

export function installEditRevisions(db) {
  for (const table of revisionTables) {
    if (!tableExists(db, table)) continue;
    let columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(column => column.name);
    if (!columns.includes('revision')) {
      db.exec(`ALTER TABLE ${quote(table)} ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1)`);
      columns = [...columns, 'revision'];
    }
    // Rebuild only these owned triggers so a later additive migration's new
    // columns participate too. Migration is called before the HTTP listener.
    db.exec(`DROP TRIGGER IF EXISTS ${table}_edit_revision;
      DROP TRIGGER IF EXISTS ${table}_revision_valid;
      CREATE TRIGGER ${table}_revision_valid BEFORE UPDATE OF revision ON ${quote(table)}
      WHEN typeof(NEW.revision)<>'integer' OR NEW.revision<OLD.revision OR NEW.revision>OLD.revision+1
      BEGIN SELECT RAISE(ABORT,'Invalid record revision'); END;
      CREATE TRIGGER ${table}_edit_revision AFTER UPDATE ON ${quote(table)}
      WHEN NEW.revision=OLD.revision AND (${changed(columns)})
      BEGIN UPDATE ${quote(table)} SET revision=OLD.revision+1 WHERE id=NEW.id; END;`);
  }
  // A changed child line invalidates the entire order form, including zero-value
  // lines and description-only edits which need not change account totals.
  for (const [table, parent, foreignKey] of [
    ['work_order_lines', 'work_orders', 'work_order_id'],
    ['retail_special_lines', 'retail_special_orders', 'retail_order_id']
  ]) {
    if (!tableExists(db, table) || !tableExists(db, parent)) continue;
    const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(column => column.name);
    db.exec(`DROP TRIGGER IF EXISTS ${table}_parent_insert_revision;
      DROP TRIGGER IF EXISTS ${table}_parent_update_revision;
      DROP TRIGGER IF EXISTS ${table}_parent_delete_revision;
      CREATE TRIGGER ${table}_parent_insert_revision AFTER INSERT ON ${quote(table)}
      BEGIN UPDATE ${quote(parent)} SET revision=revision+1 WHERE id=NEW.${foreignKey}; END;
      CREATE TRIGGER ${table}_parent_update_revision AFTER UPDATE ON ${quote(table)}
      WHEN ${changed(columns)}
      BEGIN UPDATE ${quote(parent)} SET revision=revision+1 WHERE id IN (OLD.${foreignKey},NEW.${foreignKey}); END;
      CREATE TRIGGER ${table}_parent_delete_revision AFTER DELETE ON ${quote(table)}
      BEGIN UPDATE ${quote(parent)} SET revision=revision+1 WHERE id=OLD.${foreignKey}; END;`);
  }
}

export function editRevisionTarget(method, pathname, body = {}) {
  const verb = String(method || 'GET').toUpperCase();
  const path = String(pathname || '').split('?')[0];
  let match;
  if (verb === 'PATCH' || verb === 'DELETE') {
    for (const [pattern, table] of [
      [/^\/api\/pos\/customers\/(\d+)$/, 'customers'],
      [/^\/api\/pos\/vehicles\/(\d+)$/, 'vehicles'],
      [/^\/api\/(?:pos\/)?work-orders\/(\d+)$/, 'work_orders'],
      [/^\/api\/pos\/lines\/(\d+)$/, 'work_order_lines'],
      [/^\/api\/shop\/retail-orders\/(\d+)$/, 'retail_special_orders'],
      [/^\/api\/shop\/retail-orders\/\d+\/lines\/(\d+)$/, 'retail_special_lines']
    ]) if ((match = path.match(pattern))) return {table, id:Number(match[1])};
  }
  if (verb === 'POST') {
    if ((match = path.match(/^\/api\/pos\/work-orders\/(\d+)\/lines$/))) return {table:'work_orders', id:Number(match[1])};
    if ((match = path.match(/^\/api\/work-orders\/(\d+)\/(ready|request-approval)$/))) return {table:'work_orders', id:Number(match[1])};
    if ((match = path.match(/^\/api\/work-orders\/(\d+)\/updates$/)) && Object.hasOwn(body, 'stage')) return {table:'work_orders', id:Number(match[1])};
    if ((match = path.match(/^\/api\/shop\/retail-orders\/(\d+)\/(lines|issue-invoice)$/))) return {table:'retail_special_orders', id:Number(match[1])};
    if ((match = path.match(/^\/api\/shop\/retail-orders\/\d+\/lines\/(\d+)\/(verify|status)$/))) return {table:'retail_special_lines', id:Number(match[1])};
  }
  return null;
}

function failure(status, message, fields = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, fields);
  return error;
}

function parseExpected(value, target) {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) throw failure(400, 'Supply one record revision');
  let raw = String(value).trim();
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
  const scoped = raw.match(/^([a-z_]+):(\d+):(\d+)$/);
  if (scoped) {
    if (scoped[1] !== target.table || Number(scoped[2]) !== target.id) throw failure(409, 'Edit revision belongs to another record');
    raw = scoped[3];
  }
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw failure(400, 'Record revision must be a positive integer');
  return Number(raw);
}

// Invoke synchronously AFTER the awaited request body, immediately before the
// first mutation. There must be no await between this guard and the SQLite writes.
// Authorization must run first, so this helper does not expose records to guests.
export function requireEditRevision(db, req, pathname, body = {}, {required = process.env.REQUIRE_EDIT_REVISION !== 'false'} = {}) {
  const target = editRevisionTarget(req.method, pathname, body);
  if (!target) return null;
  if (!tableExists(db, target.table)) return null;
  const row = db.prepare(`SELECT revision FROM ${quote(target.table)} WHERE id=?`).get(target.id);
  if (!row) throw failure(404, 'The record no longer exists');
  const header = req.headers?.['if-match'];
  const fromBody = body?.expectedRevision ?? body?.expected_revision ?? body?._revision;
  const expected = parseExpected(header ?? fromBody, target);
  if (header !== undefined && fromBody !== undefined && parseExpected(fromBody, target) !== expected) throw failure(400, 'Header and body edit revisions disagree');
  if (expected === null) {
    if (required) throw failure(428, 'Refresh this record before editing; its revision is required', {currentRevision:row.revision, record:target});
    return {...target, currentRevision:row.revision};
  }
  if (expected !== row.revision) throw failure(409, 'Another employee changed this record. Refresh it and review your changes before saving again.', {currentRevision:row.revision, expectedRevision:expected, record:target});
  return {...target, currentRevision:row.revision};
}

export function revisionEtag(table, id, revision) {
  if (!revisionTables.includes(table) || !Number.isSafeInteger(Number(id)) || Number(id)<1 || !Number.isSafeInteger(Number(revision)) || Number(revision)<1) throw new Error('Invalid record revision');
  return `"${table}:${Number(id)}:${Number(revision)}"`;
}

// Existing collection queries intentionally select small field sets. Attach
// current revision values without changing every select or exposing extra data.
export function withEditRevisions(db, value, context = '') {
  if (Array.isArray(value)) return value.map(item => withEditRevisions(db, item, context));
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  let table = ({customer:'customers',customers:'customers',vehicle:'vehicles',vehicles:'vehicles',workOrder:'work_orders',workOrders:'work_orders',recent:'work_orders',line:'work_order_lines'})[context];
  if (!table && context === 'lines') table = Object.hasOwn(value, 'retail_order_id') ? 'retail_special_lines' : Object.hasOwn(value, 'work_order_id') ? 'work_order_lines' : null;
  if (!table && context === 'order' && Object.hasOwn(value, 'invoice_number')) table = 'retail_special_orders';
  const output = {};
  for (const [key, item] of Object.entries(value)) output[key] = withEditRevisions(db, item, key);
  if (table && Number.isSafeInteger(Number(value.id)) && tableExists(db, table)) {
    const row = db.prepare(`SELECT revision FROM ${quote(table)} WHERE id=?`).get(Number(value.id));
    if (row) output.revision = row.revision;
  }
  return output;
}

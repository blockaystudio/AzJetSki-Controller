import crypto from 'node:crypto';

export const SHOP_ASSIGNEES = Object.freeze(['Tyler Whitener', 'Jacobo Medina']);
const safeUserFields = 'u.id,u.username,u.display_name,u.role,u.active,u.last_login_at,u.created_at';
const tableExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const normalizedName = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
const isConfigured = db => tableExists(db, 'shop_roster_configuration') &&
  db.prepare('SELECT configured FROM shop_roster_configuration WHERE id=1').get()?.configured === 1;

export function installShopRoster(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS shop_assignment_roster (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    configured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS shop_roster_configuration (
    id INTEGER PRIMARY KEY CHECK(id=1), configured INTEGER NOT NULL DEFAULT 0 CHECK(configured IN (0,1)),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
}

// An unconfigured installation keeps its existing staff behavior. Configuring
// assignment choices never deactivates anyone or changes their login access.
export function listAssignmentStaff(db) {
  if (isConfigured(db)) {
    return db.prepare(`SELECT ${safeUserFields} FROM users u JOIN shop_assignment_roster r ON r.user_id=u.id
      WHERE u.active=1 AND u.role!='viewer' ORDER BY u.display_name,u.username`).all();
  }
  return db.prepare(`SELECT ${safeUserFields} FROM users u WHERE u.active=1 AND u.role!='viewer'
    ORDER BY u.display_name,u.username`).all();
}

export function isAssignmentStaff(db, value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) return false;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) return false;
  return listAssignmentStaff(db).some(user => user.id === id);
}

export function assertAssignmentStaff(db, value, { allowUnassigned = true } = {}) {
  if (allowUnassigned && (value === null || value === undefined || value === '' || value === 0 || value === '0')) return null;
  if (!isAssignmentStaff(db, value)) {
    throw Object.assign(new Error('Choose an active member of the assignment roster'), { status: 400 });
  }
  return Number(value);
}

function rosterPlan(db) {
  const users = db.prepare('SELECT id,username,display_name,role,active FROM users').all();
  const selected = new Set();
  const rows = SHOP_ASSIGNEES.map(name => {
    const match = normalizedName(name);
    const candidates = users.filter(user => [user.username, user.display_name].some(value => normalizedName(value) === match));
    if (candidates.length > 1) throw new Error('Assignment roster has ambiguous existing accounts; resolve those accounts before configuring');
    const user = candidates[0];
    if (user && (user.active !== 1 || user.role === 'viewer')) throw new Error('Assignment roster matches an inactive or viewer account; review that account before configuring');
    if (user && selected.has(user.id)) throw new Error('Assignment roster names must identify separate existing accounts');
    if (user) selected.add(user.id);
    return { name, user };
  });
  const currentIds = tableExists(db, 'shop_assignment_roster')
    ? db.prepare('SELECT user_id FROM shop_assignment_roster').all().map(row => row.user_id) : [];
  const create = rows.filter(row => !row.user).length;
  const rename = rows.filter(row => row.user && row.user.display_name !== row.name).length;
  const rosterChanged = create > 0 || currentIds.length !== rows.length || rows.some(row => !currentIds.includes(row.user?.id));
  return { rows, summary: { assignees: rows.length, reused: rows.length - create, create, rename, changesRequired: !isConfigured(db) || rosterChanged || rename > 0 } };
}

export function configureShopRoster(db, { apply = false, actor = 'shop-configuration' } = {}) {
  if (!apply) return rosterPlan(db).summary;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-read under the write lock; a concurrent owner edit must not create a
    // second account or accidentally reactivate an existing account.
    const plan = rosterPlan(db);
    if (!plan.summary.changesRequired) { db.exec('COMMIT'); return { ...plan.summary, applied: false }; }
    installShopRoster(db);
    const ids = [];
    for (const row of plan.rows) {
      let id = row.user?.id;
      if (!id) {
        const username = row.name.toLowerCase().replace(/\s+/g, '.');
        // These independent random values have no corresponding known login
        // password. An owner can provision credentials through normal user UI.
        const result = db.prepare(`INSERT INTO users(username,display_name,password_hash,salt,role,active)
          VALUES(?,?,?,?,'technician',1)`).run(username, row.name, crypto.randomBytes(64).toString('hex'), crypto.randomBytes(16).toString('hex'));
        id = Number(result.lastInsertRowid);
      } else if (row.user.display_name !== row.name) {
        db.prepare('UPDATE users SET display_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(row.name, id);
      }
      ids.push(id);
    }
    db.exec('DELETE FROM shop_assignment_roster');
    for (const id of ids) db.prepare('INSERT INTO shop_assignment_roster(user_id) VALUES(?)').run(id);
    db.exec(`INSERT INTO shop_roster_configuration(id,configured) VALUES(1,1)
      ON CONFLICT(id) DO UPDATE SET configured=1,updated_at=CURRENT_TIMESTAMP`);
    db.prepare('INSERT INTO audit_log(actor,action,detail) VALUES(?,?,?)').run(String(actor), 'Shop assignment roster configured',
      JSON.stringify({ userIds: ids, ...plan.summary }));
    db.exec('COMMIT');
    return { ...plan.summary, applied: true };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

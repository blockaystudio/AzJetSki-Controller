import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDb, hashPassword, verifyPassword } from '../src/db.mjs';
import { installShopRoster, listAssignmentStaff, isAssignmentStaff, assertAssignmentStaff, configureShopRoster } from '../src/shop-roster.mjs';
import { validateBackup } from '../scripts/restore-all.mjs';

function user(db, username, displayName, role = 'technician', active = 1) {
  const credentials = hashPassword('Fictional account password');
  const id = Number(db.prepare('INSERT INTO users(username,display_name,password_hash,salt,role,active) VALUES(?,?,?,?,?,?)')
    .run(username, displayName, credentials.hash, credentials.salt, role, active).lastInsertRowid);
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}
function fixture(t) { const db = openDb(':memory:'); t.after(() => db.close()); return db; }

test('assignment roster falls back before configuration and validates active non-viewer IDs', t => {
  const db = fixture(t), owner = user(db, 'fixture-owner', 'Fixture Owner', 'owner');
  user(db, 'fixture-viewer', 'Fixture Viewer', 'viewer');
  user(db, 'fixture-inactive', 'Fixture Inactive', 'technician', 0);
  assert.deepEqual(listAssignmentStaff(db).map(row => row.id), [owner.id]);
  installShopRoster(db);
  assert.equal(listAssignmentStaff(db).length, 1);
  assert.equal(isAssignmentStaff(db, owner.id), true);
  assert.equal(isAssignmentStaff(db, String(owner.id)), true);
  for (const invalid of [true, false, {}, [], -1, 1.2, '1x']) assert.equal(isAssignmentStaff(db, invalid), false);
  assert.equal(assertAssignmentStaff(db, null), null);
  assert.throws(() => assertAssignmentStaff(db, 999), { status: 400 });
  assert.throws(() => assertAssignmentStaff(db, null, { allowUnassigned: false }), { status: 400 });
});

test('roster preview makes no schema or user changes; apply reuses existing account and preserves all login privileges', t => {
  const db = fixture(t), owner = user(db, 'fixture-owner', 'Fixture Owner', 'owner');
  const existing = user(db, 'tyler.whitener', 'tyler   whitener', 'manager');
  const before = db.prepare('SELECT * FROM users WHERE id=?').get(existing.id);
  assert.deepEqual(configureShopRoster(db), { assignees: 2, reused: 1, create: 1, rename: 1, changesRequired: true });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='shop_assignment_roster'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 2);
  const applied = configureShopRoster(db, { apply: true, actor: 'fictional test operator' });
  assert.equal(applied.applied, true);
  const after = db.prepare('SELECT * FROM users WHERE id=?').get(existing.id);
  for (const field of ['id', 'username', 'password_hash', 'salt', 'role', 'active', 'pin_hash', 'pin_salt']) assert.equal(after[field], before[field]);
  assert.equal(after.display_name, 'Tyler Whitener');
  assert.equal(db.prepare('SELECT active FROM users WHERE id=?').get(owner.id).active, 1);
  assert.equal(isAssignmentStaff(db, owner.id), false);
  assert.deepEqual(listAssignmentStaff(db).map(row => row.display_name), ['Jacobo Medina', 'Tyler Whitener']);
  for (const row of listAssignmentStaff(db)) for (const key of ['password_hash', 'salt', 'pin_hash', 'pin_salt']) assert.equal(key in row, false);
  const created = db.prepare("SELECT * FROM users WHERE display_name='Jacobo Medina'").get();
  assert.equal(created.role, 'technician'); assert.equal(created.active, 1); assert.equal(created.pin_hash, null);
  assert.match(created.password_hash, /^[a-f0-9]{128}$/); assert.match(created.salt, /^[a-f0-9]{32}$/);
  for (const guess of ['', 'password', 'Jacobo Medina', 'jacobo', 'CHANGE_ME']) assert.equal(verifyPassword(guess, created.salt, created.password_hash), false);
  const auditCount = db.prepare('SELECT COUNT(*) n FROM audit_log').get().n;
  assert.equal(configureShopRoster(db, { apply: true }).applied, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_log').get().n, auditCount);
});

test('ambiguous, inactive and viewer matches fail without creating accounts or changing roles', t => {
  for (const variant of ['duplicate', 'inactive', 'viewer']) {
    const db = openDb(':memory:'); t.after(() => db.close());
    user(db, 'tyler.one', 'Tyler Whitener', variant === 'viewer' ? 'viewer' : 'technician', variant === 'inactive' ? 0 : 1);
    if (variant === 'duplicate') user(db, 'tyler.two', 'TYLER WHITENER');
    const before = db.prepare('SELECT * FROM users').all();
    assert.throws(() => configureShopRoster(db, { apply: true }), /ambiguous|inactive or viewer/);
    assert.deepEqual(db.prepare('SELECT * FROM users').all(), before);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_log').get().n, 0);
  }
});

test('roster audit failure rolls back accounts, configuration and roster together', t => {
  const db = fixture(t);
  db.exec("CREATE TRIGGER reject_roster_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'forced audit failure');END");
  assert.throws(() => configureShopRoster(db, { apply: true }), /forced audit/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='shop_assignment_roster'").get().n, 0);
});

test('roster CLI resolves private runtime paths, defaults to preview and backs up runtime uploads before applying', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ownertracker-roster-cli-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const runtime = path.join(folder, 'separate-private-runtime'), dataDirectory = path.join(runtime, 'data');
  const database = path.join(dataDirectory, 'fictional.sqlite'), envFile = path.join(runtime, 'private.env');
  openDb(database).close();
  const upload = path.join(dataDirectory, 'uploads', 'retained-photo.bin'), uploadBytes = Buffer.from('fictional retained photo bytes');
  fs.mkdirSync(path.dirname(upload), { recursive: true }); fs.writeFileSync(upload, uploadBytes);
  fs.writeFileSync(envFile, 'OWNERTRACKER_DB=./data/fictional.sqlite\nFICTIONAL_SECRET=not-for-output\n');
  const script = fileURLToPath(new URL('../scripts/configure-shop-roster.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, '--env', envFile, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const preview = run(); assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).mode, 'dry-run');
  assert.doesNotMatch(preview.stdout, /Tyler|Jacobo|not-for-output|hash|salt/);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'backups')), false);
  fs.writeFileSync(path.join(dataDirectory, 'backups'), 'block backup directory');
  assert.notEqual(run('--apply').status, 0);
  let db = new DatabaseSync(database, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0); db.close();
  fs.unlinkSync(path.join(dataDirectory, 'backups'));
  const applied = run('--apply'); assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).backupCreated, true);
  const backupRoot = path.join(dataDirectory, 'backups', fs.readdirSync(path.join(dataDirectory, 'backups'))[0]);
  const validated = validateBackup(backupRoot);
  assert.deepEqual(validated.manifest.uploads.files.map(file => file.path), ['retained-photo.bin']);
  assert.deepEqual(fs.readFileSync(path.join(backupRoot, 'uploads', 'retained-photo.bin')), uploadBytes);
  db = new DatabaseSync(path.join(backupRoot, 'ownertracker.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0); db.close();
  db = new DatabaseSync(database, { readOnly: true });
  assert.equal(listAssignmentStaff(db).length, 2); db.close();
});

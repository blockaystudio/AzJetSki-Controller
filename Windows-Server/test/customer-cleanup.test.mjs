import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.mjs';
import { extendDatabase } from '../src/pos-extension.mjs';
import { previewContactlessCustomers, archiveContactlessCustomers } from '../src/customer-cleanup.mjs';
import { restoreFullBackup, validateBackup } from '../scripts/restore-all.mjs';

function fixture(t) { const db = openDb(':memory:'); extendDatabase(db); t.after(() => db.close()); return db; }
function customer(db, values = {}) {
  const row = { name: 'Fictional customer', ...values }, fields = Object.keys(row);
  return Number(db.prepare(`INSERT INTO customers(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`).run(...Object.values(row)).lastInsertRowid);
}

test('cleanup excludes every nonblank contact field, including partial legacy and billing addresses', t => {
  const db = fixture(t);
  const contactFields = ['phone', 'email', 'address', 'address_line1', 'address_line2', 'city', 'state', 'postal_code',
    'billing_address_line1', 'billing_address_line2', 'billing_city', 'billing_state', 'billing_postal_code'];
  for (const field of contactFields) customer(db, { [field]: ' existing contact ' });
  // Additional contact columns are also protected as the schema grows.
  db.exec("ALTER TABLE customers ADD COLUMN mailing_country TEXT DEFAULT ''; ALTER TABLE customers ADD COLUMN alternate_phone TEXT DEFAULT ''");
  customer(db, { mailing_country: 'US' }); customer(db, { alternate_phone: '0' });
  const blank = customer(db, { name: 'Fictional blank', phone: '\t\n ', email: null, address: '\u00a0\t' });
  const archived = customer(db, { archived: 1 });
  const expected = { activeCustomers: contactFields.length + 3, eligible: 1, retainedWithContact: contactFields.length + 2 };
  assert.deepEqual(previewContactlessCustomers(db), expected);
  assert.equal(archiveContactlessCustomers(db).archived, 0);
  assert.equal(db.prepare('SELECT archived FROM customers WHERE id=?').get(blank).archived, 0);
  const applied = archiveContactlessCustomers(db, { apply: true }); assert.equal(applied.archived, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers WHERE archived=0').get().n, contactFields.length + 2);
  assert.equal(db.prepare('SELECT archived FROM customers WHERE id=?').get(archived).archived, 1);
  const audit = JSON.parse(db.prepare("SELECT detail FROM audit_log WHERE action='Contactless customer archived'").get().detail);
  assert.equal(audit.customerId, blank); assert.equal(audit.previousArchived, 0); assert.equal(audit.archived, 1);
  assert.equal(audit.contactFieldsChecked.includes('billing_postal_code'), true);
  assert.equal(archiveContactlessCustomers(db, { apply: true }).archived, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_log').get().n, 1);
});

test('archive preserves linked work orders, vehicles, receipts and immutable imported mappings', t => {
  const db = fixture(t), id = customer(db);
  db.exec(`CREATE TABLE legacy_customer_links(external_id TEXT PRIMARY KEY,customer_id INTEGER REFERENCES customers(id));
    CREATE TRIGGER retain_link BEFORE UPDATE ON legacy_customer_links BEGIN SELECT RAISE(ABORT,'retained mapping');END;
    CREATE TABLE fictional_retained_receipts(id INTEGER PRIMARY KEY,customer_id INTEGER REFERENCES customers(id),snapshot TEXT);`);
  db.prepare('INSERT INTO legacy_customer_links VALUES(?,?)').run('fictional-original-id', id);
  db.prepare('INSERT INTO work_orders(customer_id,customer_name,raw_json) VALUES(?,?,?)').run(id, 'Retained fictional identity', '{"immutable":"history"}');
  db.prepare('INSERT INTO vehicles(customer_id,hin) VALUES(?,?)').run(id, 'FICTIONAL0001');
  db.prepare('INSERT INTO fictional_retained_receipts(customer_id,snapshot) VALUES(?,?)').run(id, 'retained receipt bytes');
  const tables = ['work_orders', 'vehicles', 'legacy_customer_links', 'fictional_retained_receipts'];
  const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  archiveContactlessCustomers(db, { apply: true });
  for (let index = 0; index < tables.length; index++) assert.deepEqual(db.prepare(`SELECT * FROM ${tables[index]}`).all(), before[index]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers WHERE id=?').get(id).n, 1);
});

test('cleanup audit failure rolls every archive flag back', t => {
  const db = fixture(t); customer(db); customer(db);
  db.exec("CREATE TRIGGER reject_cleanup_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'forced audit failure');END");
  assert.throws(() => archiveContactlessCustomers(db, { apply: true }), /forced audit/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers WHERE archived=0').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_log').get().n, 0);
});

test('cleanup CLI uses env-relative data and creates a restorable backup with runtime photos and private legacy archive', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ownertracker-cleanup-cli-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const runtime = path.join(folder, 'separate-private-runtime'), dataDirectory = path.join(runtime, 'data');
  const database = path.join(dataDirectory, 'fictional.sqlite'), envFile = path.join(runtime, 'private.env');
  let db = openDb(database); extendDatabase(db); customer(db, { name: 'Private fictional sentinel' }); customer(db, { email: 'retain@example.test' }); db.close();
  const photos = path.join(dataDirectory, 'uploads'), archive = path.join(photos, 'private-legacy', 'fictional-archive.sqlite');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const archiveDb = new DatabaseSync(archive);
  archiveDb.exec("CREATE TABLE fictional_receipts(id INTEGER PRIMARY KEY,detail TEXT); INSERT INTO fictional_receipts(detail) VALUES('retained fictional receipt')");
  archiveDb.close();
  const archiveBytes = fs.readFileSync(archive), photoBytes = Buffer.from('fictional retained photo bytes');
  fs.writeFileSync(path.join(photos, 'retained-photo.bin'), photoBytes);
  fs.writeFileSync(envFile, 'OWNERTRACKER_DB=./data/fictional.sqlite\nFICTIONAL_SECRET=not-for-output\n');
  const script = fileURLToPath(new URL('../scripts/cleanup-contactless-customers.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, '--env', envFile, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const preview = run(); assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout), { mode: 'dry-run', activeCustomers: 2, eligible: 1, retainedWithContact: 1, archived: 0 });
  assert.doesNotMatch(preview.stdout, /sentinel|example|not-for-output|customerId/);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'backups')), false);
  fs.writeFileSync(path.join(dataDirectory, 'backups'), 'block backup directory');
  assert.notEqual(run('--apply').status, 0);
  db = new DatabaseSync(database, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers WHERE archived=1').get().n, 0); db.close();
  fs.unlinkSync(path.join(dataDirectory, 'backups'));
  const applied = run('--apply'); assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).archived, 1);
  const backupRoot = path.join(dataDirectory, 'backups', fs.readdirSync(path.join(dataDirectory, 'backups'))[0]);
  const validated = validateBackup(backupRoot);
  assert.deepEqual(validated.manifest.uploads.files.map(file => file.path), ['private-legacy/fictional-archive.sqlite', 'retained-photo.bin']);
  assert.deepEqual(fs.readFileSync(path.join(backupRoot, 'uploads', 'private-legacy', 'fictional-archive.sqlite')), archiveBytes);
  assert.deepEqual(fs.readFileSync(path.join(backupRoot, 'uploads', 'retained-photo.bin')), photoBytes);
  db = new DatabaseSync(path.join(backupRoot, 'ownertracker.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers WHERE archived=1').get().n, 0); db.close();
  db = new DatabaseSync(database, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers WHERE archived=1').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers WHERE archived=0').get().n, 1); db.close();
  const restoreDirectory = path.join(folder, 'disposable-restore');
  const restored = restoreFullBackup(backupRoot, { databasePath: path.join(restoreDirectory, 'restored.sqlite'), uploadsPath: path.join(restoreDirectory, 'uploads') });
  db = new DatabaseSync(restored.database, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers WHERE archived=1').get().n, 0); db.close();
  assert.deepEqual(fs.readFileSync(path.join(restored.uploads, 'private-legacy', 'fictional-archive.sqlite')), archiveBytes);
  assert.deepEqual(fs.readFileSync(path.join(restored.uploads, 'retained-photo.bin')), photoBytes);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createFullBackup, fingerprint, photoTree } from '../scripts/backup-all.mjs';
import { validateBackup, restoreFullBackup } from '../scripts/restore-all.mjs';

function fixture(t, { photos = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownertracker-backup-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'), destination = path.join(dir, 'destination');
  fs.mkdirSync(source); fs.mkdirSync(destination);
  const databasePath = path.join(source, 'shop.sqlite');
  const uploadsPath = path.join(source, 'uploads');
  writeDatabase(databasePath, 'backed up');
  if (photos) {
    fs.mkdirSync(path.join(uploadsPath, 'nested'), { recursive: true });
    fs.mkdirSync(path.join(uploadsPath, 'empty'));
    fs.writeFileSync(path.join(uploadsPath, 'nested', 'photo.jpg'), 'backed-up-photo');
  }
  const backup = createFullBackup({ databasePath, uploadsPath, backupRoot: path.join(dir, 'backups') });
  const target = { databasePath: path.join(destination, 'live.sqlite'), uploadsPath: path.join(destination, 'uploads') };
  writeDatabase(target.databasePath, 'current');
  fs.mkdirSync(target.uploadsPath);
  fs.writeFileSync(path.join(target.uploadsPath, 'stale.jpg'), 'current-photo');
  return { dir, source, destination, backup, target, databasePath, uploadsPath };
}
function writeDatabase(file, value) {
  const db = new DatabaseSync(file);
  try { db.exec('CREATE TABLE marker(value TEXT)'); db.prepare('INSERT INTO marker VALUES(?)').run(value); } finally { db.close(); }
}
function databaseValue(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT value FROM marker').get().value; } finally { db.close(); }
}
function manifest(backup, change) {
  const file = path.join(backup, 'manifest.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(value);
  fs.writeFileSync(file, JSON.stringify(value));
}
function unchanged(target, action, errorPattern) {
  const database = fingerprint(target.databasePath), photos = photoTree(target.uploadsPath);
  assert.throws(action, errorPattern);
  assert.deepEqual(fingerprint(target.databasePath), database);
  assert.deepEqual(photoTree(target.uploadsPath), photos);
}

test('backup snapshots DB without migrating source and records DB/photos checksums with private modes', t => {
  const f = fixture(t);
  const sourceBefore = fingerprint(f.databasePath);
  const verified = validateBackup(f.backup);
  assert.equal(verified.manifest.schemaVersion, 1);
  assert.deepEqual(verified.database, verified.manifest.database && { size: verified.manifest.database.size, sha256: verified.manifest.database.sha256 });
  assert.deepEqual(verified.uploads, photoTree(f.uploadsPath));
  assert.deepEqual(fingerprint(f.databasePath), sourceBefore);
  assert.equal(databaseValue(path.join(f.backup, 'ownertracker.sqlite')), 'backed up');
  if (process.platform !== 'win32') {
    for (const file of ['manifest.json', 'ownertracker.sqlite', 'uploads/nested/photo.jpg']) assert.equal(fs.statSync(path.join(f.backup, file)).mode & 0o777, 0o600);
    for (const dir of ['', 'uploads', 'uploads/nested']) assert.equal(fs.statSync(path.join(f.backup, dir)).mode & 0o777, 0o700);
  }
});

test('restore replaces complete DB/photo set and retains the previous full state', t => {
  const f = fixture(t);
  const previousDb = fingerprint(f.target.databasePath), previousPhotos = photoTree(f.target.uploadsPath);
  const restored = restoreFullBackup(f.backup, f.target);
  assert.equal(databaseValue(f.target.databasePath), 'backed up');
  assert.deepEqual(photoTree(f.target.uploadsPath), photoTree(path.join(f.backup, 'uploads')));
  assert.equal(fs.existsSync(path.join(f.target.uploadsPath, 'stale.jpg')), false);
  assert.deepEqual(fingerprint(path.join(restored.previous, 'ownertracker.sqlite')), previousDb);
  assert.deepEqual(photoTree(path.join(restored.previous, 'uploads')), previousPhotos);
  validateBackup(restored.previous);
  assert.equal(fs.readdirSync(f.destination).some(name => name.startsWith('.ownertracker-')), false);
});

test('backup with no uploads removes stale destination photos while retaining them for recovery', t => {
  const f = fixture(t, { photos: false });
  const result = restoreFullBackup(f.backup, f.target);
  assert.equal(fs.existsSync(f.target.uploadsPath), false);
  assert.equal(fs.readFileSync(path.join(result.previous, 'uploads', 'stale.jpg'), 'utf8'), 'current-photo');
});

test('corrupt SQLite fails before touching destination', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.backup, 'ownertracker.sqlite'), 'this is not SQLite');
  unchanged(f.target, () => restoreFullBackup(f.backup, f.target), /database|SQLite/i);
  assert.deepEqual(fs.readdirSync(f.destination).sort(), ['live.sqlite', 'uploads']);
});

test('valid but changed SQLite is rejected by checksum', t => {
  const f = fixture(t);
  const db = new DatabaseSync(path.join(f.backup, 'ownertracker.sqlite'));
  db.exec("UPDATE marker SET value='tampered'"); db.close();
  unchanged(f.target, () => restoreFullBackup(f.backup, f.target), /checksum/);
});

test('missing uploads and tampered photos fail before touching destination', async t => {
  for (const mode of ['missing-file', 'missing-directory', 'changed', 'extra']) await t.test(mode, t => {
    const f = fixture(t);
    const photo = path.join(f.backup, 'uploads', 'nested', 'photo.jpg');
    if (mode === 'missing-file') fs.unlinkSync(photo);
    if (mode === 'missing-directory') fs.rmSync(path.join(f.backup, 'uploads'), { recursive: true });
    if (mode === 'changed') fs.writeFileSync(photo, 'tampered');
    if (mode === 'extra') fs.writeFileSync(path.join(f.backup, 'uploads', 'extra.jpg'), 'unlisted');
    unchanged(f.target, () => restoreFullBackup(f.backup, f.target), /uploads|checksum/);
  });
});

test('invalid or path-traversing manifests are rejected rather than treated as legacy', async t => {
  for (const mode of ['json', 'version', 'path', 'duplicate', 'legacy-invalid']) await t.test(mode, t => {
    const f = fixture(t);
    if (mode === 'json') fs.writeFileSync(path.join(f.backup, 'manifest.json'), '{invalid');
    if (mode === 'version') manifest(f.backup, value => { value.schemaVersion = 999; });
    if (mode === 'path') manifest(f.backup, value => { value.uploads.files[0].path = '../outside'; });
    if (mode === 'duplicate') manifest(f.backup, value => { value.uploads.files.push(value.uploads.files[0]); });
    if (mode === 'legacy-invalid') fs.writeFileSync(path.join(f.backup, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), includes: ['anything'] }));
    unchanged(f.target, () => restoreFullBackup(f.backup, { ...f.target, allowLegacy: true }), /manifest|path|Duplicate/i);
  });
});

test('legacy backups require explicit permission and warn about absent checksums', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.backup, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), includes: ['ownertracker.sqlite', 'uploads (if present)'], readme: 'legacy' }));
  unchanged(f.target, () => restoreFullBackup(f.backup, f.target), /allow-legacy/);
  const warnings = [];
  restoreFullBackup(f.backup, { ...f.target, allowLegacy: true, warn: message => warnings.push(message) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no checksums/);
});

test('destination SQLite sidecars block restore without changing either DB or photos', async t => {
  for (const suffix of ['-wal', '-shm', '-journal']) await t.test(suffix, t => {
    const f = fixture(t);
    fs.writeFileSync(f.target.databasePath + suffix, 'active-or-uncheckpointed');
    unchanged(f.target, () => restoreFullBackup(f.backup, f.target), /Stop the server.*sidecar/);
    assert.equal(fs.readFileSync(f.target.databasePath + suffix, 'utf8'), 'active-or-uncheckpointed');
  });
});

test('links in source, backup or destination paths are rejected', async t => {
  for (const mode of ['backup-file', 'backup-directory', 'destination-directory', 'source-photo', 'hard-link']) await t.test(mode, t => {
    const f = fixture(t);
    if (mode === 'source-photo') {
      fs.symlinkSync(f.databasePath, path.join(f.uploadsPath, 'linked'));
      assert.throws(() => createFullBackup({ databasePath: f.databasePath, uploadsPath: f.uploadsPath, backupRoot: path.join(f.dir, 'new-backups') }), /links/i);
      return;
    }
    if (mode === 'backup-file' || mode === 'hard-link') {
      const photo = path.join(f.backup, 'uploads', 'nested', 'photo.jpg');
      fs.unlinkSync(photo);
      if (mode === 'backup-file') fs.symlinkSync(f.databasePath, photo);
      else fs.linkSync(f.databasePath, photo);
    }
    if (mode === 'backup-directory') {
      const link = path.join(f.dir, 'linked-backup'); fs.symlinkSync(f.backup, link, 'dir'); f.backup = link;
    }
    if (mode === 'destination-directory') {
      const link = path.join(f.dir, 'linked-destination'); fs.symlinkSync(f.destination, link, 'dir');
      const linkedTarget = { databasePath: path.join(link, 'live.sqlite'), uploadsPath: path.join(link, 'uploads') };
      unchanged(f.target, () => restoreFullBackup(f.backup, linkedTarget), /links/i);
      return;
    }
    unchanged(f.target, () => restoreFullBackup(f.backup, f.target), /links|linked/i);
  });
});

test('failed photo installation rolls DB and photos back after DB was already replaced', t => {
  const f = fixture(t);
  let installedDatabase = false;
  unchanged(f.target, () => restoreFullBackup(f.backup, { ...f.target, rename(from, to) {
    if (from.endsWith('new-uploads')) throw new Error('Injected photo installation failure');
    fs.renameSync(from, to);
    if (to === f.target.databasePath) installedDatabase = true;
  } }), /Injected photo installation failure.*preserved/);
  assert.equal(installedDatabase, true);
  const retained = fs.readdirSync(f.destination).find(name => name.startsWith('ownertracker-before-restore-'));
  assert.ok(retained);
  const previous = path.join(f.destination, retained);
  assert.equal(databaseValue(path.join(previous, 'ownertracker.sqlite')), 'current');
  assert.equal(fs.readFileSync(path.join(previous, 'uploads', 'stale.jpg'), 'utf8'), 'current-photo');
});

test('restore works for a new installation and rejects source/destination overlap', t => {
  const f = fixture(t);
  const target = { databasePath: path.join(f.dir, 'new', 'shop.sqlite'), uploadsPath: path.join(f.dir, 'new', 'uploads') };
  restoreFullBackup(f.backup, target);
  assert.equal(databaseValue(target.databasePath), 'backed up');
  unchanged(f.target, () => restoreFullBackup(f.backup, { ...f.target, uploadsPath: f.backup }), /overlap/);
});

test('backup refuses recursive output inside uploads and unlisted backup members', t => {
  const f = fixture(t);
  assert.throws(() => createFullBackup({ databasePath: f.databasePath, uploadsPath: f.uploadsPath, backupRoot: path.join(f.uploadsPath, 'backups') }), /outside the uploads/);
  fs.writeFileSync(path.join(f.backup, 'unlisted.txt'), 'unlisted');
  unchanged(f.target, () => restoreFullBackup(f.backup, f.target), /Unexpected file/);
});

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadEnv } from '../src/env.mjs';

export function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Check each ancestor too: rejecting just the final symlink misses directory links.
export function safePath(file, { type, optional = false } = {}) {
  const absolute = path.resolve(file);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    if (!exists(current)) {
      if (optional) return null;
      throw new Error(`Missing path: ${current}`);
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${current}`);
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Not a directory: ${current}`);
    if (i === parts.length - 1) {
      if (stat.isFile() && stat.nlink !== 1) throw new Error(`Hard-linked files are not allowed: ${current}`);
      if (type === 'file' && !stat.isFile()) throw new Error(`Not a regular file: ${current}`);
      if (type === 'directory' && !stat.isDirectory()) throw new Error(`Not a directory: ${current}`);
      return stat;
    }
  }
  return fs.lstatSync(absolute);
}

export function privateDirectory(dir) {
  safePath(dir, { type: 'directory', optional: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  safePath(dir, { type: 'directory' });
}

export function copyPrivateFile(source, destination) {
  safePath(source, { type: 'file' });
  privateDirectory(path.dirname(destination));
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
}

export function fingerprint(file) {
  safePath(file, { type: 'file' });
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const length = fs.readSync(fd, buffer);
      if (!length) break;
      hash.update(buffer.subarray(0, length));
    }
  } finally { fs.closeSync(fd); }
  return { size: fs.statSync(file).size, sha256: hash.digest('hex') };
}

export function photoTree(root) {
  if (!safePath(root, { type: 'directory', optional: true })) return { present: false, directories: [], files: [] };
  const directories = [], files = [];
  function walk(dir, prefix = '') {
    for (const item of fs.readdirSync(dir).sort()) {
      // Backslashes and colons are ambiguous across Windows and POSIX backups.
      if (!item || /[\\:\u0000-\u001f]/.test(item) || item === '.' || item === '..') throw new Error(`Unsafe upload name: ${item}`);
      const relative = prefix ? `${prefix}/${item}` : item;
      const file = path.join(dir, item);
      const stat = safePath(file);
      if (stat.isDirectory()) { directories.push(relative); walk(file, relative); }
      else if (stat.isFile()) files.push({ path: relative, ...fingerprint(file) });
      else throw new Error(`Unsupported upload entry: ${file}`);
    }
  }
  walk(root);
  return { present: true, directories, files };
}

export function copyPhotos(source, destination, tree = photoTree(source)) {
  if (!tree.present) return;
  privateDirectory(destination);
  for (const dir of tree.directories) privateDirectory(path.join(destination, ...dir.split('/')));
  for (const item of tree.files) copyPrivateFile(path.join(source, ...item.path.split('/')), path.join(destination, ...item.path.split('/')));
  if (JSON.stringify(photoTree(destination)) !== JSON.stringify(tree)) throw new Error('Upload files changed while copying');
}

export function checkDatabase(file) {
  safePath(file, { type: 'file' });
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (exists(file + suffix)) throw new Error(`Unexpected SQLite sidecar: ${file + suffix}`);
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const results = db.prepare('PRAGMA integrity_check').all();
    if (results.length !== 1 || Object.values(results[0])[0] !== 'ok') throw new Error('Backup database failed integrity check');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw new Error('Backup database has no application tables');
  } finally { db.close(); }
}

export function writeManifest(root, { kind = 'full', databasePresent = true } = {}) {
  const manifest = {
    schemaVersion: 1,
    kind,
    createdAt: new Date().toISOString(),
    database: databasePresent ? { file: 'ownertracker.sqlite', ...fingerprint(path.join(root, 'ownertracker.sqlite')) } : null,
    uploads: photoTree(path.join(root, 'uploads')),
    readme: 'Private backup. Stop the server and desktop agent before restoring. Keep encrypted offsite copies.'
  };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return manifest;
}

export function createFullBackup({ databasePath = process.env.OWNERTRACKER_DB || './data/ownertracker.sqlite', uploadsPath = './data/uploads', backupRoot = './backups' } = {}) {
  const source = path.resolve(databasePath), photos = path.resolve(uploadsPath);
  const output = path.resolve(backupRoot);
  function within(file, dir) {
    const relative = path.relative(dir, file);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  }
  if (within(source, photos) || within(output, photos)) throw new Error('Database and backup output must be outside the uploads directory');
  safePath(source, { type: 'file' });
  const tree = photoTree(photos);
  privateDirectory(output);
  const destination = fs.mkdtempSync(path.join(output, 'ownertracker-'));
  fs.chmodSync(destination, 0o700);
  try {
    // A read-only connection avoids migrations or seed writes to the source DB.
    const db = new DatabaseSync(source, { readOnly: true });
    const target = path.join(destination, 'ownertracker.sqlite');
    try { db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`); } finally { db.close(); }
    fs.chmodSync(target, 0o600);
    checkDatabase(target);
    copyPhotos(photos, path.join(destination, 'uploads'), tree);
    writeManifest(destination);
    return destination;
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  loadEnv();
  try { console.log(createFullBackup()); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

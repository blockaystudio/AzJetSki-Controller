import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/env.mjs';
import { exists, safePath, privateDirectory, copyPrivateFile, fingerprint, photoTree, copyPhotos, checkDatabase, writeManifest } from './backup-all.mjs';

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function assertDigest(actual, expected, label) {
  if (!expected || !Number.isSafeInteger(expected.size) || expected.size < 0 || !/^[a-f0-9]{64}$/.test(expected.sha256 || '') || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    throw new Error(`Backup checksum mismatch or invalid manifest: ${label}`);
  }
}

function safeRelative(file) {
  return typeof file === 'string' && file.length > 0 && !/[\\:\u0000-\u001f]/.test(file) && file.split('/').every(part => part && part !== '.' && part !== '..');
}

export function validateBackup(source, { allowLegacy = false, warn = console.warn } = {}) {
  const root = path.resolve(source);
  safePath(root, { type: 'directory' });
  const manifestPath = path.join(root, 'manifest.json');
  const manifestStat = safePath(manifestPath, { type: 'file' });
  if (manifestStat.size > 32 * 1024 * 1024) throw new Error('Backup manifest is too large');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { throw new Error('Invalid backup manifest JSON'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('Invalid backup manifest');
  const members = fs.readdirSync(root).sort();
  if (members.some(name => !['ownertracker.sqlite', 'uploads', 'manifest.json'].includes(name))) throw new Error('Unexpected file in backup directory');
  checkDatabase(path.join(root, 'ownertracker.sqlite'));
  const database = fingerprint(path.join(root, 'ownertracker.sqlite'));
  const uploads = photoTree(path.join(root, 'uploads'));
  if (manifest.schemaVersion === undefined) {
    const legacyIncludes = ['ownertracker.sqlite', 'uploads (if present)'];
    if (!same(manifest.includes, legacyIncludes) || (manifest.readme !== undefined && typeof manifest.readme !== 'string') || Object.keys(manifest).some(key => !['createdAt', 'includes', 'readme'].includes(key))) throw new Error('Invalid legacy backup manifest');
    if (!allowLegacy) throw new Error('Legacy backup has no checksums. Review its origin and use --allow-legacy explicitly');
    warn('WARNING: legacy backup has no checksums; SQLite integrity and upload paths were validated, but historical completeness cannot be verified.');
  } else {
    if (manifest.schemaVersion !== 1 || !['full', 'pre-restore'].includes(manifest.kind) || manifest.database?.file !== 'ownertracker.sqlite') throw new Error('Unsupported or invalid backup manifest');
    assertDigest(database, manifest.database, 'ownertracker.sqlite');
    const expected = manifest.uploads;
    if (!expected || typeof expected.present !== 'boolean' || !Array.isArray(expected.directories) || !Array.isArray(expected.files)) throw new Error('Invalid uploads manifest');
    if (!expected.directories.every(safeRelative) || !expected.files.every(item => item && safeRelative(item.path))) throw new Error('Unsafe path in uploads manifest');
    if (new Set(expected.directories).size !== expected.directories.length || new Set(expected.files.map(item => item.path)).size !== expected.files.length) throw new Error('Duplicate upload manifest entries');
    if (uploads.present !== expected.present || !same(uploads.directories, expected.directories) || !same(uploads.files.map(item => item.path), expected.files.map(item => item.path))) throw new Error('Backup uploads are missing or contain unexpected entries');
    for (let i = 0; i < uploads.files.length; i++) assertDigest(uploads.files[i], expected.files[i], uploads.files[i].path);
  }
  return { root, uploads, database, manifest };
}

function isWithin(file, dir) {
  const relative = path.relative(dir, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function destinationReady(database, uploads) {
  safePath(database, { type: 'file', optional: true });
  safePath(uploads, { type: 'directory', optional: true });
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (exists(database + suffix)) throw new Error(`Stop the server and desktop agent; SQLite sidecar exists: ${database + suffix}`);
  }
}

// rename is injectable so tests can verify rollback after a real partial swap.
export function restoreFullBackup(source, { databasePath = process.env.OWNERTRACKER_DB || './data/ownertracker.sqlite', uploadsPath = './data/uploads', allowLegacy = false, warn = console.warn, rename = fs.renameSync } = {}) {
  const database = path.resolve(databasePath), uploads = path.resolve(uploadsPath);
  const validated = validateBackup(source, { allowLegacy, warn });
  if (isWithin(database, validated.root) || isWithin(uploads, validated.root) || isWithin(validated.root, uploads) || isWithin(database, uploads) || isWithin(uploads, database)) throw new Error('Backup source and destination paths must not overlap');
  destinationReady(database, uploads);
  privateDirectory(path.dirname(database));
  privateDirectory(path.dirname(uploads));
  const id = crypto.randomUUID();
  const dbStage = path.join(path.dirname(database), `.ownertracker-stage-${id}`);
  const photoStage = path.join(path.dirname(uploads), `.ownertracker-photos-${id}`);
  const oldDatabase = path.join(dbStage, 'previous.sqlite');
  const oldPhotos = path.join(photoStage, 'previous-uploads');
  const before = path.join(path.dirname(database), `ownertracker-before-restore-${id}`);
  let oldDbMoved = false, oldPhotosMoved = false, newDbInstalled = false, newPhotosInstalled = false, complete = false, rollbackFailed = false;
  privateDirectory(dbStage);
  privateDirectory(photoStage);
  try {
    copyPrivateFile(path.join(validated.root, 'ownertracker.sqlite'), path.join(dbStage, 'new.sqlite'));
    copyPhotos(path.join(validated.root, 'uploads'), path.join(photoStage, 'new-uploads'), validated.uploads);
    checkDatabase(path.join(dbStage, 'new.sqlite'));
    assertDigest(fingerprint(path.join(dbStage, 'new.sqlite')), validated.database, 'staged database');
    // Retain both original components, including stale photos, before any swap.
    privateDirectory(before);
    const hadDatabase = exists(database);
    const previousDatabase = hadDatabase ? fingerprint(database) : null;
    const previousPhotos = photoTree(uploads);
    if (hadDatabase) {
      copyPrivateFile(database, path.join(before, 'ownertracker.sqlite'));
      assertDigest(fingerprint(path.join(before, 'ownertracker.sqlite')), previousDatabase, 'pre-restore database');
    }
    copyPhotos(uploads, path.join(before, 'uploads'), previousPhotos);
    writeManifest(before, { kind: 'pre-restore', databasePresent: hadDatabase });
    destinationReady(database, uploads);
    if (hadDatabase !== exists(database) || (hadDatabase && !same(fingerprint(database), previousDatabase)) || !same(photoTree(uploads), previousPhotos)) throw new Error('Destination changed while preparing restore; stop all applications before retrying');
    if (hadDatabase) { rename(database, oldDatabase); oldDbMoved = true; }
    if (exists(uploads)) { rename(uploads, oldPhotos); oldPhotosMoved = true; }
    rename(path.join(dbStage, 'new.sqlite'), database); newDbInstalled = true;
    if (validated.uploads.present) { rename(path.join(photoStage, 'new-uploads'), uploads); newPhotosInstalled = true; }
    complete = true;
    return { database, uploads, previous: before };
  } catch (error) {
    const rollbackErrors = [];
    function attempt(action) { try { action(); } catch (failure) { rollbackErrors.push(failure.message); } }
    if (newPhotosInstalled) attempt(() => fs.rmSync(uploads, { recursive: true }));
    if (newDbInstalled) attempt(() => fs.unlinkSync(database));
    if (oldPhotosMoved) attempt(() => fs.renameSync(oldPhotos, uploads));
    if (oldDbMoved) attempt(() => fs.renameSync(oldDatabase, database));
    rollbackFailed = rollbackErrors.length > 0;
    if (rollbackFailed) throw new Error(`${error.message}. Automatic rollback incomplete: ${rollbackErrors.join('; ')}. Preserve ${dbStage}, ${photoStage}, and ${before} for recovery.`);
    throw new Error(`${error.message}. Existing database and photos were preserved${exists(before) ? `; recovery copy: ${before}` : ''}.`);
  } finally {
    if (!rollbackFailed) {
      // Cleanup failures must not turn a successful restore into a false rollback.
      for (const dir of [dbStage, photoStage]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) { warn(`Could not remove private staging directory ${dir}: ${error.message}`); }
      }
    }
    if (!complete && exists(before) && !exists(path.join(before, 'manifest.json'))) warn(`Incomplete pre-restore copy retained at ${before}; existing data was preserved.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  loadEnv();
  const args = process.argv.slice(2), allowLegacy = args.includes('--allow-legacy');
  const sources = args.filter(arg => arg !== '--allow-legacy');
  try {
    if (sources.length !== 1 || sources[0].startsWith('--')) throw new Error('Usage: node scripts/restore-all.mjs PATH_TO_BACKUP [--allow-legacy] (stop server and desktop agent first)');
    const result = restoreFullBackup(sources[0], { allowLegacy });
    console.log('RESTORED', result.database, 'previous database/photos:', result.previous);
    console.log('Restart server, sign in and confirm customers, units, work orders and images.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

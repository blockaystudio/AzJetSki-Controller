import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadEnv } from '../src/env.mjs';
import { configureShopRoster } from '../src/shop-roster.mjs';
import { createFullBackup } from './backup-all.mjs';

process.umask(0o077);
let db;
try {
  const args = process.argv.slice(2);
  let apply = false, envFile;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply' && !apply) apply = true;
    else if (args[index] === '--env' && !envFile && args[index + 1] && !args[index + 1].startsWith('--')) envFile = path.resolve(args[++index]);
    else throw new Error('Usage: node scripts/configure-shop-roster.mjs [--env PRIVATE_ENV_FILE] [--apply]');
  }
  const applicationDirectory = fileURLToPath(new URL('../', import.meta.url));
  process.chdir(applicationDirectory);
  if (envFile && !fs.statSync(envFile).isFile()) throw new Error('Private environment file must be a regular file');
  loadEnv(envFile || '.env');
  // An explicit private env file belongs to its runtime, which can be separate
  // from this source checkout. Resolve its relative data path in that runtime.
  const configurationDirectory = envFile ? path.dirname(envFile) : applicationDirectory;
  const database = fs.realpathSync(path.resolve(configurationDirectory, process.env.OWNERTRACKER_DB || './data/ownertracker.sqlite'));
  const dataDirectory = path.dirname(database);
  if (!fs.statSync(database).isFile()) throw new Error('Existing shop database is required');
  db = new DatabaseSync(database, { readOnly: true });
  const preview = configureShopRoster(db);
  db.close(); db = null;
  if (!apply) console.log(JSON.stringify({ mode: 'dry-run', ...preview }));
  else {
    // No writable database handle or migration is opened before backup succeeds.
    createFullBackup({ databasePath: database, uploadsPath: path.join(dataDirectory, 'uploads'), backupRoot: path.join(dataDirectory, 'backups') });
    db = new DatabaseSync(database);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    console.log(JSON.stringify({ mode: 'applied', backupCreated: true, ...configureShopRoster(db, { apply: true }) }));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { db?.close(); }

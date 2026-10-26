// Run the supplied regressions in a disposable copy, never against shop data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const folders = ['src', 'scripts', 'public', 'test'];

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args.join(' ')} failed (${result.signal || result.status})`);
  }
}

function syntaxFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? syntaxFiles(file) : /\.(mjs|js)$/.test(file) ? [file] : [];
  });
}

try {
  const files = folders.flatMap(folder => syntaxFiles(path.join(root, folder)));
  for (const file of files) run(process.execPath, ['--check', file], root, process.env);
  console.log(`PASS: JavaScript syntax (${files.length} files)`);

  if (!process.argv.includes('--syntax-only')) {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ownertracker-qa-')));
    try {
      for (const folder of folders) fs.cpSync(path.join(root, folder), path.join(sandbox, folder), { recursive: true });
      fs.copyFileSync(path.join(root, 'package.json'), path.join(sandbox, 'package.json'));
      fs.mkdirSync(path.join(sandbox, 'data'));

      // Do not inherit application credentials, .env, target URLs, or live adapters.
      const env = {};
      for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      env.PATH = path.dirname(process.execPath) + path.delimiter + (env.PATH || '');
      env.NODE_ENV = 'test';
      env.LIVE_VENDOR_ORDERING = 'false';
      env.DOCUSIGN_ENABLE_SEND = 'false';
      env.DOCUSIGN_POLICY_APPROVED = 'false';
      env.AUTO_SUPPLIER_LOOKUP = 'false';
      env.REQUIRE_EDIT_REVISION = 'false';
      // Unit tests create their own temporary SQLite files; keep those disposable too.
      env.TMPDIR = env.TMP = env.TEMP = path.join(sandbox, 'tmp');
      fs.mkdirSync(env.TMPDIR);

      run(process.execPath, ['--test', 'test/db.test.mjs', 'test/finance-controls.test.mjs', 'test/finance-ui.test.mjs', 'test/receipts.test.mjs', 'test/backup-restore.test.mjs', 'test/authorizations.test.mjs', 'test/access-security.test.mjs', 'test/customer-access.test.mjs', 'test/edit-revisions.test.mjs', 'test/accounting.test.mjs', 'test/shop-management.test.mjs', 'test/encrypted-backup.test.mjs', 'test/google-calendar-sync.test.mjs', 'test/package-release.test.mjs', 'test/service-notifications.test.mjs', 'test/shop-reports.test.mjs', 'test/shop-launch-api.test.mjs', 'test/purchase-policy.test.mjs', 'test/repair-line-finance.test.mjs', 'test/job-policy.test.mjs', 'test/shop-mail.test.mjs', 'test/inventory-movements.test.mjs', 'test/payment-docs.test.mjs', 'test/billing-ui.test.mjs', 'test/intake-ui.test.mjs', 'test/job-workspace.test.mjs', 'test/account-workspace-ui.test.mjs', 'test/invoice-documents.test.mjs', 'test/setup-server.test.mjs', 'test/retail-fulfillment.test.mjs'], sandbox, env);
      for (const script of ['run-v6.sh', 'run-billing-v9.sh', 'run-v10.sh', 'run-v11.sh']) {
        console.log(`\nRunning ${script}`);
        run('bash', [path.join('test', script)], sandbox, env);
      }
      console.log('\nPASS: financial controls, receipts, recovery and all V6/V8/V9/V10/V11 regressions');
    } catch (error) {
      for (const name of fs.readdirSync(path.join(sandbox, 'data')).filter(name => name.endsWith('.log'))) {
        console.error(`\n${name}:\n${fs.readFileSync(path.join(sandbox, 'data', name), 'utf8')}`);
      }
      throw error;
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

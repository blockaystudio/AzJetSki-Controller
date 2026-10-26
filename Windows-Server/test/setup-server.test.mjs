import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createServerSetup, validateShopDomain} from '../scripts/setup-server.mjs';

test('server setup validates a public DNS name before writing any configuration', () => {
  assert.equal(validateShopDomain('Shop.Example.COM'), 'shop.example.com');
  for (const domain of [undefined, '', 'localhost', '127.0.0.1', '[::1]', 'shop.local', 'shop.test', 'https://shop.example.com', 'shop.example.com:443', 'shop.example.com/path', '*.example.com', 'x\nSECRET=value', ' shop.example.com', '-shop.example.com', 'x..com', 'a'.repeat(64)+'.com']) {
    assert.throws(() => validateShopDomain(domain), /domain/i);
  }
});

test('server bootstrap creates private independent secrets, safe defaults, and refuses overwrite', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ot-server-setup-')));
  try {
    const directory = path.join(root, '.server');
    createServerSetup({domain: 'shop.example.com', directory});
    const envFile = path.join(directory, '.env'), original = fs.readFileSync(envFile, 'utf8');
    const values = Object.fromEntries(original.split('\n').filter(line => line && !line.startsWith('#')).map(line => {const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];}));
    assert.equal(values.PUBLIC_BASE_URL, 'https://shop.example.com');
    assert.match(values.OWNERTRACKER_ADMIN_PASSWORD, /^[a-zA-Z0-9_-]{32}$/);
    const secrets = ['OWNERTRACKER_SESSION_SECRET', 'QBPOS_BRIDGE_TOKEN', 'DESKTOP_AGENT_TOKEN', 'OWNERTRACKER_BACKUP_KEY', 'EMAIL_PREFERENCES_SIGNING_KEY', 'GOOGLE_CALENDAR_TOKEN_KEY'].map(key => values[key]);
    for (const secret of secrets) assert.match(secret, /^[a-f0-9]{64}$/);
    assert.equal(new Set(secrets).size, secrets.length);
    assert.equal(values.AUTO_ENCRYPTED_BACKUP, 'true');
    for (const flag of ['OWNERTRACKER_REVIEW', 'AUTO_SUPPLIER_LOOKUP', 'LIVE_VENDOR_ORDERING', 'DOCUSIGN_ENABLE_SEND', 'DOCUSIGN_POLICY_APPROVED', 'NOTIFICATIONS_AUTO_SEND']) assert.equal(values[flag], 'false');
    const login = fs.readFileSync(path.join(directory, 'owner-login.txt'), 'utf8');
    assert.ok(login.includes(values.OWNERTRACKER_ADMIN_PASSWORD));
    assert.ok(!login.includes(values.OWNERTRACKER_BACKUP_KEY));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      for (const file of ['.env', 'owner-login.txt']) assert.equal(fs.statSync(path.join(directory, file)).mode & 0o777, 0o600);
    }
    assert.throws(() => createServerSetup({domain: 'different.example.com', directory}), /refusing to overwrite/);
    assert.equal(fs.readFileSync(envFile, 'utf8'), original);
    const other = path.join(root, 'other');
    createServerSetup({domain: 'shop.example.com', directory: other});
    assert.notEqual(fs.readFileSync(path.join(other, '.env'), 'utf8'), original);
    if (process.platform !== 'win32') {
      fs.symlinkSync(root, path.join(root, 'link'));
      assert.throws(() => createServerSetup({domain: 'shop.example.com', directory: path.join(root, 'link', 'private')}), /symbolic links/);
    }
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('server setup CLI never prints generated passwords or keys and rejects repeat setup', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ot-server-cli-')));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    const script = path.join(root, 'scripts', 'setup-server.mjs');
    fs.copyFileSync(new URL('../scripts/setup-server.mjs', import.meta.url), script);
    const run = () => spawnSync(process.execPath, [script, '--domain', 'shop.example.com'], {encoding: 'utf8'});
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const env = fs.readFileSync(path.join(root, '.server', '.env'), 'utf8');
    for (const line of env.split('\n').filter(line => /(?:PASSWORD|SECRET|TOKEN|KEY)=.+/.test(line))) assert.ok(!(first.stdout + first.stderr).includes(line.slice(line.indexOf('=') + 1)));
    const second = run();
    assert.equal(second.status, 1);
    assert.match(second.stderr, /refusing to overwrite/);
    assert.equal(fs.readFileSync(path.join(root, '.server', '.env'), 'utf8'), env);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

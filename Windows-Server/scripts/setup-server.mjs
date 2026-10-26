import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const defaultDirectory = fileURLToPath(new URL('../.server/', import.meta.url));

export function validateShopDomain(input) {
  if (typeof input !== 'string' || input !== input.trim()) throw new Error('Supply a domain name without whitespace, a scheme, port, or path.');
  const domain = input.toLowerCase();
  const labels = domain.split('.');
  if (domain.length > 253 || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !/^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/.test(labels.at(-1)) ||
      ['localhost', 'local', 'internal', 'test', 'invalid', 'example'].includes(labels.at(-1))) {
    throw new Error('Supply a public DNS domain such as shop.yourdomain.com, without a scheme, port, or path.');
  }
  return domain;
}

function assertRealParent(directory) {
  const parent = path.dirname(directory), root = path.parse(parent).root;
  let current = root;
  for (const part of parent.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Private setup requires an existing directory without symbolic links.');
  }
}

export function createServerSetup({domain: input, directory = defaultDirectory} = {}) {
  const domain = validateShopDomain(input), destination = path.resolve(directory);
  assertRealParent(destination);
  // Atomic directory creation also rejects existing files, directories, and links.
  try { fs.mkdirSync(destination, {mode: 0o700}); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Private server setup already exists; refusing to overwrite credentials.');
    throw error;
  }
  try {
    fs.chmodSync(destination, 0o700);
    const password = crypto.randomBytes(24).toString('base64url');
    const randomKey = () => crypto.randomBytes(32).toString('hex');
    const environment = [
      '# Private server configuration. Keep an offline recovery copy; never commit or share.',
      `SHOP_DOMAIN=${domain}`,
      `PUBLIC_BASE_URL=https://${domain}`,
      'NODE_ENV=production', 'HOST=0.0.0.0', 'PORT=8787',
      'OWNERTRACKER_DB=/app/data/ownertracker.sqlite',
      'OWNERTRACKER_ADMIN_USER=owner', `OWNERTRACKER_ADMIN_PASSWORD=${password}`,
      `OWNERTRACKER_SESSION_SECRET=${randomKey()}`,
      `QBPOS_BRIDGE_TOKEN=${randomKey()}`, `DESKTOP_AGENT_TOKEN=${randomKey()}`,
      `OWNERTRACKER_BACKUP_KEY=${randomKey()}`,
      `EMAIL_PREFERENCES_SIGNING_KEY=${randomKey()}`,
      `GOOGLE_CALENDAR_TOKEN_KEY=${randomKey()}`,
      "SHOP_NAME='AZ Jet Ski, Boats & Powersports'", 'SHOP_PHONE=602-482-9322',
      'SHOP_LOGO_URL=/brand-logo.png', 'SHOP_LABOR_RATE=140',
      'TRUST_PROXY=true', 'REQUIRE_EDIT_REVISION=true',
      'OWNERTRACKER_REVIEW=false', 'QBPOS_IMPORT_MODE=disabled',
      'AUTO_BUILD_PROCUREMENT=true', 'AUTO_SUPPLIER_LOOKUP=false', 'LIVE_VENDOR_ORDERING=false',
      'DOCUSIGN_MODE=disabled', 'DOCUSIGN_ENABLE_SEND=false', 'DOCUSIGN_POLICY_APPROVED=false',
      'NOTIFICATIONS_AUTO_SEND=false',
      'AUTO_ENCRYPTED_BACKUP=true', 'BACKUP_INTERVAL_HOURS=24', 'BACKUP_RETAIN_COUNT=30',
      'BACKUP_OFFSITE_URL=', 'BACKUP_OFFSITE_TOKEN=',
      'ORDER_OUTBOX_DIR=/app/data/order-manifests', ''
    ].join('\n');
    fs.writeFileSync(path.join(destination, '.env'), environment, {flag: 'wx', mode: 0o600});
    fs.writeFileSync(path.join(destination, 'owner-login.txt'), [
      'Private initial owner login — save in the shop password manager.',
      `URL: https://${domain}`, 'Username: owner', `Password: ${password}`, '',
      'Keep a separate offline copy of .env, especially OWNERTRACKER_BACKUP_KEY.',
      'The login password initializes only a new database. Changing .env does not reset an existing owner.',
      'Use the application to change the password and update the password manager.', ''
    ].join('\n'), {flag: 'wx', mode: 0o600});
    return {directory: destination, domain};
  } catch (error) {
    fs.rmSync(destination, {recursive: true, force: true});
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--domain') throw new Error('Usage: node scripts/setup-server.mjs --domain shop.yourdomain.com');
    const result = createServerSetup({domain: args[1]});
    console.log(`Created private server configuration in ${result.directory}.`);
    console.log('Save owner-login.txt and an offline recovery copy of .env securely. No secrets were printed.');
    console.log('Follow docs/SERVER_DEPLOYMENT.md before starting the public server.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

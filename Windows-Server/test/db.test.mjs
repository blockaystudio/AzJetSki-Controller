import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, hashPassword, verifyPassword } from '../src/db.mjs';

test('password hashing', () => {
  const x = hashPassword('abc123');
  assert.equal(verifyPassword('abc123', x.salt, x.hash), true);
  assert.equal(verifyPassword('bad', x.salt, x.hash), false);
});

test('V5 schema initializes with workflow and procurement tables', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-'));
  const db = openDb(path.join(d, 'x.sqlite'));
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name));
  for (const table of [
    'work_orders', 'approvals', 'users', 'work_order_updates', 'media',
    'vendors', 'part_requirements', 'supplier_offers', 'part_vendor_map',
    'procurement_carts', 'procurement_cart_lines'
  ]) assert.ok(names.has(table), `missing ${table}`);
});

test('V5 seeds shop supplier thresholds', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-'));
  const db = openDb(path.join(d, 'x.sqlite'));
  const vendors = Object.fromEntries(db.prepare('SELECT code, order_threshold FROM vendors').all().map(v => [v.code, v.order_threshold]));
  assert.equal(vendors.WSM, 100);
  assert.equal(vendors.PU, 0);
  assert.equal(vendors.TMS, 0);
  assert.equal(vendors.BRP, 250);
});

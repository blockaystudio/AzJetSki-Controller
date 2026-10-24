import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
export function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function tableColumns(db, table) { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name)); }
function addColumn(db, table, definition) {
  const name = definition.trim().split(/\s+/)[0];
  if (!tableColumns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL DEFAULT 'manual',
      external_id TEXT,
      ref_number TEXT,
      customer_external_id TEXT,
      customer_name TEXT,
      phone TEXT,
      email TEXT,
      unit_label TEXT,
      year TEXT,
      make TEXT,
      model TEXT,
      serial TEXT,
      complaint TEXT,
      authorized_work TEXT,
      qb_status TEXT,
      stage TEXT NOT NULL DEFAULT 'Intake',
      estimate_total REAL NOT NULL DEFAULT 0,
      parts_total REAL NOT NULL DEFAULT 0,
      labor_total REAL NOT NULL DEFAULT 0,
      paid_total REAL NOT NULL DEFAULT 0,
      balance REAL NOT NULL DEFAULT 0,
      tech TEXT,
      date_opened TEXT,
      date_closed TEXT,
      time_modified TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_orders_stage ON work_orders(stage);
    CREATE INDEX IF NOT EXISTS idx_work_orders_updated ON work_orders(updated_at);
    CREATE TABLE IF NOT EXISTS work_order_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
      line_type TEXT,
      item_ref TEXT,
      description TEXT,
      qty REAL NOT NULL DEFAULT 0,
      rate REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'sent',
      choice TEXT,
      signer_name TEXT,
      signed_at TEXT,
      authorized_description TEXT,
      external_envelope_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER REFERENCES work_orders(id) ON DELETE SET NULL,
      event TEXT NOT NULL,
      destination TEXT,
      status TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      imported_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER REFERENCES work_orders(id) ON DELETE SET NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS work_order_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
      author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      author_name TEXT NOT NULL,
      title TEXT,
      body TEXT,
      stage TEXT,
      customer_visible INTEGER NOT NULL DEFAULT 1,
      notify_customer INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_updates_work_order ON work_order_updates(work_order_id, id DESC);

    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
      update_id INTEGER REFERENCES work_order_updates(id) ON DELETE SET NULL,
      approval_id INTEGER REFERENCES approvals(id) ON DELETE SET NULL,
      scope TEXT NOT NULL DEFAULT 'progress',
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      caption TEXT,
      customer_visible INTEGER NOT NULL DEFAULT 1,
      uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_media_work_order ON media(work_order_id, id DESC);

    CREATE TABLE IF NOT EXISTS customer_portal_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_portal_work_order ON customer_portal_tokens(work_order_id, active);

    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      order_threshold REAL NOT NULL DEFAULT 0,
      auto_submit INTEGER NOT NULL DEFAULT 0,
      integration_mode TEXT NOT NULL DEFAULT 'manual_portal',
      portal_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      settings_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS part_requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'qbpos',
      source_key TEXT NOT NULL,
      item_ref TEXT,
      description TEXT NOT NULL,
      qty_needed REAL NOT NULL DEFAULT 1,
      qty_on_hand REAL NOT NULL DEFAULT 0,
      qty_ordered REAL NOT NULL DEFAULT 0,
      qty_received REAL NOT NULL DEFAULT 0,
      sell_price REAL NOT NULL DEFAULT 0,
      qb_cost REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'needs_source',
      preferred_vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
      preferred_vendor_sku TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(work_order_id, source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_part_req_status ON part_requirements(status, active);

    CREATE TABLE IF NOT EXISTS supplier_offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_requirement_id INTEGER NOT NULL REFERENCES part_requirements(id) ON DELETE CASCADE,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
      vendor_sku TEXT,
      available_qty REAL NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0,
      eta_text TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(part_requirement_id, vendor_id, vendor_sku)
    );

    CREATE TABLE IF NOT EXISTS part_vendor_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_item_ref TEXT NOT NULL,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
      vendor_sku TEXT NOT NULL,
      last_unit_cost REAL NOT NULL DEFAULT 0,
      times_used INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shop_item_ref, vendor_id, vendor_sku)
    );
    CREATE INDEX IF NOT EXISTS idx_part_vendor_map_item ON part_vendor_map(shop_item_ref, times_used DESC);

    CREATE TABLE IF NOT EXISTS procurement_carts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      status TEXT NOT NULL DEFAULT 'draft',
      total REAL NOT NULL DEFAULT 0,
      threshold_snapshot REAL NOT NULL DEFAULT 0,
      auto_submit_snapshot INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      order_reference TEXT,
      external_order_id TEXT,
      tracking_number TEXT,
      eta_text TEXT,
      integration_result TEXT,
      submitted_at TEXT,
      received_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_carts_status ON procurement_carts(status, vendor_id);

    CREATE TABLE IF NOT EXISTS procurement_cart_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cart_id INTEGER NOT NULL REFERENCES procurement_carts(id) ON DELETE CASCADE,
      part_requirement_id INTEGER NOT NULL REFERENCES part_requirements(id) ON DELETE CASCADE,
      work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
      vendor_sku TEXT,
      description TEXT,
      qty REAL NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      available_qty REAL NOT NULL DEFAULT 0,
      eta_text TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(cart_id, part_requirement_id)
    );
  `);

  addColumn(db, 'users', 'display_name TEXT');
  addColumn(db, 'users', 'active INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'users', 'pin_hash TEXT');
  addColumn(db, 'users', 'pin_salt TEXT');
  addColumn(db, 'users', 'last_login_at TEXT');
  addColumn(db, 'users', 'updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP');
  addColumn(db, 'work_orders', 'assigned_user_id INTEGER REFERENCES users(id)');
  addColumn(db, 'work_orders', 'priority TEXT NOT NULL DEFAULT \'normal\'');
  addColumn(db, 'work_orders', 'promised_date TEXT');
  addColumn(db, 'work_orders', 'next_action TEXT');
  addColumn(db, 'work_orders', 'next_action_due TEXT');

  const vendorSeed = db.prepare(`INSERT OR IGNORE INTO vendors(code,name,order_threshold,auto_submit,integration_mode,portal_url) VALUES(?,?,?,?,?,?)`);
  vendorSeed.run('WSM','WSM Parts',100,1,'manual_portal','https://www.wsmparts.com/');
  vendorSeed.run('PU','Parts Unlimited',0,1,'parts_unlimited_api','https://dealer.parts-unlimited.com/login');
  vendorSeed.run('TMS','TMS Parts',0,1,'manual_portal','https://www.tmsparts.com/');
  vendorSeed.run('BRP','BRP Dealer Parts',250,1,'approved_dms_or_portal','https://www.brp.com/');

  return db;
}

export function ensureAdmin(db, username, password) {
  const existing = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (existing) return;
  if (!password || password.startsWith('CHANGE_ME')) throw new Error('Set OWNERTRACKER_ADMIN_PASSWORD before first start.');
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO users(username,display_name,password_hash,salt,role,active) VALUES(?,?,?,?,?,1)').run(username, 'Owner', hash, salt, 'owner');
}

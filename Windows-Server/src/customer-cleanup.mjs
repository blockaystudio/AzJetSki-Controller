const quoted = name => '"' + name.replaceAll('"', '""') + '"';
const contactName = name => /phone|e_?mail|address|mailing|postal|(^|_)(city|state|zip(code)?|country|fax)(_|$)/i.test(name);

function contactlessPlan(db) {
  const columns = db.prepare('PRAGMA table_info(customers)').all().map(column => column.name);
  if (!['id', 'archived', 'phone', 'email', 'address'].every(name => columns.includes(name))) {
    throw new Error('Existing customer directory with contact and archive fields is required');
  }
  // Include structured service/billing addresses and any additional contact
  // columns. Partial addresses, malformed phones and emails still count as
  // contact; cleanup must never decide whether an existing value is usable.
  const fields = columns.filter(contactName);
  const rows = [];
  let activeCustomers = 0;
  for (const row of db.prepare(`SELECT id,${fields.map(quoted).join(',')} FROM customers WHERE archived=0`).iterate()) {
    activeCustomers++;
    if (fields.every(field => String(row[field] ?? '').trim() === '')) rows.push(row.id);
  }
  return { rows, fields, summary: { activeCustomers, eligible: rows.length, retainedWithContact: activeCustomers - rows.length } };
}

export function previewContactlessCustomers(db) { return contactlessPlan(db).summary; }

// Archive only: historical work orders, receipts, vehicles and immutable
// original-ID mappings retain their customer IDs. Each change has a reversible
// archived=0 -> archived=1 audit entry and remains in the pre-cleanup backup.
export function archiveContactlessCustomers(db, { apply = false, actor = 'customer-cleanup' } = {}) {
  if (!apply) return { ...previewContactlessCustomers(db), archived: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    const plan = contactlessPlan(db);
    const archive = db.prepare('UPDATE customers SET archived=1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND archived=0');
    const audit = db.prepare('INSERT INTO audit_log(actor,action,detail) VALUES(?,?,?)');
    for (const id of plan.rows) {
      if (archive.run(id).changes !== 1) throw new Error('Customer directory changed during cleanup');
      audit.run(String(actor), 'Contactless customer archived', JSON.stringify({
        customerId: id, previousArchived: 0, archived: 1, contactFieldsChecked: plan.fields
      }));
    }
    db.exec('COMMIT');
    return { ...plan.summary, archived: plan.rows.length };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

import crypto from 'node:crypto';
const has=(db,table)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const str=v=>String(v??'').trim();
const digest=row=>crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
const contact=row=>[str(row.name).toLowerCase().replace(/\s+/g,' '),str(row.email).toLowerCase(),str(row.phone).replace(/\D/g,'')];
export function planLegacyCustomers(db,archive){
 if(archive.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Archive integrity check failed');
 const rows=archive.prepare('SELECT * FROM customers ORDER BY ListID').all(),ids=new Set();
 const links=has(db,'legacy_customer_links')?new Map(db.prepare('SELECT * FROM legacy_customer_links').all().map(r=>[r.external_id,r])):new Map();
 const existing=db.prepare('SELECT id,name,email,phone FROM customers').all();
 const contacts=new Map();for(const row of existing){const [name,email,phone]=contact(row);for(const value of [email&&name+'|e|'+email,phone&&name+'|p|'+phone].filter(Boolean)){if(!contacts.has(value))contacts.set(value,[]);contacts.get(value).push(row.id);}}
 const plan={rows:[],create:0,alreadyImported:0,conflicts:0,changedSource:0,total:rows.length};
 for(const row of rows){const externalId=row.ListID;if(typeof externalId!=='string'||!externalId||ids.has(externalId))throw Error('Source customer identifiers must be unique nonempty text');ids.add(externalId);const fingerprint=digest(row),prior=links.get(externalId);if(prior){if(prior.source_hash!==fingerprint)plan.changedSource++;else plan.alreadyImported++;continue;}
 const name=str(row.FullName)||[row.FirstName,row.LastName].map(str).filter(Boolean).join(' ')||str(row.CompanyName)||'Legacy customer '+externalId;
 const values={name,phone:str(row.Phone),email:str(row.EMail),address:str(row.BillAddress_Street),address_line1:str(row.BillAddress_Street),city:str(row.BillAddress_City),state:str(row.BillAddress_State),postal_code:str(row.BillAddress_PostalCode),notes:str(row.Notes),billing_same_as_service:1};
 const [normalized,email,phone]=contact(values);const candidates=new Set([...(email?contacts.get(normalized+'|e|'+email)||[]:[]),...(phone?contacts.get(normalized+'|p|'+phone)||[]:[])]);
 if(candidates.size){plan.conflicts++;continue;}
 plan.rows.push({externalId,fingerprint,values});plan.create++;
 }
 return plan;
}
export function importLegacyCustomers(db,archive,{apply=false,actor='owner migration'}={}){
 const plan=planLegacyCustomers(db,archive);const summary=({rows,...summary})=>summary;
 if(!apply)return summary(plan);
 if(plan.conflicts||plan.changedSource)throw Error('Customer collisions or changed imported source rows require reviewed mapping before import');
 db.exec('BEGIN IMMEDIATE');try{
  // Re-read after acquiring the write lock to prevent overlapping imports.
  const locked=planLegacyCustomers(db,archive);if(locked.conflicts||locked.changedSource)throw Error('Import changed during review');
  db.exec(`CREATE TABLE IF NOT EXISTS legacy_customer_links(external_id TEXT PRIMARY KEY,customer_id INTEGER NOT NULL UNIQUE REFERENCES customers(id),source_hash TEXT NOT NULL,imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);CREATE TRIGGER IF NOT EXISTS legacy_customer_links_no_update BEFORE UPDATE ON legacy_customer_links BEGIN SELECT RAISE(ABORT,'Legacy customer mapping is retained');END;CREATE TRIGGER IF NOT EXISTS legacy_customer_links_no_delete BEFORE DELETE ON legacy_customer_links BEGIN SELECT RAISE(ABORT,'Legacy customer mapping is retained');END;`);
  for(const row of locked.rows){const fields=Object.keys(row.values);const result=db.prepare(`INSERT INTO customers(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).run(...Object.values(row.values));db.prepare('INSERT INTO legacy_customer_links(external_id,customer_id,source_hash) VALUES(?,?,?)').run(row.externalId,Number(result.lastInsertRowid),row.fingerprint);}
  if(locked.create)db.prepare('INSERT INTO audit_log(actor,action,detail) VALUES(?,?,?)').run(actor,'Recovered POS customers imported',JSON.stringify(summary(locked)));
  db.exec('COMMIT');return summary(locked);
 }catch(error){db.exec('ROLLBACK');throw error;}
}

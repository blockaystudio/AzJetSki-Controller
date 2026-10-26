// Identity corrections are limited to untouched intake records. Issued links,
// retained documents and operational history must continue to name their party.
import crypto from 'node:crypto';

export const jobIdentityFields = Object.freeze(['customer_id','vehicle_id','customer_external_id','customer_name','unit_label','year','make','model','serial']);
const fail = (status,message) => {const error=new Error(message);error.status=status;throw error;};
const exists = (db,table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const normalized = (key,value) => key.endsWith('_id') && key!=='customer_external_id' ? Number(value)||null : String(value??'');
export function jobIdentityFingerprint(job) {
  return crypto.createHash('sha256').update(JSON.stringify(jobIdentityFields.map(key=>normalized(key,job[key])))).digest('hex');
}

export function assertJobIdentityChange(db,current,changes) {
  if(!current)fail(404,'Work order not found');
  const changed=jobIdentityFields.filter(key=>Object.hasOwn(changes,key)&&normalized(key,current[key])!==normalized(key,changes[key]));
  if(!changed.length)return false;
  let protectedHistory=current.stage!=='Intake'||Number(current.paid_total)!==0;
  for(const table of ['customer_portal_tokens','approvals','ot_invoices','ot_signature_packets','pos_payments','notes','work_order_updates','media','work_order_lines','part_requirements','custody_events']) {
    if(exists(db,table)&&db.prepare(`SELECT 1 FROM ${table} WHERE work_order_id=? LIMIT 1`).get(current.id)){protectedHistory=true;break;}
  }
  if(exists(db,'unit_custody')&&db.prepare('SELECT 1 FROM unit_custody WHERE work_order_id=? OR (vehicle_id=? AND status=\'in_lot\') LIMIT 1').get(current.id,current.vehicle_id||null))protectedHistory=true;
  for(const table of ['finance_events','accounting_credits']) {
    if(exists(db,table)&&db.prepare(`SELECT 1 FROM ${table} WHERE scope='repair' AND entity_id=? LIMIT 1`).get(current.id))protectedHistory=true;
  }
  if(db.prepare("SELECT 1 FROM audit_log WHERE work_order_id=? AND action NOT IN ('Created work order','Edited work order','Work order updated','Job identity corrected') LIMIT 1").get(current.id))protectedHistory=true;
  for(const entry of db.prepare("SELECT detail FROM audit_log WHERE work_order_id=? AND action IN ('Edited work order','Work order updated')").all(current.id)) {
    try {const detail=JSON.parse(entry.detail);if(detail.stage&&detail.stage!=='Intake')protectedHistory=true;}
    catch {protectedHistory=true;}
  }
  if(protectedHistory)fail(409,'Customer or unit cannot be reassigned after links, documents, payments, custody or work history exist. Preserve this job and open the correct job.');
  return true;
}

export function assertJobStageChange(current,nextStage) {
  if(nextStage===undefined||nextStage===current?.stage)return;
  if(['Picked Up','Closed'].includes(nextStage))fail(409,'Use the vehicle checkout operation to complete pickup after Ready status and payment settlement.');
  if(['Picked Up','Closed'].includes(current?.stage))fail(409,'A completed job cannot be reopened by a stage edit. Check in the unit and open a new repair.');
}

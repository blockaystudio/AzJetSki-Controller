import crypto from 'node:crypto';

const roles = new Set(['owner', 'manager', 'service_writer', 'advisor']);
const closedStages = new Set(['Closed', 'Picked Up', 'Declined']);
const fail = (status, message, extra = {}) => { throw Object.assign(Error(message), {status, ...extra}); };
const idOf = (value, name) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) fail(400, `${name} is required.`);
  return id;
};
const jobUrl = id => `/?view=workorders&workOrderId=${id}`;
const checkinUrl = (job, appointment) => `/vehicle-checkin.html?workOrderId=${job}&appointmentId=${appointment}`;
const hashBody = body => crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries([
  'customer_id', 'vehicle_id', 'ref_number', 'complaint', 'authorized_work', 'stage', 'estimate_total', 'priority', 'assigned_user_id'
].map(key => [key, body[key] ?? null])))).digest('hex');

export function installCalendarIntake(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS appointment_intake_links (
    appointment_id INTEGER PRIMARY KEY REFERENCES shop_appointments(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
    work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
    creation_fingerprint TEXT NOT NULL DEFAULT '',
    prepared_by INTEGER NOT NULL REFERENCES users(id),
    prepared_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS appointment_intake_job ON appointment_intake_links(work_order_id);
  CREATE TRIGGER IF NOT EXISTS appointment_intake_link_no_update BEFORE UPDATE ON appointment_intake_links
    BEGIN SELECT RAISE(ABORT,'Appointment intake links are retained'); END;
  CREATE TRIGGER IF NOT EXISTS appointment_intake_link_no_delete BEFORE DELETE ON appointment_intake_links
    BEGIN SELECT RAISE(ABORT,'Appointment intake links are retained'); END;`);
}

function transaction(db, action) {
  const nested = db.isTransaction;
  db.exec(nested ? 'SAVEPOINT calendar_intake' : 'BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec(nested ? 'RELEASE calendar_intake' : 'COMMIT');
    return result;
  } catch (error) {
    db.exec(nested ? 'ROLLBACK TO calendar_intake' : 'ROLLBACK');
    if (nested) db.exec('RELEASE calendar_intake');
    throw error;
  }
}

function appointment(db, id) {
  const row = db.prepare('SELECT * FROM shop_appointments WHERE id=?').get(id);
  if (!row) fail(404, 'Appointment not found.');
  return row;
}

function exactCustomerUnit(db, row, customerId, vehicleId) {
  if (row.status !== 'scheduled') fail(409, 'This appointment is no longer scheduled. Review the calendar before preparing intake.');
  if (!row.customer_id || Number(row.customer_id) !== customerId) fail(409, 'Choose the customer saved on this appointment.');
  const customer = db.prepare('SELECT * FROM customers WHERE id=? AND archived=0').get(customerId);
  if (!customer) fail(409, 'The appointment customer is unavailable. Review the customer directory.');
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id=? AND customer_id=? AND archived=0').get(vehicleId, customerId);
  if (!vehicle || (row.vehicle_id && Number(row.vehicle_id) !== vehicleId)) fail(409, 'The vehicle must match this appointment and its customer.');
  return {customer, vehicle};
}

function exactJob(db, link) {
  const job = db.prepare('SELECT * FROM work_orders WHERE id=? AND customer_id=? AND vehicle_id=?').get(link.work_order_id, link.customer_id, link.vehicle_id);
  if (!job) fail(409, 'The saved appointment repair no longer matches its customer and vehicle. Review the job before continuing.');
  return job;
}

function storeLink(db, user, row, job, fingerprint = '') {
  db.prepare('INSERT INTO appointment_intake_links(appointment_id,customer_id,vehicle_id,work_order_id,creation_fingerprint,prepared_by) VALUES(?,?,?,?,?,?)')
    .run(row.id, job.customer_id, job.vehicle_id, job.id, fingerprint, user.id);
  db.prepare('INSERT INTO audit_log(work_order_id,actor,action,detail) VALUES(?,?,?,?)').run(job.id, user.username, 'Appointment intake prepared', JSON.stringify({appointmentId:row.id,customerId:job.customer_id,vehicleId:job.vehicle_id,workOrderId:job.id,physicalCheckIn:false}));
}

// Called by the normal create-repair endpoint. Both repair creation and its
// appointment link commit together; retries cannot create a second repair.
export function createAppointmentJob(db, user, appointmentId, body, createFn) {
  if (!roles.has(user?.role)) fail(user ? 403 : 401, 'Service desk access is required.');
  installCalendarIntake(db);
  return transaction(db, () => {
    const row = appointment(db, idOf(appointmentId, 'Appointment'));
    const customerId = idOf(body.customer_id, 'Customer'), vehicleId = idOf(body.vehicle_id, 'Vehicle');
    exactCustomerUnit(db, row, customerId, vehicleId);
    const fingerprint = hashBody(body);
    const existing = db.prepare('SELECT * FROM appointment_intake_links WHERE appointment_id=?').get(row.id);
    if (existing) {
      const job = exactJob(db, existing);
      if (existing.customer_id !== customerId || existing.vehicle_id !== vehicleId || existing.creation_fingerprint !== fingerprint)
        fail(409, 'This appointment already has a saved repair. Open that repair before starting another intake.', {existingJobId:job.id});
      return {id:job.id,ref_number:job.ref_number,appointmentId:row.id,duplicate:true};
    }
    const custody = db.prepare("SELECT * FROM unit_custody WHERE vehicle_id=? AND status='in_lot'").get(vehicleId);
    if (custody?.work_order_id) fail(409, 'This vehicle is already on site for another repair. Review the lot and saved jobs first.', {existingJobId:custody.work_order_id});
    const created = createFn();
    if (created?.then) throw Error('Appointment repair creation must complete inside its database transaction.');
    const job = db.prepare('SELECT * FROM work_orders WHERE id=? AND customer_id=? AND vehicle_id=?').get(idOf(created?.id, 'Saved repair'), customerId, vehicleId);
    if (!job || closedStages.has(job.stage)) fail(409, 'The saved repair must match this appointment customer and vehicle and remain open.');
    storeLink(db, user, row, job, fingerprint);
    return {...created,appointmentId:row.id,duplicate:false};
  });
}

export function linkAppointmentJob(db, user, appointmentId, body) {
  if (!roles.has(user?.role)) fail(user ? 403 : 401, 'Service desk access is required.');
  return transaction(db, () => {
    const row = appointment(db, idOf(appointmentId, 'Appointment'));
    const customerId = idOf(body.customerId, 'Customer'), vehicleId = idOf(body.vehicleId, 'Vehicle'), workOrderId = idOf(body.workOrderId, 'Repair');
    exactCustomerUnit(db, row, customerId, vehicleId);
    const existing = db.prepare('SELECT * FROM appointment_intake_links WHERE appointment_id=?').get(row.id);
    if (existing) {
      const job = exactJob(db, existing);
      if (existing.customer_id !== customerId || existing.vehicle_id !== vehicleId || existing.work_order_id !== workOrderId)
        fail(409, 'This appointment is already prepared for another saved repair. Reload its saved details.', {existingJobId:job.id});
      return {ok:true,duplicate:true,workOrderId:job.id,checkinUrl:checkinUrl(job.id,row.id)};
    }
    const job = db.prepare('SELECT * FROM work_orders WHERE id=? AND customer_id=? AND vehicle_id=?').get(workOrderId, customerId, vehicleId);
    if (!job || closedStages.has(job.stage)) fail(409, 'Choose an open saved repair for this exact customer and vehicle.');
    storeLink(db, user, row, job);
    return {ok:true,duplicate:false,workOrderId:job.id,checkinUrl:checkinUrl(job.id,row.id)};
  });
}

export function appointmentIntakeContext(db, appointmentId) {
  const row = appointment(db, idOf(appointmentId, 'Appointment'));
  const customer = row.customer_id ? db.prepare('SELECT * FROM customers WHERE id=? AND archived=0').get(row.customer_id) || null : null;
  const vehicles = customer ? db.prepare('SELECT * FROM vehicles WHERE customer_id=? AND archived=0 ORDER BY id DESC').all(customer.id) : [];
  const link = db.prepare('SELECT * FROM appointment_intake_links WHERE appointment_id=?').get(row.id);
  const vehicle = vehicles.find(v => v.id === Number(row.vehicle_id || link?.vehicle_id)) || null;
  let blockedReason = '';
  if (row.status !== 'scheduled') blockedReason = 'This appointment is no longer scheduled.';
  else if (!customer) blockedReason = 'Choose an active customer in the calendar before preparing intake.';
  else if (row.vehicle_id && !vehicle) blockedReason = 'The appointment vehicle does not belong to this active customer. Review the calendar record.';
  let linkedJob = null;
  if (link) {
    if (!customer || link.customer_id !== customer.id || !vehicle || link.vehicle_id !== vehicle.id) blockedReason = 'The saved preparation no longer matches the appointment customer and vehicle. Review the calendar record.';
    else {
      try { linkedJob = exactJob(db, link); }
      catch (error) { blockedReason = error.message; }
    }
  }
  const jobs = customer ? db.prepare(`SELECT id,ref_number,stage,customer_id,vehicle_id,complaint,unit_label,year,make,model FROM work_orders
    WHERE customer_id=? AND stage NOT IN ('Closed','Picked Up','Declined') ${vehicle ? 'AND vehicle_id=?' : ''} ORDER BY id DESC`)
    .all(...(vehicle ? [customer.id,vehicle.id] : [customer.id])).filter(job => vehicles.some(v => v.id === job.vehicle_id)) : [];
  const custody = vehicle ? db.prepare('SELECT vehicle_id,work_order_id,status,checked_in_at,lot_location,keys_tag FROM unit_custody WHERE vehicle_id=?').get(vehicle.id) || null : null;
  const prepared = link ? {appointment_id:link.appointment_id,customer_id:link.customer_id,vehicle_id:link.vehicle_id,work_order_id:link.work_order_id,prepared_by:link.prepared_by,prepared_at:link.prepared_at} : null;
  return {
    appointment:{...row,work_order_id:linkedJob?.id || null}, customer, vehicle, vehicles, jobs, linkedJob, custody,
    preparation:prepared, canPrepare:!blockedReason, blockedReason,
    intakeUrl:`/intake.html?appointmentId=${row.id}`,
    jobUrl:linkedJob ? jobUrl(linkedJob.id) : null,
    checkinUrl:linkedJob && !closedStages.has(linkedJob.stage) ? checkinUrl(linkedJob.id,row.id) : null,
    physicalCheckIn:custody?.status === 'in_lot',
    sync:{hasGoogleEvent:!!row.google_event_id,status:row.sync_status || 'local_only',syncedAt:row.synced_at || null}
  };
}

export function phoenixDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'America/Phoenix',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}

export function calendarIntakeRoutes({db,currentUser,json,readBody}) {
  installCalendarIntake(db);
  return async (req, res, pathname, url) => {
    const match = pathname.match(/^\/api\/shop\/schedule\/(\d+)\/(intake-context|intake-job)$/);
    if (pathname !== '/api/shop/calendar-arrivals' && !match) return false;
    const respond = (status, body) => { json(res,status,body,{'cache-control':'no-store'}); return true; };
    const user = currentUser(req);
    if (!roles.has(user?.role)) return respond(user ? 403 : 401,{error:user ? 'Service desk access is required.' : 'Unauthorized'});
    try {
      if (pathname === '/api/shop/calendar-arrivals' && req.method === 'GET') {
        const date = url.searchParams.get('date') || phoenixDate();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date+'T00:00:00-07:00')) || new Date(date+'T00:00:00Z').toISOString().slice(0,10) !== date)
          fail(400, 'Choose a valid calendar date.');
        const start = new Date(date+'T00:00:00-07:00'), end = new Date(start.getTime()+86400000);
        const rows = db.prepare("SELECT id FROM shop_appointments WHERE status='scheduled' AND julianday(starts_at)>=julianday(?) AND julianday(starts_at)<julianday(?) ORDER BY julianday(starts_at),id").all(start.toISOString(),end.toISOString());
        return respond(200,{date,timeZone:'America/Phoenix',source:'saved_ownertracker_appointments',appointments:rows.map(row => appointmentIntakeContext(db,row.id)),notice:'Preparing an appointment does not check in a vehicle. Only confirmed physical check-in records place it in the lot.'});
      }
      if (match?.[2] === 'intake-context' && req.method === 'GET') return respond(200,appointmentIntakeContext(db,Number(match[1])));
      if (match?.[2] === 'intake-job' && req.method === 'POST') return respond(200,linkAppointmentJob(db,user,Number(match[1]),await readBody(req)));
      return respond(405,{error:'Method not allowed.'});
    } catch (error) { return respond(error.status || 500,{error:error.status ? error.message : 'Unable to prepare this appointment.',...(error.existingJobId ? {existingJobId:error.existingJobId} : {})}); }
  };
}

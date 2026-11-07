import crypto from 'node:crypto';

export const checkinParkingLocations = Object.freeze(['Dirt lot', 'Front lot']);
export const checkinChecklist = Object.freeze([
  {key:'identityConfirmed', label:'Match the customer, repair and VIN on this unit.'},
  {key:'exteriorReviewed', label:'Walk around the unit and record its condition before service.'},
  {key:'belongingsRecorded', label:'Record accessories, loose items and customer belongings in the notes.'},
  {key:'keysRecorded', label:'Record the key / lanyard tag, or write “No keys”.'}
]);
const roles = new Set(['owner','manager','service_writer','advisor','technician']);
const fail = (status,message) => {throw Object.assign(new Error(message),{status});};
const clean = (value,limit) => String(value ?? '').trim().slice(0,limit);
const requestKey = value => {
  if(typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(value)) fail(400,'A valid retry key is required');
  return value;
};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const imageSignatureMatches=(bytes,mimeType)=>{
  if(mimeType==='image/png')return bytes.length>=24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16)==='IHDR';
  if(mimeType==='image/jpeg')return bytes.length>=12 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
  return bytes.length>=16 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP';
};

export function installVehicleCheckins(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS vehicle_checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_order_id INTEGER NOT NULL UNIQUE REFERENCES work_orders(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','completed')),
    version INTEGER NOT NULL DEFAULT 1,
    lot_location TEXT NOT NULL DEFAULT '', keys_tag TEXT NOT NULL DEFAULT '',
    condition_notes TEXT NOT NULL DEFAULT '', checklist_json TEXT NOT NULL DEFAULT '{}',
    create_request_key TEXT NOT NULL UNIQUE, complete_request_key TEXT UNIQUE,
    created_by INTEGER NOT NULL REFERENCES users(id), completed_by INTEGER REFERENCES users(id),
    custody_event_id INTEGER REFERENCES custody_events(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS vehicle_checkin_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checkin_id INTEGER NOT NULL REFERENCES vehicle_checkins(id),
    media_id INTEGER NOT NULL UNIQUE REFERENCES media(id),
    request_key TEXT NOT NULL UNIQUE, payload_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_checkin_vehicle ON vehicle_checkins(vehicle_id);
  CREATE TRIGGER IF NOT EXISTS vehicle_checkin_completed_immutable
    BEFORE UPDATE ON vehicle_checkins WHEN OLD.status='completed'
    BEGIN SELECT RAISE(ABORT,'Completed check-in is retained'); END;
  CREATE TRIGGER IF NOT EXISTS vehicle_checkin_completed_retained
    BEFORE DELETE ON vehicle_checkins WHEN OLD.status='completed'
    BEGIN SELECT RAISE(ABORT,'Completed check-in is retained'); END;
  CREATE TRIGGER IF NOT EXISTS vehicle_checkin_photo_retained
    BEFORE DELETE ON vehicle_checkin_photos
    BEGIN SELECT RAISE(ABORT,'Check-in photo is retained'); END;
  CREATE TRIGGER IF NOT EXISTS vehicle_checkin_photo_immutable
    BEFORE UPDATE ON vehicle_checkin_photos
    BEGIN SELECT RAISE(ABORT,'Check-in photo is retained'); END;
  CREATE TRIGGER IF NOT EXISTS vehicle_checkin_photo_closed
    BEFORE INSERT ON vehicle_checkin_photos
    WHEN (SELECT status FROM vehicle_checkins WHERE id=NEW.checkin_id)='completed'
    BEGIN SELECT RAISE(ABORT,'Completed check-in photos are retained'); END;
  CREATE TRIGGER IF NOT EXISTS vehicle_checkin_photo_binding
    BEFORE INSERT ON vehicle_checkin_photos
    WHEN NOT EXISTS(SELECT 1 FROM media m JOIN vehicle_checkins c ON c.id=NEW.checkin_id
      WHERE m.id=NEW.media_id AND m.work_order_id=c.work_order_id AND m.scope='checkin' AND m.customer_visible=0)
    BEGIN SELECT RAISE(ABORT,'Check-in photo must remain internal to this repair'); END;
  CREATE TRIGGER IF NOT EXISTS vehicle_checkin_media_immutable
    BEFORE UPDATE ON media WHEN EXISTS(SELECT 1 FROM vehicle_checkin_photos p WHERE p.media_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'Check-in photo is retained and internal'); END;
  CREATE TRIGGER IF NOT EXISTS vehicle_checkin_media_retained
    BEFORE DELETE ON media WHEN EXISTS(SELECT 1 FROM vehicle_checkin_photos p WHERE p.media_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'Check-in photo is retained and internal'); END;`);
}

export function vehicleCheckinRoutes({db,currentUser,json,readBody,saveImage,canAccessJob}) {
  installVehicleCheckins(db);
  const record = id => {
    const row=db.prepare('SELECT * FROM vehicle_checkins WHERE id=?').get(id);
    if(!row)return null;
    const {checklist_json,create_request_key,complete_request_key,...view}=row;
    return {...view,checklist:JSON.parse(checklist_json),photos:db.prepare(`SELECT m.id,m.caption,m.original_name,m.mime_type,m.size_bytes,m.created_at
      FROM vehicle_checkin_photos p JOIN media m ON m.id=p.media_id WHERE p.checkin_id=? ORDER BY p.id`).all(id).map(photo=>({...photo,url:`/api/media/${photo.id}`}))};
  };
  const identity = (workOrderId,user,{allowClosed=false}={}) => {
    const job=db.prepare('SELECT * FROM work_orders WHERE id=?').get(workOrderId);
    if(!job)fail(404,'Repair not found');
    if(user.role==='technician' && Number(job.assigned_user_id)!==Number(user.id))fail(403,'Not assigned to this repair');
    if(canAccessJob && !canAccessJob(user,job.id))fail(403,'Not assigned to this repair');
    const customer=db.prepare('SELECT * FROM customers WHERE id=?').get(job.customer_id);
    const vehicle=db.prepare('SELECT * FROM vehicles WHERE id=?').get(job.vehicle_id);
    if(!customer || !vehicle || Number(vehicle.customer_id)!==Number(job.customer_id))fail(409,'Repair must link to this exact customer and vehicle; reconcile the saved records first');
    if(!allowClosed && (customer.archived || vehicle.archived || ['Picked Up','Closed','Declined'].includes(job.stage)))fail(409,'Check-in is unavailable for an archived customer, archived unit or closed repair');
    return {job,customer,vehicle};
  };
  const assertBinding = (row,context) => {
    if(row.customer_id!==context.customer.id || row.vehicle_id!==context.vehicle.id)fail(409,'Repair ownership changed. Review the retained check-in before continuing');
  };
  const audit=(user,action,row,detail={})=>db.prepare('INSERT INTO audit_log(work_order_id,actor,action,detail) VALUES(?,?,?,?)')
    .run(row.work_order_id,user.username,action,JSON.stringify({checkinId:row.id,vehicleId:row.vehicle_id,...detail}));
  const transaction=action=>{db.exec('BEGIN IMMEDIATE');try{const result=action();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
  return async (req,res,p,url) => {
    if(!p.startsWith('/api/vehicle-checkins'))return false;
    const respond=(status,body)=>{json(res,status,body,{'cache-control':'no-store'});return true;};
    const user=currentUser(req);
    if(!user)return respond(401,{error:'Unauthorized'});
    if(!roles.has(user.role))return respond(403,{error:'Permission denied'});
    try {
      if(p==='/api/vehicle-checkins/context' && req.method==='GET') {
        const workOrderId=Number(url.searchParams.get('workOrderId'));
        if(!Number.isSafeInteger(workOrderId)||workOrderId<1)fail(400,'Choose a saved repair first');
        const context=identity(workOrderId,user,{allowClosed:true});
        const existing=db.prepare('SELECT id FROM vehicle_checkins WHERE work_order_id=?').get(workOrderId);
        return respond(200,{...context,custody:db.prepare('SELECT * FROM unit_custody WHERE vehicle_id=?').get(context.vehicle.id)||null,
          checkin:existing?record(existing.id):null,checklist:checkinChecklist,parkingLocations:checkinParkingLocations,minimumPhotos:2});
      }
      if(p==='/api/vehicle-checkins' && req.method==='POST') {
        const body=await readBody(req,16_000),key=requestKey(body.requestKey);
        const workOrderId=Number(body.workOrderId),context=identity(workOrderId,user,{allowClosed:true});
        if(Number(body.customerId)!==context.customer.id || Number(body.vehicleId)!==context.vehicle.id)fail(409,'Confirm the exact customer, vehicle and repair before check-in');
        const existing=db.prepare('SELECT * FROM vehicle_checkins WHERE work_order_id=? OR create_request_key=?').all(workOrderId,key);
        if(existing.some(row=>row.work_order_id!==workOrderId))fail(409,'Retry key belongs to another repair');
        if(existing.length){assertBinding(existing[0],context);return respond(200,{checkin:record(existing[0].id),replayed:true});}
        identity(workOrderId,user);
        const custody=db.prepare('SELECT * FROM unit_custody WHERE vehicle_id=?').get(context.vehicle.id);
        if(custody?.status==='in_lot' && custody.work_order_id!==workOrderId)fail(409,'Unit is already on site under another repair. Review the lot record first');
        const id=transaction(()=>{
          const result=db.prepare('INSERT INTO vehicle_checkins(work_order_id,customer_id,vehicle_id,create_request_key,created_by,lot_location,keys_tag) VALUES(?,?,?,?,?,?,?)')
            .run(workOrderId,context.customer.id,context.vehicle.id,key,user.id,checkinParkingLocations.includes(custody?.lot_location)?custody.lot_location:'',custody?.keys_tag||'');
          const id=Number(result.lastInsertRowid);audit(user,'Vehicle check-in draft opened',{id,work_order_id:workOrderId,vehicle_id:context.vehicle.id});return id;
        });
        return respond(201,{checkin:record(id)});
      }
      const match=p.match(/^\/api\/vehicle-checkins\/(\d+)(?:\/(photos|complete))?$/);
      if(!match)return respond(404,{error:'Check-in route not found'});
      const id=Number(match[1]),action=match[2];
      let row=db.prepare('SELECT * FROM vehicle_checkins WHERE id=?').get(id);
      if(!row)fail(404,'Check-in not found');
      const context=identity(row.work_order_id,user,{allowClosed:true});assertBinding(row,context);
      // Request bodies can arrive concurrently. Re-read after that await so a
      // second device cannot complete or overwrite an earlier record version.
      const refresh=()=>{row=db.prepare('SELECT * FROM vehicle_checkins WHERE id=?').get(id);if(!row)fail(404,'Check-in not found');assertBinding(row,identity(row.work_order_id,user,{allowClosed:true}));};
      if(!action && req.method==='GET')return respond(200,{checkin:record(id)});
      if(!action && req.method==='PATCH') {
        const body=await readBody(req,20_000);
        refresh();
        identity(row.work_order_id,user);
        if(row.status!=='draft')fail(409,'Completed check-in is retained and cannot be edited');
        if(body.version!==row.version)fail(409,'Check-in changed on another device. Reload the saved draft before editing');
        const lotLocation=clean(body.lotLocation,80);
        if(lotLocation && !checkinParkingLocations.includes(lotLocation))fail(400,'Choose Dirt lot or Front lot');
        const checklist=Object.fromEntries(checkinChecklist.map(({key})=>[key,body.checklist?.[key]===true]));
        db.prepare(`UPDATE vehicle_checkins SET lot_location=?,keys_tag=?,condition_notes=?,checklist_json=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='draft' AND version=?`)
          .run(lotLocation,clean(body.keysTag,80),clean(body.conditionNotes,4000),JSON.stringify(checklist),id,row.version);
        return respond(200,{checkin:record(id)});
      }
      if(action==='photos' && req.method==='POST') {
        const body=await readBody(req,12_000_000),key=requestKey(body.requestKey);
        refresh();
        const payload={filename:clean(body.filename,200),mimeType:clean(body.mimeType,80),dataBase64:String(body.dataBase64||''),caption:clean(body.caption,500)};
        const hash=digest(payload),prior=db.prepare('SELECT * FROM vehicle_checkin_photos WHERE request_key=?').get(key);
        if(prior){if(prior.checkin_id!==id || prior.payload_sha256!==hash)fail(409,'Photo retry differs from the saved photo');return respond(200,{checkin:record(id),mediaId:prior.media_id,replayed:true});}
        identity(row.work_order_id,user);
        if(row.status!=='draft')fail(409,'Completed check-in photos are retained and cannot be changed');
        if(db.prepare('SELECT COUNT(*) n FROM vehicle_checkin_photos WHERE checkin_id=?').get(id).n>=20)fail(400,'A check-in can hold up to 20 photos');
        if(!['image/jpeg','image/png','image/webp'].includes(payload.mimeType))fail(400,'Only JPEG, PNG, and WebP images are accepted');
        const bytes=Buffer.from(payload.dataBase64.replace(/^data:[^;]+;base64,/,''),'base64');
        if(!bytes.length || bytes.length>8_000_000)fail(400,'Photo must contain an image up to 8 MB');
        if(!imageSignatureMatches(bytes,payload.mimeType))fail(400,'Photo contents do not match a supported image format');
        const mediaId=transaction(()=>{
          const mediaId=saveImage({...payload,workOrderId:row.work_order_id,scope:'checkin',customerVisible:false,userId:user.id});
          db.prepare('INSERT INTO vehicle_checkin_photos(checkin_id,media_id,request_key,payload_sha256) VALUES(?,?,?,?)').run(id,mediaId,key,hash);
          audit(user,'Before-service photo retained',row,{mediaId});return mediaId;
        });
        return respond(201,{checkin:record(id),mediaId});
      }
      if(action==='complete' && req.method==='POST') {
        const body=await readBody(req,16_000),key=requestKey(body.requestKey);
        refresh();
        if(row.status==='completed') {
          if(row.complete_request_key!==key)fail(409,'Check-in is already complete. Reload its retained record');
          return respond(200,{checkin:record(id),replayed:true});
        }
        identity(row.work_order_id,user);
        if(body.version!==row.version)fail(409,'Check-in changed on another device. Reload before completing');
        if(!checkinParkingLocations.includes(row.lot_location))fail(400,'Choose Dirt lot or Front lot');
        if(!row.keys_tag || !row.condition_notes)fail(400,'Record the key / lanyard tag and condition notes, including belongings or none');
        const checklist=JSON.parse(row.checklist_json);
        if(checkinChecklist.some(({key})=>checklist[key]!==true))fail(400,'Complete every check-in checklist item');
        if(db.prepare('SELECT COUNT(*) n FROM vehicle_checkin_photos WHERE checkin_id=?').get(id).n<2)fail(400,'Take at least two before-service photos, including front and rear');
        transaction(()=>{
          const custody=db.prepare('SELECT * FROM unit_custody WHERE vehicle_id=?').get(row.vehicle_id);
          if(custody?.status==='in_lot' && custody.work_order_id!==row.work_order_id)fail(409,'Unit is already on site under another repair. Review the lot record first');
          const alreadyInLot=custody?.status==='in_lot';
          if(alreadyInLot) db.prepare('UPDATE unit_custody SET lot_location=?,keys_tag=? WHERE vehicle_id=?').run(row.lot_location,row.keys_tag,row.vehicle_id);
          else db.prepare(`INSERT INTO unit_custody(vehicle_id,work_order_id,status,checked_in_at,checked_out_at,lot_location,keys_tag,checked_in_by,checked_out_by)
            VALUES(?,?,'in_lot',CURRENT_TIMESTAMP,NULL,?,?,?,NULL)
            ON CONFLICT(vehicle_id) DO UPDATE SET work_order_id=excluded.work_order_id,status='in_lot',checked_in_at=CURRENT_TIMESTAMP,checked_out_at=NULL,lot_location=excluded.lot_location,keys_tag=excluded.keys_tag,checked_in_by=excluded.checked_in_by,checked_out_by=NULL`)
              .run(row.vehicle_id,row.work_order_id,row.lot_location,row.keys_tag,user.id);
          const event=db.prepare('INSERT INTO custody_events(vehicle_id,work_order_id,action,actor_id,location,keys_tag,notes) VALUES(?,?,?,?,?,?,?)')
            .run(row.vehicle_id,row.work_order_id,alreadyInLot?'check_in_documented':'check_in',user.id,row.lot_location,row.keys_tag,row.condition_notes);
          db.prepare("UPDATE vehicle_checkins SET status='completed',complete_request_key=?,completed_by=?,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,version=version+1,custody_event_id=? WHERE id=? AND status='draft'")
            .run(key,user.id,Number(event.lastInsertRowid),id);
          audit(user,'Vehicle check-in completed',row,{lotLocation:row.lot_location,existingArrival:alreadyInLot});
        });
        return respond(200,{checkin:record(id)});
      }
      return respond(405,{error:'Method not allowed'});
    } catch(error) {return respond(error.status||400,{error:error.status?error.message:'Check-in could not be saved; review the saved draft and retry'});}
  };
}

import {DatabaseSync} from 'node:sqlite';import crypto from 'node:crypto';
const db=new DatabaseSync(process.env.OWNERTRACKER_DB);
const cart=db.prepare('SELECT id FROM procurement_carts ORDER BY id LIMIT 1').get();
const payload={vendor:'WSM',cartId:cart.id,lines:[{sku:'QA-EXAMPLE',description:'Safe agent receiver test (no purchase)',workOrder:'QA-106',qty:1,unitCost:10}],total:10,reviewedBy:'owner',reviewedAt:new Date().toISOString()};
const raw=JSON.stringify(payload),uuid=crypto.randomUUID(),sha=crypto.createHash('sha256').update(raw).digest('hex');
db.prepare('INSERT INTO purchase_commands(command_uuid,cart_id,reviewed_by,snapshot_json,snapshot_sha256) VALUES(?,?,?,?,?)').run(uuid,cart.id,1,raw,sha);db.close();
console.log('Added test desktop command',uuid);

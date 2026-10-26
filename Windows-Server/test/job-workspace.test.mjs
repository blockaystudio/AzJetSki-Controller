import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizationSummary,financialSummary,nextJobAction,pickupEligibility,createUnsavedGuard,jobUrl} from '../public/job-workspace.js';

test('historical approval and an Approved stage never establish approval of the current scope',()=>{
  const job={id:7,stage:'Approved',estimate_total:240,approvals:[{status:'completed',choice:'Approve Repairs'}]};
  assert.equal(authorizationSummary(null,job).approved,false);
  assert.equal(authorizationSummary({hasCurrentRepairAuthorization:false},job).amount,null);
  assert.deepEqual(authorizationSummary({hasCurrentRepairAuthorization:true},job),{approved:true,label:'Current repair approval',amount:240});
  assert.equal(nextJobAction(job,financialSummary(job,{balance:240}),authorizationSummary(null,job)).tab,'estimate');
});

test('the header uses authoritative credits, net paid and refund due without counting pending funds',()=>{
  const job={estimate_total:125,paid_total:0,balance:125};
  const summary=financialSummary(job,{originalTotal:125,credits:25,total:100,paid:115,pending:30,balance:0,refundDue:15});
  assert.deepEqual(summary,{available:true,original:125,credits:25,total:100,paid:115,pending:30,due:0,refund:15});
  assert.equal(nextJobAction({...job,stage:'Ready'},summary,{approved:true}).label,'Review refund owed');
  assert.deepEqual(financialSummary(job,null),{available:false,original:125});
});

test('contextual pickup needs this exact job and unit, Ready, and no balance or refund owed',()=>{
  const job={id:7,vehicle_id:9,stage:'Ready'};
  const row={work_order_id:7,vehicle_id:9,stage:'Ready',balance:0,refundDue:0};
  const check=override=>pickupEligibility(job,{inLot:[{...row,...override}]}).allowed;
  assert.equal(check({}),true);
  for(const override of [{work_order_id:8},{vehicle_id:10},{stage:'In Progress'},{balance:0.01},{refundDue:0.01}])assert.equal(check(override),false);
  assert.equal(pickupEligibility({...job,stage:'Picked Up'},{inLot:[]}).allowed,false);
});

function guardFixture(confirmation=false){
  const fields=[{name:'message',type:'textarea',value:'Existing note'},{name:'notify',type:'checkbox',checked:false},{name:'photo',type:'file',files:[]}];
  const form={elements:fields,closest:()=>form},events=new Map(),messages=[];
  const root={querySelectorAll:()=>[form],addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
  const guard=createUnsavedGuard(root,{confirmLeave:message=>{messages.push(message);return confirmation;}});
  return {fields,form,events,root,messages,guard};
}

test('unsaved text, checkboxes and attachments block departure; reverting and acknowledged saves clear it',async()=>{
  const {fields,form,events,root,messages,guard}=guardFixture();
  assert.equal(guard.canLeave(),true);
  fields[0].value='Unsaved note';assert.equal(guard.canLeave(),false);assert.equal(guard.canSwitch(root),false);
  fields[0].value='Existing note';assert.equal(guard.dirty().length,0);
  fields[1].checked=true;assert.equal(guard.canLeave(),false);guard.markSaved(form);assert.equal(guard.canLeave(),true);
  fields[2].files=[{name:'finding.jpg',size:1234,lastModified:6}];assert.equal(guard.canLeave(),false);
  events.get('workspace:saved')({target:form});fields[2].files=[];await Promise.resolve();assert.equal(guard.canLeave(),true);
  assert.ok(messages.some(message=>message.includes('edits will stay')));
  guard.destroy();assert.equal(events.size,0);
});

test('accepting a tab switch preserves unsaved edits so later navigation still requires a decision',()=>{
  const {fields,root,messages,guard}=guardFixture(true);
  fields[0].value='Keep this draft';assert.equal(guard.canSwitch(root),true);assert.equal(guard.dirty().length,1);
  assert.equal(guard.canLeave(),true);assert.equal(messages.length,2);assert.equal(guard.dirty().length,1);
});

test('drafts restored after an unrelated financial save remain guarded until they are saved',()=>{
  const {form,events,guard}=guardFixture();
  events.get('workspace:restored')({target:form});
  assert.equal(guard.canLeave(),false);
  events.get('workspace:saved')({target:form});
  assert.equal(guard.canLeave(),true);
});

test('job URLs retain identity and only allow supported tabs',()=>{
  assert.equal(jobUrl(7,'payments'),'/?view=workorders&workOrderId=7&tab=payments');
  assert.equal(jobUrl(7,'<script>'),'/?view=workorders&workOrderId=7&tab=overview');
});

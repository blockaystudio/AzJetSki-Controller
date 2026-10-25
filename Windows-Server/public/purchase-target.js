export function makePurchaseTarget(kind,vendorId,cartId,lines){
 return {kind,vendorId:Number(vendorId),cartId:Number(cartId),lines:lines.map(line=>({
  id:Number(line.lineId??line.id),sku:String(line.vendor_sku??line.sku??''),description:String(line.description??''),
  quantity:Number(line.qty??line.quantity),unitCostCents:Number(line.unitCostCents??line.unit_cost_cents??Math.round(Number(line.unit_cost??line.unitCost)*100)),
  workOrderId:Number(line.work_order_id??line.workOrderId??0),retailOrderId:Number(line.retail_order_id??line.orderId??0)
 })).sort((a,b)=>a.id-b.id)};
}
export function mountPurchaseApproval(form,{target,totalCents,workOrderIds=[]}){
 const label=document.createElement('label');label.className='field ops-field';label.textContent='Approved purchase request number (when required)';
 const input=document.createElement('input');input.name='purchaseApprovalId';input.type='number';input.min='1';input.className='ops-input';label.append(input);
 const request=document.createElement('button');request.type='button';request.className='btn ops-button ops-secondary';request.textContent='Request independent purchase approval';
 const message=document.createElement('p');message.setAttribute('role','status');
 form.append(label,request,message);
 request.onclick=async()=>{
  const reason=prompt('Explain this purchase for the approving owner or manager:');if(!reason?.trim())return;
  request.disabled=true;
  try{const response=await fetch('/api/management/purchase-requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({totalCents,workOrderIds,context:'purchase',target,reason:reason.trim(),idempotencyKey:crypto.randomUUID()})});const result=await response.json();if(!response.ok)throw Error(result.error||'Unable to request approval');const row=result.request||result;input.value=row.id;message.textContent=`Request #${row.id} created. A different owner or manager must approve these exact lines in Management before you queue them.`;}catch(error){message.textContent=error.message;}finally{request.disabled=false;}
 };
 return ()=>input.value?Number(input.value):undefined;
}

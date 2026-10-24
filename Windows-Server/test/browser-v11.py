from playwright.sync_api import sync_playwright
import json
base='http://127.0.0.1:18992'
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
 page=browser.new_page(viewport={'width':390,'height':844},device_scale_factor=1)
 errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(base+'/shop-ops.html')
 page.locator('#opsLogin [name=username]').fill('owner')
 page.locator('#opsLogin [name=password]').fill('Test-Owner-Password-2395!')
 page.locator('#opsLogin button').click()
 page.get_by_text('Shop Operations').wait_for()
 assert page.get_by_text('Ready for Pickup').count()>=1 or page.get_by_text('Ready & Paid').count()>=1
 labels=['In the Lot','Checked-In Customers','Retail Parts Orders','Parts Carts','Scheduling','Purchase Exceptions','Inventory','Shop Queues']
 for label in labels:
  page.locator('.ops-tabs').get_by_role('button',name=label).click()
  page.wait_for_timeout(180)
  assert page.locator('#ops-main').inner_text().strip(),label
  assert not page.get_by_text('Unable to load shop operations').count(),label
 print('PASS: all eight Shop Ops navigation tabs render on 390px iPhone viewport')
 # create customer and vehicle via authenticated fetch from browser; exercises server CRUD and dependent dropdown
 data=page.evaluate('''async()=>{
  const send=async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return r.json()};
  const customer=(await send('/api/pos/customers',{name:'Mobile Browser QA',address_line1:'101 Test Road',city:'Phoenix',state:'AZ',postal_code:'85027'})).customer;
  const vehicle=(await send('/api/pos/vehicles',{customer_id:customer.id,make:'Yamaha',model:'FX Cruiser',year:'2024'})).vehicle;
  return {customer,vehicle};}''')
 page.locator('.ops-tabs').get_by_role('button',name='In the Lot').click()
 page.locator('#checkIn [name=vehicleId]').select_option(str(data['vehicle']['id']))
 page.locator('#checkIn [name=lotLocation]').fill('BAY 12')
 page.locator('#checkIn [name=keysTag]').fill('KEY-88')
 page.locator('#checkIn button').click()
 page.get_by_text('BAY 12').wait_for(timeout=5000)
 print('PASS: check-in form creates visible on-lot vehicle')
 page.locator('.ops-tabs').get_by_role('button',name='Checked-In Customers').click()
 assert page.get_by_text('Mobile Browser QA').count()>0
 print('PASS: checked-in customers UI shows current customer')
 page.locator('.ops-tabs').get_by_role('button',name='Retail Parts Orders').click()
 page.locator('#newRetail [name=customerId]').select_option(str(data['customer']['id']))
 page.locator('#newRetail button').click()
 page.get_by_text('Special order opened').wait_for(timeout=5000)
 page.locator('#retailAdd [name=description]').fill('Premium drive belt')
 page.locator('#retailAdd [name=quantity]').fill('1')
 page.locator('#retailAdd [name=unitCost]').fill('50.00')
 page.locator('#retailAdd [name=unitPrice]').fill('88.00')
 page.locator('#retailAdd button').click()
 page.get_by_text('Premium drive belt').wait_for()
 print('PASS: phone UI creates retail-only special order and line without requiring a vehicle')
 page.locator('.ops-tabs').get_by_role('button',name='Scheduling').click()
 assert page.get_by_text('Google Calendar not connected').count()>0
 print('PASS: scheduling shows accurate disconnected state')
 page.screenshot(path='/mnt/data/OwnerTracker-V11/iPhone-Shop-Ops-V11.png',full_page=True)
 assert errors==[],f'JS errors: {errors}'
 print('PASS: no client-side JavaScript exceptions')
 browser.close()

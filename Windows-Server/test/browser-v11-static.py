from playwright.sync_api import sync_playwright
from urllib.parse import urlparse
from pathlib import Path
import json
root=Path(__file__).resolve().parent.parent/'public'
files={'/shop-ops.html':'shop-ops.html','/shop-ops.js':'shop-ops.js','/styles.css':'styles.css','/brand-logo.png':'brand-logo.png'}
def response(route):
 url=urlparse(route.request.url)
 if url.path in files:
  path=root/files[url.path];ctype='text/html' if path.suffix=='.html' else 'text/css' if path.suffix=='.css' else 'text/javascript' if path.suffix=='.js' else 'image/png';return route.fulfill(status=200,body=path.read_bytes(),content_type=ctype)
 if url.path=='/api/me':return route.fulfill(status=200,body=json.dumps({'user':{'username':'owner','displayName':'Demo Owner','role':'owner'},'roles':['owner','advisor']}),content_type='application/json')
 if url.path=='/api/shop/queues':return route.fulfill(status=200,body=json.dumps({'readyForPickup':[],'paymentPending':[],'inLot':[],'checkedInCustomers':[],'retailReadyForPickup':[],'retailPaymentPending':[]}),content_type='application/json')
 if url.path=='/api/pos/vehicles':return route.fulfill(status=200,body=json.dumps({'vehicles':[]}),content_type='application/json')
 if url.path=='/api/work-orders':return route.fulfill(status=200,body=json.dumps({'workOrders':[]}),content_type='application/json')
 if url.path=='/api/pos/customers':return route.fulfill(status=200,body=json.dumps({'customers':[]}),content_type='application/json')
 if url.path=='/api/vendors':return route.fulfill(status=200,body=json.dumps({'vendors':[]}),content_type='application/json')
 if url.path=='/api/shop/retail-orders':return route.fulfill(status=200,body=json.dumps({'orders':[]}),content_type='application/json')
 if url.path=='/api/shop/retail-carts':return route.fulfill(status=200,body=json.dumps({'carts':[]}),content_type='application/json')
 if url.path=='/api/shop/schedule':return route.fulfill(status=200,body=json.dumps({'appointments':[],'googleCalendar':{'configured':False,'connected':False}}),content_type='application/json')
 if url.path=='/api/shop/purchase-exceptions':return route.fulfill(status=200,body=json.dumps({'repairWithoutInvoiceOrApproval':[],'retailWithoutInvoice':[],'total':0}),content_type='application/json')
 if url.path=='/api/pos/purchase-commands':return route.fulfill(status=200,body=json.dumps({'commands':[]}),content_type='application/json')
 if url.path=='/api/shop/inventory':return route.fulfill(status=200,body=json.dumps({'stock':[],'history':[],'restock':[]}),content_type='application/json')
 if url.path=='/api/shop/readiness':return route.fulfill(status=200,body=json.dumps({'checks':[{'id':'test','label':'Live test','next':'Verify hardware','state':'requires_live_certification'}],'pendingRetailDesktopCommands':0,'approvedRestocksNotPurchased':0,'productionCertified':False}),content_type='application/json')
 return route.fulfill(status=404,body='{}',content_type='application/json')
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
 page=browser.new_page(viewport={'width':390,'height':844})
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('**/*',response)
 try:
  page.goto('https://ownertracker.test/shop-ops.html',wait_until='domcontentloaded',timeout=10000)
  page.get_by_text('Shop Operations').wait_for(timeout=8000)
  buttons=page.locator('.ops-tabs button');n=buttons.count();print('tabs:',n)
  for index in range(n):
   buttons=page.locator('.ops-tabs button');name=buttons.nth(index).inner_text();buttons.nth(index).click();page.wait_for_timeout(80)
   assert page.locator('#ops-main').inner_text().strip(),name
   print('PASS UI tab:',name)
  page.screenshot(path='/mnt/data/OwnerTracker-V11/OwnerTracker-V11-Mobile-Preview.png',full_page=True)
  assert not errors,errors
  print('PASS: browser mock-driven mobile interactions and JS execution')
 except Exception as e:
  print('BLOCKED:',str(e)[:300]);raise
 finally: browser.close()

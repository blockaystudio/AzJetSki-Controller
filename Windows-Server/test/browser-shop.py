"""Disposable Chromium acceptance: real server, fictional seed, no shop data/providers.
Run: python test/browser-shop.py (requires playwright + Chromium).
"""
import json
import hashlib
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect
from browser_workspace import run_workspace_journeys, responsive
from browser_operations import run_operations_journeys

SOURCE = Path(__file__).resolve().parents[1]
NODE = os.environ.get('OWNERTRACKER_NODE', 'node')
ARTIFACTS = Path(os.environ.get('OWNERTRACKER_BROWSER_ARTIFACTS', tempfile.mkdtemp(prefix='ownertracker-browser-artifacts-')))
ARTIFACTS.mkdir(parents=True, exist_ok=True)
PASSWORD = 'Review-Only-2026!'


def session_headers(page):
    # Chromium permits Secure cookies on trustworthy loopback origins. The
    # Playwright request client does not, so forward this disposable session.
    return {'cookie': '; '.join(f'{cookie["name"]}={cookie["value"]}' for cookie in page.context.cookies())}


def api(page, path, method='GET', body=None):
    response = page.request.fetch(page.url.split('/', 3)[0] + '//' + page.url.split('/', 3)[2] + path, method=method, data=body, headers=session_headers(page))
    value = response.json()
    assert response.ok, (path, response.status, value)
    return value


def no_overflow(page, label):
    dimensions = page.evaluate('''()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth})''')
    assert dimensions['document'] <= dimensions['viewport'] + 1, (label, dimensions)


def visit(page, base, route, ready):
    page.goto(base + route)
    page.locator(ready).first.wait_for()
    page.wait_for_timeout(100)


def run(base):
    with sync_playwright() as playwright:
        executable = os.environ.get('OWNERTRACKER_BROWSER')
        if not executable and not Path(playwright.chromium.executable_path).exists() and Path('/usr/bin/chromium').exists():
            executable = '/usr/bin/chromium'
        browser = playwright.chromium.launch(headless=True, executable_path=executable, args=['--no-sandbox', '--disable-dev-shm-usage'])
        context = browser.new_context(reduced_motion='reduce')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(base)
        page.get_by_label('Employee username').fill('owner')
        page.get_by_label('Password or employee PIN', exact=True).fill(PASSWORD)
        page.get_by_role('button', name='Sign in', exact=True).click()
        page.get_by_role('heading', name='Today', exact=True).wait_for()
        routes = [('/', '#view .metrics'), ('/billing.html', '#jobinfo b'), ('/shop-ops.html', '#ops-main'), ('/shop-management.html', '#policy'), ('/accounting.html', '#workspace:not([hidden])'), ('/shop-reports.html', '#report .card'), ('/owner.html', '#mobile-app .daily-actions'), ('/tech.html', '.listing'), ('/launch.html', '#security form')]
        for width in [390, 768, 1440]:
            page.set_viewport_size({'width': width, 'height': 900})
            print(f'Checking viewport {width}', flush=True)
            for route, ready in routes:
                visit(page, base, route, ready)
                no_overflow(page, f'{route} at {width}')
                if route == '/':
                    assert page.get_by_role('link', name='New Repair / Check In').count() == 1
                    assert page.get_by_role('link', name='New Counter Sale').count() == 1
                    actions = page.locator('.daily-action').evaluate_all('(nodes)=>nodes.map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height,bg:getComputedStyle(n).backgroundColor}))')
                    assert actions[0] == actions[1], actions
                    assert page.locator('.daily-nav>a').count() == 6
                    assert page.locator('#todayCounterSales').is_visible()
                    assert page.locator('#todayCounterSales a[href*="retailId"]').count() >= 1
                    assert page.locator('#view').evaluate('(node)=>getComputedStyle(node).animationName') == 'none'
                    page.screenshot(path=str(ARTIFACTS / f'today-{width}.png'), full_page=True)
                if route == '/shop-ops.html':
                    for tab in ['lot', 'customers', 'retail', 'carts', 'schedule', 'risk', 'stock', 'readiness']:
                        page.locator(f'[data-tab="{tab}"]').click()
                        page.locator('#ops-main').wait_for()
                        page.wait_for_timeout(70)
                        no_overflow(page, f'operations/{tab} at {width}')
                    page.screenshot(path=str(ARTIFACTS / f'inventory-{width}.png'), full_page=True)
                if route == '/shop-management.html':
                    for tab in ['receiving', 'communications', 'schedule', 'connections']:
                        page.locator(f'[data-tab="{tab}"]').click()
                        no_overflow(page, f'management/{tab} at {width}')
        # Guided repair intake, contextual accounts and retained approvals use the real server.
        run_workspace_journeys(page, base, ARTIFACTS, api, no_overflow)
        # Keyboard navigation remains available from the work-order list.
        visit(page, base, '/?view=workorders', '#list a.job-link')
        link = page.locator('#list a.job-link').first
        link.focus()
        assert link.evaluate('(e)=>getComputedStyle(e).outlineStyle') != 'none'
        link.press('Enter')
        page.locator('#edit').wait_for()
        no_overflow(page, 'job keyboard detail')
        # Clear and race billing selections while financial requests are pending.
        visit(page, base, '/billing.html', '#jobinfo b')
        ids = page.locator('#jobs option').evaluate_all('(items)=>items.map(x=>x.value).filter(Boolean)')
        page.locator('#jobs').select_option('')
        assert page.locator('#invoiceForm button').is_disabled()
        assert page.locator('#signForm button').is_disabled()
        assert page.locator('#recipient').input_value() == ''
        assert page.locator('#payForm [name=amount]').input_value() == ''
        posts = []
        page.on('request', lambda r: posts.append(r.url) if r.method == 'POST' and ('/invoice' in r.url or '/docusign' in r.url) else None)
        page.locator('#invoiceForm').evaluate('(form)=>form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
        page.wait_for_timeout(150)
        assert not posts, posts
        pending = []
        page.route('**/api/work-orders/' + ids[0], lambda route: pending.append(route))
        page.locator('#jobs').select_option(ids[0])
        page.wait_for_timeout(100)
        assert page.locator('#invoiceForm button').is_disabled()
        page.locator('#jobs').select_option(ids[1])
        page.locator('#jobinfo b').first.wait_for()
        selected_info = page.locator('#jobinfo').inner_text()
        for route in pending:
            route.continue_()
        page.wait_for_timeout(250)
        assert page.locator('#jobs').input_value() == ids[1]
        assert page.locator('#jobinfo').inner_text() == selected_info
        page.unroute('**/api/work-orders/' + ids[0])
        # Outcome helpers render real server outcome distinctions accurately.
        outcomes = page.evaluate('''async()=>{const ui=await import('/shared-ui.js');return {queued:ui.notificationOutcome({status:'queued'}),unknown:ui.notificationOutcome({status:'delivery_unknown'}),local:ui.calendarOutcome({status:'local_only',synced:false}),conflict:ui.calendarOutcome({status:'conflict',synced:false}),supplier:ui.supplierOutcome([{status:'error'}])}}''')
        assert 'queued' in outcomes['queued'] and 'not been confirmed' in outcomes['queued']
        assert 'unknown' in outcomes['unknown'] and 'locally' in outcomes['local']
        assert 'conflict' in outcomes['conflict'] and 'failed' in outcomes['supplier']
        # Empty, one-item and multi-item mobile lists must have one proper empty state.
        sample_jobs = api(page, '/api/work-orders')['workOrders']
        for count in [0, 1, 3]:
            page.route('**/api/my-work', lambda route, request, count=count: route.fulfill(json={'workOrders':sample_jobs[:count]}))
            visit(page, base, '/tech.html', '#mobile-app main')
            assert page.locator('.listing').count() == count
            assert ('No work orders assigned.' in page.locator('main').inner_text()) == (count == 0)
            page.unroute('**/api/my-work')
        # An actual counter sale: scan catalog, issue one stock movement, split tender, pickup.
        visit(page, base, '/shop-ops.html?tab=retail&new=1', '#newRetail')
        api(page, '/api/shop/inventory-adjustments', 'POST', {'sku':'REVIEW-SERVICE-KIT','quantityDelta':3,'reason':'cycle_count','referenceType':'cycle_count','referenceId':'BROWSER-OPENING-COUNT','idempotencyKey':'browser-opening-stock'})
        existing = {row['id'] for row in api(page, '/api/shop/retail-orders')['orders']}
        customer = api(page, '/api/pos/customers')['customers'][0]
        page.locator('#newRetail [name=customerId]').select_option(str(customer['id']))
        page.locator('#newRetail button').click()
        page.locator('#retailAdd').wait_for()
        page.locator('#stockLookup').fill('000000001001')
        page.locator('#lookupStock').click()
        page.wait_for_function("document.querySelector('#retailAdd [name=requestedSku]').value === 'REVIEW-SERVICE-KIT'")
        assert '3 on hand' in page.locator('#stockLookupResult').inner_text()
        page.locator('#retailAdd [name=unitCost]').fill('40.00')
        page.locator('#retailAdd [name=unitPrice]').fill('100.50')
        page.locator('#retailAdd').get_by_role('button', name='Add Line', exact=True).click()
        page.locator('#retailDetail tbody tr').wait_for()
        accept_dialog = lambda dialog: dialog.accept()
        page.on('dialog', accept_dialog)
        page.locator('#issueRetail').click()
        page.locator('[data-account-workspace][data-scope=retail] [data-account-payment]').wait_for()
        page.locator('[data-stock-sale]').click()
        page.locator('[data-status=picked_up]').wait_for()
        order = next(row for row in api(page, '/api/shop/retail-orders')['orders'] if row['id'] not in existing)
        for amount, method in [('50.00','cash'), ('59.65','card_dejavoo')]:
            page.locator('[data-account-workspace][data-scope=retail] [data-account-payment] [name=method]').select_option(method)
            page.locator('[data-account-workspace][data-scope=retail] [data-account-payment] [name=amount]').fill(amount)
            page.locator('[data-account-workspace][data-scope=retail] [data-account-payment] [name=reference]').fill('FICTIONAL-BROWSER-RECEIPT')
            page.locator('[data-account-workspace][data-scope=retail] [data-account-payment] [name=verified]').check()
            page.locator('[data-account-workspace][data-scope=retail] [data-account-payment] button').click()
            expect(page.locator('[data-account-workspace][data-scope=retail] [data-account-payment] [name=amount]')).to_have_value('')
        paid = api(page, f"/api/shop/retail-orders/{order['id']}")['order']
        assert paid['paymentTotals']['due'] == 0
        assert len(paid['payments']) == 2
        expect(page.locator('[data-account-workspace][data-scope=retail] [data-finance-panel]')).to_contain_text('FICTIONAL-BROWSER-RECEIPT')
        responsive(page, ARTIFACTS, no_overflow, 'counter-paid-ledger')
        page.locator('[data-status=picked_up]').click()
        page.wait_for_function("!document.querySelector('[data-status=picked_up]')")
        stock = api(page, '/api/shop/inventory')['stock']
        assert next(row['on_hand'] for row in stock if row['sku'] == 'REVIEW-SERVICE-KIT') == 2
        assert api(page, f"/api/shop/retail-orders/{order['id']}")['order']['lines'][0]['status'] == 'picked_up'
        receipt = page.request.get(base + f"/api/receipts/retail/{order['id']}", headers=session_headers(page))
        assert receipt.ok and 'text/html' in receipt.headers.get('content-type', '')
        page.remove_listener('dialog', accept_dialog)
        run_operations_journeys(page, base, ARTIFACTS, api, no_overflow)
        # Numeric WCAG contrast checks for actual shared computed colors.
        visit(page, base, '/', '#view .metrics')
        colors = page.evaluate("""()=>({text:getComputedStyle(document.body).color,panel:getComputedStyle(document.querySelector('.card')).backgroundColor,muted:getComputedStyle(document.querySelector('.muted')).color,green:getComputedStyle(document.querySelector('.daily-action')).backgroundColor,buttonText:getComputedStyle(document.querySelector('.daily-action')).color,focus:getComputedStyle(document.documentElement).getPropertyValue('--focus').trim()})""")
        import re
        def luminance(color):
            values = [int(color[x:x+2],16)/255 for x in (1,3,5)] if color.startswith('#') else [int(x)/255 for x in re.findall(r'\d+', color)[:3]]
            return sum(weight * (v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4) for weight, v in zip([.2126,.7152,.0722], values))
        def contrast(a,b):
            x,y=sorted([luminance(a),luminance(b)])
            return round((y+.05)/(x+.05), 2)
        ratios={'body_on_panel':contrast(colors['text'],colors['panel']),'muted_on_panel':contrast(colors['muted'],colors['panel']),'button_on_green':contrast(colors['buttonText'],colors['green']),'focus_on_panel':contrast(colors['focus'],colors['panel']),'warning_on_panel':contrast('#ffd166',colors['panel']),'error_on_panel':contrast('#ff9797',colors['panel'])}
        assert min(ratios.values()) >= 4.5, ratios
        (ARTIFACTS/'contrast.json').write_text(json.dumps({'colors':colors,'ratios':ratios},indent=2))
        print('Contrast ratios:', ratios, flush=True)
        assert not errors, errors
        browser.close()
        print('PASS: nine pages at 390/768/1440; operations/management tabs; equal daily entry points; decimal input; keyboard focus; reduced motion; billing deselection/races; mobile empty states; guided customer/unit intake; job tabs/deep links/unsaved guards; retained revised approvals; contextual invoice/payment ledger; counter stock/special-order partial-receipt retry/payment/pickup; partial return/original-payment refund/combined close; truthful outcomes')


def main():
    with tempfile.TemporaryDirectory(prefix='ownertracker-browser-') as folder:
        runtime = Path(folder)
        # Never copy .env, data, uploads, backups, logs, or customer documents.
        for name in ['src', 'public', 'scripts']:
            shutil.copytree(SOURCE / name, runtime / name)
        shutil.copy2(SOURCE / 'package.json', runtime / 'package.json')
        manifest = {str(path.relative_to(runtime)): hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in sorted(runtime.rglob('*')) if path.is_file()}
        (ARTIFACTS / 'source-manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True))
        (runtime / 'data').mkdir()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        base = f'http://127.0.0.1:{port}'
        env = {key: os.environ[key] for key in ['PATH', 'SystemRoot', 'TEMP', 'TMP'] if key in os.environ}
        # Generated customer links require HTTPS, but every request/seed stays on loopback.
        # No public URL is opened, and only this explicit source-only environment reaches Node.
        env.update({'HOST':'127.0.0.1','PORT':str(port),'PUBLIC_BASE_URL':'https://browser.ownertracker.example.invalid','OWNERTRACKER_REVIEW':'true','OWNERTRACKER_DB':str(runtime/'data/browser.sqlite'),'OWNERTRACKER_ADMIN_PASSWORD':PASSWORD,'OWNERTRACKER_SESSION_SECRET':'browser-only-session-secret','QBPOS_BRIDGE_TOKEN':'browser-only-bridge','DESKTOP_AGENT_TOKEN':'browser-only-agent','AUTO_BUILD_PROCUREMENT':'false','AUTO_SUPPLIER_LOOKUP':'false','REQUIRE_EDIT_REVISION':'true'})
        with (ARTIFACTS/'server.log').open('w') as log:
            server = subprocess.Popen([NODE, 'src/server.mjs'], cwd=runtime, env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    if server.poll() is not None:
                        raise RuntimeError('Disposable server failed; see ' + str(ARTIFACTS/'server.log'))
                    try:
                        urllib.request.urlopen(base + '/api/me', timeout=1)
                        break
                    except OSError:
                        time.sleep(.1)
                else:
                    raise RuntimeError('Disposable server did not start')
                subprocess.run([NODE, 'scripts/seed-review.mjs'], cwd=runtime, env=env, check=True, stdout=log, stderr=subprocess.STDOUT)
                run(base)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
    print('Fictional browser artifacts:', ARTIFACTS)

if __name__ == '__main__':
    main()

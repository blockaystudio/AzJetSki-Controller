"""Isolated legacy archive paging UI, using fictional HTTP responses only.
Run: python test/browser-legacy.py (requires Playwright and Chromium).
"""
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import sync_playwright, expect

PUBLIC = Path(__file__).resolve().parents[1] / 'public'


with sync_playwright() as playwright:
    executable = os.environ.get('OWNERTRACKER_BROWSER')
    if not executable and not Path(playwright.chromium.executable_path).exists() and Path('/usr/bin/chromium').exists():
        executable = '/usr/bin/chromium'
    browser = playwright.chromium.launch(headless=True, executable_path=executable, args=['--no-sandbox', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors, requests = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))

    def response(route):
        url = urlparse(route.request.url)
        assert route.request.method == 'GET', route.request.method
        if url.path in ['/legacy.html', '/legacy-ui.js', '/styles.css', '/ui-foundation.css']:
            file = PUBLIC / url.path[1:]
            mime = 'text/html' if file.suffix == '.html' else 'text/javascript' if file.suffix == '.js' else 'text/css'
            return route.fulfill(status=200, body=file.read_bytes(), content_type=mime)
        if url.path == '/api/legacy/status':
            body = {'configured': True, 'customers': 106, 'receipts': 107, 'items': 107}
        elif url.path in ['/api/legacy/customers', '/api/legacy/receipts']:
            query = {key: value[0] for key, value in parse_qs(url.query, keep_blank_values=True).items()}
            requests.append((url.path, query))
            number = int(query['page'])
            scope = url.path.rsplit('/', 1)[1]
            total = 106 if scope == 'customers' else 107
            start, end = (number - 1) * 50, min(number * 50, total)
            rows = [{'ListID': f'PAGE-C-{i:03}', 'FullName': f'Fictional customer {i}'} for i in range(start, end)] if scope == 'customers' else [
                {'TxnID': f'PAGE-T-{i:03}', 'SalesReceiptNumber': f'Fictional receipt {i}', 'TxnDate': '2009-01-01', 'Total': '10.00'} for i in range(start, end)]
            body = {'configured': True, scope: rows, 'pagination': {'page': number, 'pageSize': 50, 'total': total, 'pageCount': 3}}
        elif url.path.startswith('/api/legacy/receipts/'):
            transaction = url.path.rsplit('/', 1)[1]
            body = {'receipt': {'TxnID': transaction, 'SalesReceiptNumber': transaction}, 'customer': None, 'items': [], 'tenders': [], 'notice': 'Fictional historical receipt'}
        else:
            return route.fulfill(status=404, body='{}', content_type='application/json')
        route.fulfill(status=200, body=json.dumps(body), content_type='application/json')

    page.route('**/*', response)
    try:
        page.goto('https://ownertracker.test/legacy.html?customerId=000-C')
        expect(page.locator('#results')).to_contain_text('Showing 1–50 of 107 receipts.')
        expect(page.get_by_role('button', name='Previous', exact=True)).to_be_disabled()
        page.get_by_role('button', name='Next', exact=True).click()
        expect(page.locator('#results')).to_contain_text('Showing 51–100 of 107 receipts.')
        # Editing search fields does not change the history scope of an existing page.
        page.locator('[name=q]').fill('Fictional new search')
        page.locator('[name=scope]').select_option('customers')
        page.get_by_role('button', name='Next', exact=True).click()
        expect(page.locator('#results')).to_contain_text('Showing 101–107 of 107 receipts.')
        assert requests[-1] == ('/api/legacy/receipts', {'page': '3', 'customerId': '000-C'}), requests[-1]
        expect(page.get_by_role('button', name='Next', exact=True)).to_be_disabled()
        page.locator('[data-receipt="PAGE-T-106"]').click()
        expect(page.locator('#detail')).to_contain_text('Original transaction: PAGE-T-106')
        page.get_by_role('button', name='Previous', exact=True).click()
        expect(page.locator('#results')).to_contain_text('Page 2 of 3')
        page.get_by_role('button', name='Search', exact=True).click()
        expect(page.locator('#results')).to_contain_text('Showing 1–50 of 106 customers.')
        assert requests[-1] == ('/api/legacy/customers', {'page': '1', 'q': 'Fictional new search'}), requests[-1]
        page.get_by_role('button', name='Next', exact=True).click()
        expect(page.locator('#results')).to_contain_text('Showing 51–100 of 106 customers.')
        page.locator('[data-customer="PAGE-C-050"]').click()
        expect(page.locator('#results')).to_contain_text('Showing 1–50 of 107 receipts.')
        assert requests[-1] == ('/api/legacy/receipts', {'page': '1', 'customerId': 'PAGE-C-050'}), requests[-1]
        page.locator('[name=scope]').select_option('receipts')
        page.get_by_role('button', name='Search', exact=True).click()
        expect(page.locator('#results')).to_contain_text('Showing 1–50 of 107 receipts.')
        page.locator('[name=q]').fill('Unsubmitted edit')
        page.get_by_role('button', name='Next', exact=True).click()
        expect(page.locator('#results')).to_contain_text('Showing 51–100 of 107 receipts.')
        assert requests[-1] == ('/api/legacy/receipts', {'page': '2', 'q': 'Fictional new search'}), requests[-1]
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        assert not errors, errors
        print('PASS: archive paging, customer/query scopes, new-search reset, receipt selection and mobile layout')
    finally:
        browser.close()

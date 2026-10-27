"""Counter purchasing and shared financial exception acceptance, fictional only."""
from urllib.parse import urlparse

from playwright.sync_api import expect

from browser_workspace import responsive


def post_form(page, form, path, *, expected=201):
    with page.expect_response(lambda r: urlparse(r.url).path == path and r.request.method == 'POST') as posted:
        form.locator('button[type=submit],button:not([type])').first.click()
    assert posted.value.status == expected, (path, posted.value.status, posted.value.text())
    return posted.value.json()


def open_details(form):
    form.locator('xpath=ancestor::details[1]').locator('summary').click()
    expect(form).to_be_visible()


def create_counter(page, base, api, *, sku, quantity, price, vendor=None):
    page.goto(base + '/shop-ops.html?tab=retail&new=1')
    expect(page.locator('#newRetail')).to_be_visible()
    customer = next(row for row in api(page, '/api/pos/customers')['customers']
                    if row['name'] == 'Fictional Browser Customer')
    page.locator('#newRetail [name=customerId]').select_option(str(customer['id']))
    created = post_form(page, page.locator('#newRetail'), '/api/shop/retail-orders')
    order_id = created['order']['id']
    form = page.locator('#retailAdd')
    expect(form).to_be_visible()
    for name, value in {'description':'Fictional browser ' + sku, 'requestedSku':sku,
                        'quantity':str(quantity), 'unitCost':'40.00', 'unitPrice':price}.items():
        form.locator(f'[name={name}]').fill(value)
    if vendor:
        form.locator('[name=vendorId]').select_option(str(vendor['id']))
        form.locator('[name=vendorSku]').fill(sku)
    post_form(page, form, f'/api/shop/retail-orders/{order_id}/lines')
    expect(page.locator('#retailDetail tbody')).to_contain_text(sku)
    with page.expect_response(lambda r: r.url.endswith(f'/api/shop/retail-orders/{order_id}/issue-invoice') and r.request.method == 'POST') as issued:
        page.locator('#issueRetail').click()
    assert issued.value.ok, issued.value.text()
    account = page.locator(f'[data-account-workspace][data-scope=retail][data-account-id="{order_id}"]')
    expect(account.locator('[data-account-payment]')).to_be_visible()
    return order_id, account


def pay_counter(page, account, order_id, amount, method, reference, *, verified=True):
    form = account.locator('[data-account-payment]')
    expect(form).to_be_visible()
    form.locator('[name=method]').select_option(method)
    form.locator('[name=amount]').fill(amount)
    form.locator('[name=reference]').fill(reference)
    form.locator('[name=verified]').set_checked(verified)
    result = post_form(page, form, f'/api/shop/retail-orders/{order_id}/payments')
    expect(account.locator('[data-finance-panel]')).to_contain_text(reference)
    expect(account.locator('[data-account-payment] [name=amount]')).to_have_value('')
    expect(account.locator('[data-account-payment] button')).to_be_enabled()
    return result


def issue_counter_stock(page, account, line_id, quantity):
    """Wait for saved stock and the refreshed invoice before entering a tender."""
    with page.expect_response(lambda r: urlparse(r.url).path == '/api/shop/inventory-adjustments'
                              and r.request.method == 'POST') as issued:
        page.locator(f'[data-stock-sale="{line_id}"]').click()
    assert issued.value.ok, issued.value.text()
    fulfillment = page.locator(f'[data-retail-fulfillment="{line_id}"]')
    expect(fulfillment).to_contain_text(f'{quantity} of {quantity} issued from stock')
    expect(fulfillment).to_contain_text('0 remaining')
    expect(page.locator(f'[data-stock-sale="{line_id}"]')).to_have_count(0)
    expect(account.locator('[data-account-payment] button')).to_be_enabled()


def pickup_counter(page, order_id, line_id, *, expected=200):
    with page.expect_response(lambda r: r.url.endswith(f'/api/shop/retail-orders/{order_id}/lines/{line_id}/status') and r.request.method == 'POST') as response:
        page.locator(f'[data-line="{line_id}"][data-status=picked_up]').click()
    assert response.value.status == expected, response.value.text()
    return response.value.json()


def cannot_pickup(page, line_id):
    button = page.locator(f'[data-line="{line_id}"][data-status=picked_up]')
    assert button.count() == 0 or button.is_disabled(), 'A partially received or unsettled sale must not offer pickup'


def special_order_journey(page, base, artifacts, api, no_overflow):
    print('Checking reviewed special order, partial receipt retry and final pickup', flush=True)
    sku = 'FICTIONAL-BROWSER-SPECIAL-KIT'
    # Unrelated available stock must not count as this supplier order's receipt.
    api(page, '/api/shop/inventory-adjustments', 'POST', {'sku':sku,'quantityDelta':3,
        'reason':'cycle_count','referenceType':'cycle_count','referenceId':'FICTIONAL-SPECIAL-OTHER-STOCK',
        'idempotencyKey':'browser-special-other-stock'})
    vendor = next(row for row in api(page, '/api/vendors')['vendors'] if row['code'] == 'TMS')
    order_id, account = create_counter(page, base, api, sku=sku, quantity=2, price='100.00', vendor=vendor)
    order_path = f'/api/shop/retail-orders/{order_id}'
    pay_counter(page, account, order_id, '50.00', 'cash', 'FICTIONAL-SPECIAL-DEPOSIT')
    order = api(page, order_path)['order']
    line_id = order['lines'][0]['id']
    with page.expect_response(lambda r: r.url.endswith(f'{order_path}/lines/{line_id}/verify') and r.request.method == 'POST') as verified:
        page.locator(f'[data-verify="{line_id}"]').click()
    assert verified.value.ok, verified.value.text()
    page.locator('[data-tab=carts]').click()
    queue = page.locator(f'[data-queue="{vendor["id"]}"]')
    expect(queue).to_be_enabled()
    queue.click()
    review = page.locator('#cartReview')
    expect(review).to_be_visible()
    review.locator(f'[data-review="{line_id}"]').check()
    review.locator('[name=confirmText]').fill('ORDER ' + vendor['code'])
    queued = post_form(page, review, f'/api/shop/retail-carts/{vendor["id"]}/queue', expected=202)
    assert queued['status'] == 'queued_not_purchased' and queued['commandId']
    page.goto(base + f'/shop-ops.html?tab=retail&retailId={order_id}')
    with page.expect_response(lambda r: r.url.endswith(f'{order_path}/lines/{line_id}/status') and r.request.method == 'POST') as ordered:
        page.locator(f'[data-line="{line_id}"][data-status=ordered]').click()
    assert ordered.value.ok, ordered.value.text()
    form = page.locator(f'[data-retail-receive="{line_id}"]')
    expect(form).to_be_visible()
    before = api(page, order_path)['order']['lines'][0]['fulfillment']
    assert before['receivedQuantity'] == before['fulfilledQuantity'] == 0
    assert before['remainingQuantity'] == 2
    form.locator('[name=quantity]').fill('1')
    form.locator('[name=supplierReference]').fill('FICTIONAL-PACKING-FIRST')
    form.locator('[name=counted]').check()
    path = f'{order_path}/lines/{line_id}/receive'
    saved = []
    requests = []
    def lose_receipt_result(route):
        requests.append(route.request.post_data_json)
        response = route.fetch()
        assert response.ok, response.text()
        saved.append(response.json())
        route.abort('failed')
    page.route('**' + path, lose_receipt_result)
    try:
        form.locator('button[type=submit],button:not([type])').first.click()
        for _ in range(100):
            if saved:
                break
            page.wait_for_timeout(10)
        assert len(saved) == 1
        expect(form.locator('button').first).to_be_enabled()
    finally:
        page.unroute('**' + path)
    partial = api(page, order_path)['order']['lines'][0]
    assert partial['status'] == 'partially_received'
    assert partial['fulfillment']['receivedQuantity'] == partial['fulfillment']['fulfilledQuantity'] == 1
    assert partial['fulfillment']['remainingQuantity'] == 1
    assert form.locator('[name=supplierReference]').input_value() == 'FICTIONAL-PACKING-FIRST'
    with page.expect_request(lambda r: urlparse(r.url).path == path and r.method == 'POST') as retry:
        post_form(page, form, path, expected=200)
    assert retry.value.post_data_json['idempotencyKey'] == requests[0]['idempotencyKey']
    expect(page.locator(f'[data-retail-fulfillment="{line_id}"]')).to_contain_text('1 of 2 received')
    cannot_pickup(page, line_id)
    responsive(page, artifacts, no_overflow, 'special-order-partial-receipt')

    # Settling the account is insufficient while one supplier item is missing.
    pay_counter(page, account, order_id, '168.20', 'card_dejavoo', 'FICTIONAL-SPECIAL-FINAL-CARD')
    assert api(page, order_path)['order']['paymentTotals']['due'] == 0
    cannot_pickup(page, line_id)
    form = page.locator(f'[data-retail-receive="{line_id}"]')
    form.locator('[name=quantity]').fill('1')
    form.locator('[name=supplierReference]').fill('FICTIONAL-PACKING-SECOND')
    form.locator('[name=counted]').check()
    post_form(page, form, path)
    expect(page.locator(f'[data-retail-fulfillment="{line_id}"]')).to_contain_text('2 of 2 received')
    expect(page.locator(f'[data-line="{line_id}"][data-status=picked_up]')).to_be_enabled()
    full = api(page, order_path)['order']['lines'][0]
    assert full['fulfillment']['receivedQuantity'] == full['fulfillment']['fulfilledQuantity'] == 2
    assert full['fulfillment']['remainingQuantity'] == 0
    stock = api(page, '/api/shop/inventory')
    assert next(row['on_hand'] for row in stock['stock'] if row['sku'] == sku) == 3
    movements = [row for row in stock['history'] if row['item_sku'] == sku]
    assert len([row for row in movements if row['reason'] == 'received']) == 2
    assert len([row for row in movements if row['reason'] == 'sold']) == 2
    original_sales = api(page, f'/api/accounting/accounts/retail/{order_id}')['stockSales']
    assert len(original_sales) == 2 and sum(-row['quantity_delta'] for row in original_sales) == 2
    responsive(page, artifacts, no_overflow, 'special-order-received-paid')
    pickup_counter(page, order_id, line_id)
    expect(page.locator('[data-status=picked_up]')).to_have_count(0)
    assert api(page, order_path)['order']['status'] == 'picked_up'
    print('PASS: reviewed special-order manifest; deposit; partial receipt; same-key lost-response retry; paid-but-incomplete pickup blocked; final receipt and pickup; exact original-sale movements', flush=True)


def partial_return_refund_close(page, base, artifacts, api, no_overflow):
    print('Checking counter partial return, original-payment refund and combined close', flush=True)
    date = page.evaluate('new Intl.DateTimeFormat("en-CA",{timeZone:"America/Phoenix",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())')
    before = api(page, '/api/accounting/daily-close?date=' + date)
    sku = 'FICTIONAL-BROWSER-RETURN-KIT'
    api(page, '/api/shop/inventory-adjustments', 'POST', {'sku':sku,'quantityDelta':4,
        'reason':'cycle_count','referenceType':'cycle_count','referenceId':'FICTIONAL-RETURN-OPENING',
        'idempotencyKey':'browser-exceptions-opening'})
    order_id, account = create_counter(page, base, api, sku=sku, quantity=2, price='100.00')
    order_path = f'/api/shop/retail-orders/{order_id}'
    original = api(page, order_path)['order']
    assert original['total_cents'] == 21820
    line_id = original['lines'][0]['id']
    assert original['lines'][0]['quantity'] == 2
    issue_counter_stock(page, account, line_id, 2)
    assert next(row['on_hand'] for row in api(page, '/api/shop/inventory')['stock'] if row['sku'] == sku) == 2
    pay_counter(page, account, order_id, '100.00', 'cash', 'FICTIONAL-RETURN-CASH')
    pay_counter(page, account, order_id, '118.20', 'zelle', 'FICTIONAL-RETURN-ZELLE-PENDING', verified=False)
    pending = api(page, order_path)['order']
    assert pending['paymentTotals']['due'] == 11820
    assert pending['paymentTotals']['pending'] == 11820
    if page.locator(f'[data-line="{line_id}"][data-status=picked_up]').is_disabled():
        cannot_pickup(page, line_id)
    else:
        rejected = pickup_counter(page, order_id, line_id, expected=409)
        assert 'payment' in rejected['error'].lower() or 'balance' in rejected['error'].lower(), rejected
    assert api(page, order_path)['order']['lines'][0]['status'] == 'received'
    bank = account.locator('[data-finance-confirm]')
    with page.expect_response(lambda r: '/api/shop/retail-payments/' in r.url and r.url.endswith('/confirm') and r.request.method == 'POST') as confirmed:
        bank.click()
    assert confirmed.value.ok, confirmed.value.text()
    expect(account.locator('[data-finance-confirm]')).to_have_count(0)
    assert api(page, order_path)['order']['paymentTotals']['due'] == 0
    pickup_counter(page, order_id, line_id)
    expect(page.locator('[data-status=picked_up]')).to_have_count(0)

    account_path = f'/api/accounting/accounts/retail/{order_id}'
    prior = api(page, account_path)
    assert len(prior['stockSales']) == 1
    sale_id = prior['stockSales'][0]['id']
    credit = account.locator('[data-account-credit]')
    open_details(credit)
    credit.locator('[name=subtotal]').fill('100.00')
    credit.locator('[name=tax]').fill('9.10')
    credit.locator('[name=reason]').fill('Fictional return of one unused kit')
    post_form(page, credit, account_path + '/credits')
    expect(account.locator('.account-summary')).to_contain_text('Refund owed to the customer')
    after_credit = api(page, account_path)
    assert after_credit['balance']['refundDueCents'] == 10910
    assert after_credit['balance']['effectiveTotalCents'] == 10910
    assert len(after_credit['credits']) == 1
    credit_id = after_credit['credits'][0]['id']

    returned = account.locator('[data-account-return]')
    open_details(returned)
    returned.locator('[name=creditNoteId]').select_option(str(credit_id))
    returned.locator('[name=saleAdjustmentId]').select_option(str(sale_id))
    returned.locator('[name=quantity]').fill('1')
    returned.locator('[name=disposition]').select_option('resellable')
    returned.locator('[name=reason]').fill('Fictional unused sealed kit physically received')
    returned.locator('[name=received]').check()
    post_form(page, returned, account_path + '/returns')
    expect(account).to_contain_text('Fictional unused sealed kit physically received')
    stock = api(page, '/api/shop/inventory')
    assert next(row['on_hand'] for row in stock['stock'] if row['sku'] == sku) == 3
    movements = [row for row in stock['history'] if row['item_sku'] == sku]
    assert sum(row['quantity_delta'] for row in movements if row['reason'] == 'return') == 1

    refund = account.locator('[data-finance-refund]')
    expect(refund).to_be_visible()
    paid = api(page, order_path)['order']
    original_payment = next(row for row in paid['payments'] if row['method'] == 'zelle' and row['direction'] == 'payment')
    refund.locator('[name=originalPaymentId]').select_option(str(original_payment['id']))
    refund.locator('[name=amount]').fill('109.10')
    refund.locator('[name=reference]').fill('FICTIONAL-ZELLE-REFUND-ONE-KIT')
    refund.locator('[name=reason]').fill('Fictional original-method refund for one returned kit')
    refund.locator('[name=verified]').check()
    post_form(page, refund, order_path + '/payments')
    expect(account.locator('[data-finance-panel]')).to_contain_text('FICTIONAL-ZELLE-REFUND-ONE-KIT')
    settled = api(page, order_path)['order']
    assert settled['paymentTotals']['total'] == 10910
    assert settled['paymentTotals']['paid'] == 10910
    assert settled['paymentTotals']['due'] == settled['paymentTotals']['refundDue'] == 0
    refunds = [row for row in settled['payments'] if row['direction'] == 'refund']
    assert len(refunds) == 1 and refunds[0]['amount_cents'] == 10910
    assert refunds[0]['original_payment_id'] == original_payment['id'] and refunds[0]['method'] == 'zelle'
    account_record = api(page, account_path)
    assert len(account_record['credits']) == len(account_record['returns']) == 1
    assert account_record['returns'][0]['sale_adjustment_id'] == sale_id
    assert account_record['returns'][0]['credit_id'] == credit_id
    assert settled['total_cents'] == original['total_cents'], 'Original invoice charge must remain retained'
    responsive(page, artifacts, no_overflow, 'counter-return-refund')

    report = api(page, '/api/accounting/daily-close?date=' + date)
    assert report['methods']['cash']['netCents'] - before['methods']['cash']['netCents'] == 10000
    assert report['methods']['zelle']['receivedCents'] - before['methods']['zelle']['receivedCents'] == 11820
    assert report['methods']['zelle']['refundCents'] - before['methods']['zelle']['refundCents'] == 10910
    assert report['methods']['zelle']['netCents'] - before['methods']['zelle']['netCents'] == 910
    assert report['creditedTaxCents'] - before['creditedTaxCents'] == 910
    assert {'repair', 'retail'} <= {row['scope'] for row in report['entries'] if not row['excluded']}
    page.goto(base + '/accounting.html')
    expect(page.locator('#closeForm')).to_be_visible()
    assert page.locator('#selectDay [name=date]').input_value() == date
    # Changing the business date must remove the prior day's close controls.
    page.locator('#selectDay [name=date]').fill('2026-01-01')
    expect(page.locator('#closeForm')).to_have_count(0)
    assert page.locator('#exportCsv').get_attribute('href') is None
    page.locator('#selectDay [name=date]').fill(date)
    page.locator('#selectDay button').click()
    expect(page.locator('#closeForm')).to_be_visible()
    close = page.locator('#closeForm')
    values = {'openingFloat':'50.00','cashPaidOut':'0.00',
              'cashCounted':f'{(report["methods"]["cash"]["netCents"] + 5000) / 100:.2f}',
              'cardVerified':f'{report["methods"]["card_dejavoo"]["netCents"] / 100:.2f}',
              'zelleVerified':f'{report["methods"]["zelle"]["netCents"] / 100:.2f}',
              'notes':'Fictional browser reconciliation: repair and counter receipts, one original-method refund'}
    for name, value in values.items():
        close.locator(f'[name={name}]').fill(value)
    close.locator('[name=verified]').check()
    if close.locator('[name=taxReview]').count():
        close.locator('[name=taxReview]').check()
    recorded = post_form(page, close, '/api/accounting/daily-close')
    expect(page.locator('#day')).to_contain_text('Revision 1')
    retained = api(page, f'/api/accounting/daily-close/{recorded["id"]}')
    # The endpoint returns the retained record, including its immutable snapshot.
    row = retained.get('close', retained)
    assert row['cash_difference_cents'] == row['card_difference_cents'] == row['zelle_difference_cents'] == 0
    refreshed = api(page, '/api/accounting/daily-close?date=' + date)
    assert len(refreshed['priorCloses']) == len(before['priorCloses']) + 1
    assert refreshed['priorCloses'][-1]['snapshot_sha256']
    responsive(page, artifacts, no_overflow, 'combined-daily-close')
    print('PASS: pending-only pickup blocked; confirmed bank deposit; one-item return; retained credit/original-payment refund; stock and combined repair/retail close reconcile', flush=True)


def run_operations_journeys(page, base, artifacts, api, no_overflow):
    def dialog_handler(dialog):
        if dialog.type != 'prompt':
            dialog.accept()
        elif 'supplier' in dialog.message.lower():
            dialog.accept('FICTIONAL-SUPPLIER-ORDER-ONE')
        elif 'eta' in dialog.message.lower():
            dialog.accept('')
        else:
            dialog.accept('FICTIONAL-BROWSER-BANK-CONFIRMATION')
    page.on('dialog', dialog_handler)
    try:
        special_order_journey(page, base, artifacts, api, no_overflow)
        partial_return_refund_close(page, base, artifacts, api, no_overflow)
    except Exception:
        page.screenshot(path=str(artifacts / 'operations-failure.png'), full_page=True)
        (artifacts / 'operations-failure.html').write_text(page.content())
        raise
    finally:
        page.remove_listener('dialog', dialog_handler)

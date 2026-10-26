"""Real-browser job journeys. All accounts, signatures and funds are fictional."""
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect


WIDTHS = [390, 768, 1440]
TABS = ['overview', 'estimate', 'work', 'parts', 'payments', 'history']


def money_inputs(page):
    """Exercise native decimal validation without making a staff draft dirty."""
    results = page.locator('input[type=number]').evaluate_all('''nodes => nodes
      .filter(e => !e.disabled && !e.readOnly && ['amount','estimate_total','rate','cost','unitCost','unitPrice','subtotal','tax','openingFloat','cashPaidOut','cashCounted','cardVerified','zelleVerified'].includes(e.name))
      .map(e => { const old=e.value; e.value='100.50'; const result={name:e.name,
        valid:e.checkValidity(),stepMismatch:e.validity.stepMismatch,mode:e.inputMode};
        e.value=old; return result; })''')
    for result in results:
        assert result['valid'] and not result['stepMismatch'], result
        assert result['mode'] == 'decimal', result


def responsive(page, artifacts, no_overflow, label):
    for width in WIDTHS:
        page.set_viewport_size({'width': width, 'height': 900})
        no_overflow(page, f'{label} at {width}')
        money_inputs(page)
        assert page.evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches')
        assert page.locator('#view, #intakeStep, #ops-main').evaluate_all(
            'nodes => nodes.every(node => getComputedStyle(node).animationName === "none")')
        page.screenshot(path=str(artifacts / f'{label}-{width}.png'), full_page=True)


def open_tab(page, tab):
    page.locator('#job-tab-' + tab).click()
    expect(page.locator('#job-tab-' + tab)).to_have_attribute('aria-selected', 'true')
    expect(page.locator('#job-panel-' + tab)).to_be_visible()
    assert parse_qs(urlparse(page.url).query)['tab'] == [tab], page.url


def fill_unit(page, suffix, *, lost_response=False, artifacts=None, no_overflow=None):
    page.get_by_role('button', name='Add a vehicle', exact=True).click()
    form = page.locator('#unitCreate')
    expect(form).to_be_visible()
    for name, value in {'year':'2024','make':'Yamaha','model':'Browser VX ' + suffix,
                        'hin':'FICTIONAL-BROWSER-' + suffix,'hours':'21.5','color':'Blue'}.items():
        form.locator(f'[name={name}]').fill(value)
    if artifacts is not None and no_overflow is not None:
        responsive(page, artifacts, no_overflow, 'intake-unit-' + suffix.lower())
    if lost_response:
        saved = []
        def lose_result(route):
            response = route.fetch()
            assert response.ok, response.text()
            saved.append(response.json()['vehicle'])
            route.abort('failed')
        page.route('**/api/pos/vehicles', lose_result)
        try:
            form.get_by_role('button', name='Save vehicle & continue', exact=True).click()
            expect(page.locator('#recoveryHeading')).to_have_text('Review the save result')
            assert len(saved) == 1
            assert page.locator('#unitCreate').count() == 0
            page.screenshot(path=str(artifacts / 'intake-uncertain-save.png'), full_page=True)
            page.locator('#recover').click()
            page.locator(f'[data-unit="{saved[0]["id"]}"]').click()
            assert len(saved) == 1
        finally:
            page.unroute('**/api/pos/vehicles')
    else:
        form.get_by_role('button', name='Save vehicle & continue', exact=True).click()
    expect(page.locator('#jobDetails')).to_be_visible()


def finish_intake(page, api, artifacts, no_overflow, label, check_in):
    form = page.locator('#jobDetails')
    form.locator('[name=complaint]').fill('Fictional browser inspection: ' + label)
    form.locator('[name=estimate_total]').fill('100.50')
    responsive(page, artifacts, no_overflow, 'intake-job-' + label)
    form.get_by_role('button', name='Review intake', exact=True).click()
    complete = page.locator('#completeIntake')
    expect(complete).to_be_visible()
    complete.locator('[name=checkIn]').set_checked(check_in)
    if check_in:
        complete.locator('[name=lotLocation]').fill('Fictional browser bay')
        complete.locator('[name=keysTag]').fill('FICTIONAL-KEYS')
    responsive(page, artifacts, no_overflow, 'intake-review-' + label)
    with page.expect_response(lambda r: '/api/pos/work-orders' in r.url and r.request.method == 'POST') as created:
        complete.get_by_role('button', name='Create repair', exact=True).click()
    assert created.value.ok, created.value.text()
    job_id = created.value.json()['id']
    expect(page.locator('#intakeComplete')).to_be_visible()
    job = api(page, f'/api/work-orders/{job_id}')['workOrder']
    assert job['complaint'] == 'Fictional browser inspection: ' + label
    assert float(job['estimate_total']) == 100.50
    lot = api(page, '/api/shop/queues')['inLot']
    custody = [row for row in lot if row['vehicle_id'] == job['vehicle_id']]
    assert bool(custody) == check_in, custody
    if check_in:
        assert custody[0]['work_order_id'] == job_id
        assert custody[0]['lot_location'] == 'Fictional browser bay'
        assert custody[0]['keys_tag'] == 'FICTIONAL-KEYS'
    page.locator('#intakeComplete').get_by_role('link', name='Open job', exact=True).click()
    expect(page.locator('#jobWorkspace')).to_be_visible()
    assert parse_qs(urlparse(page.url).query)['workOrderId'] == [str(job_id)]
    return job


def intake_journeys(page, base, artifacts, api, no_overflow):
    before_customers = api(page, '/api/pos/customers')['customers']
    page.goto(base + '/intake.html')
    page.get_by_role('button', name='New customer', exact=True).click()
    create = page.locator('#customerCreate')
    expect(create).to_be_visible()
    for name, value in {'name':'Fictional Browser Customer','phone':'602-555-0199',
                        'email':'browser-customer@example.invalid','address_line1':'123 Fictional Way',
                        'city':'Phoenix','state':'AZ','postal_code':'85001'}.items():
        create.locator(f'[name={name}]').fill(value)
    responsive(page, artifacts, no_overflow, 'intake-customer')
    create.get_by_role('button', name='Save customer & continue', exact=True).click()
    expect(page.locator('#unitChoices')).to_be_visible()
    fill_unit(page, 'ONE', artifacts=artifacts, no_overflow=no_overflow)
    first = finish_intake(page, api, artifacts, no_overflow, 'first-unit', True)
    customers = api(page, '/api/pos/customers')['customers']
    assert len(customers) == len(before_customers) + 1
    customer_id = first['customer_id']
    assert next(c for c in customers if c['id'] == customer_id)['name'] == 'Fictional Browser Customer'
    units = api(page, f'/api/pos/vehicles?customerId={customer_id}')['vehicles']
    assert len(units) == 1 and units[0]['id'] == first['vehicle_id']

    # Search and select the same account. A second unit must not duplicate it.
    page.goto(base + '/intake.html')
    page.locator('#customerSearch [name=q]').fill('Fictional Browser Customer')
    page.locator('#customerSearch').get_by_role('button', name='Search customers', exact=True).click()
    page.locator(f'[data-customer="{customer_id}"]').click()
    expect(page.locator('#unitChoices')).to_be_visible()
    expect(page.locator(f'[data-unit="{first["vehicle_id"]}"]')).to_be_visible()
    fill_unit(page, 'TWO', lost_response=True, artifacts=artifacts, no_overflow=no_overflow)
    second = finish_intake(page, api, artifacts, no_overflow, 'second-unit', False)
    assert second['customer_id'] == customer_id
    assert second['vehicle_id'] != first['vehicle_id']
    assert len(api(page, '/api/pos/customers')['customers']) == len(customers)
    units = api(page, f'/api/pos/vehicles?customerId={customer_id}')['vehicles']
    assert {v['id'] for v in units} == {first['vehicle_id'], second['vehicle_id']}
    return first, second


def workspace_navigation(page, base, artifacts, api, no_overflow, first, second):
    first_url = f'/?view=workorders&workOrderId={first["id"]}'
    page.goto(base + first_url + '&tab=overview')
    expect(page.locator('#jobWorkspace')).to_be_visible()
    for tab in TABS:
        open_tab(page, tab)
        if tab == 'payments':
            expect(page.locator('[data-account-workspace][data-scope=repair] [data-account-payment]')).to_be_visible()
        if tab == 'estimate':
            expect(page.locator('[data-auth-request]')).to_be_visible()
        responsive(page, artifacts, no_overflow, 'job-' + tab)
    page.reload()
    expect(page.locator('#job-panel-history')).to_be_visible()
    open_tab(page, 'parts')
    open_tab(page, 'work')
    page.go_back()
    expect(page.locator('#job-panel-parts')).to_be_visible()
    page.go_forward()
    expect(page.locator('#job-panel-work')).to_be_visible()

    open_tab(page, 'overview')
    field = page.locator('#edit [name=next_action]')
    previous = field.input_value()
    field.fill('UNSAVED FICTIONAL BROWSER DRAFT')
    dialogs = []
    def keep(dialog):
        dialogs.append(dialog.message)
        dialog.dismiss()
    page.once('dialog', keep)
    page.locator('#job-tab-parts').click()
    assert dialogs and 'unsaved' in dialogs[-1].lower(), dialogs
    expect(page.locator('#job-panel-overview')).to_be_visible()
    assert field.input_value() == 'UNSAVED FICTIONAL BROWSER DRAFT'
    page.once('dialog', lambda dialog: dialog.accept())
    open_tab(page, 'parts')
    # The guard promises to keep the draft while moving between this job's tabs.
    open_tab(page, 'overview')
    assert field.input_value() == 'UNSAVED FICTIONAL BROWSER DRAFT'
    assert (api(page, f'/api/work-orders/{first["id"]}')['workOrder']['next_action'] or '') == previous
    page.once('dialog', lambda dialog: dialog.accept())
    page.reload()
    expect(page.locator('#job-panel-overview')).to_be_visible()
    assert page.locator('#edit [name=next_action]').input_value() == previous


def wrong_job_races(page, base, first, second):
    """Late repair/account reads cannot replace the job currently on screen."""
    for late_path, tab in [(f'/api/work-orders/{first["id"]}', 'overview'),
                           (f'/api/pos/work-orders/{first["id"]}/invoices', 'payments')]:
        page.goto(base + '/?view=workorders')
        expect(page.locator('#list a.job-link').first).to_be_visible()
        held = []
        matcher = '**' + late_path
        page.route(matcher, lambda route: held.append(route))
        try:
            if tab == 'overview':
                with page.expect_request(lambda request: urlparse(request.url).path == late_path):
                    page.locator(f'#list a.job-link[href*="workOrderId={first["id"]}"]').click()
            else:
                page.locator(f'#list a.job-link[href*="workOrderId={first["id"]}"]').click()
                expect(page.locator('#jobWorkspace')).to_be_visible()
                with page.expect_request(lambda request: urlparse(request.url).path == late_path):
                    open_tab(page, 'payments')
            # The request event precedes Playwright's route callback dispatch.
            for _ in range(100):
                if held:
                    break
                page.wait_for_timeout(10)
            assert held, late_path
            if tab == 'overview':
                page.go_back()
            else:
                page.locator('#back').click()
            expect(page.locator('#list a.job-link').first).to_be_visible()
            page.locator(f'#list a.job-link[href*="workOrderId={second["id"]}"]').click()
            expect(page.locator('#jobWorkspace')).to_be_visible()
            open_tab(page, 'payments')
            account = page.locator(f'[data-account-workspace][data-account-id="{second["id"]}"]')
            expect(account.locator('[data-account-payment]')).to_be_visible()
            title = page.locator('#jobWorkspace h1').inner_text()
            for route in held:
                with page.expect_response(lambda response: urlparse(response.url).path == late_path):
                    route.continue_()
            held.clear()
            page.wait_for_timeout(150)
            assert page.locator('#jobWorkspace h1').inner_text() == title
            assert parse_qs(urlparse(page.url).query)['workOrderId'] == [str(second['id'])]
            expect(account.locator('[data-account-payment]')).to_be_visible()
            assert page.locator(f'[data-account-workspace][data-account-id="{first["id"]}"]').count() == 0
        finally:
            for route in held:
                route.continue_()
            page.unroute(matcher)


def contextual_account(page, base, artifacts, api, no_overflow, job):
    job_id = job['id']
    page.goto(base + f'/?view=workorders&workOrderId={job_id}&tab=payments')
    account = page.locator(f'[data-account-workspace][data-scope=repair][data-account-id="{job_id}"]')
    expect(account.locator('[data-account-invoice]')).to_be_visible()
    original = api(page, f'/api/pos/work-orders/{job_id}/payments')['totals']
    invoice_path = f'/api/pos/work-orders/{job_id}/invoices'
    for expected_count in [1, 2]:
        form = account.locator('[data-account-invoice]')
        form.locator('[name=email]').fill('browser-customer@example.invalid')
        if form.locator('[name=sendEmail]').count():
            form.locator('[name=sendEmail]').uncheck()
        with page.expect_response(lambda r: invoice_path in r.url and r.request.method == 'POST') as result:
            form.locator('button[type=submit],button:not([type])').first.click()
        assert result.value.ok, result.value.text()
        expect(account.locator('[data-account-invoice] button').first).to_be_enabled()
        invoices = api(page, invoice_path)['invoices']
        assert len(invoices) == expected_count
    current = next(row for row in invoices if not row.get('superseded_by') and not row.get('voided_at'))
    historical = next(row for row in invoices if row.get('superseded_by'))
    assert current['document_kind'] == 'revised_invoice'
    assert current['supersedes_invoice_id'] == historical['id']
    assert historical['superseded_by'] == current['id']
    totals = api(page, f'/api/pos/work-orders/{job_id}/payments')['totals']
    assert totals['total'] == original['total'], (original, totals)
    form = account.locator('[data-account-payment]')
    form.locator('[name=method]').select_option('cash')
    form.locator('[name=amount]').fill('25.50')
    form.locator('[name=reference]').fill('FICTIONAL-BROWSER-CASH')
    form.locator('[name=verified]').check()
    # Saving one financial action must retain a different unfinished form.
    account.locator('[data-account-invoice] [name=email]').fill('unfinished-invoice@example.invalid')
    payment_path = f'/api/pos/work-orders/{job_id}/payments'
    held = []
    def delay_payment(route):
        held.append(route) if route.request.method == 'POST' else route.continue_()
    page.route('**' + payment_path, delay_payment)
    try:
        form.locator('button[type=submit],button:not([type])').first.click()
        for _ in range(100):
            if held:
                break
            page.wait_for_timeout(10)
        assert len(held) == 1
        expect(account.locator('[data-account-refresh]')).to_be_disabled()
        expect(account.locator('[data-account-invoice] button')).to_be_disabled()
        with page.expect_response(lambda r: payment_path in r.url and r.request.method == 'POST') as payment:
            held.pop().continue_()
        assert payment.value.ok, payment.value.text()
    finally:
        for route in held:
            route.continue_()
        page.unroute('**' + payment_path)
    expect(account.locator('[data-finance-panel]')).to_contain_text('FICTIONAL-BROWSER-CASH')
    expect(account.locator('[data-account-invoice] [name=email]')).to_have_value('unfinished-invoice@example.invalid')
    assert parse_qs(urlparse(page.url).query)['workOrderId'] == [str(job_id)]
    result = api(page, f'/api/pos/work-orders/{job_id}/payments')
    assert len(result['payments']) == 1 and result['payments'][0]['amount_cents'] == 2550
    assert float(result['totals']['balance']) == 75.00, result['totals']
    assert float(result['totals']['paid']) == 25.50
    responsive(page, artifacts, no_overflow, 'job-account-with-ledger')
    dialogs = []
    def keep_draft(dialog):
        dialogs.append(dialog.message)
        dialog.dismiss()
    page.once('dialog', keep_draft)
    page.locator('#job-tab-overview').click()
    assert dialogs and 'unsaved' in dialogs[0].lower(), dialogs
    expect(page.locator('#job-panel-payments')).to_be_visible()
    page.once('dialog', lambda dialog: dialog.accept())
    page.reload()
    expect(page.locator('[data-account-workspace] [data-account-payment]')).to_be_visible()


def retained_approvals(page, base, artifacts, api, no_overflow, job):
    job_id = job['id']
    page.goto(base + f'/?view=workorders&workOrderId={job_id}&tab=estimate')
    form = page.locator('[data-auth-request]')
    expect(form).to_be_visible()
    form.locator('[name=description]').fill('Fictional initial browser inspection')
    with page.expect_response(lambda r: f'/api/work-orders/{job_id}/request-approval' in r.url and r.request.method == 'POST') as created:
        form.locator('button').click()
    assert created.value.ok, created.value.text()
    first = created.value.json()
    # Open only the loopback path in a separate anonymous browser context.
    public = page.context.browser.new_context(reduced_motion='reduce')
    customer = public.new_page()
    try:
        customer.goto(base + urlparse(first['approvalUrl']).path)
        customer.locator('#signAuthorization [name=choice][value="Approve Repairs"]').check()
        customer.locator('#signAuthorization [name=signerName]').fill('Fictional Browser Customer')
        customer.locator('#signAuthorization [name=agree]').check()
        with customer.expect_response(lambda r: '/approval/' in r.url and r.request.method == 'POST') as signed:
            customer.locator('#signAuthorization button').click()
        assert signed.value.ok, signed.value.text()
    finally:
        public.close()
    authorizations = api(page, f'/api/work-orders/{job_id}/authorizations')
    assert authorizations['hasCurrentRepairAuthorization']
    retained = next(row for row in authorizations['authorizations'] if row['id'] == first['approvalId'])
    assert retained['snapshot']['estimateCents'] == 10050
    assert retained['signedRecordSha256'] and retained['documentAvailable']

    page.reload()
    page.locator('#editEstimate').click()
    edit = page.locator('#editJob')
    expect(edit).to_be_visible()
    edit.locator('[name=estimate_total]').fill('125.75')
    with page.expect_response(lambda r: f'/api/pos/work-orders/{job_id}' in r.url and r.request.method == 'PATCH') as revised:
        edit.get_by_role('button', name='Save Work Order', exact=True).click()
    assert revised.value.ok, revised.value.text()
    expect(page.locator('[data-auth-request]')).to_be_visible()
    state = api(page, f'/api/work-orders/{job_id}/authorizations')
    assert not state['hasCurrentRepairAuthorization']
    form = page.locator('[data-auth-request]')
    form.locator('[name=description]').fill('Fictional revised inspection and pump test')
    with page.expect_response(lambda r: f'/api/work-orders/{job_id}/request-approval' in r.url and r.request.method == 'POST') as replacement:
        form.locator('button').click()
    assert replacement.value.ok, replacement.value.text()
    replacement_record = replacement.value.json()
    new_id = replacement_record['approvalId']
    state = api(page, f'/api/work-orders/{job_id}/authorizations')
    prior = next(row for row in state['authorizations'] if row['id'] == retained['id'])
    current = next(row for row in state['authorizations'] if row['id'] == new_id)
    assert prior['signedRecordSha256'] == retained['signedRecordSha256']
    assert prior['snapshotSha256'] == retained['snapshotSha256']
    assert prior['supersededBy'] == new_id
    assert current['previousApprovalId'] == prior['id']
    assert current['snapshot']['estimateCents'] == 12575
    assert current['status'] != 'completed' and not state['hasCurrentRepairAuthorization']
    page.reload()
    expect(page.locator('[data-auth-request]')).to_be_visible()
    responsive(page, artifacts, no_overflow, 'job-revised-authorization')
    return replacement_record


def complete_repair_pickup(page, base, artifacts, api, no_overflow, first, second, revised):
    # Sign the revised full scope, retaining the earlier signature checked above.
    public = page.context.browser.new_context(reduced_motion='reduce')
    customer = public.new_page()
    try:
        customer.goto(base + urlparse(revised['approvalUrl']).path)
        customer.locator('#signAuthorization [name=choice][value="Approve Repairs"]').check()
        customer.locator('#signAuthorization [name=signerName]').fill('Fictional Browser Customer')
        customer.locator('#signAuthorization [name=agree]').check()
        with customer.expect_response(lambda r: '/approval/' in r.url and r.request.method == 'POST') as signed:
            customer.locator('#signAuthorization button').click()
        assert signed.value.ok, signed.value.text()
    finally:
        public.close()
    approval = api(page, f'/api/work-orders/{first["id"]}/authorizations')
    assert approval['hasCurrentRepairAuthorization']
    current = next(row for row in approval['authorizations'] if row['id'] == revised['approvalId'])
    assert current['snapshot']['estimateCents'] == 12575 and current['documentAvailable']

    # Two units from one customer are on site; release must select only one.
    page.goto(base + '/shop-ops.html?tab=lot')
    checkin = page.locator('#checkIn')
    expect(checkin).to_be_visible()
    checkin.locator('[name=vehicleId]').select_option(str(second['vehicle_id']))
    checkin.locator('[name=workOrderId]').select_option(str(second['id']))
    checkin.locator('[name=lotLocation]').fill('Fictional second-unit bay')
    checkin.locator('[name=keysTag]').fill('FICTIONAL-SECOND-KEYS')
    with page.expect_response(lambda r: r.url.endswith(f'/api/shop/vehicles/{second["vehicle_id"]}/check-in') and r.request.method == 'POST') as checked:
        checkin.locator('button').click()
    assert checked.value.ok, checked.value.text()
    queues = api(page, '/api/shop/queues')
    own_units = [row for row in queues['inLot'] if row['customer_id'] == first['customer_id']]
    assert {row['vehicle_id'] for row in own_units} == {first['vehicle_id'], second['vehicle_id']}
    assert next(row['vehicleCount'] for row in queues['checkedInCustomers'] if row['id'] == first['customer_id']) == 2

    page.goto(base + f'/?view=workorders&workOrderId={first["id"]}&tab=payments')
    account = page.locator(f'[data-account-workspace][data-account-id="{first["id"]}"]')
    form = account.locator('[data-account-payment]')
    expect(form).to_be_visible()
    expect(page.locator('[data-job-pickup] button')).to_be_disabled()
    with page.expect_response(lambda r: r.url.endswith(f'/api/pos/work-orders/{first["id"]}/invoices') and r.request.method == 'POST') as final_invoice:
        account.locator('[data-account-invoice] button').click()
    assert final_invoice.value.ok, final_invoice.value.text()
    expect(account.locator('[data-account-payment] button')).to_be_enabled()
    form.locator('[name=method]').select_option('cash')
    form.locator('[name=amount]').fill('100.25')
    form.locator('[name=reference]').fill('FICTIONAL-REPAIR-FINAL-CASH')
    form.locator('[name=verified]').check()
    with page.expect_response(lambda r: r.url.endswith(f'/api/pos/work-orders/{first["id"]}/payments') and r.request.method == 'POST') as payment:
        form.locator('button').click()
    assert payment.value.ok, payment.value.text()
    expect(account.locator('[data-finance-panel]')).to_contain_text('FICTIONAL-REPAIR-FINAL-CASH')
    totals = api(page, f'/api/pos/work-orders/{first["id"]}/payments')['totals']
    assert totals['balance'] == 0 and totals['paid'] == 125.75
    # Reload obtains the post-payment revision before a workflow edit.
    page.reload()
    expect(page.locator('#jobWorkspace')).to_be_visible()
    open_tab(page, 'overview')
    page.locator('#edit [name=stage]').select_option('Ready')
    with page.expect_response(lambda r: r.url.endswith(f'/api/work-orders/{first["id"]}') and r.request.method == 'PATCH') as ready:
        page.locator('#edit button').first.click()
    assert ready.value.ok, ready.value.text()
    open_tab(page, 'payments')
    pickup = page.locator('[data-job-pickup]')
    expect(pickup.locator('button')).to_be_enabled()
    before = api(page, f'/api/work-orders/{first["id"]}')['workOrder']
    assert not before.get('date_closed')
    pickup.locator('[name=notes]').fill('Fictional customer collected first unit; second unit remains on site')
    pickup.locator('[name=confirmed]').check()
    started = page.evaluate('Date.now()')
    with page.expect_response(lambda r: r.url.endswith(f'/api/shop/vehicles/{first["vehicle_id"]}/check-out') and r.request.method == 'POST') as released:
        pickup.get_by_role('button', name='Complete pickup', exact=True).click()
    assert released.value.ok, released.value.text()
    expect(page.locator('[data-pickup-status]')).to_contain_text('Pickup is complete')
    complete = api(page, f'/api/work-orders/{first["id"]}')['workOrder']
    assert complete['stage'] == 'Picked Up' and complete['date_closed']
    completed_at = page.evaluate('stamp => Date.parse(stamp.replace(" ","T") + "Z")', complete['date_closed'])
    assert completed_at >= started - 1000 and completed_at <= page.evaluate('Date.now()') + 1000
    queues = api(page, '/api/shop/queues')
    own_units = [row for row in queues['inLot'] if row['customer_id'] == first['customer_id']]
    assert len(own_units) == 1 and own_units[0]['vehicle_id'] == second['vehicle_id']
    assert own_units[0]['work_order_id'] == second['id']
    assert next(row['vehicleCount'] for row in queues['checkedInCustomers'] if row['id'] == first['customer_id']) == 1
    remaining = api(page, f'/api/work-orders/{second["id"]}')['workOrder']
    assert remaining['stage'] == 'Intake' and not remaining.get('date_closed')
    responsive(page, artifacts, no_overflow, 'repair-selected-unit-picked-up')
    print('PASS: revised customer signature; final repair payment; Ready and contextual pickup; completion timestamp; second unit remains in custody', flush=True)


def technician_intake_guard(page, base):
    context = page.context.browser.new_context(reduced_motion='reduce')
    technician = context.new_page()
    try:
        technician.goto(base + '/intake.html')
        technician.get_by_label('Employee username').fill('technician')
        technician.get_by_label('Password or employee PIN', exact=True).fill('Review-Only-2026!')
        technician.get_by_role('button', name='Sign in', exact=True).click()
        expect(technician.get_by_role('heading', name='Repair intake requires service desk access')).to_be_visible()
        assert technician.locator('#customerSearch, #customerCreate, #jobDetails').count() == 0
    finally:
        context.close()


def run_workspace_journeys(page, base, artifacts, api, no_overflow):
    print('Checking guided intake and unified job journeys', flush=True)
    try:
        first, second = intake_journeys(page, base, artifacts, api, no_overflow)
        workspace_navigation(page, base, artifacts, api, no_overflow, first, second)
        wrong_job_races(page, base, first, second)
        contextual_account(page, base, artifacts, api, no_overflow, first)
        revised = retained_approvals(page, base, artifacts, api, no_overflow, first)
        complete_repair_pickup(page, base, artifacts, api, no_overflow, first, second, revised)
        technician_intake_guard(page, base)
    except Exception:
        page.screenshot(path=str(artifacts / 'workspace-failure.png'), full_page=True)
        (artifacts / 'workspace-failure.html').write_text(page.content())
        raise
    print('PASS: new/existing customer intake, two units and custody; six contextual tabs; deep links/history/unsaved draft; invoices/revised invoice; cash ledger; signed/revised retained approval', flush=True)

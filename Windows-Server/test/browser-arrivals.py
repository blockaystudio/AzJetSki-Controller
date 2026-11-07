"""Real-server calendar → prepared repair → phone check-in acceptance.

Run: OWNERTRACKER_NODE=/path/to/node22 python test/browser-arrivals.py
Requires Playwright + Chromium. Copies source only into a disposable runtime;
never reads review data, private configuration or provider credentials.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request
from urllib.parse import parse_qs, urlparse
import uuid
import zlib

from playwright.sync_api import expect, sync_playwright


SOURCE = Path(__file__).resolve().parents[1]
NODE = os.environ.get('OWNERTRACKER_NODE', 'node')
ARTIFACTS = Path(os.environ.get('OWNERTRACKER_BROWSER_ARTIFACTS', tempfile.mkdtemp(prefix='ownertracker-arrivals-artifacts-')))
PASSWORD = 'Fictional-Arrivals-2027!'
DATE = '2027-02-01'
CHECKLIST = ['identityConfirmed', 'exteriorReviewed', 'belongingsRecorded', 'keysRecorded']


def headers(page):
    # Secure loopback session cookies need forwarding to Playwright's request client.
    return {'cookie': '; '.join(f'{item["name"]}={item["value"]}' for item in page.context.cookies())}


def api(page, base, path, method='GET', body=None, status=200):
    response = page.request.fetch(base + path, method=method, data=body, headers=headers(page))
    assert response.status == status, (method, path, response.status, response.text())
    return response.json()


def no_custody(page, base, vehicle_id):
    rows = api(page, base, '/api/shop/queues')['inLot']
    assert not any(row['vehicle_id'] == vehicle_id for row in rows), rows


def responsive(page, label):
    for width in [390, 768, 1440]:
        page.set_viewport_size({'width': width, 'height': 900})
        dimensions = page.evaluate('''()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth})''')
        assert dimensions['document'] <= width + 1 and dimensions['body'] <= width + 1, (label, dimensions)
        page.screenshot(path=str(ARTIFACTS / f'{label}-{width}.png'), full_page=True)


def png_fixture(red, green, blue):
    """Small, valid and distinct RGB images; no external fixture downloads."""
    width, height = 64, 48
    pixels = b''.join(b'\x00' + b''.join(bytes(((red + x) % 256, (green + y) % 256, blue))
                                                for x in range(width)) for y in range(height))
    def chunk(kind, value):
        return struct.pack('!I', len(value)) + kind + value + struct.pack('!I', zlib.crc32(kind + value) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')


def seed(page, base):
    def customer(name, phone):
        return api(page, base, '/api/pos/customers', 'POST', {
            'name': name, 'phone': phone, 'email': phone[-4:] + '@example.invalid',
            'address_line1': '123 Fictional Arrival Way', 'city': 'Phoenix', 'state': 'AZ', 'postal_code': '85001',
            'notes': 'Disposable browser acceptance only.'}, status=201)['customer']
    new = customer('Fictional Arrival New Vehicle', '602-555-0141')
    existing = customer('Fictional Arrival Existing Repair', '602-555-0142')
    other = customer('Fictional Arrival Other Customer', '602-555-0143')
    def vehicle(customer_id, suffix):
        return api(page, base, '/api/pos/vehicles', 'POST', {'customer_id': customer_id, 'category': 'PWC',
            'year': '2024', 'make': 'Fictional', 'model': 'Arrival ' + suffix, 'vin': 'FICTIONAL-ARRIVAL-' + suffix}, status=201)['vehicle']
    existing_vehicle, other_vehicle = vehicle(existing['id'], 'EXISTING'), vehicle(other['id'], 'OTHER')
    def job(customer_id, vehicle_id, suffix):
        return api(page, base, '/api/pos/work-orders', 'POST', {'customer_id': customer_id, 'vehicle_id': vehicle_id,
            'ref_number': 'FICTIONAL-ARRIVAL-' + suffix, 'complaint': 'Fictional arrival inspection', 'estimate_total': 0}, status=201)
    existing_job = job(existing['id'], existing_vehicle['id'], 'EXISTING')
    other_job = job(other['id'], other_vehicle['id'], 'OTHER')
    def appointment(title, starts_at, ends_at, customer_id=None, vehicle_id=None):
        return api(page, base, '/api/shop/schedule', 'POST', {'customerId': customer_id or new['id'], 'vehicleId': vehicle_id,
            'title': title, 'startsAt': starts_at, 'endsAt': ends_at, 'notes': 'Fictional; saved locally without provider sync.'}, status=201)['id']
    previous = appointment('Fictional previous Phoenix date', '2027-02-01T06:40:00Z', '2027-02-01T06:50:00Z')
    early = appointment('Fictional early Phoenix arrival', '2027-02-01T07:05:00Z', '2027-02-01T07:15:00Z')
    existing_appointment = appointment('Fictional existing repair arrival', '2027-02-01T17:00:00Z', '2027-02-01T18:00:00Z', existing['id'], existing_vehicle['id'])
    new_appointment = appointment('Fictional late Phoenix arrival', '2027-02-02T06:40:00Z', '2027-02-02T06:50:00Z')
    following = appointment('Fictional next Phoenix date', '2027-02-02T07:05:00Z', '2027-02-02T07:15:00Z')
    return locals()


def run(base):
    with sync_playwright() as playwright:
        executable = os.environ.get('OWNERTRACKER_BROWSER')
        if not executable and not Path(playwright.chromium.executable_path).exists() and Path('/usr/bin/chromium').exists():
            executable = '/usr/bin/chromium'
        browser = playwright.chromium.launch(headless=True, executable_path=executable, args=['--no-sandbox', '--disable-dev-shm-usage'])
        context = browser.new_context(reduced_motion='reduce', viewport={'width': 1440, 'height': 900})
        page = context.new_page()
        errors, external_requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: external_requests.append(request.url) if urlparse(request.url).hostname not in [None, '127.0.0.1'] else None)
        try:
            page.goto(base)
            page.get_by_label('Employee username').fill('owner')
            page.get_by_label('Password or employee PIN', exact=True).fill(PASSWORD)
            page.get_by_role('button', name='Sign in', exact=True).click()
            page.get_by_role('heading', name='Today', exact=True).wait_for()
            staff = api(page, base, '/api/staff?assignment=1')['users']
            assert sorted(user['displayName'] for user in staff) == ['Jacobo Medina', 'Tyler Whitener'], staff
            all_staff = api(page, base, '/api/staff')['users']
            assert any(user['displayName'] == 'Fictional Other Technician' and user['active'] for user in all_staff), all_staff
            data = seed(page, base)
            appointment_id = data['new_appointment']
            existing_id = data['existing_appointment']
            context_path = f'/api/shop/schedule/{appointment_id}/intake-context'
            arrivals = api(page, base, '/api/shop/calendar-arrivals?date=' + DATE)
            assert arrivals['date'] == DATE and arrivals['timeZone'] == 'America/Phoenix', arrivals
            assert [row['appointment']['id'] for row in arrivals['appointments']] == [data['early'], existing_id, appointment_id], arrivals
            for row in arrivals['appointments']:
                assert not row['physicalCheckIn'] and not row['linkedJob'], row
                assert not row['sync']['hasGoogleEvent'], row
            api(page, base, '/api/shop/calendar-arrivals?date=2027-02-30', status=400)
            original_jobs = len(api(page, base, '/api/work-orders')['workOrders'])
            wrong_job = {'appointment_id': appointment_id, 'customer_id': data['other']['id'],
                'vehicle_id': data['other_vehicle']['id'], 'ref_number': 'FICTIONAL-WRONG-APPOINTMENT', 'complaint': 'Must be rejected'}
            api(page, base, '/api/pos/work-orders', 'POST', wrong_job, status=409)
            api(page, base, f'/api/shop/schedule/{existing_id}/intake-job', 'POST', {
                'customerId': data['other']['id'], 'vehicleId': data['other_vehicle']['id'], 'workOrderId': data['other_job']['id']}, status=409)
            assert len(api(page, base, '/api/work-orders')['workOrders']) == original_jobs
            assert api(page, base, context_path)['preparation'] is None

            # A Phoenix calendar date includes late-evening appointments stored on the next UTC date.
            page.goto(base + '/calendar-arrivals.html?date=' + DATE)
            card = page.locator(f'[data-appointment="{appointment_id}"]')
            expect(card).to_contain_text('11:40 PM')
            expect(card).to_contain_text(data['new']['name'])
            expect(card).to_contain_text('Not physically checked in')
            expect(card).to_contain_text('Saved locally')
            expect(page.locator(f'[data-appointment="{data["previous"]}"]')).to_have_count(0)
            expect(page.locator(f'[data-appointment="{data["following"]}"]')).to_have_count(0)
            responsive(page, 'scheduled-arrivals')
            card.get_by_role('link', name='Prepare new repair intake', exact=True).click()
            expect(page.locator('#unitChoices')).to_be_visible()
            expect(page.locator('[aria-label="Selected customer and vehicle"]')).to_contain_text(data['new']['name'])
            expect(page.locator('#customerSearch')).to_have_count(0)
            page.get_by_role('button', name='Add a vehicle', exact=True).click()
            unit = page.locator('#unitCreate')
            expect(unit.locator('select[name=category] option')).to_have_text(
                ['Personal watercraft', 'Jet boat', 'Boat', 'ATV', 'UTV', 'Motorcycle', 'Other'])
            expect(unit.locator('[name=hin]')).to_have_count(0)
            unit.locator('select[name=category]').select_option('Jet boat')
            for name, value in {'year': '2025', 'make': 'Fictional', 'model': 'Arrival Boat', 'vin': 'FICTIONAL-NEW-ARRIVAL', 'hours': '12.5'}.items():
                unit.locator(f'[name={name}]').fill(value)
            responsive(page, 'arrival-new-vehicle')
            with page.expect_response(lambda response: urlparse(response.url).path == '/api/pos/vehicles' and response.request.method == 'POST') as saved_vehicle:
                unit.get_by_role('button', name='Save vehicle & continue', exact=True).click()
            assert saved_vehicle.value.status == 201, saved_vehicle.value.text()
            submitted_vehicle = saved_vehicle.value.request.post_data_json
            assert submitted_vehicle['category'] == 'Jet boat' and submitted_vehicle['vin'] == 'FICTIONAL-NEW-ARRIVAL' and 'hin' not in submitted_vehicle, submitted_vehicle
            vehicle = saved_vehicle.value.json()['vehicle']
            details = page.locator('#jobDetails')
            expect(details).to_be_visible()
            assignment = details.locator('[name=assigned_user_id]')
            options = assignment.locator('option').evaluate_all('(rows)=>rows.map(row=>({value:row.value,text:row.textContent}))')
            assert {row['value'] for row in options if row['value']} == {str(user['id']) for user in staff}, options
            ty = next(user for user in staff if user['displayName'] == 'Tyler Whitener')
            assignment.select_option(str(ty['id']))
            details.locator('[name=complaint]').fill('Fictional scheduled arrival: inspect pump and record prior condition.')
            details.locator('[name=estimate_total]').fill('100.50')
            details.get_by_role('button', name='Review intake', exact=True).click()
            expect(page.locator('#completeIntake')).to_be_visible()
            responsive(page, 'arrival-prepared-review')
            with page.expect_response(lambda response: urlparse(response.url).path == '/api/pos/work-orders' and response.request.method == 'POST') as created:
                page.locator('#completeIntake').get_by_role('button', name='Create repair', exact=True).click()
            assert created.value.status == 201, created.value.text()
            submitted = created.value.request.post_data_json
            assert submitted['appointment_id'] == appointment_id, submitted
            job_id = created.value.json()['id']
            expect(page.locator('#intakeComplete')).to_be_visible()
            prepared = api(page, base, context_path)
            assert prepared['linkedJob']['id'] == job_id and prepared['preparation']['vehicle_id'] == vehicle['id'], prepared
            assert not prepared['physicalCheckIn'] and prepared['custody'] is None, prepared
            assert prepared['sync']['hasGoogleEvent'] is False, prepared
            job = api(page, base, f'/api/work-orders/{job_id}')['workOrder']
            assert job['customer_id'] == data['new']['id'] and job['vehicle_id'] == vehicle['id'] and job['assigned_user_id'] == ty['id'], job
            no_custody(page, base, vehicle['id'])
            # Replaying the acknowledged create returns its atomic appointment link.
            replay = api(page, base, '/api/pos/work-orders', 'POST', submitted)
            assert replay['id'] == job_id and replay['duplicate'] is True, replay
            assert len(api(page, base, '/api/work-orders')['workOrders']) == original_jobs + 1
            page.goto(base + '/calendar-arrivals.html?date=' + DATE)
            card = page.locator(f'[data-appointment="{appointment_id}"]')
            expect(card).to_contain_text('Saved repair ' + job['ref_number'])
            expect(card).to_contain_text('Not physically checked in')
            expect(card.get_by_role('link', name='Prepare new repair intake', exact=True)).to_have_count(0)
            checkin_link = card.get_by_role('link', name='Check in arriving vehicle', exact=True)
            expect(checkin_link).to_have_attribute('href', prepared['checkinUrl'])
            before_checkin = api(page, base, f'/api/vehicle-checkins/context?workOrderId={job_id}')
            assert before_checkin['checkin'] is None and before_checkin['custody'] is None, before_checkin
            api(page, base, '/api/vehicle-checkins', 'POST', {'workOrderId': job_id, 'customerId': data['other']['id'],
                'vehicleId': data['other_vehicle']['id'], 'requestKey': str(uuid.uuid4())}, status=409)
            assert api(page, base, f'/api/vehicle-checkins/context?workOrderId={job_id}')['checkin'] is None

            # Actual phone form, server uploads and decoded image bytes; every draft is off-lot.
            page.set_viewport_size({'width': 390, 'height': 844})
            checkin_link.click()
            form = page.locator('#checkinForm')
            expect(form).to_be_visible()
            assert parse_qs(urlparse(page.url).query)['workOrderId'] == [str(job_id)]
            expect(page.locator('.checkin-identity')).to_contain_text(data['new']['name'])
            expect(page.locator('.checkin-identity')).to_contain_text('FICTIONAL-NEW-ARRIVAL')
            expect(form.locator('select[name=lotLocation] option')).to_have_text(['Choose a lot', 'Dirt lot', 'Front lot'])
            assert form.locator('[name=lotLocation]').evaluate('(element)=>element.required')
            draft = api(page, base, f'/api/vehicle-checkins/context?workOrderId={job_id}')['checkin']
            checkin_path = f'/api/vehicle-checkins/{draft["id"]}'
            assert draft['status'] == 'draft' and not draft['photos'], draft
            no_custody(page, base, vehicle['id'])
            form.locator('[name=lotLocation]').select_option('Dirt lot')
            form.locator('[name=keysTag]').fill('FICTIONAL-K42')
            form.locator('[name=conditionNotes]').fill('Fictional pre-service condition: left-side scuff; blue cover; no loose belongings.')
            for name in CHECKLIST:
                form.locator(f'[name={name}]').check()
            page.locator('#saveDraft').click()
            expect(page.locator('#checkinStatus')).to_contain_text('Draft and photos saved')
            no_custody(page, base, vehicle['id'])
            current = api(page, base, checkin_path)['checkin']
            api(page, base, checkin_path + '/complete', 'POST', {'version': current['version'], 'requestKey': str(uuid.uuid4())}, status=400)
            form.get_by_role('button', name='Complete check-in', exact=True).click()
            expect(page.locator('#checkinStatus')).to_contain_text('at least 2')
            expect(page.locator('#checkinForm')).to_be_visible()
            no_custody(page, base, vehicle['id'])
            photo_uploads = []
            page.on('response', lambda response: photo_uploads.append(response) if urlparse(response.url).path == checkin_path + '/photos' and response.request.method == 'POST' else None)
            for index, color in enumerate([(30, 80, 150), (150, 80, 30)], start=1):
                page.locator('#photoCaption').fill('Fictional front condition' if index == 1 else 'Fictional rear condition')
                page.locator('#checkinCamera').set_input_files({'name': f'fictional-arrival-{index}.png', 'mimeType': 'image/png', 'buffer': png_fixture(*color)})
                expect(page.locator('#photoCount')).to_contain_text(f'{index} saved · 0 waiting')
                if index == 1:
                    form.get_by_role('button', name='Complete check-in', exact=True).click()
                    expect(page.locator('#checkinStatus')).to_contain_text('at least 2')
                    current = api(page, base, checkin_path)['checkin']
                    api(page, base, checkin_path + '/complete', 'POST', {'version': current['version'], 'requestKey': str(uuid.uuid4())}, status=400)
                    no_custody(page, base, vehicle['id'])
            assert len(photo_uploads) == 2 and all(response.status == 201 for response in photo_uploads), [(response.status, response.url) for response in photo_uploads]
            # Draft location can change, and a fresh page reads the retained server record.
            form.locator('[name=lotLocation]').select_option('Front lot')
            page.locator('#saveDraft').click()
            expect(page.locator('#checkinStatus')).to_contain_text('Draft and photos saved')
            page.reload()
            expect(page.locator('#checkinForm')).to_be_visible()
            expect(page.locator('[name=lotLocation]')).to_have_value('Front lot')
            expect(page.locator('[name=keysTag]')).to_have_value('FICTIONAL-K42')
            for name in CHECKLIST:
                expect(page.locator(f'[name={name}]')).to_be_checked()
            expect(page.locator('#photoCount')).to_contain_text('2 saved · 0 waiting')
            expect(page.locator('.photo-state')).to_have_text(['Saved to repair', 'Saved to repair'])
            no_custody(page, base, vehicle['id'])
            responsive(page, 'phone-checkin-draft')
            current = api(page, base, checkin_path)['checkin']
            assert current['lot_location'] == 'Front lot' and all(current['checklist'][key] for key in CHECKLIST), current
            assert len(current['photos']) == 2 and {photo['caption'] for photo in current['photos']} == {'Fictional front condition', 'Fictional rear condition'}, current
            photo_hashes = []
            for photo in current['photos']:
                response = page.request.get(base + photo['url'], headers=headers(page))
                assert response.ok and response.headers['content-type'] == 'image/jpeg', response.status
                content = response.body()
                assert content.startswith(b'\xff\xd8') and len(content) > 100, len(content)
                photo_hashes.append(hashlib.sha256(content).hexdigest())
            assert len(set(photo_hashes)) == 2, photo_hashes
            # A fresh authenticated device sees the server draft without this phone's local storage.
            second_context = browser.new_context(storage_state=context.storage_state(), viewport={'width': 390, 'height': 844})
            second_page = second_context.new_page()
            second_page.goto(page.url)
            expect(second_page.locator('[name=lotLocation]')).to_have_value('Front lot')
            expect(second_page.locator('#photoCount')).to_contain_text('2 saved · 0 waiting')
            for name in CHECKLIST:
                expect(second_page.locator(f'[name={name}]')).to_be_checked()
            second_context.close()
            page.set_viewport_size({'width': 390, 'height': 844})
            with page.expect_response(lambda response: urlparse(response.url).path == checkin_path + '/complete' and response.request.method == 'POST') as completed:
                page.locator('#checkinForm').get_by_role('button', name='Complete check-in', exact=True).click()
            assert completed.value.ok, completed.value.text()
            expect(page.get_by_role('heading', name='Vehicle check-in complete', exact=True)).to_be_visible()
            complete = api(page, base, checkin_path)['checkin']
            assert complete['status'] == 'completed' and complete['completed_at'] and complete['custody_event_id'], complete
            assert complete['lot_location'] == 'Front lot' and len(complete['photos']) == 2 and all(complete['checklist'][key] for key in CHECKLIST), complete
            custody = api(page, base, f'/api/vehicle-checkins/context?workOrderId={job_id}')['custody']
            assert custody['status'] == 'in_lot' and custody['work_order_id'] == job_id and custody['lot_location'] == 'Front lot', custody
            replay = api(page, base, checkin_path + '/complete', 'POST', completed.value.request.post_data_json)
            assert replay['replayed'] is True and replay['checkin']['custody_event_id'] == complete['custody_event_id'], replay
            api(page, base, checkin_path, 'PATCH', {'version': complete['version'], 'lotLocation': 'Dirt lot'}, status=409)
            page.reload()
            expect(page.get_by_role('heading', name='Vehicle check-in complete', exact=True)).to_be_visible()
            expect(page.locator('#checkinForm')).to_have_count(0)
            expect(page.locator('.photo-state')).to_have_text(['Saved to repair', 'Saved to repair'])
            responsive(page, 'phone-checkin-completed')

            # An existing repair can be prepared explicitly and safely retried.
            page.goto(base + '/calendar-arrivals.html?date=' + DATE)
            card = page.locator(f'[data-appointment="{appointment_id}"]')
            expect(card).to_contain_text('Physically checked in · Front lot')
            existing_card = page.locator(f'[data-appointment="{existing_id}"]')
            existing_card.locator('summary').click()
            expect(existing_card.locator(f'[data-prepare-job="{data["other_job"]["id"]}"]')).to_have_count(0)
            existing_card.locator(f'[data-prepare-job="{data["existing_job"]["id"]}"]').click()
            expect(page.locator('#checkinForm')).to_be_visible()
            no_custody(page, base, data['existing_vehicle']['id'])
            prepare_body = {'customerId': data['existing']['id'], 'vehicleId': data['existing_vehicle']['id'], 'workOrderId': data['existing_job']['id']}
            for _ in range(2):
                result = api(page, base, f'/api/shop/schedule/{existing_id}/intake-job', 'POST', prepare_body)
                assert result['duplicate'] is True and result['workOrderId'] == data['existing_job']['id'], result
            assert len(api(page, base, '/api/work-orders')['workOrders']) == original_jobs + 1
            existing_context = api(page, base, f'/api/shop/schedule/{existing_id}/intake-context')
            assert not existing_context['physicalCheckIn'] and existing_context['linkedJob']['id'] == data['existing_job']['id'], existing_context
            assert not errors, errors
            assert not external_requests, external_requests
            (ARTIFACTS / 'acceptance.json').write_text(json.dumps({'result': 'passed', 'fictionalOnly': True,
                'timeZone': 'America/Phoenix', 'date': DATE, 'viewports': [390, 768, 1440], 'beforeServicePhotoSha256': photo_hashes,
                'coverage': ['Phoenix date boundaries', 'exact appointment customer and vehicle', 'category dropdown and VIN-only creation',
                    'Tyler/Jacobo assignment roster', 'atomic appointment preparation and retry', 'preparation and draft remain off-lot',
                    'minimum two actual image uploads', 'cross-device retained draft', 'completed checklist/photos/custody and replay',
                    'existing-repair preparation and wrong-customer guards']}, indent=2))
            print('PASS: fictional real-server scheduled arrivals → prepared intake → phone checklist/two photos → custody; Phoenix dates, exact identity guards, retry safety, category/VIN and roster; 390/768/1440 layouts', flush=True)
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            raise
        finally:
            browser.close()


def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='ownertracker-arrivals-') as folder:
        runtime = Path(folder)
        # Explicit source-only allowlist: private runtime/data/provider files are never copied.
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
        env.update({'HOST': '127.0.0.1', 'PORT': str(port), 'PUBLIC_BASE_URL': 'https://arrivals.ownertracker.example.invalid',
            'OWNERTRACKER_REVIEW': 'true', 'OWNERTRACKER_DB': str(runtime / 'data' / 'arrivals.sqlite'),
            'OWNERTRACKER_ADMIN_PASSWORD': PASSWORD, 'OWNERTRACKER_SESSION_SECRET': 'fictional-arrivals-session-secret',
            'QBPOS_BRIDGE_TOKEN': 'fictional-arrivals-bridge', 'DESKTOP_AGENT_TOKEN': 'fictional-arrivals-agent',
            'AUTO_BUILD_PROCUREMENT': 'false', 'AUTO_SUPPLIER_LOOKUP': 'false', 'REQUIRE_EDIT_REVISION': 'true'})
        with (ARTIFACTS / 'server.log').open('w') as log:
            # Roster setup touches this disposable SQLite file only. Its new staff
            # have random unusable login material; no real employee credentials.
            subprocess.run([NODE, '--input-type=module', '-e', '''
import crypto from 'node:crypto';
import {openDb,ensureAdmin} from './src/db.mjs';
import {configureShopRoster} from './src/shop-roster.mjs';
const db=openDb(process.env.OWNERTRACKER_DB);
ensureAdmin(db,'owner',process.env.OWNERTRACKER_ADMIN_PASSWORD);
db.prepare("INSERT INTO users(username,display_name,password_hash,salt,role,active) VALUES(?,?,?,?,'technician',1)")
  .run('fictional.other.technician','Fictional Other Technician',crypto.randomBytes(64).toString('hex'),crypto.randomBytes(16).toString('hex'));
configureShopRoster(db,{apply:true,actor:'fictional-browser-fixture'});
db.close();
'''], cwd=runtime, env=env, check=True, stdout=log, stderr=subprocess.STDOUT)
            server = subprocess.Popen([NODE, 'src/server.mjs'], cwd=runtime, env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    if server.poll() is not None:
                        raise RuntimeError('Disposable arrivals server failed; see ' + str(ARTIFACTS / 'server.log'))
                    try:
                        urllib.request.urlopen(base + '/api/me', timeout=1).close()
                        break
                    except OSError:
                        time.sleep(.1)
                else:
                    raise RuntimeError('Disposable arrivals server did not start')
                run(base)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
    print('Fictional arrivals artifacts:', ARTIFACTS, flush=True)


if __name__ == '__main__':
    main()

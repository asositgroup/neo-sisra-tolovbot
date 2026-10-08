'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createGoogleDelivery, createPhoneUpdater } = require('../../google-delivery.cjs');

const source = fs.readFileSync(path.join(__dirname, '../phone-sync.gs'), 'utf8');
const SECRET = 'local-test-secret-not-a-real-secret';
const CONTACTS = 'CONTACTS_TEST_SPREADSHEET_ID_ONLY';
const PAYMENTS = 'PAYMENTS_TEST_SPREADSHEET_ID_ONLY';
const ID = '8531637045';
const OLD_PHONE = '+998901234567';
const NEW_PHONE = '+998951234567';
const SECOND_PHONE = '+998991234567';
const registration = { sheetId: 1596542810, name: 'Test Person', originalPhone: OLD_PHONE,
  date: '05.10.2026 13:20:01' };
const receipt = { sheetId: 0, name: 'Test Person', originalPhone: OLD_PHONE,
  date: '2026-10-05', time: '13:30:01', checkUrl: 'https://example.invalid/test-receipt' };

function harness(targets = 'both') {
  const properties = new Map(Object.entries({ PHONE_UPDATE_SECRET: SECRET,
    PHONE_CONTACT_SHEET_ID: CONTACTS, PHONE_PAYMENT_SHEET_ID: PAYMENTS,
    PHONE_UPDATE_TARGETS: targets }));
  const events = [];
  let locked = true;
  let failWrite = 0;
  let writes = 0;
  let failFlush = false;
  let failCommit = false;
  function sheet(id, name, rows) {
    const formulas = new Map();
    return { id, name, rows, formulas,
      getSheetId: () => id,
      getDataRange: () => ({ getDisplayValues: () => rows.map(row => row.map(String)) }),
      getRange(row, col, height, width) {
        assert.equal(col, 2, 'only column B may be accessed for writes');
        assert.equal(height, 1);
        assert.equal(width, 1);
        assert.ok(row > 1 && row <= rows.length, 'must not append or overwrite headers');
        return {
          getFormula: () => formulas.get(row) || '',
          setValue(value) {
            events.push(['write', name, row, col, value]);
            if (++writes === failWrite) throw new Error('Simulated upstream exception containing sensitive cell data');
            rows[row - 1][col - 1] = value;
          },
        };
      },
    };
  }
  const contacts = sheet(0, 'Sheet1', [
    ['Ism (botda kiritilgan)', 'Telefon (botda kiritilgan)', 'Telegram username',
      'Telegram profil havolasi', 'Telegram ID', 'ID orqali ochish',
      'Telegram profil nomi', 'Birinchi ro‘yxatdan o‘tish'],
    ['Test Person', OLD_PHONE, '@test', 'https://t.me/test', ID, 'tg://user?id=' + ID, 'Test', '05.10.2026'],
    ['Other Person', '+998971111111', '@other', 'https://t.me/other', '42', 'tg://user?id=42', 'Other', '05.10.2026'],
  ]);
  const registrations = sheet(1596542810, 'Royhatdan otganlar', [
    ['Ism', 'Telefon raqam', 'Tarif', 'Oferta', 'Sana'],
    [registration.name, OLD_PHONE, 'Service', 'Roziman', registration.date],
    ['Other Person', OLD_PHONE, 'Service', 'Roziman', registration.date],
  ]);
  const receipts = sheet(0, 'Chek Yuborganlar', [
    ['Ism', 'Telefon raqam', 'Tarif', 'Offerta', 'Check URL', 'sana', 'vaqt'],
    [receipt.name, OLD_PHONE, 'Service', 'Roziman', receipt.checkUrl, receipt.date, receipt.time],
  ]);
  const unique = sheet(99, 'Unique rows', [['formula'], ['=UNIQUE(A:A)']]);
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) ?? null,
      getProperties: () => Object.fromEntries(properties),
      setProperty(key, value) {
        events.push(['property', key, value]);
        if (failCommit && key.startsWith('PHONE_SYNC_USER_') && JSON.parse(value).status === 'committed') {
          throw new Error('Commit property unavailable');
        }
        properties.set(key, value);
      },
      setProperties(values, deleteOthers) {
        assert.equal(deleteOthers, false);
        for (const [key, value] of Object.entries(values)) properties.set(key, value);
      },
    }) },
    LockService: { getScriptLock: () => ({
      tryLock: () => { events.push(['lock']); return locked; },
      releaseLock: () => events.push(['unlock']),
    }) },
    Utilities: { newBlob: str => ({ getBytes: () => Array.from(Buffer.from(str, 'utf8')) }) },
    SpreadsheetApp: {
      openById(id) {
        events.push(['open', id]);
        assert.ok([CONTACTS, PAYMENTS].includes(id));
        return { getSheetByName: name => id === CONTACTS && name === 'Sheet1' ? contacts : null,
          getSheets: () => id === PAYMENTS ? [registrations, receipts, unique] : [contacts] };
      },
      flush() { events.push(['flush']); if (failFlush) throw new Error('Flush failed'); },
    },
  });
  vm.runInContext(source, context, { filename: 'phone-sync.gs' });
  const dispatch = payload => JSON.parse(JSON.stringify(context.phoneSyncDispatch_(payload)));
  const update = (overrides = {}) => dispatch({ action: 'updatePhone', secret: SECRET,
    telegramId: ID, phone: NEW_PHONE, additionalPhone: null, revision: 1,
    updatedAt: '2026-10-08T17:00:00.000Z', ...overrides });
  const seed = (records = [{ telegramId: ID, entries: [registration, receipt] }]) =>
    dispatch({ action: 'phone_seed', secret: SECRET, records });
  return { properties, events, contacts, registrations, receipts, unique, dispatch, update, seed,
    state: () => JSON.parse(properties.get('PHONE_SYNC_USER_' + ID)),
    setLocked: value => { locked = value; }, setFailWrite: value => { failWrite = value; },
    setFailFlush: value => { failFlush = value; }, setFailCommit: value => { failCommit = value; } };
}

test('Apps Script authenticates before opening Sheets or acquiring a lock', () => {
  const h = harness();
  for (const secret of [undefined, '', 'wrong', SECRET + 'x']) {
    assert.equal(h.update({ secret }).code, 'UNAUTHORIZED');
  }
  assert.deepEqual(h.events, []);
  assert.equal(h.dispatch({ action: 'phone_seed', records: [] }).code, 'UNAUTHORIZED');
});

test('Apps Script health checks fixed headers without exposing data or secrets', () => {
  const h = harness();
  assert.deepEqual(h.dispatch({ action: 'phone_health', secret: SECRET }), {
    result: 'success', ok: true, targets: ['contacts', 'payments'], headersValid: true,
  });
  h.contacts.rows[0][4] = 'Unrelated column';
  assert.equal(h.update().code, 'HEADER_MISMATCH');
  assert.equal(h.events.filter(event => event[0] === 'write').length, 0);
});

test('Apps Script updates contacts only by exact Telegram ID and preserves all other cells', () => {
  const h = harness('contacts');
  const before = structuredClone(h.contacts.rows);
  h.contacts.rows.splice(1, 0, ['Test Person', OLD_PHONE, '@decoy', '', '0' + ID, '', '', '']);
  assert.equal(h.update().ok, true);
  assert.equal(h.contacts.rows[1][1], OLD_PHONE, 'similar ID and same name must not match');
  assert.equal(h.contacts.rows[2][1], NEW_PHONE);
  const actual = h.contacts.rows[2].slice();
  actual[1] = before[1][1];
  assert.deepEqual(actual, before[1]);
  assert.deepEqual(h.contacts.rows[3], before[2]);
  assert.equal(h.registrations.rows[1][1], OLD_PHONE);
});

test('Apps Script seeded payment rows use every fingerprint field and survive row reordering', () => {
  const h = harness();
  assert.deepEqual(h.seed(), { result: 'success', ok: true, addedMappings: 2 });
  h.registrations.rows.push(h.registrations.rows.splice(1, 1)[0]);
  const initialOther = structuredClone(h.registrations.rows[1]);
  const unique = structuredClone(h.unique.rows);
  assert.deepEqual(h.update({ additionalPhone: SECOND_PHONE }), {
    result: 'success', ok: true, updated: true, telegramId: ID, revision: 1, matchedRows: 3,
  });
  for (const row of [h.contacts.rows[1], h.registrations.rows[2], h.receipts.rows[1]]) {
    assert.equal(row[1], NEW_PHONE + ' / ' + SECOND_PHONE);
  }
  assert.deepEqual(h.registrations.rows[1], initialOther);
  assert.deepEqual(h.unique.rows, unique);
  assert.equal(h.registrations.rows.length, 3);
});

test('Apps Script missing ID or unseeded payment rows fail without appending', () => {
  const h = harness('payments');
  assert.equal(h.update().code, 'ROW_NOT_FOUND');
  assert.ok(!h.properties.has('PHONE_SYNC_USER_' + ID));
  const contactOnly = harness('contacts');
  assert.equal(contactOnly.update({ telegramId: '123' }).code, 'ROW_NOT_FOUND');
  assert.equal(contactOnly.contacts.rows.length, 3);
  assert.equal(contactOnly.events.filter(event => event[0] === 'write').length, 0);
});

test('Apps Script locked worker returns retryable busy and does not access Sheets', () => {
  const h = harness();
  h.setLocked(false);
  assert.deepEqual(h.update(), { result: 'error', ok: false, code: 'BUSY' });
  assert.deepEqual(h.events, [['lock']]);
});

test('Apps Script duplicate IDs or ambiguous payment fingerprints fail closed', () => {
  const h = harness();
  h.contacts.rows.push([...h.contacts.rows[1]]);
  assert.equal(h.update().code, 'AMBIGUOUS_ROW');
  const payment = harness('payments');
  payment.registrations.rows.push([...payment.registrations.rows[1]]);
  assert.equal(payment.seed().code, 'AMBIGUOUS_ROW');
  assert.equal(payment.properties.has('PHONE_SYNC_USER_' + ID), false);
});

test('Apps Script never overwrites a formula even in the phone column', () => {
  const h = harness();
  h.seed();
  h.receipts.formulas.set(2, '=OTHER!B2');
  assert.equal(h.update().code, 'FORMULA_PROTECTED');
  assert.equal(h.contacts.rows[1][1], OLD_PHONE, 'preflight all destinations before mutation');
  assert.equal(h.events.filter(event => event[0] === 'write').length, 0);
});

test('Apps Script immutable revisions cannot overwrite newer contact details', () => {
  const h = harness();
  h.seed();
  assert.equal(h.update({ revision: 3 }).ok, true);
  assert.deepEqual(h.update({ revision: 2, phone: SECOND_PHONE }), {
    result: 'error', ok: false, code: 'STALE_REVISION',
  });
  assert.equal(h.update({ revision: 3, phone: SECOND_PHONE }).code, 'REVISION_CONFLICT');
  assert.equal(h.update({ revision: 3 }).updated, true);
  assert.equal(h.contacts.rows[1][1], NEW_PHONE);
});

test('Apps Script fences before writes, flushes before commit, and retries partial writes', () => {
  const h = harness();
  h.seed();
  h.setFailWrite(3);
  const result = h.update();
  assert.deepEqual(result, { result: 'error', ok: false, code: 'RETRY_REQUIRED' });
  assert.equal(h.state().status, 'pending');
  assert.equal(h.contacts.rows[1][1], NEW_PHONE);
  assert.equal(h.registrations.rows[1][1], NEW_PHONE);
  assert.equal(h.receipts.rows[1][1], OLD_PHONE);
  const fence = h.events.findIndex(event => event[0] === 'property');
  const firstWrite = h.events.findIndex(event => event[0] === 'write');
  assert.ok(fence >= 0 && fence < firstWrite);
  assert.equal(h.update().ok, true);
  assert.equal(h.receipts.rows[1][1], NEW_PHONE);
  assert.equal(h.state().status, 'committed');
  const lastFlush = h.events.findLastIndex(event => event[0] === 'flush');
  const committed = h.events.findLastIndex(event => event[0] === 'property');
  assert.ok(lastFlush < committed);
});

test('Apps Script higher revision supersedes a partially written lower revision safely', () => {
  const h = harness();
  h.seed();
  h.setFailWrite(3);
  assert.equal(h.update().ok, false);
  assert.equal(h.update({ revision: 2, phone: SECOND_PHONE }).ok, true);
  assert.equal(h.update().code, 'STALE_REVISION');
  for (const table of [h.contacts, h.registrations, h.receipts]) {
    assert.equal(table.rows[1][1], SECOND_PHONE);
  }
});

test('Apps Script retries safely after a flush or final property write failure', () => {
  for (const failure of ['setFailFlush', 'setFailCommit']) {
    const h = harness();
    h.seed();
    h[failure](true);
    assert.equal(h.update().code, 'RETRY_REQUIRED');
    assert.equal(h.state().status, 'pending');
    h[failure](false);
    assert.equal(h.update().ok, true);
    assert.equal(h.state().status, 'committed');
  }
});

test('Apps Script repeated updates reidentify latest stored phone with original date and name', () => {
  const h = harness();
  h.seed();
  assert.equal(h.update().ok, true);
  assert.equal(h.update({ revision: 2, phone: SECOND_PHONE }).ok, true);
  assert.equal(h.registrations.rows[1][1], SECOND_PHONE);
  h.receipts.rows[1][6] = '13:30:02';
  assert.equal(h.update({ revision: 3 }).matchedRows, 2);
  assert.equal(h.contacts.rows[1][1], NEW_PHONE);
  assert.equal(h.receipts.rows[1][1], SECOND_PHONE, 'changed fingerprint is skipped without guessing a match');
});

test('Apps Script seeding is additive and idempotent without resetting revisions', () => {
  const h = harness();
  assert.equal(h.seed([{ telegramId: ID, entries: [registration] }]).addedMappings, 1);
  assert.equal(h.update().ok, true);
  assert.equal(h.seed().addedMappings, 1);
  assert.equal(h.seed().addedMappings, 0);
  assert.equal(h.state().revision, 1);
  assert.equal(h.state().status, 'committed');
  assert.equal(h.update().matchedRows, 3, 'same-revision retry must include the newly seeded receipt');
  assert.equal(h.receipts.rows[1][1], NEW_PHONE);
  assert.equal(h.update({ revision: 2, phone: SECOND_PHONE }).ok, true);
  assert.equal(h.receipts.rows[1][1], SECOND_PHONE);
});

test('Apps Script does not map one payment identity to two Telegram accounts', () => {
  const h = harness();
  assert.equal(h.seed().ok, true);
  assert.equal(h.seed([{ telegramId: '42', entries: [registration] }]).code, 'SEED_CONFLICT');
  assert.equal(h.properties.has('PHONE_SYNC_USER_42'), false);
});

test('Apps Script rejects invalid phone requests and arbitrary seed destinations', () => {
  const h = harness();
  for (const invalid of [{ telegramId: Number(ID) }, { phone: '+9983453434' },
    { phone: '998951234567' }, { phone: 'words' }, { additionalPhone: NEW_PHONE },
    { additionalPhone: '' }, { revision: 0 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { updatedAt: 'not a timestamp' }]) {
    assert.equal(h.update(invalid).code, 'INVALID_REQUEST');
  }
  assert.equal(h.seed([{ telegramId: ID, entries: [{ ...registration, sheetId: 99 }] }]).code, 'INVALID_SEED');
  assert.equal(h.events.filter(event => event[0] === 'write').length, 0);
});

test('Apps Script same-revision retry applies destinations enabled after the first commit', () => {
  const h = harness('contacts');
  h.seed();
  assert.equal(h.update().matchedRows, 1);
  assert.equal(h.registrations.rows[1][1], OLD_PHONE);
  h.properties.set('PHONE_UPDATE_TARGETS', 'both');
  assert.equal(h.update().matchedRows, 3);
  assert.equal(h.state().matchedRows, 3);
  assert.equal(h.registrations.rows[1][1], NEW_PHONE);
  assert.equal(h.receipts.rows[1][1], NEW_PHONE);
});

test('real phone updater accepts Apps Script ACKs, including same-revision repair, and rejects stale delivery', async () => {
  const h = harness();
  h.seed([{ telegramId: ID, entries: [registration] }]);
  const calls = [];
  const updater = createPhoneUpdater({
    endpoint: 'https://script.google.com/macros/s/PHONE_SYNC_TEST_ONLY/exec',
    secret: SECRET,
    fetchImpl: async (url, options) => {
      const request = JSON.parse(options.body);
      calls.push(request);
      return { ok: true, json: async () => h.dispatch(request) };
    },
  });
  const snapshot = { telegramId: ID, phone: NEW_PHONE, additionalPhone: null,
    revision: 1, updatedAt: '2026-10-08T17:00:00.000Z' };
  assert.deepEqual(await updater.updatePhone(snapshot), {
    ok: true, telegramId: ID, revision: 1, matchedRows: 2,
  });
  assert.equal(h.seed().addedMappings, 1);
  assert.deepEqual(await updater.updatePhone(snapshot), {
    ok: true, telegramId: ID, revision: 1, matchedRows: 3,
  });
  assert.equal(h.receipts.rows[1][1], NEW_PHONE);
  assert.deepEqual(await updater.updatePhone({ ...snapshot, revision: 2, phone: SECOND_PHONE }), {
    ok: true, telegramId: ID, revision: 2, matchedRows: 3,
  });
  await assert.rejects(updater.updatePhone(snapshot), { code: 'PHONE_UPDATE_UNCONFIRMED' });
  assert.equal(h.receipts.rows[1][1], SECOND_PHONE);
  assert.equal(calls.length, 4);
});

test('Apps Script new user can self-seed verified successful append identity without a contacts row', () => {
  const h = harness();
  h.contacts.rows.splice(1, 1);
  assert.equal(h.properties.has('PHONE_SYNC_USER_' + ID), false);
  assert.deepEqual(h.update({ entries: [registration] }), {
    result: 'success', ok: true, updated: true, telegramId: ID, revision: 1, matchedRows: 1,
  });
  assert.equal(h.state().entries.length, 1);
  assert.equal(h.state().entries[0].originalPhone, OLD_PHONE);
  assert.equal(h.registrations.rows[1][1], NEW_PHONE);
  assert.equal(h.contacts.rows.length, 2, 'must not add contact rows');
  assert.equal(h.update({ entries: [registration] }).ok, true, 'retry does not rematch an obsolete original phone');
});

test('Apps Script new receipt identity accepts recognized date/time and same Drive file ID only', () => {
  const h = harness('payments');
  const fileId = 'VERIFIED_TEST_DRIVE_FILE_ID';
  h.registrations.rows[1][4] = '2026-10-05 13:20:01';
  h.receipts.rows[1][4] = `https://drive.google.com/uc?export=view&id=${fileId}`;
  h.receipts.rows[1][5] = '05.10.2026';
  h.receipts.rows[1][6] = '3:30:01';
  const entries = [registration, { ...receipt,
    checkUrl: `https://drive.google.com/file/d/${fileId}/view`, time: '03:30:01' }];
  assert.equal(h.update({ entries }).matchedRows, 2);
  const state = h.state();
  assert.equal(state.entries[0].date, '2026-10-05 13:20:01');
  assert.equal(state.entries[1].checkUrl, h.receipts.rows[1][4]);
  assert.equal(state.entries[1].date, '05.10.2026');
  assert.equal(state.entries[1].time, '3:30:01');
  assert.equal(state.entries[1].originalPhone, OLD_PHONE);
  assert.equal(h.update({ revision: 2, phone: SECOND_PHONE, entries }).matchedRows, 2);
  assert.equal(h.state().entries.length, 2, 'equivalent repeated identities do not duplicate stored entries');
});

test('Apps Script trusted inline seed still refuses fuzzy identities and spoofed receipt URLs', () => {
  const fileId = 'VERIFIED_TEST_DRIVE_FILE_ID';
  for (const bad of [
    { name: 'Test Person ' }, { originalPhone: OLD_PHONE.slice(1) }, { date: '10/05/2026' },
    { date: '2026-10-06' }, { time: '13:30' }, { time: '13:30:02' },
    { checkUrl: `https://drive.google.com.evil.invalid/file/d/${fileId}/view` },
    { checkUrl: `https://drive.google.com/uc?id=${fileId}&id=${fileId}` },
    { checkUrl: 'https://drive.google.com/file/d/OTHER_TEST_DRIVE_FILE_ID/view' },
  ]) {
    const h = harness('payments');
    h.receipts.rows[1][4] = `https://drive.google.com/uc?export=view&id=${fileId}`;
    const candidate = { ...receipt, checkUrl: `https://drive.google.com/file/d/${fileId}/view`, ...bad };
    assert.equal(h.update({ entries: [candidate] }).code, 'ROW_NOT_FOUND');
    assert.equal(h.properties.has('PHONE_SYNC_USER_' + ID), false);
    assert.equal(h.receipts.rows[1][1], OLD_PHONE);
  }
});

test('Apps Script invalid or stale updates cannot mutate identity mappings', () => {
  const h = harness();
  h.seed([{ telegramId: ID, entries: [registration] }]);
  assert.equal(h.update({ revision: 2 }).ok, true);
  const before = h.properties.get('PHONE_SYNC_USER_' + ID);
  for (const invalid of [
    { phone: 'bad' }, { revision: 0 }, { updatedAt: 'invalid' }, { secret: 'wrong' },
    { entries: 'not an array' }, { entries: Array(41).fill(receipt) },
  ]) {
    assert.equal(h.update({ revision: 3, entries: [receipt], ...invalid }).ok, false);
    assert.equal(h.properties.get('PHONE_SYNC_USER_' + ID), before);
  }
  assert.equal(h.update({ revision: 1, entries: [receipt] }).code, 'STALE_REVISION');
  assert.equal(h.properties.get('PHONE_SYNC_USER_' + ID), before);
  assert.equal(h.receipts.rows[1][1], OLD_PHONE);
  assert.equal(h.update({ revision: 2, entries: [receipt] }).matchedRows, 3);
  assert.equal(h.receipts.rows[1][1], NEW_PHONE, 'current revision may repair a newly appended receipt');
});

test('Apps Script inline seeding protects global identity ownership across equivalent date formats', () => {
  const h = harness('payments');
  h.seed([{ telegramId: '42', entries: [registration] }]);
  const equivalent = { ...registration, date: '2026-10-05 13:20:01' };
  assert.equal(h.update({ entries: [equivalent] }).code, 'SEED_CONFLICT');
  assert.equal(h.properties.has('PHONE_SYNC_USER_' + ID), false);
  assert.equal(h.registrations.rows[1][1], OLD_PHONE);
});

test('Apps Script equivalent duplicate rows and invalid later entries make seeding atomic and fail closed', () => {
  const h = harness('payments');
  h.registrations.rows.push([...h.registrations.rows[1]]);
  h.registrations.rows.at(-1)[4] = '2026-10-05 13:20:01';
  assert.equal(h.update({ entries: [registration] }).code, 'AMBIGUOUS_ROW');
  assert.equal(h.properties.has('PHONE_SYNC_USER_' + ID), false);
  const invalid = harness('payments');
  assert.equal(invalid.update({ entries: [registration, { ...receipt, sheetId: 123 }] }).code, 'INVALID_SEED');
  assert.equal(invalid.properties.has('PHONE_SYNC_USER_' + ID), false);
  assert.equal(invalid.events.filter(event => event[0] === 'write').length, 0);
});

test('real phone updater bridges a new user through captured append identity without operator seeding', async () => {
  const h = harness('payments');
  const updater = createPhoneUpdater({
    endpoint: 'https://script.google.com/macros/s/PHONE_SYNC_TEST_ONLY/exec', secret: SECRET,
    fetchImpl: async (url, options) => ({ ok: true, json: async () => h.dispatch(JSON.parse(options.body)) }),
  });
  const snapshot = { telegramId: ID, phone: NEW_PHONE, additionalPhone: null,
    revision: 1, updatedAt: '2026-10-08T17:00:00.000Z', entries: [registration] };
  assert.deepEqual(await updater.updatePhone(snapshot), {
    ok: true, telegramId: ID, revision: 1, matchedRows: 1,
  });
  assert.equal(h.registrations.rows[1][1], NEW_PHONE);
  assert.deepEqual(await updater.updatePhone({ ...snapshot, revision: 2, phone: SECOND_PHONE }), {
    ok: true, telegramId: ID, revision: 2, matchedRows: 1,
  });
  assert.equal(h.registrations.rows[1][1], SECOND_PHONE);
});

test('captured real registration and receipt delivery identities bridge into automatic backend mapping', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-08T22:04:05Z').valueOf() });
  const h = harness('payments');
  const fileId = 'CAPTURED_RECEIPT_DRIVE_TEST_ID';
  const endpoint = 'https://script.google.com/macros/s/PHONE_SYNC_TEST_ONLY/exec';
  const delivery = createGoogleDelivery({ endpoint, captureIdentity: true,
    fetchImpl: async (url, options) => {
      const form = Object.fromEntries(options.body);
      if (form.imageUpload === 'true') {
        h.receipts.rows[1] = [form.Ism, form['Telefon raqam'], form.Tarif, form.Offerta,
          `https://drive.google.com/uc?export=view&id=${fileId}`,
          form.sana.split('-').reverse().join('.'), form.vaqt.replace(/^0/, '')];
      } else {
        h.registrations.rows[1] = [form.Ism, form['Telefon raqam'], form.Tarif, form.Oferta, form.Sana];
      }
      return { ok: true, json: async () => ({ result: 'success',
        fileUrl: `https://drive.google.com/file/d/${fileId}/view` }) };
    },
  });
  const profile = { name: 'Test Person', phone: OLD_PHONE, additionalPhone: SECOND_PHONE,
    telegramId: ID, offerAccepted: true, offerVersion: 'test-version' };
  const registered = await delivery.sendRegistration(profile);
  const sentReceipt = await delivery.sendReceipt(profile, {
    bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64'),
    fileName: 'test.png', mimeType: 'image/png',
  });
  const updater = createPhoneUpdater({ endpoint, secret: SECRET,
    fetchImpl: async (url, options) => ({ ok: true, json: async () => h.dispatch(JSON.parse(options.body)) }),
  });
  const snapshot = { telegramId: ID, phone: NEW_PHONE, additionalPhone: SECOND_PHONE,
    revision: 1, updatedAt: '2026-10-08T22:05:00.000Z',
    entries: [registered.sheetIdentity, sentReceipt.sheetIdentity] };
  assert.deepEqual(await updater.updatePhone(snapshot), {
    ok: true, telegramId: ID, revision: 1, matchedRows: 2,
  });
  assert.equal(h.state().entries.length, 2);
  assert.equal(h.state().entries[1].time, '3:04:05');
  assert.equal(h.state().entries[1].date, '09.10.2026');
  assert.equal(h.state().entries[1].originalPhone, OLD_PHONE + ' / ' + SECOND_PHONE);
  assert.equal(h.receipts.rows[1][1], NEW_PHONE + ' / ' + SECOND_PHONE);
});

test('Apps Script skips deleted existing mappings while updating verified remaining destinations', () => {
  const h = harness();
  h.seed();
  const deleted = h.registrations.rows.splice(1, 1)[0];
  assert.equal(h.update().matchedRows, 2);
  assert.equal(h.contacts.rows[1][1], NEW_PHONE);
  assert.equal(h.receipts.rows[1][1], NEW_PHONE);
  const state = h.state();
  assert.equal(state.entries[0].originalPhone, OLD_PHONE);
  assert.equal(state.entries[0].currentPhone, OLD_PHONE);
  assert.equal(state.entries[1].currentPhone, NEW_PHONE);
  assert.deepEqual(state.pendingPhones, [NEW_PHONE]);
  h.registrations.rows.push(deleted);
  assert.equal(h.update().matchedRows, 3, 'same revision repairs a restored original row');
  assert.equal(h.registrations.rows.at(-1)[1], NEW_PHONE);
  assert.deepEqual(h.state().pendingPhones, []);
});

test('Apps Script all missing destinations fail without committing or writing any cell', () => {
  const h = harness('payments');
  h.seed();
  const before = h.properties.get('PHONE_SYNC_USER_' + ID);
  h.registrations.rows.splice(1, 1);
  h.receipts.rows.splice(1, 1);
  assert.equal(h.update().code, 'ROW_NOT_FOUND');
  assert.equal(h.properties.get('PHONE_SYNC_USER_' + ID), before);
  assert.equal(h.events.filter(event => event[0] === 'write').length, 0);
});

test('Apps Script ambiguous remaining mapping still aborts even if another mapped row is missing', () => {
  const h = harness();
  h.seed();
  h.registrations.rows.splice(1, 1);
  h.receipts.rows.push([...h.receipts.rows[1]]);
  assert.equal(h.update().code, 'AMBIGUOUS_ROW');
  assert.equal(h.contacts.rows[1][1], OLD_PHONE);
  assert.equal(h.events.filter(event => event[0] === 'write').length, 0);
});

test('Apps Script preserves pending values for missing rows after a partial-write retry', () => {
  const h = harness();
  h.seed();
  h.setFailWrite(3);
  assert.equal(h.update().code, 'RETRY_REQUIRED');
  const deleted = h.registrations.rows.splice(1, 1)[0];
  assert.equal(deleted[1], NEW_PHONE, 'the removed row already received the interrupted revision');
  assert.equal(h.update({ revision: 2, phone: SECOND_PHONE }).matchedRows, 2);
  assert.equal(h.state().entries[0].currentPhone, OLD_PHONE);
  assert.deepEqual(h.state().pendingPhones, [NEW_PHONE, SECOND_PHONE]);
  h.registrations.rows.push(deleted);
  assert.equal(h.update({ revision: 2, phone: SECOND_PHONE }).matchedRows, 3);
  assert.equal(h.registrations.rows.at(-1)[1], SECOND_PHONE);
  assert.deepEqual(h.state().pendingPhones, []);
});

test('Apps Script newly supplied identity still fails strictly when no row verifies it', () => {
  const h = harness();
  h.seed([{ telegramId: ID, entries: [registration] }]);
  h.receipts.rows.splice(1, 1);
  assert.equal(h.update({ entries: [receipt] }).code, 'ROW_NOT_FOUND');
  assert.equal(h.contacts.rows[1][1], OLD_PHONE);
  assert.equal(h.registrations.rows[1][1], OLD_PHONE);
  assert.equal(h.state().entries.length, 1);
});

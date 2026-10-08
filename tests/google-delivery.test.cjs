'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleDelivery, validateReceipt } = require('../google-delivery.cjs');

const endpoint = 'https://script.google.com/macros/s/NEO_SISRA_TEST_ONLY/exec';
const profile = {
  name: '  Neo Sisra Test  ', phone: '+998901234567', offerAccepted: true,
  offerVersion: 'test-2026-10-04', telegramId: 123456789,
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64');
const receipt = { bytes: png, fileName: 'chek.png', mimeType: 'image/png' };
const fileUrl = 'https://drive.google.com/file/d/NEO_SISRA_TEST_RECEIPT/view';
const success = { result: 'success', fileUrl };

function fakeDelivery(result = success) {
  const calls = [];
  const delivery = createGoogleDelivery({ endpoint, fetchImpl: async (url, options) => {
    calls.push({ url, options, fields: Object.fromEntries(options.body) });
    return { ok: true, json: async () => result };
  } });
  return { calls, delivery };
}

test('registration posts exactly the existing schema and Tashkent timestamp across UTC midnight', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-04T20:04:05Z').valueOf() });
  const { calls, delivery } = fakeDelivery();
  assert.deepEqual(await delivery.sendRegistration(profile), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, endpoint);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.ok(calls[0].options.body instanceof FormData);
  assert.deepEqual(calls[0].fields, {
    sheetName: 'Royhatdan otganlar', imageUpload: 'false', Ism: 'Neo Sisra Test',
    'Telefon raqam': profile.phone, Tarif: 'Koreyaga talaba yuborish',
    Oferta: 'Roziman', Sana: '05.10.2026 01:04:05',
  });
});

test('receipt posts exact fields, preserves bytes and uses Tashkent midnight without hour 24', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-04T19:00:01Z').valueOf() });
  const { calls, delivery } = fakeDelivery();
  assert.deepEqual(await delivery.sendReceipt(profile, receipt), { fileUrl });
  assert.deepEqual(calls[0].fields, {
    sheetName: 'Chek Yuborganlar', imageUpload: 'true', Ism: 'Neo Sisra Test',
    'Telefon raqam': profile.phone, Tarif: 'Koreyaga talaba yuborish',
    Offerta: 'Roziman', sana: '2026-10-05', vaqt: '00:00:01', checkUrlHeader: 'Check URL',
    file_data: png.toString('base64'), file_filename: 'chek.png', file_mime: 'image/png',
  });
  assert.deepEqual(Buffer.from(calls[0].fields.file_data, 'base64'), png);
});

test('both operations reject missing, stale-shaped or false consent before any request', async () => {
  const { calls, delivery } = fakeDelivery();
  for (const invalid of [undefined, {}, { ...profile, offerAccepted: false },
    { ...profile, offerAccepted: 'true' }, { ...profile, offerVersion: '' },
    { ...profile, offerVersion: '  ' }, { ...profile, offerVersion: undefined },
    { ...profile, offerVersion: '\n' }]) {
    await assert.rejects(delivery.sendRegistration(invalid), { code: 'CONSENT_REQUIRED' });
    await assert.rejects(delivery.sendReceipt(invalid, receipt), { code: 'CONSENT_REQUIRED' });
  }
  assert.equal(calls.length, 0);
});

test('registration and receipt include both phone numbers in the existing phone column only', async () => {
  const additionalPhone = '+998951234567';
  const { calls, delivery } = fakeDelivery();
  await delivery.sendRegistration({ ...profile, additionalPhone });
  await delivery.sendReceipt({ ...profile, additionalPhone }, receipt);
  const legacy = fakeDelivery();
  await legacy.delivery.sendRegistration(profile);
  await legacy.delivery.sendReceipt(profile, receipt);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.fields['Telefon raqam'], `${profile.phone} / ${additionalPhone}`);
    assert.deepEqual(Object.keys(call.fields), Object.keys(legacy.calls[index].fields));
  }
});

test('legacy profiles with absent or empty additional phone retain the primary number', async () => {
  const { calls, delivery } = fakeDelivery();
  for (const additionalPhone of [undefined, null, '']) {
    await delivery.sendRegistration({ ...profile, additionalPhone });
    await delivery.sendReceipt({ ...profile, additionalPhone }, receipt);
  }
  assert.equal(calls.length, 6);
  for (const call of calls) assert.equal(call.fields['Telefon raqam'], profile.phone);
});

test('both operations reject malformed or duplicate additional phone before any request', async () => {
  const { calls, delivery } = fakeDelivery();
  for (const additionalPhone of ['  ', '951234567', '+998 95 1234567', '+012345678',
    '+998951234567\n', '+1234567890123456', 998951234567, false, {}, profile.phone]) {
    await assert.rejects(delivery.sendRegistration({ ...profile, additionalPhone }),
      { code: 'INVALID_PROFILE' });
    await assert.rejects(delivery.sendReceipt({ ...profile, additionalPhone }, receipt),
      { code: 'INVALID_PROFILE' });
  }
  assert.equal(calls.length, 0);
});

test('both operations reject invalid contact data before any request', async () => {
  const { calls, delivery } = fakeDelivery();
  for (const change of [{ name: '' }, { name: 'a\nb' }, { name: 'a'.repeat(101) },
    { phone: '901234567' }, { phone: '+012345678' }, { phone: '+998 90 1234567' }]) {
    await assert.rejects(delivery.sendRegistration({ ...profile, ...change }), { code: 'INVALID_PROFILE' });
    await assert.rejects(delivery.sendReceipt({ ...profile, ...change }, receipt), { code: 'INVALID_PROFILE' });
  }
  assert.equal(calls.length, 0);
});

test('receipt signatures, MIME types, extensions, sizes and byte input must agree', () => {
  const invalid = [
    [Buffer.alloc(0), 'check.png', 'image/png'],
    [Buffer.alloc(10 * 1024 * 1024 + 1), 'check.png', 'image/png'],
    [png, 'check.gif', 'image/gif'], [png, 'check.pdf', 'image/png'],
    [png, 'check.pdf', 'application/pdf'], [Buffer.from('not a png'), 'check.png', 'image/png'],
    [Buffer.from([255, 216]), 'check.jpg', 'image/jpeg'],
    [Buffer.from('%PD'), 'check.pdf', 'application/pdf'],
    ['https://api.telegram.org/file/botTEST_SECRET/check.png', 'check.png', 'image/png'],
    [png, 'https://api.telegram.org/file/botTEST_SECRET/check.png', 'image/png'],
    [png, '', 'image/png'], [png, 'no-extension', 'image/png'],
  ];
  for (const values of invalid) assert.throws(() => validateReceipt(...values), { code: 'INVALID_RECEIPT' });
});

test('valid PNG, JPEG and PDF signatures are accepted; full 10 MiB is allowed', () => {
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 255, 217]);
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj <<>> endobj\n%%EOF');
  for (const [bytes, name, mimeType] of [[png, 'file.PNG', 'image/png'],
    [jpeg, 'file.jpeg', 'image/jpeg'], [jpeg, 'file.jpg', 'image/jpeg'],
    [pdf, 'file.pdf', 'application/pdf']]) {
    const checked = validateReceipt(bytes, name, mimeType);
    assert.deepEqual(checked.bytes, bytes);
    assert.notEqual(checked.bytes, bytes, 'validated receipt must hold a copy');
    assert.equal(checked.mimeType, mimeType);
  }
  const largest = Buffer.alloc(10 * 1024 * 1024);
  png.copy(largest);
  assert.equal(validateReceipt(largest, 'largest.png', 'image/png').bytes.length, largest.length);
});

test('filename sanitation strips paths and unsafe characters, retaining extension within 120 chars', async () => {
  const { calls, delivery } = fakeDelivery();
  await delivery.sendReceipt(profile, { ...receipt,
    fileName: 'C:\\receipts\\..\\' + 'a'.repeat(140) + '<bad>\u0000.PNG' });
  const filename = calls[0].fields.file_filename;
  assert.equal(filename.length, 120);
  assert.ok(filename.endsWith('.png'));
  assert.doesNotMatch(filename, /[<>\u0000\\/]/);
  assert.equal(validateReceipt(png, '../... .png', 'image/png').fileName, 'receipt.png');
});

test('invalid receipt causes no request even with valid consent', async () => {
  const { calls, delivery } = fakeDelivery();
  await assert.rejects(delivery.sendReceipt(profile, undefined), { code: 'INVALID_RECEIPT' });
  await assert.rejects(delivery.sendReceipt(profile, { ...receipt, bytes: Buffer.from('fake') }),
    { code: 'INVALID_RECEIPT' });
  assert.equal(calls.length, 0);
});

test('success requires HTTP success and result success; backend and network errors stay redacted', async () => {
  const secret = 'TEST_SECRET_BACKEND_PAYLOAD';
  const responders = [
    async () => ({ ok: false, json: async () => success }),
    async () => ({ ok: true, json: async () => ({ result: 'error', error: secret }) }),
    async () => ({ ok: true, json: async () => ({ success: true }) }),
    async () => ({ ok: true, json: async () => null }),
    async () => ({ ok: true, json: async () => { throw new Error(secret); } }),
    async () => { throw new Error(secret); },
  ];
  for (const fetchImpl of responders) {
    const delivery = createGoogleDelivery({ endpoint, fetchImpl });
    for (const run of [() => delivery.sendRegistration(profile), () => delivery.sendReceipt(profile, receipt)]) {
      await assert.rejects(run, error => {
        assert.equal(error.code, 'DELIVERY_UNCONFIRMED');
        assert.doesNotMatch(error.message, new RegExp(secret));
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  }
});

test('receipt acknowledgement requires an HTTPS Drive file link', async () => {
  const invalid = [undefined, '', 'https://example.com/file/d/abc/view',
    'http://drive.google.com/file/d/abc/view', 'https://drive.google.com/',
    'https://drive.google.com/file/d/a%2Fb/view', 'https://drive.google.com:444/file/d/abc/view',
    'https://user:secret@drive.google.com/file/d/abc/view',
    'https://drive.google.com.evil.example/file/d/abc/view'];
  for (const value of invalid) {
    const { delivery } = fakeDelivery({ result: 'success', fileUrl: value });
    await assert.rejects(delivery.sendReceipt(profile, receipt), { code: 'DELIVERY_UNCONFIRMED' });
  }
  for (const value of ['https://drive.google.com/open?id=NEO_SISRA_TEST_RECEIPT',
    'https://drive.google.com/uc?fileId=NEO_SISRA_TEST_RECEIPT', fileUrl + '?unwanted=TEST_SECRET']) {
    const { delivery } = fakeDelivery({ result: 'success', fileUrl: value });
    assert.deepEqual(await delivery.sendReceipt(profile, receipt), { fileUrl });
  }
});

test('deadline aborts and rejects even when fetch ignores abort', async () => {
  let signal;
  const delivery = createGoogleDelivery({ endpoint, timeoutMs: 10,
    fetchImpl: async (url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  await assert.rejects(delivery.sendRegistration(profile), { code: 'DELIVERY_TIMEOUT' });
  assert.equal(signal.aborted, true);
});

test('default deadlines allow 45 seconds for signup and 120 seconds for receipts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  const delivery = createGoogleDelivery({ endpoint, fetchImpl: async (url, options) => {
    signals.push(options.signal);
    return new Promise(() => {});
  } });
  const registration = assert.rejects(delivery.sendRegistration(profile), { code: 'DELIVERY_TIMEOUT' });
  const upload = assert.rejects(delivery.sendReceipt(profile, receipt), { code: 'DELIVERY_TIMEOUT' });
  t.mock.timers.tick(44999);
  assert.equal(signals[0].aborted, false);
  assert.equal(signals[1].aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  await registration;
  t.mock.timers.tick(74999);
  assert.equal(signals[1].aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signals[1].aborted, true);
  await upload;
});

test('untrusted endpoint and invalid timeout configuration are rejected without exposing values', () => {
  const invalid = [undefined, 'https://api.telegram.org/file/botTEST_SECRET/check.png',
    'http://script.google.com/macros/s/id/exec',
    'https://secret:password@script.google.com/macros/s/id/exec',
    endpoint + '?secret=TEST_SECRET'];
  for (const value of invalid) assert.throws(() => createGoogleDelivery({ endpoint: value }),
    { code: 'INVALID_CONFIGURATION', message: 'Google delivery configuration is invalid.' });
  for (const timeoutMs of [-1, 0, NaN, Infinity, '10']) {
    assert.throws(() => createGoogleDelivery({ endpoint, timeoutMs }), { code: 'INVALID_CONFIGURATION' });
  }
});

test('identity capture preserves the exact registration values submitted to Google', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-08T18:20:30Z').valueOf() });
  let submitted;
  const delivery = createGoogleDelivery({ endpoint, captureIdentity: true,
    fetchImpl: async (url, options) => {
      submitted = Object.fromEntries(options.body);
      return { ok: true, json: async () => success };
    },
  });
  const result = await delivery.sendRegistration({ ...profile, additionalPhone: '+998911234567' });
  assert.deepEqual(result, { ok: true, sheetIdentity: {
    sheetId: 1596542810, name: submitted.Ism, originalPhone: submitted['Telefon raqam'],
    date: submitted.Sana,
  } });
  assert.equal(result.sheetIdentity.name, 'Neo Sisra Test');
  assert.equal(result.sheetIdentity.originalPhone, '+998901234567 / +998911234567');
  assert.equal(result.sheetIdentity.date, '08.10.2026 23:20:30');
  assert.equal(Object.isFrozen(result.sheetIdentity), true);
});

test('receipt identity captures submitted timestamps and raw Drive ACK URL while public link remains normalized', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-08T19:00:01Z').valueOf() });
  const rawUrl = 'https://drive.google.com/uc?export=view&id=NEO_SISRA_TEST_RECEIPT';
  let submitted;
  const delivery = createGoogleDelivery({ endpoint, captureIdentity: true,
    fetchImpl: async (url, options) => {
      submitted = Object.fromEntries(options.body);
      return { ok: true, json: async () => ({ ...success, fileUrl: rawUrl }) };
    },
  });
  const result = await delivery.sendReceipt(profile, receipt);
  assert.deepEqual(result, { fileUrl, sheetIdentity: {
    sheetId: 0, name: submitted.Ism, originalPhone: submitted['Telefon raqam'],
    date: '2026-10-09', time: '00:00:01', checkUrl: rawUrl,
  } });
  assert.equal(result.sheetIdentity.date, submitted.sana);
  assert.equal(result.sheetIdentity.time, submitted.vaqt);
  assert.equal(Object.isFrozen(result.sheetIdentity), true);
});

test('captured identity does not follow profile edits made during delivery', async () => {
  let release;
  const mutable = { ...profile };
  const delivery = createGoogleDelivery({ endpoint, captureIdentity: true,
    fetchImpl: () => new Promise(resolve => { release = resolve; }),
  });
  const pending = delivery.sendRegistration(mutable);
  mutable.name = 'Changed Person';
  mutable.phone = '+998971234567';
  release({ ok: true, json: async () => success });
  const result = await pending;
  assert.equal(result.sheetIdentity.name, 'Neo Sisra Test');
  assert.equal(result.sheetIdentity.originalPhone, profile.phone);
});

test('identity capture cannot return a receipt mapping when Google ACK is invalid', async () => {
  const delivery = createGoogleDelivery({ endpoint, captureIdentity: true,
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: 'success', fileUrl: 'https://example.com/private' }) }),
  });
  await assert.rejects(delivery.sendReceipt(profile, receipt), { code: 'DELIVERY_UNCONFIRMED' });
  assert.throws(() => createGoogleDelivery({ endpoint, captureIdentity: 'true' }), { code: 'INVALID_CONFIGURATION' });
});

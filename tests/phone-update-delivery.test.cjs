'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPhoneUpdater } = require('../google-delivery.cjs');

const endpoint = 'https://script.google.com/macros/s/NEO_SISRA_PHONE_UPDATE_TEST_ONLY/exec';
const secret = 'TEST_ONLY_PHONE_UPDATE_SECRET_1234567890';
const input = Object.freeze({
  telegramId: '123456789', phone: '+998901234567', additionalPhone: '+998911234567',
  revision: 2, updatedAt: '2026-10-08T18:20:30.000Z',
});
const success = Object.freeze({
  result: 'success', telegramId: input.telegramId, revision: input.revision,
  updated: true, matchedRows: 1,
});

function fakeUpdater(result = success) {
  const calls = [];
  const updater = createPhoneUpdater({ endpoint, secret, fetchImpl: async (url, options) => {
    calls.push({ url, options, payload: JSON.parse(options.body) });
    return { ok: true, json: async () => result };
  } });
  return { calls, updater };
}

test('phone updater sends exact JSON contract and confirms identity and revision', async () => {
  const { updater, calls } = fakeUpdater({ ...success, matchedRows: 3 });
  assert.deepEqual(await updater.updatePhone(input), {
    ok: true, telegramId: input.telegramId, revision: input.revision, matchedRows: 3,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, endpoint);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.deepEqual(calls[0].options.headers, { 'Content-Type': 'text/plain;charset=utf-8' });
  assert.deepEqual(calls[0].payload, { action: 'updatePhone', secret, ...input });
});

test('phone updater serializes an immutable snapshot and normalizes numeric Telegram ID only', async () => {
  let resolve;
  let body;
  const updater = createPhoneUpdater({ endpoint, secret, fetchImpl: async (url, options) => {
    body = options.body;
    return new Promise(done => { resolve = done; });
  } });
  const mutable = { ...input, telegramId: Number(input.telegramId) };
  const pending = updater.updatePhone(mutable);
  mutable.telegramId = '987654321';
  mutable.phone = '+998991234567';
  mutable.additionalPhone = null;
  mutable.revision = 3;
  mutable.updatedAt = '2026-10-08T18:30:00.000Z';
  resolve({ ok: true, json: async () => success });
  assert.equal((await pending).revision, input.revision);
  assert.deepEqual(JSON.parse(body), { action: 'updatePhone', secret, ...input });
});

test('absent additional phone is explicitly sent as null', async () => {
  const { updater, calls } = fakeUpdater();
  for (const additionalPhone of [undefined, null]) {
    await updater.updatePhone({ ...input, additionalPhone });
  }
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.payload.additionalPhone, null);
});

test('invalid Telegram IDs, phone values, revision and date are rejected before delivery', async () => {
  const { updater, calls } = fakeUpdater();
  const invalid = [undefined, null, {},
    ...[undefined, '', '0', 0, -1, '-100123456789', '0123', '123x', '123\n',
      '1e3', '9007199254740992', Number.MAX_SAFE_INTEGER + 1, 1.5, {}, true]
      .map(telegramId => ({ ...input, telegramId })),
    ...[undefined, '', '998901234567', '+998 90 123 45 67', '+998901234567x',
      '+998901234567\n', '+0123456789', '+123456', '+1234567890123456', 998901234567]
      .map(phone => ({ ...input, phone })),
    ...['', '998911234567', '+998 91 1234567', '+998911234567x', '+998911234567\n',
      '+0123456789', '+123456', '+1234567890123456', input.phone, false]
      .map(additionalPhone => ({ ...input, additionalPhone })),
    ...[undefined, 0, -1, 1.1, '2', Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]
      .map(revision => ({ ...input, revision })),
    ...[undefined, '', 'not-a-date', '2026-10-08', '2026-02-30T18:20:30.000Z',
      '2026-10-08T18:20:30.000Z\n', new Date(input.updatedAt)]
      .map(updatedAt => ({ ...input, updatedAt })),
  ];
  for (const value of invalid) {
    await assert.rejects(updater.updatePhone(value), {
      code: 'INVALID_PHONE_UPDATE', message: 'Phone update data is invalid.',
    });
  }
  assert.equal(calls.length, 0);
});

test('acknowledgement must match the exact user and revision and an existing updated row', async () => {
  const invalid = [null, {}, { ...success, result: 'error' },
    { ...success, telegramId: Number(input.telegramId) }, { ...success, telegramId: '987654321' },
    { ...success, revision: input.revision - 1 }, { ...success, revision: input.revision + 1 },
    { ...success, revision: String(input.revision) }, { ...success, updated: false },
    { ...success, updated: 'true' }, { ...success, matchedRows: 0 },
    { ...success, matchedRows: -1 }, { ...success, matchedRows: 1.5 },
    { ...success, matchedRows: '1' }, { ...success, matchedRows: undefined },
  ];
  for (const result of invalid) {
    const { updater, calls } = fakeUpdater(result);
    await assert.rejects(updater.updatePhone(input), { code: 'PHONE_UPDATE_UNCONFIRMED' });
    assert.equal(calls.length, 1, 'a failed acknowledgement must not trigger an internal retry');
  }
});

test('HTTP, parsing and network failures never expose endpoint, secret, payload or backend errors', async () => {
  const sensitive = `${endpoint} ${secret} ${input.phone} PRIVATE_BACKEND_RESPONSE`;
  for (const responder of [
    async () => ({ ok: false, json: async () => success }),
    async () => ({ ok: true, json: async () => { throw new Error(sensitive); } }),
    async () => ({ ok: true, json: async () => ({ result: 'error', error: sensitive }) }),
    async () => { throw new Error(sensitive); },
  ]) {
    let requests = 0;
    const updater = createPhoneUpdater({ endpoint, secret, fetchImpl: (...args) => {
      requests += 1;
      return responder(...args);
    } });
    await assert.rejects(updater.updatePhone(input), error => {
      assert.equal(error.code, 'PHONE_UPDATE_UNCONFIRMED');
      assert.equal(error.message, 'Phone update was not confirmed.');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.stack, /PRIVATE_BACKEND_RESPONSE|https:\/\/|TEST_ONLY_PHONE|998901234567/);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test('deadline aborts at 45 seconds even when fetch ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const updater = createPhoneUpdater({ endpoint, secret, fetchImpl: async (url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  const pending = assert.rejects(updater.updatePhone(input), {
    code: 'PHONE_UPDATE_TIMEOUT', message: 'Phone update was not confirmed.',
  });
  t.mock.timers.tick(44999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  await pending;
});

test('deadline also covers a stalled JSON acknowledgement', async () => {
  let signal;
  const updater = createPhoneUpdater({ endpoint, secret, timeoutMs: 10,
    fetchImpl: async (url, options) => {
      signal = options.signal;
      return { ok: true, json: () => new Promise(() => {}) };
    },
  });
  await assert.rejects(updater.updatePhone(input), { code: 'PHONE_UPDATE_TIMEOUT' });
  assert.equal(signal.aborted, true);
});

test('only a trusted Apps Script exec endpoint and a sufficiently long secret are accepted', () => {
  const invalid = [undefined, '', 'https://example.com/macros/s/id/exec',
    'http://script.google.com/macros/s/id/exec',
    'https://script.google.com.evil.example/macros/s/id/exec',
    'https://secret:password@script.google.com/macros/s/id/exec',
    'https://script.google.com:444/macros/s/id/exec',
    'https://script.google.com/macros/s/id/dev', endpoint + '?secret=PRIVATE', endpoint + '#PRIVATE',
    'https://script.google.com/macros/s/id/exec/anything',
  ].map(value => ({ endpoint: value, secret }));
  invalid.push(...[undefined, '', 'short', ' '.repeat(32), 'x'.repeat(31), secret + '\n', {}]
    .map(value => ({ endpoint, secret: value })));
  invalid.push(...[-1, 0, NaN, Infinity, '10'].map(timeoutMs => ({ endpoint, secret, timeoutMs })));
  invalid.push({ endpoint, secret, fetchImpl: null });
  for (const options of invalid) {
    assert.throws(() => createPhoneUpdater(options), {
      code: 'INVALID_CONFIGURATION', message: 'Phone update configuration is invalid.',
    });
  }
});

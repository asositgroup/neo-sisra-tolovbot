'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every external boundary in this suite is synthetic. No real bot credentials,
// polling request, Telegram message, or Google upload is used.
process.env.BOT_TOKEN = '123456:OFFLINE_CONCURRENCY_TOKEN';
process.env.GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/OFFLINE_ONLY/exec';
process.env.PRIMARY_ADMIN_IDS = '42';
process.env.EXTRA_ADMIN_IDS = '';
process.env.NOTIFY_CHAT_ID = '';
process.env.WELCOME_IMAGE_PATH = '';
process.env.OFFER_DOC_PATH = '';
process.env.OFFER_VERSION = 'offline-concurrency-v1';
const { createBot } = require('../bot.js');
const { readState } = require('../state-store.cjs');
const unpaced = { run: (_options, fn) => Promise.resolve().then(fn), idle: () => Promise.resolve() };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); }
  assert.fail('Offline operation did not reach its expected state');
}
const message = (id, text = '', extra = {}) => ({ chat: { id, type: 'private' }, from: { id }, message_id: 1, text, ...extra });
const update = (id, chatId, text = '') => ({ update_id: id, message: message(chatId, text) });
const callback = (id, chatId) => ({ update_id: id, callback_query: { id: `cb-${id}`, from: { id: chatId }, message: { chat: { id: chatId, type: 'private' } }, data: 'offer:yes' } });

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-concurrency-test-'));
  const bots = [];
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const bot of bots) { await bot.waitForBackground(); bot.closeStore(); }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir,
    open(overrides = {}) {
      const bot = createBot({ dataDir, telegramQueue: unpaced,
        google: { sendRegistration: async () => ({ ok: true }), sendReceipt: async () => ({ fileUrl: 'https://drive.google.com/file/d/OFFLINE/view' }) },
        ...options, ...overrides });
      bots.push(bot); return bot;
    },
  };
}

function fakeTelegram({ batch = [], onPoll, onSend } = {}) {
  const requests = [];
  let polls = 0;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    assert.ok(url.startsWith('https://api.telegram.org/bot123456:OFFLINE_CONCURRENCY_TOKEN/') || url.startsWith('https://api.telegram.org/file/bot123456:OFFLINE_CONCURRENCY_TOKEN/'), 'Only an offline test bot URL may be requested');
    if (url.includes('/getUpdates?')) {
      polls++;
      if (onPoll) await onPoll(polls, url);
      return Response.json({ ok: true, result: polls === 1 ? batch : [] });
    }
    if (url.includes('/file/bot')) return new Response(Buffer.from([255, 216, 255, 1, 2, 3]));
    const body = options.body ? JSON.parse(options.body) : {};
    const method = url.slice(url.lastIndexOf('/') + 1);
    requests.push({ method, body });
    if (onSend) await onSend(method, body);
    return Response.json({ ok: true, result: method === 'getFile' ? { file_path: 'photos/offline.jpg', file_size: 6 } : { message_id: requests.length } });
  };
  return { requests, polls: () => polls };
}

test('polling processes independent chats concurrently and keeps each chat FIFO', { timeout: 5000 }, async t => {
  const f = fixture(t), bot = f.open(), gate = deferred(), seen = [];
  const runtime = bot.createPollingRuntime({ onUpdate: async event => {
    seen.push(`start:${event.update_id}`);
    if (event.update_id === 1) await gate.promise;
    seen.push(`done:${event.update_id}`);
  } });
  fakeTelegram({ batch: [update(1, 100), update(2, 100), update(3, 200)], onPoll: count => { if (count === 2) runtime.requestStop(); } });
  const running = runtime.run();
  try {
    await until(() => seen.includes('done:3'));
    assert.deepEqual(seen, ['start:1', 'start:3', 'done:3']);
    const saved = readState({ dataDir: f.dataDir });
    assert.equal(saved.last_update_id, 0);
    assert.deepEqual(saved.completed_update_ids, [3]);
  } finally { gate.resolve(); }
  await running;
  assert.deepEqual(seen, ['start:1', 'start:3', 'done:3', 'done:1', 'start:2', 'done:2']);
  const saved = readState({ dataDir: f.dataDir });
  assert.equal(saved.last_update_id, 3);
  assert.deepEqual(saved.completed_update_ids, []);
});

test('out-of-order completion survives restart without acknowledging or replaying an unfinished prefix', { timeout: 5000 }, async t => {
  const f = fixture(t), first = f.open(), gate = deferred(), seen = [];
  const batch = [update(10, 100), update(11, 200)];
  fakeTelegram({ batch });
  const runtime = first.createPollingRuntime({ onUpdate: async event => {
    if (event.update_id === 10) { await gate.promise; throw Object.assign(new Error('Synthetic storage stop'), { code: 'STATE_STORE_ERROR' }); }
    seen.push(event.update_id);
  } });
  const stopped = assert.rejects(runtime.run(), /Synthetic storage stop/);
  await until(() => seen.length === 1);
  const before = readState({ dataDir: f.dataDir });
  assert.equal(before.last_update_id, 0); assert.deepEqual(before.completed_update_ids, [11]);
  gate.resolve(); await stopped;
  const second = f.open(), replayed = [];
  const next = second.createPollingRuntime({ onUpdate: async event => { replayed.push(event.update_id); } });
  fakeTelegram({ batch, onPoll: (count, url) => {
    if (count === 1) assert.equal(new URL(url).searchParams.get('offset'), '1');
    if (count === 2) next.requestStop();
  } });
  await next.run();
  assert.deepEqual(replayed, [10]);
  const saved = readState({ dataDir: f.dataDir });
  assert.equal(saved.last_update_id, 11); assert.deepEqual(saved.completed_update_ids, []);
});

test('Google delivery has four active jobs while excess jobs remain durable and drain later', { timeout: 5000 }, async t => {
  const gate = deferred(); let active = 0, peak = 0, calls = 0;
  const f = fixture(t, { google: { sendRegistration: async () => {
    active++; calls++; peak = Math.max(peak, active);
    try { await gate.promise; return { ok: true }; } finally { active--; }
  } } });
  const bot = f.open(), db = bot.loadDb();
  for (let i = 0; i < 9; i++) db.registrations.push({ id: `signup-${i}`, telegram_id: 100 + i, name: 'Offline Test', phone: '+998000000000', offer: 'Roziman', offer_version: 'offline-concurrency-v1', status: 'pending' });
  bot.saveDb(db); bot.pumpDeliveries(db);
  try {
    await until(() => active === 4);
    assert.equal(calls, 4);
    assert.equal(bot.queueStats().deliveries.total, 4);
    const saved = readState({ dataDir: f.dataDir });
    assert.equal(saved.registrations.filter(row => row.status === 'sending').length, 4);
    assert.equal(saved.registrations.filter(row => row.status === 'pending').length, 5);
  } finally { gate.resolve(); }
  await bot.waitForBackground();
  assert.equal(calls, 9); assert.equal(peak, 4);
  assert.ok(readState({ dataDir: f.dataDir }).registrations.every(row => row.status === 'sent'));
});

test('duplicate consent and repeated receipt updates through polling create one registration and receipt', { timeout: 5000 }, async t => {
  let registrations = 0, receipts = 0;
  const f = fixture(t, { google: {
    sendRegistration: async () => { registrations++; return { ok: true }; },
    sendReceipt: async () => { receipts++; return { fileUrl: 'https://drive.google.com/file/d/OFFLINE/view' }; },
  } });
  const bot = f.open(), db = bot.loadDb();
  db.users['55'] = { chat_id: 55, step: 'offer', name: 'Offline Person', phone: '+998000000000' };
  bot.saveDb(db);
  const photo = { photo: [{ file_id: 'OFFLINE_PHOTO', file_unique_id: 'OFFLINE_UNIQUE', file_size: 6 }] };
  const runtime = bot.createPollingRuntime();
  fakeTelegram({ batch: [callback(1, 55), callback(2, 55), { update_id: 3, message: message(55, '', photo) }, { update_id: 4, message: message(55, '', photo) }],
    onPoll: count => { if (count === 2) runtime.requestStop(); } });
  await runtime.run();
  const saved = readState({ dataDir: f.dataDir });
  assert.equal(registrations, 1); assert.equal(receipts, 1);
  assert.equal(saved.registrations.length, 1); assert.equal(saved.payments.length, 1);
  assert.equal(saved.registrations[0].status, 'sent'); assert.equal(saved.payments[0].status, 'sent');
  assert.equal(saved.last_update_id, 4);
});

test('a blocked broadcast network request does not hold an independent user conversation', { timeout: 5000 }, async t => {
  const f = fixture(t), bot = f.open(), db = bot.loadDb(), gate = deferred();
  db.registrations.push({ id: 'audience', telegram_id: 900, status: 'sent' });
  db.broadcast = { step: 'collecting', fromChatId: 42, items: [{ id: 'asset', srcMessageId: 1 }] };
  bot.saveDb(db);
  let copyStarted = false;
  const runtime = bot.createPollingRuntime();
  const wire = fakeTelegram({ batch: [update(1, 42, '✅ Yuborish'), update(2, 77, '/start')],
    onPoll: count => { if (count === 2) runtime.requestStop(); },
    onSend: async method => { if (method === 'copyMessage') { copyStarted = true; await gate.promise; } },
  });
  const running = runtime.run();
  try {
    await until(() => copyStarted && wire.requests.filter(request => request.body.chat_id === 77 && request.method === 'sendMessage').length === 2);
    assert.equal(readState({ dataDir: f.dataDir }).users['77'].step, 'name');
    assert.equal(readState({ dataDir: f.dataDir }).broadcast_job.in_flight, true);
  } finally { gate.resolve(); }
  await running;
  assert.equal(readState({ dataDir: f.dataDir }).broadcast_job.sent, 1);
});

test('cancelling an in-flight broadcast cannot replace its job until the accepted network request finishes', { timeout: 5000 }, async t => {
  const f = fixture(t), bot = f.open(), db = bot.loadDb(), gate = deferred();
  db.registrations.push({ id: 'audience-a', telegram_id: 900, status: 'sent' }, { id: 'audience-b', telegram_id: 901, status: 'sent' });
  db.broadcast = { step: 'collecting', fromChatId: 42, items: [{ id: 'old-asset', srcMessageId: 1 }] };
  bot.saveDb(db);
  let copies = 0;
  const wire = fakeTelegram({ onSend: async method => { if (method === 'copyMessage' && ++copies === 1) await gate.promise; } });
  await bot.handleMessage(message(42, '✅ Yuborish'), db);
  await until(() => copies === 1);
  const oldJob = db.broadcast_job;
  try {
    await bot.handleMessage(message(42, '/broadcast_cancel'), db);
    assert.equal(oldJob.status, 'cancelled');
    await bot.handleMessage(message(42, '/broadcast'), db);
    await bot.handleMessage(message(42, 'Offline replacement asset'), db);
    await bot.handleMessage(message(42, '✅ Yuborish'), db);
    const persisted = readState({ dataDir: f.dataDir });
    assert.equal(persisted.broadcast_job.id, oldJob.id);
    assert.equal(persisted.broadcast_job.status, 'cancelled');
    assert.equal(persisted.broadcast_job.in_flight, true);
    assert.equal(copies, 1);
    assert.ok(wire.requests.some(request => request.body.text?.includes('Oldingi yuborish hali yakunlanmagan')));
  } finally { gate.resolve(); }
  await bot.waitForBackground();
  assert.equal(oldJob.sent, 1);
  assert.equal(oldJob.in_flight, false);
  assert.equal(copies, 1, 'Cancellation must not start the remaining old recipient');
  await bot.handleMessage(message(42, '✅ Yuborish'), db);
  await bot.waitForBackground();
  assert.notEqual(db.broadcast_job.id, oldJob.id);
  assert.equal(db.broadcast_job.status, 'done');
  assert.equal(db.broadcast_job.sent, 2);
  assert.equal(copies, 3);
});

test('graceful stop finishes active Google work and leaves unstarted outbox jobs for the next runtime', { timeout: 5000 }, async t => {
  const gate = deferred(), pollGate = deferred();
  const delivered = [];
  let active = 0;
  const f = fixture(t, { google: { sendRegistration: async profile => {
    active++;
    try { await gate.promise; delivered.push(profile.name); return { ok: true }; }
    finally { active--; }
  } } });
  const first = f.open(), db = first.loadDb();
  for (let i = 0; i < 9; i++) db.registrations.push({ id: `resume-${i}`, telegram_id: 100 + i, name: `Offline ${i}`, phone: '+998000000000', offer: 'Roziman', offer_version: 'offline-concurrency-v1', status: 'pending' });
  first.saveDb(db);
  const runtime = first.createPollingRuntime();
  fakeTelegram({ onPoll: async count => { if (count === 1) await pollGate.promise; } });
  const running = runtime.run();
  try {
    await until(() => active === 4);
    runtime.requestStop();
  } finally { gate.resolve(); pollGate.resolve(); }
  await running;
  const stopped = readState({ dataDir: f.dataDir });
  assert.equal(stopped.registrations.filter(row => row.status === 'sent').length, 4);
  assert.equal(stopped.registrations.filter(row => row.status === 'pending').length, 5);
  assert.equal(stopped.registrations.filter(row => row.status === 'sending').length, 0);
  const second = f.open({ google: { sendRegistration: async profile => { delivered.push(profile.name); return { ok: true }; } } });
  const restarted = second.createPollingRuntime();
  fakeTelegram({ onPoll: async count => {
    if (count === 1) { await second.waitForBackground(); restarted.requestStop(); }
  } });
  await restarted.run();
  assert.equal(delivered.length, 9);
  assert.equal(new Set(delivered).size, 9, 'Restart must not resend completed outbox jobs');
  assert.ok(readState({ dataDir: f.dataDir }).registrations.every(row => row.status === 'sent'));
});

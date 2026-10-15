'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

process.env.BOT_TOKEN = '123456:OFFLINE_ADMIN_BROADCAST_TOKEN';
process.env.GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/OFFLINE_ONLY/exec';
process.env.PRIMARY_ADMIN_IDS = '42';
process.env.EXTRA_ADMIN_IDS = '43';
process.env.NOTIFY_CHAT_ID = '';
const { createBot, normalizeBroadcastButton } = require('../bot.js');
const { readState } = require('../state-store.cjs');
const { createTelegramQueue } = require('../telegram-queue.cjs');
const unpaced = { run: (_options, fn) => Promise.resolve().then(fn), idle: () => Promise.resolve() };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('Offline broadcast did not reach expected state');
}
const message = (id, text) => ({ chat: { id, type: 'private' }, from: { id }, message_id: 1, text });
function fixture(t, initial = [101, 102, 103], options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-admin-broadcast-test-'));
  const originalFetch = globalThis.fetch, bots = [], calls = [], queueOptions = [];
  let onSend;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith('https://api.telegram.org/bot123456:OFFLINE_ADMIN_BROADCAST_TOKEN/'), 'Only synthetic bot requests are permitted');
    const method = String(url).split('/').at(-1), body = JSON.parse(init.body);
    calls.push({ method, body, signal: init.signal });
    return await onSend?.(method, body) || Response.json({ ok: true, result: { message_id: calls.length } });
  };
  const open = () => {
    const bot = createBot({ dataDir, google: {}, telegramQueue: {
      ...unpaced,
      run(options, fn) { queueOptions.push(options); return unpaced.run(options, fn); },
    }, ...options });
    bots.push(bot); return bot;
  };
  const bot = open(), db = bot.loadDb();
  for (const id of initial) db.users[String(id)] = { chat_id: id, step: 'name' };
  bot.saveDb(db);
  t.after(async () => {
    for (const item of bots) { await item.waitForBackground(); item.closeStore(); }
    globalThis.fetch = originalFetch;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { bot, db, open, dataDir, calls, queueOptions, onSend(fn) { onSend = fn; } };
}
const create = (bot, text = 'Test <b>oddiy matn</b>', requestId = randomUUID()) => bot.createAdminBroadcast({ text, requestId });

test('audience includes partial registrations and record fallbacks, deduplicates and excludes admins and non-private IDs', async t => {
  const f = fixture(t, [101, 102, 42, 43, -100, 0]);
  f.db.users['fallback'] = { chat_id: 102 };
  f.db.users['103'] = { step: 'offer' };
  f.db.users['bad'] = { chat_id: 'not-a-number' };
  f.db.users['fraction'] = { chat_id: 2.5 };
  f.db.registrations.push({ id: 'old-user', telegram_id: '104' }, { id: 'same-user', telegram_id: 101 });
  f.db.payments.push({ id: 'receipt-user', telegram_id: 105 });
  f.bot.saveDb(f.db);
  assert.equal(f.bot.getAdminDashboard().audienceCount, 5);
  create(f.bot);
  await f.bot.waitForBackground();
  assert.deepEqual(f.calls.map(call => call.body.chat_id).sort((a, b) => a - b), [101, 102, 103, 104, 105]);
  assert.ok(f.calls.every(call => call.method === 'sendMessage' && call.body.text === 'Test <b>oddiy matn</b>'
    && !('parse_mode' in call.body) && !('reply_markup' in call.body)));
  assert.ok(f.queueOptions.every(options => options.priority === 10));
  assert.equal(f.bot.getAdminDashboard().job.sent, 5);
});

test('an optional URL button is normalized, persisted, previewed and sent only to the frozen test recipient', async t => {
  const f = fixture(t, [101, 102], { broadcastTestRecipient: { chatId: 42, label: 'Offline test' } });
  const input = { text: '  👤 Admin bilan bogʻlanish  ', url: '  https://T.ME/example  ' };
  const expected = { text: '👤 Admin bilan bogʻlanish', url: 'https://t.me/example' };
  const result = f.bot.createAdminBroadcast({ text: 'Contact us', requestId: randomUUID(), button: input });
  assert.deepEqual(result.button, expected);
  input.url = 'https://example.com/changed';
  result.button.text = 'Changed outside the job';
  await f.bot.waitForBackground();
  assert.deepEqual(f.calls.map(call => call.body), [{ chat_id: 42, text: 'Contact us',
    reply_markup: { inline_keyboard: [[expected]] } }]);
  assert.deepEqual(readState({ dataDir: f.dataDir }).broadcast_job.button, expected);
  const dashboard = f.bot.getAdminDashboard();
  assert.deepEqual(dashboard.job.button, expected);
  assert.deepEqual(dashboard.history[0].button, expected);
  f.bot.createAdminBroadcast({ text: 'No button this time', requestId: randomUUID(), button: null });
  await f.bot.waitForBackground();
  assert.equal('reply_markup' in f.calls.at(-1).body, false);
  assert.equal('button' in f.bot.getAdminDashboard().job, false);
});

test('invalid optional buttons fail before any send and absent buttons remain compatible', async t => {
  const f = fixture(t, [101]);
  assert.equal(normalizeBroadcastButton(), null);
  assert.equal(normalizeBroadcastButton(null), null);
  const valid = { text: 'Open', url: 'https://example.com' };
  const invalid = [false, [], 'button', {}, { ...valid, callback_data: 'unexpected' },
    { ...valid, text: '' }, { ...valid, text: '   ' }, { ...valid, text: 42 },
    { ...valid, text: 'a'.repeat(65) }, { ...valid, text: 'Line\nBreak' },
    ...[undefined, 42, '', '/relative', 'https:example.com', 'http://example.com', 'javascript:alert(1)',
      'https://user:password@example.com', 'https://example.com/\npath', 'https://example.com/a b',
      'https://example.com\\path', 'https://example.com/' + 'x'.repeat(2048),
      'https://example.com/' + '漢'.repeat(300)].map(url => ({ ...valid, url }))];
  for (const button of invalid) {
    assert.throws(() => f.bot.createAdminBroadcast({ text: 'Text', requestId: randomUUID(), button }),
      error => error.statusCode === 400);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.db.broadcast_job, undefined);
});

test('button requests remain idempotent after history eviction and restart and reject changed or removed buttons', async t => {
  const f = fixture(t, [101]), gate = deferred(), requestId = randomUUID();
  const button = { text: 'Contact', url: 'https://t.me/example' };
  const payload = { text: 'With link', requestId, button };
  f.onSend(async () => { await gate.promise; });
  const first = f.bot.createAdminBroadcast(payload);
  const changes = [null, { ...button, text: 'Other text' }, { ...button, url: 'https://example.com/' }];
  try {
    await until(() => f.calls.length === 1);
    assert.equal(f.bot.createAdminBroadcast({ ...payload, button: { text: ' Contact ', url: 'https://T.ME/example' } }).id, first.id);
    for (const changed of changes) assert.throws(() => f.bot.createAdminBroadcast({ ...payload, button: changed }), error => error.statusCode === 409);
  } finally { gate.resolve(); }
  await f.bot.waitForBackground();
  f.onSend(undefined);
  const done = f.bot.createAdminBroadcast(payload);
  for (let i = 0; i < 21; i++) { create(f.bot, 'Later plain message '+i); await f.bot.waitForBackground(); }
  assert.ok(!f.bot.getAdminDashboard().history.some(job => job.id === first.id));
  f.bot.closeStore();
  const next = f.open();
  assert.deepEqual(next.createAdminBroadcast(payload), done);
  for (const changed of changes) assert.throws(() => next.createAdminBroadcast({ ...payload, button: changed }), error => error.statusCode === 409);
  assert.equal(f.calls.length, 22, 'Retries never create another Telegram send');
});

test('legacy text-only request ledger entries allow plain retries but never accept an added button', async t => {
  const f = fixture(t, [101]), requestId = randomUUID();
  create(f.bot, 'Legacy message', requestId);
  await f.bot.waitForBackground();
  const done = create(f.bot, 'Legacy message', requestId);
  delete f.db.admin_broadcast_requests[requestId].buttonHash;
  f.bot.saveDb(f.db);
  f.bot.closeStore();
  const next = f.open();
  assert.deepEqual(create(next, 'Legacy message', requestId), done);
  assert.throws(() => next.createAdminBroadcast({ text: 'Legacy message', requestId,
    button: { text: 'Added link', url: 'https://example.com/' } }), error => error.statusCode === 409);
  assert.equal(f.calls.length, 1);
});

test('delivery counts distinguish explicit blocks, other 403/400 failures, ambiguous network/5xx and successful delivery', async t => {
  const f = fixture(t, [101, 102, 103, 104, 105, 106, 107]);
  f.onSend((_method, body) => {
    if (body.chat_id === 102) return Response.json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, { status: 403 });
    if (body.chat_id === 103) return Response.json({ ok: false, error_code: 403, description: 'Forbidden: user is deactivated' }, { status: 403 });
    if (body.chat_id === 104) return Response.json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, { status: 400 });
    if (body.chat_id === 105) throw new Error('private transport details must never reach dashboard');
    if (body.chat_id === 106) return new Response('private backend message', { status: 502 });
    if (body.chat_id === 107) return Response.json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
  });
  create(f.bot);
  await f.bot.waitForBackground();
  const result = f.bot.getAdminDashboard();
  assert.equal(result.job.status, 'done');
  assert.deepEqual({ total: result.job.total, sent: result.job.sent, blocked: result.job.blocked, failed: result.job.failed, unknown: result.job.unknown, processed: result.job.processed, remaining: result.job.remaining },
    { total: 7, sent: 1, blocked: 2, failed: 2, unknown: 2, processed: 7, remaining: 0 });
  assert.equal(result.history.length, 1);
  assert.ok(result.job.finishedAt);
  assert.doesNotMatch(JSON.stringify(result), /private transport|private backend|description|OFFLINE_ADMIN_BROADCAST_TOKEN/);
  assert.equal(f.calls.length, 7, 'A web broadcast must not send an admin completion message');
});

test('same request ID is idempotent during execution, after completion, after history eviction and after restart', async t => {
  const f = fixture(t, [101]), gate = deferred(), requestId = randomUUID();
  f.onSend(async () => { await gate.promise; });
  const first = create(f.bot, 'Initial text', requestId);
  try {
    await until(() => f.calls.length === 1);
    assert.equal(create(f.bot, 'Initial text', requestId).id, first.id);
    assert.throws(() => create(f.bot, 'Different text', requestId), error => error.statusCode === 409);
    assert.throws(() => create(f.bot), error => error.statusCode === 409);
  } finally { gate.resolve(); }
  await f.bot.waitForBackground();
  f.onSend(undefined);
  const done = create(f.bot, 'Initial text', requestId);
  assert.equal(done.status, 'done');
  for (let i = 0; i < 21; i++) { create(f.bot, 'History '+i); await f.bot.waitForBackground(); }
  assert.equal(f.bot.getAdminDashboard().history.length, 20);
  assert.ok(!f.bot.getAdminDashboard().history.some(job => job.id === first.id));
  f.bot.closeStore();
  const next = f.open();
  const replayed = create(next, 'Initial text', requestId);
  assert.deepEqual(replayed, done);
  assert.equal(f.calls.length, 22, 'Completed IDs remain durable even when their history rows are evicted');
});

test('crash recovery counts an in-flight send as unknown and explicit resume sends only remaining recipients', async t => {
  const f = fixture(t), requestId = randomUUID();
  const button = { text: 'Persisted contact', url: 'https://t.me/example' };
  f.db.broadcast_recipients = [101, 102, 103];
  f.db.broadcast_job = { id: 'crashed-job', kind: 'admin_text', requestId, text: 'Crash test', button, status: 'running',
    total: 3, recipient: 1, item: 0, in_flight: true, sent: 0, blocked: 0, failed: 0, unknown: 0,
    createdAt: '2026-10-15T10:00:00.000Z', finishedAt: null };
  f.bot.saveDb(f.db);
  f.bot.closeStore();
  const next = f.open(), recovered = next.getAdminDashboard().job;
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.unknown, 1);
  assert.equal(recovered.remaining, 2);
  assert.equal(f.calls.length, 0, 'Restart never automatically resumes a bulk send');
  next.resumeAdminBroadcast(recovered.id);
  await next.waitForBackground();
  assert.deepEqual(f.calls.map(call => call.body.chat_id), [102, 103]);
  assert.ok(f.calls.every(call => JSON.stringify(call.body.reply_markup) === JSON.stringify({ inline_keyboard: [[button]] })));
  const done = next.getAdminDashboard().job;
  assert.equal(done.status, 'done'); assert.equal(done.sent, 2); assert.equal(done.unknown, 1); assert.equal(done.remaining, 0);
});

test('cancellation during a network request waits for that outcome and prevents replacing the job until settled', async t => {
  const f = fixture(t), gate = deferred();
  f.onSend(async () => { await gate.promise; });
  const first = create(f.bot);
  try {
    await until(() => f.calls.length === 1);
    assert.equal(readState({ dataDir: f.dataDir }).broadcast_job.in_flight, true);
    const cancelled = f.bot.cancelAdminBroadcast(first.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.throws(() => create(f.bot), error => error.statusCode === 409);
    assert.throws(() => f.bot.resumeAdminBroadcast(first.id), error => error.statusCode === 409);
  } finally { gate.resolve(); }
  await f.bot.waitForBackground();
  const cancelled = f.bot.getAdminDashboard().job;
  assert.equal(cancelled.sent, 1); assert.equal(cancelled.remaining, 2); assert.ok(cancelled.finishedAt);
  assert.equal(f.calls.length, 1);
  f.onSend(undefined);
  create(f.bot, 'Replacement');
  await f.bot.waitForBackground();
  assert.equal(f.calls.length, 4);
});

test('cancellation before the queued request starts sends nothing and leaves no uncertain recipient', async t => {
  const gate = deferred();
  const f = fixture(t, [101], { telegramQueue: { run: async (_options, fn) => { await gate.promise; return fn(); } } });
  const job = create(f.bot);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.db.broadcast_job.in_flight, false);
  f.bot.cancelAdminBroadcast(job.id);
  gate.resolve();
  await f.bot.waitForBackground();
  assert.equal(f.calls.length, 0);
  const result = f.bot.getAdminDashboard().job;
  assert.equal(result.unknown, 0); assert.equal(result.failed, 0); assert.equal(result.remaining, 1);
});

test('graceful stop preserves the unfinished audience for explicit resume after restart', async t => {
  const f = fixture(t), gate = deferred();
  f.onSend(async () => { await gate.promise; });
  const job = create(f.bot), runtime = f.bot.createPollingRuntime();
  try {
    await until(() => f.calls.length === 1);
    runtime.requestStop();
  } finally { gate.resolve(); }
  await f.bot.waitForBackground();
  runtime.dispose();
  assert.equal(f.bot.getAdminDashboard().job.status, 'interrupted');
  assert.throws(() => f.bot.resumeAdminBroadcast(job.id), error => error.statusCode === 409);
  f.bot.closeStore();
  const next = f.open();
  f.onSend(undefined);
  next.resumeAdminBroadcast(job.id);
  await next.waitForBackground();
  assert.deepEqual(f.calls.map(call => call.body.chat_id), [101, 102, 103]);
});

test('web sends share the cached state with simultaneous user and registration writes', async t => {
  const f = fixture(t, [101]), gate = deferred();
  f.onSend(async () => { await gate.promise; });
  create(f.bot);
  try {
    await until(() => f.calls.length === 1);
    const shared = f.bot.loadDb();
    assert.equal(shared, f.db);
    shared.users['777'] = { chat_id: 777, step: 'phone', name: 'Offline Person' };
    shared.registrations.push({ id: 'during-send', telegram_id: 777, status: 'pending' });
    shared.last_update_id = 99;
    f.bot.saveDb(shared);
  } finally { gate.resolve(); }
  await f.bot.waitForBackground();
  const stored = readState({ dataDir: f.dataDir });
  assert.equal(stored.users['777'].name, 'Offline Person');
  assert.equal(stored.registrations[0].id, 'during-send');
  assert.equal(stored.last_update_id, 99);
  assert.equal(stored.broadcast_job.sent, 1);
  assert.equal(f.bot.getAdminDashboard().audienceCount, 2);
});

test('Telegram and web broadcasts cannot overlap in either direction', async t => {
  const f = fixture(t, [101]), gate = deferred();
  f.db.registrations.push({ id: 'registered', telegram_id: 101 });
  f.db.broadcast = { step: 'collecting', fromChatId: 42, items: [{ srcMessageId: 4 }] };
  f.bot.saveDb(f.db);
  f.onSend(async method => { if (method === 'copyMessage') await gate.promise; });
  await f.bot.handleMessage(message(42, '✅ Yuborish'), f.db);
  try {
    await until(() => f.calls.some(call => call.method === 'copyMessage'));
    assert.throws(() => create(f.bot), error => error.statusCode === 409);
  } finally { gate.resolve(); }
  await f.bot.waitForBackground();
  const webGate = deferred();
  f.onSend(async (_method, body) => { if (body.text === 'Web pending') await webGate.promise; });
  const webJob = create(f.bot, 'Web pending');
  try {
    await until(() => f.calls.some(call => call.body.text === 'Web pending'));
    f.db.broadcast = { step: 'collecting', fromChatId: 42, items: [{ srcMessageId: 5 }] };
    await f.bot.handleMessage(message(42, '✅ Yuborish'), f.db);
    assert.equal(f.db.broadcast_job.id, webJob.id);
    assert.ok(f.calls.some(call => call.body.text?.includes('Oldingi yuborish hali yakunlanmagan')));
  } finally { webGate.resolve(); }
  await f.bot.waitForBackground();
});

test('invalid text, invalid request ID, empty audience and unknown jobs fail before sending', async t => {
  const f = fixture(t, []);
  for (const text of ['', '  \n ', 'a'.repeat(4097), 42]) assert.throws(() => create(f.bot, text), error => error.statusCode === 400);
  for (const requestId of ['', '__proto__', 'with spaces in identifier']) assert.throws(() => create(f.bot, 'Text', requestId), error => error.statusCode === 400);
  assert.throws(() => create(f.bot), error => error.statusCode === 409);
  assert.throws(() => f.bot.cancelAdminBroadcast('missing'), error => error.statusCode === 404);
  assert.throws(() => f.bot.resumeAdminBroadcast('missing'), error => error.statusCode === 404);
  assert.equal(f.calls.length, 0);
});

test('explicit Telegram 429 retry advances the durable recipient cursor only once', async t => {
  const f = fixture(t, [101, 102], { telegramQueue: createTelegramQueue({ ratePerSecond: 10000, perChatMs: 1, groupMs: 1 }) });
  f.onSend(() => f.calls.length === 1 ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 0.001 } }, { status: 429 }) : undefined);
  create(f.bot);
  await f.bot.waitForBackground();
  assert.deepEqual(f.calls.map(call => call.body.chat_id), [101, 101, 102]);
  assert.equal(f.bot.getAdminDashboard().job.sent, 2);
  assert.equal(f.bot.getAdminDashboard().job.unknown, 0);
  assert.equal(f.db.broadcast_job.recipient, 2);
});

test('cancelling during a rejected 429 retry delay prevents the retry and retains the unprocessed recipient', async t => {
  const gate = deferred();
  let retryWaiting = false;
  const f = fixture(t, [101, 102], { telegramQueue: { run: async (_options, fn) => {
    try { return await fn(); }
    catch (error) {
      assert.equal(error.status, 429);
      retryWaiting = true;
      await gate.promise;
      return fn();
    }
  } } });
  f.onSend(() => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 3 } }, { status: 429 }));
  const job = create(f.bot);
  try {
    await until(() => retryWaiting);
    f.bot.cancelAdminBroadcast(job.id);
  } finally { gate.resolve(); }
  await f.bot.waitForBackground();
  assert.equal(f.calls.length, 1);
  const result = f.bot.getAdminDashboard().job;
  assert.equal(result.processed, 0); assert.equal(result.remaining, 2); assert.equal(result.unknown, 0);
  assert.equal(f.db.broadcast_job.in_flight, false);
});

test('test broadcasts reach only the configured private profile even when it is an excluded admin', async t => {
  const recipient = { chatId: 42, label: 'GLMV Dev' };
  const f = fixture(t, [101, 102, 42, 43], { broadcastTestRecipient: recipient });
  f.db.registrations.push({ id: 'registered', telegram_id: 103 });
  f.db.payments.push({ id: 'paid', telegram_id: 104 });
  f.bot.saveDb(f.db);
  recipient.chatId = 999; // Configuration is captured; caller mutation cannot widen it.
  const dashboard = f.bot.getAdminDashboard();
  assert.equal(dashboard.broadcastMode, 'test');
  assert.deepEqual(dashboard.testRecipient, { chatId: 42, label: 'GLMV Dev' });
  assert.equal(dashboard.audienceCount, 1);
  create(f.bot);
  await f.bot.waitForBackground();
  assert.deepEqual(f.calls.map(call => call.body.chat_id), [42]);
  const result = f.bot.getAdminDashboard();
  assert.equal(result.job.total, 1);
  assert.equal(result.job.sent, 1);
  assert.equal(result.job.broadcastMode, 'test');
  assert.deepEqual(result.history[0].testRecipient, { chatId: 42, label: 'GLMV Dev' });
});

test('test audience includes the explicit profile without a local user or registration record', async t => {
  const f = fixture(t, [101, 102], { broadcastTestRecipient: { chatId: 777, label: 'GLMV Dev' } });
  assert.equal(f.bot.getAdminDashboard().audienceCount, 1);
  create(f.bot);
  await f.bot.waitForBackground();
  assert.deepEqual(f.calls.map(call => call.body.chat_id), [777]);
  assert.equal(f.db.users['777'], undefined);
});

test('Telegram copy broadcasts obey the same sole test recipient restriction', async t => {
  const f = fixture(t, [101, 102, 42], { broadcastTestRecipient: { chatId: 42, label: 'GLMV Dev' } });
  f.db.registrations.push({ id: 'registered', telegram_id: 101 });
  f.db.broadcast = { step: 'collecting', fromChatId: 42, items: [{ srcMessageId: 4 }, { srcMessageId: 5 }] };
  f.bot.saveDb(f.db);
  await f.bot.handleMessage(message(42, '✅ Yuborish'), f.db);
  await f.bot.waitForBackground();
  assert.deepEqual(f.calls.filter(call => call.method === 'copyMessage').map(call => [call.body.chat_id, call.body.message_id]), [[42, 4], [42, 5]]);
  assert.equal(f.bot.getAdminDashboard().job.broadcastMode, 'test');
  assert.equal(f.bot.getAdminDashboard().job.sent, 2);
});

test('test mode refuses to resume a historical wider web audience and does not redirect its text', async t => {
  const f = fixture(t, [101, 102], { broadcastTestRecipient: { chatId: 42, label: 'GLMV Dev' } });
  f.db.broadcast_recipients = [101, 42];
  f.db.broadcast_job = { id: 'old-all-users', kind: 'admin_text', text: 'Old campaign', status: 'running',
    total: 2, recipient: 0, item: 0, in_flight: false, sent: 0, blocked: 0, failed: 0, unknown: 0 };
  f.bot.saveDb(f.db);
  assert.equal(f.bot.getAdminDashboard().job.status, 'interrupted');
  assert.throws(() => f.bot.resumeAdminBroadcast('old-all-users'), error => error.statusCode === 409 && error.code === 'BROADCAST_SCOPE_MISMATCH');
  await f.bot.waitForBackground();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.db.broadcast_recipients, [101, 42]);
  assert.equal(f.db.broadcast_job.status, 'interrupted');
  f.bot.cancelAdminBroadcast('old-all-users');
  create(f.bot, 'New explicit test');
  await f.bot.waitForBackground();
  assert.deepEqual(f.calls.map(call => [call.body.chat_id, call.body.text]), [[42, 'New explicit test']]);
});

test('Telegram resume cannot bypass test scope for a previous copy campaign', async t => {
  const f = fixture(t, [101, 102], { broadcastTestRecipient: { chatId: 42, label: 'GLMV Dev' } });
  f.db.broadcast_recipients = [101, 42];
  f.db.broadcast_job = { id: 'old-telegram', status: 'interrupted', fromChatId: 42,
    items: [{ srcMessageId: 4 }], total: 2, recipient: 0, item: 0, in_flight: false,
    sent: 0, blocked: 0, failed: 0, unknown: 0 };
  f.bot.saveDb(f.db);
  await f.bot.handleMessage(message(42, '/broadcast_resume'), f.db);
  await f.bot.waitForBackground();
  assert.equal(f.db.broadcast_job.status, 'interrupted');
  assert.equal(f.calls.filter(call => call.method === 'copyMessage').length, 0);
  assert.ok(f.calls.every(call => call.body.chat_id === 42));
  assert.match(f.calls.at(-1).body.text, /Test rejimida/);
});

test('test mode rechecks audience after queueing and interrupts before a network request', async t => {
  const gate = deferred();
  let queued = false;
  const f = fixture(t, [101, 102], { broadcastTestRecipient: { chatId: 42, label: 'GLMV Dev' },
    telegramQueue: { run: async (_options, fn) => { queued = true; await gate.promise; return fn(); } } });
  create(f.bot);
  try {
    await until(() => queued);
    f.db.broadcast_recipients.push(101);
    f.bot.saveDb(f.db);
  } finally { gate.resolve(); }
  await f.bot.waitForBackground();
  assert.equal(f.calls.length, 0);
  const result = f.bot.getAdminDashboard().job;
  assert.equal(result.status, 'interrupted');
  assert.equal(result.processed, 0);
  assert.equal(f.db.broadcast_job.in_flight, false);
});

test('test mode validates the captured destination even if a queued historical audience is replaced', async t => {
  const gate = deferred();
  let queued = false;
  const f = fixture(t, [101], { broadcastTestRecipient: { chatId: 42, label: 'GLMV Dev' },
    telegramQueue: { run: async (options, fn) => {
      if (options.priority === 10) { queued = true; await gate.promise; }
      return fn();
    } } });
  f.db.broadcast_recipients = [101];
  f.db.broadcast_job = { id: 'old-running', status: 'running', fromChatId: 42,
    items: [{ srcMessageId: 4 }], total: 1, recipient: 0, item: 0, in_flight: false,
    sent: 0, blocked: 0, failed: 0, unknown: 0 };
  f.bot.saveDb(f.db);
  try {
    await f.bot.handleMessage(message(42, '/broadcast_status'), f.db);
    await until(() => queued);
    f.db.broadcast_recipients = [42];
    f.bot.saveDb(f.db);
  } finally { gate.resolve(); }
  await f.bot.waitForBackground();
  assert.equal(f.calls.filter(call => call.method === 'copyMessage').length, 0);
  assert.ok(f.calls.every(call => call.body.chat_id === 42));
  assert.equal(f.db.broadcast_job.status, 'interrupted');
  assert.equal(f.db.broadcast_job.sent, 0);
});

test('test scope is rechecked before a Telegram 429 retry', async t => {
  const gate = deferred();
  let retryWaiting = false;
  const f = fixture(t, [101], { broadcastTestRecipient: { chatId: 42, label: 'GLMV Dev' },
    telegramQueue: { run: async (_options, fn) => {
      try { return await fn(); }
      catch (error) {
        assert.equal(error.status, 429);
        retryWaiting = true;
        await gate.promise;
        return fn();
      }
    } } });
  f.onSend(() => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 3 } }, { status: 429 }));
  create(f.bot);
  try {
    await until(() => retryWaiting);
    f.db.broadcast_recipients = [101];
    f.bot.saveDb(f.db);
  } finally { gate.resolve(); }
  await f.bot.waitForBackground();
  assert.deepEqual(f.calls.map(call => call.body.chat_id), [42]);
  const result = f.bot.getAdminDashboard().job;
  assert.equal(result.status, 'interrupted');
  assert.equal(result.processed, 0);
  assert.equal(f.db.broadcast_job.recipient, 0);
  assert.equal(f.db.broadcast_job.in_flight, false);
});

test('invalid test recipient options and environment fail closed before opening storage', () => {
  for (const candidate of [null, undefined, {}, { chatId: 0 }, { chatId: -42 }, { chatId: 1.5 },
    { chatId: '42' }, { chatId: NaN }, { chatId: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => createBot({ broadcastTestRecipient: candidate, google: {}, telegramQueue: unpaced }), /BROADCAST_TEST_CHAT_ID/);
  }
  const oldId = process.env.BROADCAST_TEST_CHAT_ID, oldLabel = process.env.BROADCAST_TEST_LABEL;
  try {
    process.env.BROADCAST_TEST_LABEL = 'GLMV Dev';
    for (const value of ['', '0', '-42', '1.5', '4e2', '42junk', '9007199254740992']) {
      process.env.BROADCAST_TEST_CHAT_ID = value;
      assert.throws(() => createBot({ google: {}, telegramQueue: unpaced }), /BROADCAST_TEST_CHAT_ID/);
    }
    delete process.env.BROADCAST_TEST_CHAT_ID;
    assert.throws(() => createBot({ google: {}, telegramQueue: unpaced }), /BROADCAST_TEST_CHAT_ID/);
    process.env.BROADCAST_TEST_CHAT_ID = '42';
    const bot = createBot({ google: {}, telegramQueue: unpaced, stateStore: {
      load: () => ({ users: {}, registrations: [], payments: [] }), save: () => {}, close: () => {},
    } });
    assert.equal(bot.getAdminDashboard().broadcastMode, 'test');
    assert.deepEqual(bot.getAdminDashboard().testRecipient, { chatId: 42, label: 'GLMV Dev' });
    bot.closeStore();
  } finally {
    if (oldId === undefined) delete process.env.BROADCAST_TEST_CHAT_ID; else process.env.BROADCAST_TEST_CHAT_ID = oldId;
    if (oldLabel === undefined) delete process.env.BROADCAST_TEST_LABEL; else process.env.BROADCAST_TEST_LABEL = oldLabel;
  }
});

test('personal transport accepts a confirmed delivery after the usual 15-second deadline within its configured 65-second budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred();
  const f = fixture(t, [101, 102], { telegramTimeoutMs: 65000, broadcastTestRecipient: { chatId: 42, label: 'Offline personal test' } });
  f.onSend(async () => { await gate.promise; });
  create(f.bot, 'Slow but confirmed personal delivery');
  try {
    await until(() => f.calls.length === 1);
    t.mock.timers.tick(16376);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls[0].signal.aborted, false);
    assert.equal(f.bot.getAdminDashboard().job.status, 'running');
    assert.equal(f.bot.getAdminDashboard().job.unknown, 0);
  } finally { gate.resolve(); }
  await f.bot.waitForBackground();
  assert.deepEqual(f.calls.map(call => call.body.chat_id), [42]);
  const result = f.bot.getAdminDashboard().job;
  assert.equal(result.status, 'done');
  assert.equal(result.sent, 1);
  assert.equal(result.unknown, 0);
});

test('an expired configured personal transport deadline remains unknown and is never automatically retried', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred();
  const f = fixture(t, [101], { telegramTimeoutMs: 65000, broadcastTestRecipient: { chatId: 42, label: 'Offline personal test' } });
  f.onSend(async () => { await gate.promise; });
  create(f.bot);
  try {
    await until(() => f.calls.length === 1);
    t.mock.timers.tick(64999);
    assert.equal(f.calls[0].signal.aborted, false);
    t.mock.timers.tick(1);
    await f.bot.waitForBackground();
    assert.equal(f.calls[0].signal.aborted, true);
    const result = f.bot.getAdminDashboard().job;
    assert.equal(result.status, 'done');
    assert.equal(result.sent, 0);
    assert.equal(result.unknown, 1);
    assert.equal(f.calls.length, 1, 'An uncertain send must never be retried automatically');
  } finally { gate.resolve(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.bot.getAdminDashboard().job.unknown, 1, 'An acknowledgement arriving after the deadline cannot silently overwrite the settled outcome');
});

test('normal Telegram delivery retains its existing 15-second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred();
  const f = fixture(t, [101]);
  f.onSend(async () => { await gate.promise; });
  create(f.bot);
  try {
    await until(() => f.calls.length === 1);
    t.mock.timers.tick(14999);
    assert.equal(f.calls[0].signal.aborted, false);
    t.mock.timers.tick(1);
    await f.bot.waitForBackground();
    assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.bot.getAdminDashboard().job.unknown, 1);
    assert.equal(f.calls.length, 1);
  } finally { gate.resolve(); }
  await new Promise(resolve => setImmediate(resolve));
});

test('invalid Telegram timeout options fail before any transport or storage is opened', () => {
  for (const telegramTimeoutMs of [0, -1, 1.5, '65000', NaN, Infinity, 120001, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => createBot({ telegramTimeoutMs, google: {}, telegramQueue: unpaced,
      stateStore: { load() { assert.fail('Invalid timeout must not open state'); } } }), /kutish muddati/);
  }
});

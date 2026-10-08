'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.BOT_TOKEN = '123456:OFFLINE_PHONE_UPDATE_TOKEN';
process.env.GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/OFFLINE/exec';
process.env.PRIMARY_ADMIN_IDS = '42';
process.env.EXTRA_ADMIN_IDS = '';
process.env.NOTIFY_CHAT_ID = '';
process.env.WELCOME_IMAGE_PATH = '';
process.env.OFFER_VERSION = 'offline-phone-update-v1';
delete process.env.PHONE_UPDATE_SCRIPT_URL;
delete process.env.PHONE_UPDATE_SECRET;
const { createBot } = require('../bot.js');
const { readState } = require('../state-store.cjs');
const oldPhone = '+998901234567', newPhone = '+998931234567', otherPhone = '+998941234567';
const extraPhone = '+998911234567';
const msg = (id, text, extra = {}) => ({ chat: { id, type: 'private' }, from: { id }, message_id: 20, text, ...extra });
const cb = id => ({ id: 'offline-cb', from: { id }, message: { chat: { id, type: 'private' }, message_id: 30 }, data: 'offer:yes' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); }
  assert.fail('Offline phone update did not reach the expected state');
}
function fixture(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-phone-update-'));
  const originalFetch = globalThis.fetch, bots = [], requests = [], corrections = [], registrations = [], receipts = [];
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    assert.ok(url.startsWith('https://api.telegram.org/'), 'Only synthetic Telegram requests are allowed');
    if (url.includes('/file/bot')) return new Response(Buffer.from([255, 216, 255, 1, 2, 3]));
    const body = options.body ? JSON.parse(options.body) : {};
    requests.push({ method: url.slice(url.lastIndexOf('/') + 1), body });
    return Response.json({ ok: true, result: url.endsWith('/getFile') ? { file_path: 'photos/offline.jpg', file_size: 6 } : { message_id: requests.length } });
  };
  const updater = { updatePhone: async update => { corrections.push(update); return { ok: true, ...update, matchedRows: 1 }; } };
  const open = options => {
    const bot = createBot({ dataDir, telegramQueue: { run: (_, fn) => Promise.resolve().then(fn), idle: async () => {} },
      google: { sendRegistration: async value => { registrations.push(value); return { ok: true }; },
        sendReceipt: async value => { receipts.push(value); return { fileUrl: 'https://drive.google.com/file/d/OFFLINE/view' }; } },
      phoneUpdater: updater, ...overrides, ...options });
    bots.push(bot); return bot;
  };
  t.after(async () => {
    for (const bot of bots) { await bot.waitForBackground(); bot.closeStore(); }
    globalThis.fetch = originalFetch;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, open, updater, requests, corrections, registrations, receipts };
}
function registered(bot, id = 101, step = 'receipt') {
  const db = bot.loadDb();
  db.users[String(id)] = { chat_id: id, username: 'offline', name: 'Offline Person', phone: oldPhone, additional_phone: extraPhone,
    step, offerAccepted: true, offerVersion: process.env.OFFER_VERSION };
  db.registrations.push({ id: 'registered-' + id, telegram_id: id, name: 'Offline Person', phone: oldPhone,
    additional_phone: extraPhone, offer: 'Roziman', offer_version: process.env.OFFER_VERSION,
    date: '01.10.2026 10:00:00', status: 'sent' });
  bot.saveDb(db);
  return db;
}

test('registered corrections are durable and acknowledged without waiting for Google', async t => {
  const f = fixture(t), gate = deferred();
  let called = false;
  f.updater.updatePhone = async update => {
    called = true; f.corrections.push(update);
    assert.equal(readState({ dataDir: f.dataDir }).phone_updates['101'].phone, newPhone);
    assert.match(f.requests.at(-1).body.text, /Telefon raqamingiz qabul qilindi/);
    await gate.promise;
    return { ok: true, revision: update.revision, telegramId: update.telegramId };
  };
  const bot = f.open(), db = registered(bot);
  try {
    await bot.handleMessage(msg(101, '+998 93 123 45 67'), db);
    await until(() => called);
    assert.equal(db.phone_updates['101'].status, 'sending');
    assert.equal(db.users['101'].step, 'receipt');
    assert.equal(db.users['101'].phone, oldPhone);
    assert.equal(db.users['101'].latest_phone, newPhone);
    assert.equal(db.registrations.length, 1);
    assert.equal(db.registrations[0].date, '01.10.2026 10:00:00');
    assert.equal(f.registrations.length, 0);
  } finally { gate.resolve(); await bot.waitForBackground(); }
  assert.equal(db.phone_updates['101'].status, 'sent');
});

test('registered offer, done and missing profiles accept corrections without restarting registration', async t => {
  const f = fixture(t), bot = f.open();
  for (const [id, step] of [[102, 'offer'], [103, 'done'], [104, null]]) {
    const db = registered(bot, id, step || 'done');
    if (!step) { delete db.users[String(id)]; bot.saveDb(db); }
    await bot.handleMessage(msg(id, newPhone), db);
    await bot.waitForBackground();
    assert.equal(db.phone_updates[String(id)].status, 'sent');
    assert.equal(db.users[String(id)]?.step, step || undefined);
    assert.equal(db.registrations.find(row => row.telegram_id === id).latest_phone, newPhone);
  }
  assert.equal(f.corrections.length, 3);
});

test('invalid and foreign phone contacts never replace a saved phone; own contact is accepted', async t => {
  const f = fixture(t), bot = f.open(), db = registered(bot);
  for (const value of ['9983453434', '+9983452343', 'abc901234567']) {
    await bot.handleMessage(msg(101, value), db);
    assert.equal(db.phone_updates, undefined);
    assert.match(f.requests.at(-1).body.text, /Telefon raqamini tekshiring/);
  }
  await bot.handleMessage(msg(101, '', { contact: { user_id: 999, phone_number: newPhone } }), db);
  assert.equal(db.phone_updates, undefined);
  assert.match(f.requests.at(-1).body.text, /Oʻzingizning/);
  await bot.handleMessage(msg(101, '', { contact: { user_id: 101, phone_number: newPhone } }), db);
  await bot.waitForBackground();
  assert.equal(db.phone_updates['101'].phone, newPhone);
  assert.equal(f.corrections.length, 1);
});

test('new registrations and unconfigured bots retain their existing phone and receipt flows', async t => {
  const f = fixture(t), bot = f.open(), db = bot.loadDb();
  await bot.handleMessage(msg(105, '/start'), db);
  await bot.handleMessage(msg(105, 'Offline New Person'), db);
  await bot.handleMessage(msg(105, oldPhone), db);
  assert.equal(db.users['105'].step, 'additional_phone');
  await bot.handleMessage(msg(105, extraPhone), db);
  await bot.handleMessage(msg(105, newPhone), db);
  assert.equal(db.users['105'].step, 'offer');
  assert.equal(db.phone_updates, undefined);
  bot.closeStore();
  const legacy = f.open({ phoneUpdater: null }), legacyDb = registered(legacy);
  await legacy.handleMessage(msg(101, newPhone), legacyDb);
  assert.equal(legacyDb.phone_updates, undefined);
  assert.match(f.requests.at(-1).body.text, /Toʻlov chekini/);
});

test('latest correction wins while earlier Google delivery is held; repeated latest number is idempotent', async t => {
  const f = fixture(t), gate = deferred(), bot = f.open(), db = registered(bot);
  f.updater.updatePhone = async update => {
    f.corrections.push(update);
    if (f.corrections.length === 1) await gate.promise;
    return { ok: true, revision: update.revision, telegramId: update.telegramId };
  };
  try {
    await bot.handleMessage(msg(101, newPhone), db);
    await until(() => f.corrections.length === 1);
    await bot.handleMessage(msg(101, otherPhone, { message_id: 21 }), db);
    assert.equal(f.corrections.length, 1);
    assert.equal(db.phone_updates['101'].phone, otherPhone);
    assert.equal(db.phone_updates['101'].status, 'pending');
    assert.ok(db.phone_updates['101'].revision > f.corrections[0].revision);
  } finally { gate.resolve(); await bot.waitForBackground(); }
  assert.equal(f.corrections.length, 2);
  assert.equal(db.phone_updates['101'].phone, otherPhone);
  assert.equal(db.phone_updates['101'].status, 'sent');
  await bot.handleMessage(msg(101, otherPhone, { message_id: 22 }), db);
  await bot.waitForBackground();
  assert.equal(f.corrections.length, 2);
});

test('failed updates automatically retry the same version and a wrong ACK cannot mark it sent', async t => {
  const f = fixture(t), bot = f.open({ phoneRetryBaseMs: 15 }), db = registered(bot);
  f.updater.updatePhone = async update => {
    f.corrections.push(update);
    return { ok: true, revision: f.corrections.length === 1 ? update.revision - 1 : update.revision };
  };
  await bot.handleMessage(msg(101, newPhone), db);
  await bot.waitForBackground();
  assert.equal(db.phone_updates['101'].status, 'pending');
  assert.equal(db.phone_updates['101'].attempts, 1);
  await new Promise(resolve => setTimeout(resolve, 40));
  await bot.waitForBackground();
  assert.equal(db.phone_updates['101'].status, 'sent');
  assert.equal(f.corrections.length, 2);
  assert.equal(f.corrections[0].revision, f.corrections[1].revision);
});

test('correction retry survives restart and interrupted sending recovers as pending', async t => {
  const f = fixture(t), bot = f.open(), db = registered(bot);
  f.updater.updatePhone = async update => { f.corrections.push(update); throw new Error('offline timeout'); };
  await bot.handleMessage(msg(101, newPhone), db);
  await bot.waitForBackground();
  const revision = db.phone_updates['101'].revision;
  db.phone_updates['101'].status = 'sending'; bot.saveDb(db); bot.closeStore();
  const resumed = f.open({ phoneUpdater: { updatePhone: async update => { f.corrections.push(update); return { ok: true, revision: update.revision }; } } });
  const recovered = resumed.recoverInterrupted(resumed.loadDb());
  assert.equal(recovered.phone_updates['101'].status, 'pending');
  resumed.saveDb(recovered); resumed.pumpPhoneUpdates(recovered);
  await resumed.waitForBackground();
  assert.equal(recovered.phone_updates['101'].status, 'sent');
  assert.equal(recovered.phone_updates['101'].revision, revision);
});

test('/start during a correction does not restore the old profile on completion and newly completed registration updates contact', async t => {
  const f = fixture(t), gate = deferred(), bot = f.open(), db = registered(bot);
  f.updater.updatePhone = async update => {
    f.corrections.push(update);
    if (f.corrections.length === 1) await gate.promise;
    return { ok: true, revision: update.revision };
  };
  try {
    await bot.handleMessage(msg(101, newPhone), db);
    await until(() => f.corrections.length === 1);
    await bot.handleMessage(msg(101, '/start'), db);
    assert.equal(db.users['101'].step, 'name');
  } finally { gate.resolve(); await bot.waitForBackground(); }
  assert.equal(db.users['101'].step, 'name');
  assert.equal(db.users['101'].phone, undefined);
  await bot.handleMessage(msg(101, 'Fresh Name'), db);
  await bot.handleMessage(msg(101, otherPhone), db);
  await bot.handleMessage(msg(101, extraPhone), db);
  await bot.handleCallback(cb(101), db);
  await bot.waitForBackground();
  assert.equal(db.users['101'].name, 'Fresh Name');
  assert.equal(db.phone_updates['101'].phone, otherPhone);
  assert.equal(f.corrections.length, 2);
  assert.equal(f.registrations.at(-1).phone, otherPhone);
});

test('receipt dedupe identity stays unchanged while downstream contact, admin reports and Excel use the latest number', async t => {
  const f = fixture(t), bot = f.open(), db = registered(bot);
  const photo = { photo: [{ file_id: 'OFFLINE_FILE', file_unique_id: 'OFFLINE_UNIQUE', file_size: 6 }] };
  await bot.handleMessage(msg(101, '', photo), db);
  await bot.waitForBackground();
  assert.equal(db.payments.length, 1);
  await bot.handleMessage(msg(101, newPhone), db);
  await bot.waitForBackground();
  await bot.handleMessage(msg(101, '', photo), db);
  await bot.waitForBackground();
  assert.equal(db.payments.length, 1);
  assert.equal(db.payments[0].phone, oldPhone);
  assert.equal(f.receipts.length, 1);
  assert.match(f.requests.at(-1).body.text, /Bu chek tekshirish uchun yuborilgan/);
  await bot.handleMessage(msg(101, '', { photo: [{ file_id: 'OFFLINE_FILE_2', file_unique_id: 'OFFLINE_UNIQUE_2', file_size: 6 }] }), db);
  await bot.waitForBackground();
  assert.equal(f.receipts.at(-1).phone, newPhone);
  assert.equal(f.receipts.at(-1).additionalPhone, extraPhone);
  const report = bot.leadReport(db.payments[0], 'Offline Test', true);
  assert.ok(report.includes(newPhone)); assert.ok(!report.includes(oldPhone));
  const exported = fs.readFileSync(bot.exportExcel(db), 'utf8');
  assert.ok(exported.includes(newPhone)); assert.ok(!exported.includes(oldPhone));
  assert.equal(db.payments[0].offer, 'Roziman');
});

test('corrected primary equal to additional phone removes the duplicate instead of retaining the bad primary', async t => {
  const f = fixture(t), bot = f.open(), db = registered(bot);
  await bot.handleMessage(msg(101, extraPhone), db);
  await bot.waitForBackground();
  assert.equal(f.corrections[0].phone, extraPhone);
  assert.equal(f.corrections[0].additionalPhone, null);
  assert.equal(db.users['101'].latest_additional_phone, '');
  const report = bot.leadReport(db.registrations[0], 'Offline Test');
  assert.ok(!report.includes(oldPhone));
  assert.ok(!report.includes('Qoʻshimcha telefon:'));
});

test('closing the store cancels a scheduled retry without reopening SQLite in a timer', async t => {
  const f = fixture(t), bot = f.open({ phoneRetryBaseMs: 20 }), db = registered(bot);
  f.updater.updatePhone = async update => { f.corrections.push(update); throw new Error('offline timeout'); };
  await bot.handleMessage(msg(101, newPhone), db);
  await bot.waitForBackground();
  bot.closeStore();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.corrections.length, 1);
  assert.equal(readState({ dataDir: f.dataDir }).phone_updates['101'].status, 'pending');
});

test('slow Sheets delivery uses only two workers while excess corrections remain durably pending', async t => {
  const f = fixture(t), gate = deferred(), bot = f.open();
  f.updater.updatePhone = async update => {
    f.corrections.push(update); await gate.promise;
    return { ok: true, revision: update.revision };
  };
  try {
    for (let id = 201; id < 206; id++) {
      const db = registered(bot, id);
      await bot.handleMessage(msg(id, newPhone), db);
    }
    await until(() => f.corrections.length === 2);
    const saved = Object.values(readState({ dataDir: f.dataDir }).phone_updates);
    assert.equal(saved.filter(entry => entry.status === 'sending').length, 2);
    assert.equal(saved.filter(entry => entry.status === 'pending').length, 3);
    assert.equal(f.requests.filter(request => request.body.text?.includes('Telefon raqamingiz qabul qilindi')).length, 5);
  } finally { gate.resolve(); await bot.waitForBackground(); }
  assert.equal(f.corrections.length, 5);
  assert.ok(Object.values(readState({ dataDir: f.dataDir }).phone_updates).every(entry => entry.status === 'sent'));
});

test('graceful stop finishes an active correction and preserves the newer queued number for restart', async t => {
  const f = fixture(t), gate = deferred(), bot = f.open(), db = registered(bot);
  const runtime = bot.createPollingRuntime();
  f.updater.updatePhone = async update => {
    f.corrections.push(update); await gate.promise;
    return { ok: true, revision: update.revision };
  };
  try {
    await bot.handleMessage(msg(101, newPhone), db);
    await until(() => f.corrections.length === 1);
    await bot.handleMessage(msg(101, otherPhone), db);
    runtime.requestStop();
  } finally { gate.resolve(); await bot.waitForBackground(); runtime.dispose(); }
  assert.equal(f.corrections.length, 1);
  assert.equal(db.phone_updates['101'].phone, otherPhone);
  assert.equal(db.phone_updates['101'].status, 'pending');
  bot.closeStore();
  const resumed = f.open({ phoneUpdater: { updatePhone: async update => { f.corrections.push(update); return { ok: true, revision: update.revision }; } } });
  const recovered = resumed.recoverInterrupted(resumed.loadDb());
  resumed.saveDb(recovered); resumed.pumpPhoneUpdates(recovered);
  await resumed.waitForBackground();
  assert.equal(f.corrections.length, 2);
  assert.equal(f.corrections[1].phone, otherPhone);
  assert.equal(recovered.phone_updates['101'].status, 'sent');
});

test('/phone and owned phone:update callback request the contact without changing conversation or consent', async t => {
  const f = fixture(t), bot = f.open(), db = registered(bot);
  await bot.handleMessage(msg(101, '/phone'), db);
  assert.equal(db.users['101'].step, 'receipt');
  assert.equal(db.users['101'].offerAccepted, true);
  assert.equal(f.requests.at(-1).body.reply_markup.keyboard[0][0].request_contact, true);
  await bot.handleMessage(msg(101, '', { contact: { user_id: 101, phone_number: newPhone } }), db);
  await bot.waitForBackground();
  assert.equal(db.phone_update_requests['101'], undefined);
  assert.equal(f.requests.at(-1).body.reply_markup.remove_keyboard, true);
  await bot.handleCallback({ ...cb(101), data: 'phone:update' }, db);
  assert.equal(db.users['101'].step, 'receipt');
  assert.equal(db.users['101'].offerVersion, process.env.OFFER_VERSION);
  assert.equal(db.phone_update_requests['101'], true);
  assert.equal(f.requests.at(-1).body.reply_markup.keyboard[0][0].request_contact, true);
  assert.equal(f.corrections.length, 1);
});

test('phone:update refuses foreign owners, groups and unregistered users without requesting their contact', async t => {
  const f = fixture(t), bot = f.open(), db = registered(bot);
  for (const event of [
    { ...cb(101), from: { id: 777 }, data: 'phone:update' },
    { ...cb(101), message: { chat: { id: 101, type: 'group' } }, data: 'phone:update' },
    { ...cb(777), data: 'phone:update' },
  ]) {
    await bot.handleCallback(event, db);
    assert.equal(f.requests.at(-1).method, 'answerCallbackQuery');
    assert.equal(db.phone_update_requests, undefined);
  }
  assert.equal(f.requests.filter(request => request.method === 'sendMessage').length, 0);
  assert.equal(f.corrections.length, 0);
});

test('explicit phone update during fresh registration preserves the current step and /start cancels its request', async t => {
  const f = fixture(t), bot = f.open(), db = registered(bot);
  await bot.handleMessage(msg(101, '/start'), db);
  await bot.handleCallback({ ...cb(101), data: 'phone:update' }, db);
  await bot.handleMessage(msg(101, 'short'), db);
  assert.equal(db.users['101'].step, 'name');
  assert.match(f.requests.at(-1).body.text, /Telefon raqamini tekshiring/);
  await bot.handleMessage(msg(101, newPhone), db);
  await bot.waitForBackground();
  assert.equal(db.users['101'].step, 'name');
  assert.equal(db.phone_updates['101'].phone, newPhone);
  await bot.handleMessage(msg(101, '/phone'), db);
  await bot.handleMessage(msg(101, '/start'), db);
  assert.equal(db.phone_update_requests['101'], undefined);
  await bot.handleMessage(msg(101, 'Fresh Person'), db);
  assert.equal(db.users['101'].step, 'phone');
  await bot.handleMessage(msg(101, '/phone'), db);
  await bot.handleMessage(msg(101, newPhone), db);
  assert.equal(db.users['101'].step, 'phone');
  await bot.handleMessage(msg(101, otherPhone), db);
  await bot.handleMessage(msg(101, extraPhone), db);
  await bot.handleCallback(cb(101), db);
  await bot.waitForBackground();
  assert.equal(db.phone_updates['101'].phone, otherPhone);
  assert.equal(f.registrations.at(-1).phone, otherPhone);
});

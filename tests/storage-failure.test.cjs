'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createStateStore, readState } = require('../state-store.cjs');

process.env.BOT_TOKEN = '123456:FAKE_TOKEN_FOR_OFFLINE_STORAGE_TESTS';
process.env.GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/TEST_ONLY/exec';
process.env.PRIMARY_ADMIN_IDS = '';
process.env.EXTRA_ADMIN_IDS = '';
process.env.ADMIN_IDS = '';
process.env.NOTIFY_CHAT_ID = '';
const { createBot } = require('../bot.js');

function fixture(t, failSave) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-storage-failure-test-'));
  const durable = createStateStore({ dataDir });
  const injected = { ...durable, save(db) {
    if (failSave(db)) throw new Error('Synthetic disk failure');
    return durable.save(db);
  } };
  const bot = createBot({ dataDir, stateStore: injected,
    telegramQueue: { run: (_settings, fn) => fn(), idle: async () => {}, stats: () => ({}) },
    google: { sendRegistration: async () => ({ ok: true }) },
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    // Failed transactions deliberately leave dirty in-memory state for a fatal
    // process exit. Restore the persisted snapshot before a test-only clean close.
    durable.save(durable.snapshot({ persisted: true }));
    durable.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, durable, bot };
}

test('handler persistence failure does not acknowledge its update or start another poll', async t => {
  let fail = false;
  const f = fixture(t, () => fail);
  let polls = 0;
  globalThis.fetch = async url => {
    assert.ok(String(url).includes('/getUpdates?'));
    polls++;
    if (polls > 1) throw new Error('An unfinished update must not be acknowledged');
    return Response.json({ ok: true, result: [{ update_id: 101, message: { chat: { id: 1, type: 'private' } } }] });
  };
  const runtime = f.bot.createPollingRuntime({ onUpdate(_update, db) {
    db.users['1'] = { name: 'Must not commit' };
    fail = true;
    f.bot.saveDb(db);
  } });
  try { await assert.rejects(runtime.run(), error => error.code === 'STATE_STORE_ERROR'); }
  finally { runtime.dispose(); }
  assert.equal(polls, 1);
  const persisted = readState({ dataDir: f.dataDir });
  assert.equal(persisted.last_update_id, 0);
  assert.equal(persisted.users['1'], undefined);
});

test('offset commit failure preserves completed business data but never acknowledges an unsaved offset', async t => {
  const f = fixture(t, db => db.last_update_id > 0);
  let polls = 0;
  globalThis.fetch = async url => {
    assert.ok(String(url).includes('/getUpdates?'));
    polls++;
    return Response.json({ ok: true, result: [{ update_id: 202, message: { chat: { id: 2, type: 'private' } } }] });
  };
  const runtime = f.bot.createPollingRuntime({ onUpdate(_update, db) {
    db.users['2'] = { name: 'Durable business update' };
    f.bot.saveDb(db);
  } });
  try { await assert.rejects(runtime.run(), error => error.code === 'STATE_STORE_ERROR'); }
  finally { runtime.dispose(); }
  assert.equal(polls, 1);
  const persisted = readState({ dataDir: f.dataDir });
  assert.equal(persisted.last_update_id, 0);
  assert.equal(persisted.users['2'].name, 'Durable business update');
});

test('background delivery persistence failure stops polling and preserves an ambiguous sending claim', async t => {
  let failureObserved;
  const failed = new Promise(resolve => { failureObserved = resolve; });
  const f = fixture(t, db => {
    if (db.registrations.some(row => row.status === 'sent')) { failureObserved(); return true; }
    return false;
  });
  const db = f.durable.load();
  db.registrations.push({ id: 'background-test', status: 'pending', name: 'TEST receipt owner', phone: '+998000000000', offer: 'Roziman', offer_version: 'test', telegram_id: 3 });
  f.durable.save();
  let releasePoll;
  const heldPoll = new Promise(resolve => { releasePoll = resolve; });
  let polls = 0;
  globalThis.fetch = async url => {
    assert.ok(String(url).includes('/getUpdates?'));
    polls++;
    await heldPoll;
    return Response.json({ ok: true, result: [] });
  };
  const runtime = f.bot.createPollingRuntime();
  const running = runtime.run();
  try {
    await failed;
    releasePoll();
    await assert.rejects(running, error => error.code === 'STATE_STORE_ERROR');
    assert.equal(polls, 1);
    const persisted = readState({ dataDir: f.dataDir });
    assert.equal(persisted.last_update_id, 0);
    assert.equal(persisted.registrations[0].status, 'sending');
    assert.equal(f.bot.recoverInterrupted(persisted).registrations[0].status, 'failed');
  } finally { releasePoll(); runtime.dispose(); }
});

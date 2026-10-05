const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-sisra-shutdown-test-'));
let dbPath, testDirectory;
process.env.DATA_DIR = directory;
process.env.BOT_TOKEN = '123456:FAKE_TOKEN_FOR_OFFLINE_TESTS';
process.env.GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/TEST_ONLY/exec';
process.env.PRIMARY_ADMIN_IDS = '';
process.env.EXTRA_ADMIN_IDS = '';
process.env.ADMIN_IDS = '';
process.env.NOTIFY_CHAT_ID = '';
process.env.OFFER_VERSION = 'TEST-OFFER';
const originalFetch = globalThis.fetch;
let fetchHook;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  const body = options.body instanceof FormData ? Object.fromEntries(options.body) : options.body ? JSON.parse(options.body) : null;
  const result = await fetchHook?.(target, body);
  if (result) return result;
  if (target.endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'photos/test.jpg', file_size: 6 } });
  if (target.includes('/file/bot')) return new Response(Buffer.from([255, 216, 255, 1, 2, 3]));
  if (target.startsWith('https://script.google.com/')) return Response.json({ result: 'success', fileUrl: 'https://drive.google.com/file/d/TEST_ONLY/view' });
  if (target.includes('/getUpdates?')) throw new Error('Unexpected additional polling request');
  return Response.json({ ok: true, result: { message_id: 1 } });
};
const {createBot} = require('../bot.js');
const {readState} = require('../state-store.cjs');
let bot;
beforeEach(()=>{
  testDirectory=fs.mkdtempSync(path.join(directory,'case-'));
  dbPath=path.join(testDirectory,'bot_data.json');
  bot=createBot({dataDir:testDirectory,telegramQueue:{run:(_,fn)=>Promise.resolve().then(fn),idle:()=>Promise.resolve()}});
});
afterEach(()=>bot.closeStore());
after(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(directory, { recursive: true, force: true });
});
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const readDb = () => readState({dataDir:testDirectory});
const writeDb = db => fs.writeFileSync(dbPath, JSON.stringify(db));
const message = (id, text, extra = {}) => ({ chat: { id, type: 'private' }, from: { id }, text, ...extra });

test('shutdown finishes the fetched batch, commits offsets after handling, and starts no new poll', async () => {
  writeDb(bot.emptyDb());
  const firstReply = deferred();
  const releaseReply = deferred();
  const runtime = bot.createPollingRuntime();
  let polls = 0;
  const replies = [];
  fetchHook = async (url, body) => {
    if (url.includes('/getUpdates?')) {
      polls += 1;
      return Response.json({ ok: true, result: [
        { update_id: 101, message: message(501, '/id') },
        { update_id: 102, message: message(502, '/id') },
      ] });
    }
    if (url.endsWith('/sendMessage')) {
      replies.push(body.chat_id);
      if (body.chat_id === 501) {
        runtime.requestStop();
        runtime.requestStop();
        firstReply.resolve();
        await releaseReply.promise;
      }
    }
  };
  const running = runtime.run();
  try {
    await firstReply.promise;
    assert.equal(readDb().last_update_id, 0, 'an unfinished update is not acknowledged');
    releaseReply.resolve();
    await running;
    assert.deepEqual(replies, [501, 502]);
    assert.equal(readDb().last_update_id, 102);
    assert.equal(polls, 1);
  } finally {
    releaseReply.resolve();
    runtime.requestStop();
    await running;
    runtime.dispose();
    fetchHook = null;
  }
});

test('shutdown waits for a held receipt delivery and persists its successful acknowledgment', async () => {
  const db = bot.emptyDb();
  db.users['503'] = { chat_id: 503, name: 'TEST shutdown', phone: '+998901234567', step: 'receipt', offerAccepted: true, offerVersion: 'TEST-OFFER' };
  writeDb(db);
  const googleStarted = deferred();
  const releaseGoogle = deferred();
  const runtime = bot.createPollingRuntime();
  let completed = false;
  let polls = 0;
  fetchHook = async (url, body) => {
    if (url.includes('/getUpdates?')) {
      polls += 1;
      return Response.json({ ok: true, result: [{ update_id: 201, message: message(503, '', {
        photo: [{ file_id: 'TEST_RECEIPT', file_unique_id: 'TEST_UNIQUE', file_size: 6 }],
      }) }] });
    }
    if (body?.text?.includes('Chekingiz qabul qilindi')) runtime.requestStop();
    if (url.startsWith('https://script.google.com/')) {
      googleStarted.resolve();
      await releaseGoogle.promise;
    }
  };
  const running = runtime.run().then(() => { completed = true; });
  try {
    await googleStarted.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    assert.equal(readDb().payments[0].status, 'sending');
    releaseGoogle.resolve();
    await running;
    const saved = readDb();
    assert.equal(saved.last_update_id, 201);
    assert.equal(saved.payments[0].status, 'sent');
    assert.equal(saved.payments[0].check_url, 'https://drive.google.com/file/d/TEST_ONLY/view');
    assert.equal(polls, 1);
  } finally {
    releaseGoogle.resolve();
    runtime.requestStop();
    await running;
    runtime.dispose();
    fetchHook = null;
  }
});

test('shutdown deadline is bounded and preserves durable state while polling is held', async () => {
  const db = bot.emptyDb();
  db.last_update_id = 300;
  writeDb(db);
  const pollStarted = deferred();
  const releasePoll = deferred();
  const expired = deferred();
  let expirations = 0;
  const runtime = bot.createPollingRuntime({ shutdownTimeoutMs: 20, onShutdownTimeout: () => { expirations += 1; expired.resolve(); } });
  fetchHook = async url => {
    if (url.includes('/getUpdates?')) {
      pollStarted.resolve();
      await releasePoll.promise;
      return Response.json({ ok: true, result: [] });
    }
  };
  const running = runtime.run();
  try {
    await pollStarted.promise;
    runtime.requestStop();
    await expired.promise;
    assert.equal(expirations, 1);
    assert.equal(readDb().last_update_id, 300);
    releasePoll.resolve();
    await running;
  } finally {
    releasePoll.resolve();
    runtime.requestStop();
    await running;
    runtime.dispose();
    fetchHook = null;
  }
});

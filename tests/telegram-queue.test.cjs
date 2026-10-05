'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTelegramQueue } = require('../telegram-queue.cjs');
const { QueueFullError } = require('../work-queue.cjs');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function clockQueue(options = {}) {
  let time = 0, id = 0;
  const timers = new Map();
  const now = () => time;
  const queue = createTelegramQueue({ ...options, now,
    setTimeout(callback, delay) { const key = ++id; timers.set(key, { at: time + delay, callback }); return key; },
    clearTimeout(key) { timers.delete(key); },
  });
  return { queue, now, timers,
    async advance(ms) {
      await flush();
      const target = time + ms;
      let iterations = 0;
      while (true) {
        if (++iterations > 10000) throw new Error('Timer spin');
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        time = next[1].at;
        timers.delete(next[0]); next[1].callback(); await flush();
      }
      time = target; await flush();
    },
  };
}

test('global default pacing starts at most 25 messages per second without artificial bursts', async () => {
  const h = clockQueue(), starts = [];
  const jobs = Array.from({ length: 26 }, (_, chatId) => h.queue.run({ chatId }, () => starts.push(h.now())));
  await h.advance(999);
  assert.equal(starts.length, 25);
  await h.advance(1);
  await Promise.all(jobs); await h.queue.idle();
  assert.equal(starts[25], 1000);
  assert.equal(h.timers.size, 0);
});

test('same chat has 1050ms pacing and groups 3100ms while unrelated chats proceed', async () => {
  const h = clockQueue(), seen = [];
  const jobs = [1, 1, -100, -100, 2].map(chatId => h.queue.run({ chatId }, () => seen.push([chatId, h.now()])));
  await h.advance(3200);
  await Promise.all(jobs);
  assert.deepEqual(seen, [[1, 0], [-100, 40], [2, 80], [1, 1050], [-100, 3140]]);
  assert.equal(h.timers.size, 0);
});

test('normal replies overtake queued broadcast work in different chats', async () => {
  const h = clockQueue(), seen = [];
  const low = h.queue.run({ chatId: 1, priority: 10 }, () => seen.push('broadcast'));
  const high = h.queue.run({ chatId: 2 }, () => seen.push('reply'));
  await h.advance(40);
  await Promise.all([low, high]);
  assert.deepEqual(seen, ['reply', 'broadcast']);
});

test('confirmed 429 globally pauses new starts and its retry keeps chat ordering', async () => {
  const h = clockQueue(), seen = [];
  let attempts = 0;
  const first = h.queue.run({ chatId: 1 }, () => {
    seen.push(['first', h.now()]);
    if (++attempts === 1) throw Object.assign(new Error('safe'), { status: 429, retryAfter: 2 });
  });
  const later = h.queue.run({ chatId: 1 }, () => seen.push(['later', h.now()]));
  const other = h.queue.run({ chatId: 2 }, () => seen.push(['other', h.now()]));
  await h.advance(1999);
  assert.deepEqual(seen, [['first', 0]]);
  await h.advance(1051);
  await Promise.all([first, later, other]);
  assert.deepEqual(seen, [['first', 0], ['first', 2000], ['other', 2040], ['later', 3050]]);
});

test('429 without positive retry_after and ambiguous network or 5xx failures are never retried', async () => {
  for (const props of [{ status: 429 }, { status: 429, retryAfter: 0 }, { status: 429, retryAfter: -1 }, { status: 500, retryAfter: 1 }, { code: 'TELEGRAM_TIMEOUT' }, { code: 'TELEGRAM_NETWORK_ERROR' }]) {
    const h = clockQueue(); let calls = 0;
    const expected = Object.assign(new Error('synthetic'), props);
    const failed = assert.rejects(h.queue.run({ chatId: 1 }, () => { calls++; throw expected; }), failure => failure === expected);
    await h.advance(10000); await failed; await h.queue.idle();
    assert.equal(calls, 1); assert.equal(h.timers.size, 0);
  }
});

test('confirmed rate limits have at most 3 retries and clean up timers after exhaustion', async () => {
  const h = clockQueue(); let calls = 0;
  const failed = assert.rejects(h.queue.run({ chatId: 1 }, () => {
    calls++; throw Object.assign(new Error('limited'), { errorCode: 429, retryAfter: 1 });
  }), /limited/);
  await h.advance(5000); await failed; await h.queue.idle();
  assert.equal(calls, 4); assert.equal(h.timers.size, 0);
});

test('non-message operations skip message pacing but remain bounded and observe global cooldown', async () => {
  const h = clockQueue(), seen = [];
  const failed = assert.rejects(h.queue.run({ chatId: 1 }, () => { throw Object.assign(new Error('limited'), { status: 429, retryAfter: 1 }); }), /limited/);
  await h.advance(0);
  const metadata = h.queue.run({ rateLimited: false }, () => seen.push(h.now()));
  await h.advance(999); assert.deepEqual(seen, []);
  await h.advance(1); assert.deepEqual(seen, [1000]);
  await h.advance(4000); await Promise.all([failed, metadata]);
});

test('network concurrency and same-chat exclusion both hold for unpaced operations', async () => {
  const h = clockQueue({ concurrency: 2 });
  let release; const hold = new Promise(resolve => { release = resolve; });
  const seen = [];
  const jobs = [1, 1, 2, 3].map(chatId => h.queue.run({ chatId, rateLimited: false }, async () => { seen.push(chatId); await hold; }));
  await h.advance(0);
  assert.deepEqual(seen, [1, 2]);
  assert.equal(h.queue.stats().active, 2);
  release(); await Promise.all(jobs); await h.queue.idle();
  assert.deepEqual(seen, [1, 2, 1, 3]);
});

test('queue bounds count active and retrying jobs and rejection has no network side effects', async () => {
  const h = clockQueue({ maxPending: 1 });
  let release; const hold = new Promise(resolve => { release = resolve; });
  const job = h.queue.run({ chatId: 1 }, () => hold);
  let called = false;
  await assert.rejects(h.queue.run({ chatId: 2 }, () => { called = true; }), QueueFullError);
  assert.equal(called, false);
  release(); await job; await h.queue.idle();
  assert.equal(h.queue.stats().total, 0);
});

test('per-chat pacing survives an empty queue and undefined rejection remains a rejection', async () => {
  const h = clockQueue(), seen = [];
  const first = h.queue.run({ chatId: 1 }, () => seen.push(h.now()));
  await h.advance(0); await first; await h.queue.idle();
  const second = h.queue.run({ chatId: 1 }, () => seen.push(h.now()));
  await h.advance(1049); assert.deepEqual(seen, [0]);
  await h.advance(1); await second; assert.deepEqual(seen, [0, 1050]);
  const failure = h.queue.run({ rateLimited: false }, () => Promise.reject(undefined));
  const captured = failure.then(() => assert.fail('Must reject'), value => assert.equal(value, undefined));
  await h.advance(0); await captured;
});

test('invalid limits fail immediately', () => {
  for (const options of [{ ratePerSecond: 0 }, { perChatMs: NaN }, { concurrency: 0 }, { maxPending: -1 }, { maxRetries: 4 }]) assert.throws(() => createTelegramQueue(options));
});

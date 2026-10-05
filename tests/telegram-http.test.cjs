'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'telegram-http.cjs'), 'utf8');
const secretUrl = 'https://api.telegram.org/bot123456789:OFFLINE_SECRET_TOKEN_FOR_TEST_ONLY/getUpdates';
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

function harness(fetch) {
  const jobs = new Map(), calls = [];
  let nextTimer = 0;
  const context = {
    require: name => { assert.equal(name, 'node:buffer'); return require(name); },
    module: { exports: {} }, AbortController,
    fetch(url, options) { calls.push({ url, options }); return fetch(url, options); },
    setTimeout(callback, delay) { const id = ++nextTimer; jobs.set(id, { callback, delay }); return id; },
    clearTimeout(id) { jobs.delete(id); },
  };
  vm.runInNewContext(source, context, { filename: 'telegram-http.cjs' });
  return { ...context.module.exports, jobs, calls,
    expire() { for (const { callback } of [...jobs.values()]) callback(); },
  };
}

function assertSafe(error, code) {
  assert.equal(error.code, code);
  assert.doesNotMatch(error.message, /https?:|OFFLINE_SECRET|123456789|backend-private/);
  return true;
}

function stream(chunks, options = {}) {
  let index = 0;
  const state = { reads: 0, cancelled: 0, released: 0 };
  return {
    state,
    body: { getReader() { return {
      async read() {
        state.reads++;
        if (index < chunks.length) return { done: false, value: chunks[index++] };
        if (options.hangs) return new Promise(() => {});
        if (options.fails) throw new Error('backend-private ' + secretUrl);
        return { done: true };
      },
      async cancel() { state.cancelled++; },
      releaseLock() { state.released++; },
    }; } },
  };
}

test('JSON success preserves request options and clears the timer after complete parsing', async () => {
  let complete;
  const h = harness(async () => ({ ok: true, json: () => new Promise(resolve => { complete = resolve; }) }));
  const pending = h.fetchJson(secretUrl, { method: 'POST', body: 'offline-body' }, 15000, 'Telegram sendMessage');
  await flush();
  assert.equal(h.calls[0].options.method, 'POST');
  assert.equal(h.calls[0].options.body, 'offline-body');
  assert.equal([...h.jobs.values()][0].delay, 15000);
  complete({ ok: true, result: [] });
  assert.deepEqual(await pending, { ok: true, result: [] });
  assert.equal(h.jobs.size, 0);
});

test('A fetch that never returns headers times out even when it ignores abort', async () => {
  const h = harness(() => new Promise(() => {}));
  const pending = h.fetchJson(secretUrl, {}, 35000, secretUrl);
  const rejection = assert.rejects(pending, error => assertSafe(error, 'TELEGRAM_TIMEOUT'));
  assert.equal([...h.jobs.values()][0].delay, 35000);
  h.expire();
  await rejection;
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(h.jobs.size, 0);
});

test('JSON body parsing remains covered after response headers arrive', async () => {
  const h = harness(async () => ({ ok: true, json: () => new Promise(() => {}) }));
  const pending = h.fetchJson(secretUrl);
  const rejection = assert.rejects(pending, error => assertSafe(error, 'TELEGRAM_TIMEOUT'));
  await flush();
  assert.equal(h.jobs.size, 1);
  h.expire();
  await rejection;
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(h.jobs.size, 0);
});

test('HTTP, malformed JSON and transport errors never expose response text or secret URLs', async () => {
  for (const [fetch, code] of [
    [async () => ({ ok: false, json() { assert.fail('Error response body must not be read'); } }), 'TELEGRAM_HTTP_ERROR'],
    [async () => ({ ok: true, json: async () => { throw new Error('backend-private ' + secretUrl); } }), 'TELEGRAM_JSON_ERROR'],
    [async () => { throw new Error('backend-private ' + secretUrl); }, 'TELEGRAM_NETWORK_ERROR'],
  ]) {
    const h = harness(fetch);
    await assert.rejects(h.fetchJson(secretUrl), error => assertSafe(error, code));
    assert.equal(h.jobs.size, 0);
  }
});

test('File chunks are preserved exactly at the configured size boundary', async () => {
  const file = stream([Uint8Array.from([0, 255]), Uint8Array.from([1, 2, 128])]);
  const h = harness(async () => ({ ok: true, body: file.body }));
  const bytes = await h.fetchBytes(secretUrl, { method: 'GET' }, 30000, 5);
  assert.deepEqual(bytes, Buffer.from([0, 255, 1, 2, 128]));
  assert.equal(h.jobs.size, 0);
});

test('Oversized downloads stop at the first excess chunk and cancel the source', async () => {
  const file = stream([Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5, 6]), Uint8Array.from([7])]);
  const h = harness(async () => ({ ok: true, body: file.body }));
  await assert.rejects(h.fetchBytes(secretUrl, {}, 30000, 5), error => assertSafe(error, 'TELEGRAM_BODY_TOO_LARGE'));
  assert.equal(file.state.reads, 2);
  assert.equal(file.state.cancelled, 1);
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(h.jobs.size, 0);
});

test('Oversize cancellation reaches a native stream before its reader lock is released', async () => {
  let cancelled = 0;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2, 3]));
      controller.enqueue(Uint8Array.from([4, 5, 6]));
    },
    cancel() { cancelled++; },
  });
  const h = harness(async () => ({ ok: true, body }));
  await assert.rejects(h.fetchBytes(secretUrl, {}, 30000, 5), error => assertSafe(error, 'TELEGRAM_BODY_TOO_LARGE'));
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('A file body that stops producing chunks times out even when cancellation is ignored', async () => {
  const file = stream([Uint8Array.from([1, 2])], { hangs: true });
  const h = harness(async () => ({ ok: true, body: file.body }));
  const pending = h.fetchBytes(secretUrl);
  const rejection = assert.rejects(pending, error => assertSafe(error, 'TELEGRAM_TIMEOUT'));
  await flush();
  assert.equal(file.state.reads, 2);
  assert.equal([...h.jobs.values()][0].delay, 30000);
  h.expire();
  await rejection;
  assert.ok(file.state.cancelled >= 1);
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(h.jobs.size, 0);
});

test('File stream failures return safe errors and release the deadline', async () => {
  const file = stream([], { fails: true });
  const h = harness(async () => ({ ok: true, body: file.body }));
  await assert.rejects(h.fetchBytes(secretUrl), error => assertSafe(error, 'TELEGRAM_NETWORK_ERROR'));
  assert.equal(h.jobs.size, 0);
});

test('HTTP 429 reads only safe numeric retry metadata without exposing Telegram descriptions', async () => {
  const bytes = Buffer.from(JSON.stringify({ ok: false, error_code: 429, description: secretUrl, parameters: { retry_after: 3 } }));
  const body = stream([bytes]);
  const h = harness(async () => ({ ok: false, status: 429, body: body.body }));
  await assert.rejects(h.fetchJson(secretUrl), error => {
    assertSafe(error, 'TELEGRAM_HTTP_ERROR');
    assert.equal(error.status, 429);
    assert.equal(error.errorCode, 429);
    assert.equal(error.retryAfter, 3);
    return true;
  });
  assert.equal(h.jobs.size, 0);
});

test('Telegram API 429 in an HTTP 200 response uses the same safe retry metadata', async () => {
  const h = harness(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error_code: 429, description: secretUrl, parameters: { retry_after: 2 } }) }));
  await assert.rejects(h.fetchJson(secretUrl), error => {
    assertSafe(error, 'TELEGRAM_HTTP_ERROR');
    assert.equal(error.status, 200);
    assert.equal(error.errorCode, 429);
    assert.equal(error.retryAfter, 2);
    return true;
  });
});

test('rate-limit error body stalls remain subject to the full request deadline', async () => {
  const body = stream([], { hangs: true });
  const h = harness(async () => ({ ok: false, status: 429, body: body.body }));
  const failure = assert.rejects(h.fetchJson(secretUrl), error => assertSafe(error, 'TELEGRAM_TIMEOUT'));
  await flush(); h.expire(); await failure;
  assert.ok(body.state.cancelled >= 1);
  assert.equal(h.jobs.size, 0);
});

test('oversized or malformed 429 responses cannot trigger a retry', async () => {
  for (const chunks of [[Buffer.alloc(65537, 65)], [Buffer.from('not-json ' + secretUrl)]]) {
    const body = stream(chunks);
    const h = harness(async () => ({ ok: false, status: 429, body: body.body }));
    await assert.rejects(h.fetchJson(secretUrl), error => {
      assertSafe(error, 'TELEGRAM_HTTP_ERROR');
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, undefined);
      return true;
    });
    assert.equal(h.jobs.size, 0);
  }
});

test('invalid retry_after is ignored and unrelated HTTP failures retain their status without reading bodies', async () => {
  for (const retry_after of [0, -1, '3', Infinity, 1e308]) {
    const h = harness(async () => ({ ok: false, status: 429, json: async () => ({ error_code: 429, parameters: { retry_after } }) }));
    await assert.rejects(h.fetchJson(secretUrl), error => error.status === 429 && error.retryAfter === undefined);
  }
  const h = harness(async () => ({ ok: false, status: 503, json() { assert.fail('Do not read an unrelated error body'); } }));
  await assert.rejects(h.fetchJson(secretUrl), error => error.status === 503 && error.retryAfter === undefined && assertSafe(error, 'TELEGRAM_HTTP_ERROR'));
});

test('successful streamed JSON is bounded and parsed inside the original deadline', async () => {
  const ok = stream([Buffer.from('{"ok":true,"result":'), Buffer.from('[]}')]);
  const h = harness(async () => ({ ok: true, body: ok.body }));
  const result = await h.fetchJson(secretUrl);
  assert.equal(result.ok, true);
  assert.equal(result.result.length, 0);
  const excessive = stream([Buffer.alloc(4 * 1024 * 1024 + 1, 65)]);
  const limited = harness(async () => ({ ok: true, body: excessive.body }));
  await assert.rejects(limited.fetchJson(secretUrl), error => assertSafe(error, 'TELEGRAM_BODY_TOO_LARGE'));
  assert.equal(excessive.state.cancelled, 1);
});

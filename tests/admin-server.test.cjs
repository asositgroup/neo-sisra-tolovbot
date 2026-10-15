'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { makeAccount, createAuth, readAccount } = require('../admin-auth.cjs');
const { createAdminServer } = require('../admin-server.cjs');
const { provision } = require('../scripts/setup-admin.cjs');
let account;
const password = 'Only-for-offline-tests-12345';
// Raw HTTP preserves the proxy's public Host header; fetch may rewrite it.
const fetch = (url, options = {}) => new Promise((resolve, reject) => {
  const request = http.request(url, { method: options.method || 'GET', headers: options.headers }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
  });
  request.on('error', reject);
  request.end(options.body);
});
before(async () => { account = await makeAccount(password); });

test('password is salted, session expires, wrong login is throttled, and logout revokes access', async () => {
  assert.notEqual(account.hash, password);
  assert.notEqual((await makeAccount(password)).hash, account.hash);
  let now = 0;
  const auth = createAuth({ account, now: () => now, sessionMs: 100, maxAttempts: 2, windowMs: 200 });
  await assert.rejects(auth.login('someone-else', password, 'a'), { statusCode: 401 });
  await assert.rejects(auth.login('neo-admin', 'wrong', 'a'), { statusCode: 401 });
  await assert.rejects(auth.login('neo-admin', password, 'a'), { statusCode: 429 });
  now = 201;
  const first = await auth.login('neo-admin', password, 'a');
  assert.equal(auth.get(first.token).username, 'neo-admin');
  auth.logout(first.token);
  assert.equal(auth.get(first.token), undefined);
  const second = await auth.login('neo-admin', password, 'a');
  now += 101;
  assert.equal(auth.get(second.token), undefined);
});

test('setup never overwrites credentials implicitly and rotation invalidates old password', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-admin-account-'));
  try {
    const output = path.join(temp, 'access.txt');
    const first = await provision({ dataDir: temp, output });
    const saved = readAccount(temp);
    const access = fs.readFileSync(output, 'utf8');
    assert.equal(first.username, 'neo-admin');
    assert.match(access, /Parol: [A-Za-z0-9_-]{32}/);
    assert.ok(!JSON.stringify(saved).includes(access.match(/Parol: (\S+)/)[1]));
    await assert.rejects(provision({ dataDir: temp, output: path.join(temp, 'second.txt') }), /mavjud/);
    assert.deepEqual(readAccount(temp), saved);
    const nextOutput = path.join(temp, 'rotated.txt');
    await provision({ dataDir: temp, output: nextOutput, rotate: true });
    assert.notEqual(readAccount(temp).hash, saved.hash);
    const refreshed = createAuth({ account: readAccount(temp) });
    await assert.rejects(refreshed.login('neo-admin', access.match(/Parol: (\S+)/)[1], 'rotation'), { statusCode: 401 });
    assert.equal((await refreshed.login('neo-admin', fs.readFileSync(nextOutput, 'utf8').match(/Parol: (\S+)/)[1], 'rotation')).username, 'neo-admin');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('HTTP admin rejects anonymous, cross-origin and CSRF writes; serves bundled UI and logs out', async () => {
  let creates = 0;
  const fakeBot = {
    getAdminDashboard: () => ({ audienceCount: 12, job: null, history: [] }),
    createAdminBroadcast: input => { creates++; return { id: 'abc', text: input.text, status: 'running' }; },
    resumeAdminBroadcast: id => ({ id, status: 'running' }),
    cancelAdminBroadcast: id => ({ id, status: 'cancelled' }),
  };
  const origin = 'http://127.0.0.1:8787';
  const panel = createAdminServer({ bot: fakeBot, origin, port: 0, account, assets: { '/index.html': { contentType: 'text/html', body: Buffer.from('<!doctype html><title>Neo Sisra</title>').toString('base64') } } });
  const address = await panel.start();
  const base = `http://127.0.0.1:${address.port}`;
  const request = (pathname, options = {}) => fetch(base + '/api/admin/' + pathname, { ...options, headers: { host: '127.0.0.1:8787', ...options.headers } });
  const post = (pathname, input, headers = {}) => request(pathname, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
  try {
    assert.equal((await request('dashboard')).status, 401);
    assert.equal((await post('login', { username: 'neo-admin', password }, { origin: 'https://other.invalid' })).status, 403);
    assert.equal((await post('login', { username: 'neo-admin', password: 'bad' })).status, 401);
    const login = await post('login', { username: 'neo-admin', password });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    const session = await login.json();
    assert.equal(session.username, 'neo-admin');
    assert.ok(!JSON.stringify(session).includes(password));
    const authHeaders = { cookie, 'x-csrf-token': session.csrfToken };
    assert.equal((await request('dashboard', { headers: { cookie } })).status, 200);
    assert.equal((await post('broadcasts', { text: 'test', requestId: 'test-request-123456' }, { cookie })).status, 403);
    assert.equal(creates, 0);
    assert.equal((await post('broadcasts', { text: 'test' }, { ...authHeaders, origin: 'https://other.invalid' })).status, 403);
    assert.equal((await post('broadcasts', { text: 'test', requestId: 'test-request-123456' }, authHeaders)).status, 202);
    assert.equal(creates, 1);
    assert.equal((await post('broadcasts/abc/cancel', {}, authHeaders)).status, 200);
    assert.equal((await post('broadcasts/abc/resume', {}, authHeaders)).status, 200);
    assert.equal((await post('broadcasts', { text: 'x'.repeat(33000) }, authHeaders)).status, 413);
    const ui = await fetch(base, { headers: { host: '127.0.0.1:8787' } });
    assert.equal(ui.status, 200); assert.match(await ui.text(), /Neo Sisra/);
    assert.match(ui.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await fetch(base + '/.env', { headers: { host: '127.0.0.1:8787' } })).status, 404);
    assert.equal((await fetch(base, { headers: { host: 'evil.invalid' } })).status, 403);
    assert.equal((await post('logout', {}, authHeaders)).status, 200);
    assert.equal((await request('session', { headers: { cookie } })).status, 401);
  } finally { await panel.close(); }
});

test('public HTTP origins and malformed configuration fail closed', () => {
  for (const origin of ['http://admin.example.com', 'https://admin.example.com/', 'https://user:pass@admin.example.com', undefined]) {
    assert.throws(() => createAdminServer({ origin, account, assets: {} }), /ADMIN_ORIGIN/);
  }
});

test('HTTPS deployment uses Secure cookies', async () => {
  const panel = createAdminServer({ origin: 'https://admin.example.com', port: 0, account, assets: {}, bot: {} });
  const address = await panel.start();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/admin/login`, {
      method: 'POST', headers: { host: 'admin.example.com', origin: 'https://admin.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'neo-admin', password }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /; Secure/);
  } finally { await panel.close(); }
});

test('proxy rate limiting separates verified client IPs only with explicit loopback proxy trust', async () => {
  for (const trustProxy of [false, true]) {
    const panel = createAdminServer({ origin: 'https://admin.example.com', port: 0, account, assets: {}, bot: {}, trustProxy, authOptions: { maxAttempts: 1 } });
    const address = await panel.start();
    const login = (forwarded, value) => fetch(`http://127.0.0.1:${address.port}/api/admin/login`, {
      method: 'POST', headers: { host: 'admin.example.com', origin: 'https://admin.example.com', 'content-type': 'application/json', 'x-forwarded-for': forwarded },
      body: JSON.stringify({ username: 'neo-admin', password: value }),
    });
    try {
      assert.equal((await login('192.0.2.1', 'bad')).status, 401);
      assert.equal((await login('192.0.2.1', password)).status, 429);
      assert.equal((await login('192.0.2.2', password)).status, trustProxy ? 200 : 429);
      if (trustProxy) {
        assert.equal((await login('192.0.2.3, 192.0.2.4', 'bad')).status, 401);
        assert.equal((await login('192.0.2.5, 192.0.2.6', password)).status, 429);
      }
    } finally { await panel.close(); }
  }
});

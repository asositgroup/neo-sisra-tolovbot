'use strict';

const http = require('node:http');
const { isIP } = require('node:net');
const { createAuth, readAccount } = require('./admin-auth.cjs');
const COOKIE = 'neo_admin_session';
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });

function createAdminServer({ bot, dataDir, origin, host = '127.0.0.1', port = 8787, account, assets, authOptions, trustProxy = false } = {}) {
  let publicUrl;
  try { publicUrl = new URL(origin); } catch { throw new Error('ADMIN_ORIGIN toʻliq manzil boʻlishi kerak.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname);
  if (publicUrl.origin !== origin || publicUrl.username || publicUrl.password || !['http:', 'https:'].includes(publicUrl.protocol) || (!local && publicUrl.protocol !== 'https:')) {
    throw new Error('ADMIN_ORIGIN HTTPS manzil boʻlishi kerak (lokalda HTTP mumkin).');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ADMIN_PORT notoʻgʻri.');
  const auth = createAuth({ ...authOptions, account: account || readAccount(dataDir) });
  const staticAssets = assets || require('./admin-assets.cjs');
  const secure = publicUrl.protocol === 'https:';
  let closing = false;
  function cookie(value, age) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  }
  function headers(response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  }
  async function body(request) {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw fail(415, 'JSON yuborilishi kerak.');
    if (Number(request.headers['content-length']) > 32768) throw fail(413, 'Soʻrov hajmi juda katta.');
    const parts = []; let size = 0;
    for await (const part of request) {
      size += part.length;
      if (size > 32768) throw fail(413, 'Soʻrov hajmi juda katta.');
      parts.push(part);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw fail(400, 'Soʻrov notoʻgʻri.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'Soʻrov notoʻgʻri.');
    return value;
  }
  const server = http.createServer(async (request, response) => {
    headers(response);
    try {
      if (closing) throw fail(503, 'Server qayta ishga tushmoqda. Birozdan soʻng qayta urinib koʻring.');
      if (request.headers.host !== publicUrl.host) throw fail(403, 'Manzil ruxsat etilmagan.');
      const pathname = new URL(request.url, publicUrl.origin).pathname;
      const mutating = !['GET', 'HEAD'].includes(request.method);
      if (mutating && (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site')) throw fail(403, 'Soʻrov manbasi ruxsat etilmagan.');
      if (pathname.startsWith('/api/admin/')) {
        const token = String(request.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
        if (pathname === '/api/admin/login' && request.method === 'POST') {
          const input = await body(request);
          const peer = request.socket.remoteAddress;
          const forwarded = request.headers['x-forwarded-for'];
          const loopbackPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
          const address = trustProxy && loopbackPeer && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : peer;
          const session = await auth.login(input.username, input.password, address);
          response.setHeader('Set-Cookie', cookie(session.token, Math.floor(auth.sessionMs / 1000)));
          return json(response, 200, { username: session.username, csrfToken: session.csrfToken });
        }
        const session = auth.get(token);
        if (!session) throw fail(401, 'Davom etish uchun tizimga kiring.');
        if (mutating && request.headers['x-csrf-token'] !== session.csrfToken) throw fail(403, 'Sahifani yangilab qayta urinib koʻring.');
        if (pathname === '/api/admin/session' && request.method === 'GET') return json(response, 200, { username: session.username, csrfToken: session.csrfToken });
        if (pathname === '/api/admin/logout' && request.method === 'POST') {
          auth.logout(token); response.setHeader('Set-Cookie', cookie('', 0));
          return json(response, 200, { ok: true });
        }
        if (pathname === '/api/admin/dashboard' && request.method === 'GET') return json(response, 200, bot.getAdminDashboard());
        if (pathname === '/api/admin/broadcasts' && request.method === 'POST') return json(response, 202, { job: bot.createAdminBroadcast(await body(request)) });
        const action = pathname.match(/^\/api\/admin\/broadcasts\/([A-Za-z0-9_-]{1,128})\/(resume|cancel)$/);
        if (action && request.method === 'POST') {
          await body(request);
          const job = action[2] === 'resume' ? bot.resumeAdminBroadcast(action[1]) : bot.cancelAdminBroadcast(action[1]);
          return json(response, 200, { job });
        }
        throw fail(404, 'Soʻralgan amal topilmadi.');
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw fail(405, 'Usul ruxsat etilmagan.');
      const name = pathname === '/' ? '/index.html' : pathname;
      const asset = Object.hasOwn(staticAssets, name) ? staticAssets[name] : null;
      if (!asset) throw fail(404, 'Sahifa topilmadi.');
      const bytes = Buffer.from(asset.body, 'base64');
      if (name.startsWith('/assets/')) response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      response.writeHead(200, { 'Content-Type': asset.contentType, 'Content-Length': bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = [400,401,403,404,405,409,413,415,429,503].includes(error.statusCode) ? error.statusCode : 500;
      json(response, status, { error: status === 500 ? 'Serverda xatolik yuz berdi. Birozdan soʻng qayta urinib koʻring.' : error.message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 15000;
  server.maxRequestsPerSocket = 100;
  return {
    server,
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); });
    }),
    close: () => new Promise((resolve, reject) => {
      closing = true;
      if (!server.listening) return resolve();
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }),
  };
}

module.exports = { createAdminServer };

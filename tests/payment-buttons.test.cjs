'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.BOT_TOKEN = '123456:OFFLINE_PAYMENT_BUTTONS';
process.env.GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/OFFLINE_BUTTONS/exec';
const { createBot } = require('../bot.js');
const token = '123456:OFFLINE_PAYMENT_BUTTONS';
const endpoint = 'https://script.google.com/macros/s/OFFLINE_BUTTONS/exec';
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64');
const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const message = (id, text = '', extra = {}) => ({ chat: { id, type: 'private' }, from: { id }, message_id: 1, text, ...extra });
const callback = (id, data, extra = {}) => ({ id: 'cb-' + id, from: { id }, message: { chat: { id, type: 'private' } }, data, ...extra });

function fixture(t, settings = {}, hook) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-payment-buttons-'));
  const imagePath = path.join(dataDir, 'payment.png');
  fs.writeFileSync(imagePath, imageBytes);
  const pdfPath = path.join(dataDir, 'paynet-qr.pdf');
  fs.writeFileSync(pdfPath, pdfBytes);
  const config = {
    BOT_TOKEN: token, GOOGLE_SCRIPT_URL: endpoint, PRIMARY_ADMIN_IDS: '42', EXTRA_ADMIN_IDS: '',
    NOTIFY_CHAT_ID: '', OFFER_VERSION: 'offline-payment-v1', OFFER_DOC_PATH: '', WELCOME_IMAGE_PATH: '',
    PAYMENT_IMAGE_PATH: '', PAYME_URL: '', CLICK_URL: '', PAYNET_URL: '', PAYNET_QR_PATH: '', CONTACT_ADMIN: '',
    CONTACT_PHONE: 'XXX', SERVICE_PRICE: 'XXX', UZCARD_NUMBER: 'XXXX XXXX XXXX XXXX',
    UZCARD_HOLDER: 'XXX', VISA_NUMBER: 'XXXX XXXX XXXX XXXX', VISA_HOLDER: 'XXX', ...settings,
  };
  if (config.PAYMENT_IMAGE_PATH === true) config.PAYMENT_IMAGE_PATH = imagePath;
  if (config.PAYNET_QR_PATH === true) config.PAYNET_QR_PATH = pdfPath;
  const previousEnv = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
  Object.assign(process.env, config);
  const requests = [], originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    assert.ok(url === endpoint || url.startsWith('https://api.telegram.org/bot' + token + '/') ||
      url.startsWith('https://api.telegram.org/file/bot' + token + '/'), 'Only synthetic test endpoints may be used');
    const body = options.body instanceof FormData ? Object.fromEntries(options.body) : options.body ? JSON.parse(options.body) : {};
    const request = { url, method: url.slice(url.lastIndexOf('/') + 1), body };
    requests.push(request);
    if (hook) await hook(request);
    if (url === endpoint) return Response.json({ result: 'success', fileUrl: 'https://drive.google.com/file/d/OFFLINE_PAYMENT_RECEIPT/view' });
    if (url.includes('/file/bot')) return new Response(Buffer.from([255, 216, 255, 1, 2, 3]));
    return Response.json({ ok: true, result: request.method === 'getFile' ? { file_path: 'photos/offline.jpg', file_size: 6 } : { message_id: requests.length } });
  };
  const bot = createBot({ dataDir, telegramQueue: { run: (_options, fn) => Promise.resolve().then(fn), idle: () => Promise.resolve() } });
  t.after(async () => {
    try { await bot.waitForBackground(); bot.closeStore(); }
    finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  const db = bot.loadDb();
  return { bot, db, requests, pdfPath,
    googleRequests: () => requests.filter(request => request.url === endpoint),
    replies: () => requests.filter(request => ['sendPhoto', 'sendMessage'].includes(request.method)),
    async fill(id = 101) {
      await bot.handleMessage(message(id, '/start'), db);
      await bot.handleMessage(message(id, 'Offline Person'), db);
      await bot.handleMessage(message(id, '+998901234567'), db);
    },
    async consent(id = 101) {
      await bot.handleCallback(callback(id, 'offer:yes'), db);
      await bot.waitForBackground();
    },
  };
}

function markup(request) {
  const value = request.body.reply_markup;
  return typeof value === 'string' ? JSON.parse(value) : value;
}
function buttons(request) { return markup(request).inline_keyboard.flat(); }

test('consent shows one payment photo with complete caption and this business’s configured provider links', async t => {
  const urls = {
    PAYME_URL: 'https://checkout.payme.uz/OFFLINE_MERCHANT',
    CLICK_URL: 'https://my.click.uz/services/pay?merchant_id=OFFLINE_ONLY',
    PAYNET_URL: 'https://paynet.uz/OFFLINE_MERCHANT',
  };
  const f = fixture(t, { PAYMENT_IMAGE_PATH: true, CONTACT_ADMIN: '@offline_manager', ...urls });
  await f.fill();
  f.requests.length = 0;
  await f.consent();
  assert.equal(f.replies().length, 1);
  const reply = f.replies()[0];
  assert.equal(reply.method, 'sendPhoto');
  assert.deepEqual(Buffer.from(await reply.body.photo.arrayBuffer()), imageBytes);
  assert.equal(reply.body.caption, f.bot.paymentText());
  assert.ok(reply.body.caption.length <= 1024);
  assert.equal(reply.body.parse_mode, 'HTML');
  assert.deepEqual(buttons(reply).map(button => button.url), [...Object.values(urls), 'https://t.me/offline_manager']);
  assert.ok(markup(reply).inline_keyboard.every(row => row.length === 1));
  assert.equal(f.googleRequests().length, 1);
  assert.equal(f.googleRequests()[0].body.Oferta, 'Roziman');
  assert.equal(f.db.registrations.length, 1);
  assert.equal(f.db.users['101'].step, 'receipt');
});

test('missing links are hidden while old callbacks retain honest alerts without state or Google changes', async t => {
  const f = fixture(t);
  await f.fill(); await f.consent();
  const reply = f.replies().at(-1);
  assert.equal(reply.method, 'sendMessage');
  assert.deepEqual(buttons(reply).map(button => button.callback_data), ['payment:contact']);
  const before = JSON.stringify(f.db);
  f.requests.length = 0;
  for (const provider of ['payme', 'click', 'paynet', 'contact']) {
    await f.bot.handleCallback(callback(101, 'payment:' + provider), f.db);
    const alert = f.requests.at(-1);
    assert.equal(alert.method, 'answerCallbackQuery');
    assert.equal(alert.body.show_alert, true);
    assert.match(alert.body.text, /hali berilmagan/);
    assert.doesNotMatch(alert.body.text, /toʻlandi|muvaffaqiyatli|tayyorlanmoqda/i);
  }
  assert.equal(f.replies().length, 0);
  assert.equal(f.googleRequests().length, 0);
  assert.equal(JSON.stringify(f.db), before);
});

test('callback actions require current consent and the profile owner’s private chat', async t => {
  const f = fixture(t);
  await f.fill();
  for (const action of ['payme', 'click', 'paynet', 'paynet_qr', 'contact', 'menu', 'status']) {
    const before = JSON.stringify(f.db);
    f.requests.length = 0;
    await f.bot.handleCallback(callback(101, 'payment:' + action), f.db);
    assert.equal(f.requests.length, 1);
    assert.match(f.requests[0].body.text, /rozilik/);
    assert.equal(JSON.stringify(f.db), before);
  }
  assert.equal(f.googleRequests().length, 0);
  await f.consent();
  const valid = { ...f.db.users['101'] };
  const scenarios = [
    { event: callback(101, 'payment:menu', { from: { id: 42 } }) },
    { event: callback(101, 'payment:status', { message: { chat: { id: 101, type: 'group' } } }) },
    { event: callback(101, 'payment:payme'), profile: { ...valid, offerVersion: 'expired-v0' } },
    { event: callback(101, 'payment:payme'), profile: { ...valid, step: 'name' } },
    { event: callback(999, 'payment:contact') },
  ];
  for (const scenario of scenarios) {
    f.db.users['101'] = scenario.profile || valid;
    const before = JSON.stringify(f.db);
    f.requests.length = 0;
    await f.bot.handleCallback(scenario.event, f.db);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].method, 'answerCallbackQuery');
    assert.equal(f.requests[0].body.show_alert, true);
    assert.match(f.requests[0].body.text, /rozilik/);
    assert.equal(JSON.stringify(f.db), before);
  }
});

test('payment command and repeated menu/status callbacks reuse registration without Google writes', async t => {
  const f = fixture(t);
  await f.fill();
  await f.bot.handleMessage(message(101, '/payment'), f.db);
  assert.equal(f.db.users['101'].step, 'offer');
  assert.equal(f.googleRequests().length, 0);
  await f.consent();
  const before = JSON.stringify(f.db);
  f.requests.length = 0;
  for (let i = 0; i < 3; i++) {
    await f.bot.handleMessage(message(101, '/payment'), f.db);
    await f.bot.handleCallback(callback(101, 'payment:menu'), f.db);
    await f.bot.handleCallback(callback(101, 'payment:status'), f.db);
  }
  assert.equal(f.googleRequests().length, 0);
  assert.equal(JSON.stringify(f.db), before);
  assert.equal(f.replies().filter(reply => reply.body.text === f.bot.paymentText()).length, 6);
  assert.equal(f.replies().filter(reply => reply.body.text === 'Hali chek yubormagansiz.').length, 3);
});

for (const [name, config] of Object.entries({
  'no image': {},
  'missing image': { PAYMENT_IMAGE_PATH: '__offline_file_does_not_exist__.png' },
  'long caption': { PAYMENT_IMAGE_PATH: true, UZCARD_HOLDER: 'LONG_HOLDER_'.repeat(100) },
})) {
  test('payment stays complete with usable buttons when ' + name, async t => {
    const f = fixture(t, config);
    await f.fill(); f.requests.length = 0; await f.consent();
    assert.equal(f.replies().length, 1);
    assert.equal(f.replies()[0].method, 'sendMessage');
    assert.equal(f.replies()[0].body.text, f.bot.paymentText());
    assert.equal(buttons(f.replies()[0]).length, 1);
  });
}

for (const [name, urls] of Object.entries({
  'plain HTTP': ['http://payme.uz/pay', 'http://click.uz/pay', 'http://paynet.uz/pay'],
  'lookalike host': ['https://payme.uz.example.com/pay', 'https://evilclick.uz/pay', 'https://paynet.uz.evil.com/pay'],
  'credentials': ['https://account:secret@payme.uz/pay', 'https://account@click.uz/pay', 'https://account@paynet.uz/pay'],
  'wrong provider': ['https://click.uz/pay', 'https://paynet.uz/pay', 'https://payme.uz/pay'],
  'nonstandard port': ['https://payme.uz:8443/pay', 'https://click.uz:8443/pay', 'https://paynet.uz:8443/pay'],
})) {
  test('rejects ' + name + ' payment links without exposing their configuration', async t => {
    const f = fixture(t, { PAYME_URL: urls[0], CLICK_URL: urls[1], PAYNET_URL: urls[2], CONTACT_ADMIN: 'https://t.me/+OFFLINE_CHANNEL_INVITE' });
    await f.fill(); f.requests.length = 0; await f.consent();
    assert.ok(buttons(f.replies()[0]).every(button => button.callback_data && !button.url));
    await f.bot.handleCallback(callback(101, 'payment:payme'), f.db);
    assert.match(f.requests.at(-1).body.text, /hali berilmagan/);
    const serialized = JSON.stringify(f.requests);
    for (const url of urls) assert.ok(!serialized.includes(url));
    assert.doesNotMatch(serialized, /account:secret|OFFLINE_CHANNEL_INVITE/);
  });
}

test('manager HTTPS username is a contact button', async t => {
  const f = fixture(t, { CONTACT_ADMIN: 'https://t.me/offline_manager/' });
  await f.fill(); await f.consent();
  assert.equal(buttons(f.replies().at(-1)).at(-1).url, 'https://t.me/offline_manager');
});

test('missing manager username falls back to the configured telephone without treating it as a URL', async t => {
  const f = fixture(t, { CONTACT_PHONE: '+998901234567' });
  await f.fill(); await f.consent();
  assert.equal(buttons(f.replies().at(-1)).at(-1).callback_data, 'payment:contact');
  await f.bot.handleCallback(callback(101, 'payment:contact'), f.db);
  assert.equal(f.requests.at(-1).body.text, 'Menejer bilan bogʻlanish: +998901234567');
  assert.equal(f.requests.at(-1).body.show_alert, true);
});

test('receipt acknowledgment keeps payment and status controls while Google delivery remains pending', { timeout: 5000 }, async t => {
  let releaseUpload, uploadStarted;
  const gate = new Promise(resolve => { releaseUpload = resolve; });
  const started = new Promise(resolve => { uploadStarted = resolve; });
  const f = fixture(t, { PAYNET_QR_PATH: true }, async request => {
    if (request.url === endpoint && request.body.imageUpload === 'true') { uploadStarted(); await gate; }
  });
  const photo = { photo: [{ file_id: 'OFFLINE_PHOTO', file_unique_id: 'OFFLINE_UNIQUE', file_size: 6 }] };
  await f.fill(); await f.consent(); f.requests.length = 0;
  try {
    await f.bot.handleMessage(message(101, '', photo), f.db);
    await started;
    const ack = f.replies().find(reply => reply.body.text?.includes('Chekingiz qabul qilindi'));
    assert.ok(ack, 'Acknowledgment must not wait for Google');
    assert.deepEqual(buttons(ack).map(button => button.callback_data), ['payment:paynet_qr', 'payment:contact', 'payment:menu', 'payment:status']);
    assert.equal(f.db.users['101'].step, 'done');
    assert.equal(f.db.payments[0].status, 'sending');
    await f.bot.handleCallback(callback(101, 'payment:status'), f.db);
    assert.match(f.replies().at(-1).body.text, /Chekingiz yuborilyapti/);
    await f.bot.handleCallback(callback(101, 'payment:menu'), f.db);
    assert.equal(f.db.users['101'].step, 'done');
    assert.equal(f.db.registrations.length, 1);
    assert.equal(f.db.payments.length, 1);
  } finally { releaseUpload(); }
  await f.bot.waitForBackground();
  assert.equal(f.db.payments[0].status, 'sent');
  assert.ok(buttons(f.replies().at(-1)).some(button => button.callback_data === 'payment:status'));
  await f.bot.handleMessage(message(101, '', photo), f.db);
  assert.ok(buttons(f.replies().at(-1)).some(button => button.callback_data === 'payment:status'));
  assert.equal(f.googleRequests().length, 1, 'Menus and duplicate receipts must not upload again');
});

test('Paynet PDF-only button sends the original document after callback acknowledgment without state or Google writes', async t => {
  const f = fixture(t, { PAYNET_QR_PATH: true, SERVICE_PRICE: '4 400 000 soʻm' });
  await f.fill(); await f.consent();
  assert.deepEqual(buttons(f.replies().at(-1)), [
    { text: '💳 Paynet orqali toʻlash', callback_data: 'payment:paynet_qr' },
    { text: '👨‍💼 Menejer bilan bogʻlanish', callback_data: 'payment:contact' },
  ]);
  const before = JSON.stringify(f.db);
  for (const action of ['paynet_qr', 'paynet']) {
    f.requests.length = 0;
    await f.bot.handleCallback(callback(101, 'payment:' + action), f.db);
    assert.deepEqual(f.requests.map(request => request.method), ['answerCallbackQuery', 'sendDocument']);
    assert.notEqual(f.requests[0].body.show_alert, true);
    const reply = f.requests[1];
    assert.equal(reply.body.chat_id, '101');
    assert.equal(reply.body.document.name, 'paynet-qr.pdf');
    assert.equal(reply.body.document.type, 'application/pdf');
    assert.deepEqual(Buffer.from(await reply.body.document.arrayBuffer()), pdfBytes);
    assert.match(reply.body.caption, /4 400 000 soʻm/);
    assert.match(reply.body.caption, /qabul qiluvchi va summani tekshiring/);
    assert.match(reply.body.caption, /chekni shu botga yuboring/);
    assert.doesNotMatch(reply.body.caption, /toʻlov tasdiqlandi/i);
    assert.equal(f.googleRequests().length, 0);
    assert.equal(JSON.stringify(f.db), before);
  }
});

test('configured Paynet checkout and PDF appear separately while unavailable providers stay hidden', async t => {
  const url = 'https://app.paynet.uz/OFFLINE_MERCHANT';
  const f = fixture(t, { PAYNET_QR_PATH: true, PAYNET_URL: url });
  await f.fill(); await f.consent();
  assert.deepEqual(buttons(f.replies().at(-1)).slice(0, 2), [
    { text: '💳 Paynet orqali toʻlash', url },
    { text: '📄 Paynet QR-kodi', callback_data: 'payment:paynet_qr' },
  ]);
  assert.equal(buttons(f.replies().at(-1)).length, 3);
  f.requests.length = 0;
  await f.bot.handleCallback(callback(101, 'payment:paynet'), f.db);
  assert.equal(f.requests.at(-1).method, 'sendDocument', 'A stale old Paynet callback should still open the configured PDF');
});

test('Paynet checkout works without a PDF and old callbacks reopen the current payment menu', async t => {
  const url = 'https://app.paynet.uz/OFFLINE_MERCHANT';
  const f = fixture(t, { PAYNET_URL: url });
  await f.fill(); await f.consent();
  assert.deepEqual(buttons(f.replies().at(-1)).map(button => button.url || button.callback_data), [url, 'payment:contact']);
  f.requests.length = 0;
  await f.bot.handleCallback(callback(101, 'payment:paynet'), f.db);
  assert.deepEqual(f.requests.map(request => request.method), ['answerCallbackQuery', 'sendMessage']);
  assert.equal(buttons(f.replies().at(-1))[0].url, url);
  assert.equal(f.googleRequests().length, 0);
});

for (const scenario of ['missing', 'directory', 'invalid header', 'unreadable']) {
  test('Paynet PDF ' + scenario + ' is hidden and its stale callback reports the problem without writing state', async t => {
    const f = fixture(t, { PAYNET_QR_PATH: true });
    await f.fill(); await f.consent();
    if (scenario === 'missing') fs.unlinkSync(f.pdfPath);
    else if (scenario === 'directory') { fs.unlinkSync(f.pdfPath); fs.mkdirSync(f.pdfPath); }
    else if (scenario === 'invalid header') fs.writeFileSync(f.pdfPath, 'not a PDF file');
    const originalOpen = fs.openSync;
    if (scenario === 'unreadable') fs.openSync = (filePath, ...rest) => {
      if (filePath === f.pdfPath) throw Object.assign(new Error('Synthetic permission denied'), { code: 'EACCES' });
      return originalOpen(filePath, ...rest);
    };
    try {
      const before = JSON.stringify(f.db);
      f.requests.length = 0;
      await f.bot.handleMessage(message(101, '/payment'), f.db);
      assert.deepEqual(buttons(f.replies().at(-1)).map(button => button.callback_data), ['payment:contact']);
      f.requests.length = 0;
      for (const action of ['paynet_qr', 'paynet']) {
        await f.bot.handleCallback(callback(101, 'payment:' + action), f.db);
        assert.equal(f.requests.at(-1).method, 'answerCallbackQuery');
        assert.equal(f.requests.at(-1).body.show_alert, true);
        assert.match(f.requests.at(-1).body.text, /QR fayli hozir ochilmadi/);
      }
      assert.equal(f.googleRequests().length, 0);
      assert.equal(f.requests.some(request => request.method === 'sendDocument'), false);
      assert.equal(JSON.stringify(f.db), before);
    } finally { fs.openSync = originalOpen; }
  });
}

test('Paynet QR document requires the current consenting owner in a private chat', async t => {
  const f = fixture(t, { PAYNET_QR_PATH: true });
  await f.fill(); await f.consent();
  const valid = { ...f.db.users['101'] };
  for (const scenario of [
    { event: callback(101, 'payment:paynet_qr', { from: { id: 42 } }) },
    { event: callback(101, 'payment:paynet_qr', { message: { chat: { id: 101, type: 'group' } } }) },
    { event: callback(101, 'payment:paynet_qr'), profile: { ...valid, offerAccepted: false } },
    { event: callback(101, 'payment:paynet_qr'), profile: { ...valid, offerVersion: 'older-version' } },
    { event: callback(101, 'payment:paynet_qr'), profile: { ...valid, step: 'name' } },
    { event: callback(999, 'payment:paynet_qr') },
  ]) {
    f.db.users['101'] = scenario.profile || valid;
    const before = JSON.stringify(f.db);
    f.requests.length = 0;
    await f.bot.handleCallback(scenario.event, f.db);
    assert.deepEqual(f.requests.map(request => request.method), ['answerCallbackQuery']);
    assert.match(f.requests[0].body.text, /rozilik/);
    assert.equal(JSON.stringify(f.db), before);
  }
});

test('Paynet upload failure is acknowledged promptly and offers retry without changing state', async t => {
  const f = fixture(t, { PAYNET_QR_PATH: true }, request => {
    if (request.method === 'sendDocument') throw new Error('Synthetic upload failure');
  });
  await f.fill(); await f.consent();
  const before = JSON.stringify(f.db);
  f.requests.length = 0;
  const originalError = console.error;
  const errors = [];
  console.error = message => errors.push(message);
  try { await f.bot.handleCallback(callback(101, 'payment:paynet_qr'), f.db); }
  finally { console.error = originalError; }
  assert.deepEqual(f.requests.map(request => request.method), ['answerCallbackQuery', 'sendDocument', 'sendMessage']);
  assert.match(f.requests.at(-1).body.text, /yuborib boʻlmadi/);
  assert.match(f.requests.at(-1).body.text, /qayta bosing/);
  assert.equal(errors.length, 1);
  assert.equal(JSON.stringify(f.db), before);
  assert.equal(f.googleRequests().length, 0);
});

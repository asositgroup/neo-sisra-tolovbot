const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');

const BASE_DIR = __dirname;

function loadEnv() {
  const envPath = path.join(BASE_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    if (!process.env[key.trim()]) {
      process.env[key.trim()] = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

loadEnv();

function createBot(options = {}) {
const DATA_DIR = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(BASE_DIR, 'data'));
const EXPORT_PATH = path.join(DATA_DIR, 'neo-sisra-pay-export.xls');

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const GOOGLE_SCRIPT_URL = (process.env.GOOGLE_SCRIPT_URL || '').trim();
function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

const PRIMARY_ADMIN_IDS = splitCsv(process.env.PRIMARY_ADMIN_IDS || process.env.ADMIN_IDS);
const EXTRA_ADMIN_IDS = splitCsv(process.env.EXTRA_ADMIN_IDS);
const ADMIN_IDS = [...new Set([...PRIMARY_ADMIN_IDS, ...EXTRA_ADMIN_IDS])];
const { createGoogleDelivery, validateReceipt } = require('./google-delivery.cjs');
const { fetchJson, fetchBytes } = require('./telegram-http.cjs');
const { createStateStore } = require('./state-store.cjs');
const { createWorkQueue } = require('./work-queue.cjs');
const { createTelegramQueue } = require('./telegram-queue.cjs');
function setting(name, fallback, maximum) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(name+' notoʻgʻri sozlangan.');
  return value;
}
const updateWorkers = options.updateWorkers || setting('UPDATE_WORKERS', 100, 100);
const deliveryWorkers = options.deliveryWorkers || setting('DELIVERY_WORKERS', 4, 10);
const deliveryQueue = createWorkQueue({ concurrency: deliveryWorkers, maxPending: deliveryWorkers });
const telegramQueue = options.telegramQueue || createTelegramQueue({
  ratePerSecond: setting('TELEGRAM_MESSAGES_PER_SECOND', 28, 30),
  perChatMs: 1050, groupMs: 3100, concurrency: 16, maxPending: 500,
});
const google = options.google || createGoogleDelivery({ endpoint: GOOGLE_SCRIPT_URL });
let store = options.stateStore;
let storageFailure;
let backgroundStopping = false;
function storage() { return store ||= createStateStore({ dataDir: DATA_DIR, emptyDb }); }
function storageAction(fn) {
  if (storageFailure) throw storageFailure;
  try { return fn(); } catch (error) {
    storageFailure = Object.assign(new Error('Bot maʼlumotlarini saqlashda xatolik.'), { code: 'STATE_STORE_ERROR', cause: error });
    throw storageFailure;
  }
}
const WELCOME_IMAGE_PATH = process.env.WELCOME_IMAGE_PATH ? path.resolve(BASE_DIR, process.env.WELCOME_IMAGE_PATH) : '';
const PAYMENT_IMAGE_PATH = process.env.PAYMENT_IMAGE_PATH ? path.resolve(BASE_DIR, process.env.PAYMENT_IMAGE_PATH) : '';
const PAYNET_QR_PATH = process.env.PAYNET_QR_PATH ? path.resolve(BASE_DIR, process.env.PAYNET_QR_PATH) : '';
const OFFER_DOC_PATH = process.env.OFFER_DOC_PATH ? path.resolve(BASE_DIR, process.env.OFFER_DOC_PATH) : '';
const OFFER_VERSION = process.env.OFFER_VERSION || 'pending-2026-10-04';
const API = 'https://api.telegram.org/bot' + BOT_TOKEN;
const FILE_API = 'https://api.telegram.org/file/bot' + BOT_TOKEN;
const NOTIFY_CHAT_ID = (process.env.NOTIFY_CHAT_ID || '').trim();
const NOTIFY_REG_TOPIC = Number(process.env.NOTIFY_REG_TOPIC || 0);
const NOTIFY_PAY_TOPIC = Number(process.env.NOTIFY_PAY_TOPIC || 0);
const TELEGRAM_TIMEOUT_MS = 15000;
const TELEGRAM_FILE_TIMEOUT_MS = 30000;
const POLL_TIMEOUT_SECONDS = 25;
const POLL_FETCH_TIMEOUT_MS = 35000;
const SERVICE_NAME = 'Koreyaga talaba yuborish';
const CONTACT_PHONE = process.env.CONTACT_PHONE || 'XXX';
const CONTACT_ADMIN = process.env.CONTACT_ADMIN || '';
function paymentUrl(value, domain) {
  const candidate = String(value || '').trim();
  if (!/^https:\/\/[^\s\\]+$/i.test(candidate)) return '';
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    if (url.hostname !== domain && !url.hostname.endsWith('.' + domain)) return '';
    return url.href;
  } catch { return ''; }
}
function managerUrl(value) {
  const candidate = String(value || '').trim();
  const username = candidate.match(/^@([a-z][a-z0-9_]{4,31})$/i)?.[1]
    || candidate.match(/^https:\/\/t\.me\/([a-z][a-z0-9_]{4,31})\/?$/i)?.[1];
  return username ? 'https://t.me/' + username : '';
}
const PAYMENT_PROVIDERS = [
  { id: 'payme', name: 'Payme', url: paymentUrl(process.env.PAYME_URL, 'payme.uz') },
  { id: 'click', name: 'Click', url: paymentUrl(process.env.CLICK_URL, 'click.uz') },
  { id: 'paynet', name: 'Paynet', url: paymentUrl(process.env.PAYNET_URL, 'paynet.uz') },
];
const MANAGER_URL = managerUrl(CONTACT_ADMIN);
const SERVICE_PRICE = process.env.SERVICE_PRICE || 'XXX';
const REGULAR_SERVICE_PRICE = process.env.REGULAR_SERVICE_PRICE || 'XXX';
const PAYMENT_CARDS = [
  { bank: 'HUMO', number: process.env.HUMO_NUMBER || 'XXXX XXXX XXXX XXXX', holder: process.env.HUMO_HOLDER || 'XXX' },
  { bank: 'UZCARD', number: process.env.UZCARD_NUMBER || 'XXXX XXXX XXXX XXXX', holder: process.env.UZCARD_HOLDER || 'XXX' },
  { bank: 'Visa', number: process.env.VISA_NUMBER || 'XXXX XXXX XXXX XXXX', holder: process.env.VISA_HOLDER || 'XXX' },
];
const WELCOME_BUTTONS = ["💳 To'lov qilish uchun ro'yxatdan o'tish"];
const pendingTasks = new Set();
const registrationFlights = new Set();
const paymentFlights = new Set();
const queuedDeliveries = new Set();
function safeError(error) {
  return String(error?.message || error || 'Xatolik').replace(/https?:\/\/api\.telegram\.org\/[^\s"']+/g, '[Telegram API]').replace(/\b\d{6,12}:[A-Za-z0-9_-]{25,}\b/g, '[TOKEN]');
}
function profileFor(row) {
  return {name:row.name, phone:row.phone, additionalPhone:row.additional_phone, offerAccepted:row.offer==='Roziman', offerVersion:row.offer_version};
}
function retryKeyboard() {
  return keyboard([['🔄 Qayta yuborish'], ['📋 Holat']]);
}
function paymentKeyboard(withStatus = false) {
  const hasPaynetQr = paynetQrAvailable();
  const rows = PAYMENT_PROVIDERS.filter(provider => provider.url || (provider.id === 'paynet' && hasPaynetQr)).map(provider => [{
    text: '💳 ' + provider.name + ' orqali toʻlash',
    ...(provider.url ? { url: provider.url } : { callback_data: 'payment:paynet_qr' }),
  }]);
  if (hasPaynetQr && PAYMENT_PROVIDERS.some(provider => provider.id === 'paynet' && provider.url)) {
    rows.push([{ text: '📄 Paynet QR-kodi', callback_data: 'payment:paynet_qr' }]);
  }
  rows.push([{ text: '👨‍💼 Menejer bilan bogʻlanish', ...(MANAGER_URL ? { url: MANAGER_URL } : { callback_data: 'payment:contact' }) }]);
  if (withStatus) rows.push([{ text: '💳 Toʻlov', callback_data: 'payment:menu' }, { text: '📋 Holat', callback_data: 'payment:status' }]);
  return { inline_keyboard: rows };
}
function paynetQrAvailable() {
  if (!PAYNET_QR_PATH || path.extname(PAYNET_QR_PATH).toLowerCase() !== '.pdf') return false;
  let descriptor;
  try {
    const stat = fs.statSync(PAYNET_QR_PATH);
    if (!stat.isFile() || stat.size < 5 || stat.size > 50 * 1024 * 1024) return false;
    descriptor = fs.openSync(PAYNET_QR_PATH, 'r');
    const header = Buffer.alloc(5);
    return fs.readSync(descriptor, header, 0, 5, 0) === 5 && header.toString('ascii') === '%PDF-';
  } catch { return false; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
async function sendPaynetQr(cb, chatId) {
  if (!paynetQrAvailable()) {
    await answerCb(cb.id, 'Paynet QR fayli hozir ochilmadi. /payment orqali toʻlov maʼlumotlarini oching yoki menejer bilan bogʻlaning.', true);
    return;
  }
  await answerCb(cb.id);
  try {
    await sendDocument(chatId, PAYNET_QR_PATH,
      'Neo Sisra — Paynet orqali toʻlov\n\nVebinar narxi: ' + SERVICE_PRICE +
      '\n\nPDF ichidagi QR-kodni qoʻllab-quvvatlaydigan toʻlov ilovasida skanerlang. Summa soʻralsa, yuqoridagi vebinar narxini kiriting. Toʻlovdan oldin qabul qiluvchi va summani tekshiring. Toʻlovdan soʻng chekni shu botga yuboring.');
  } catch (error) {
    console.error(safeError(error));
    await sendMessage(chatId, 'Paynet QR faylini yuborib boʻlmadi. Tugmani qayta bosing yoki menejer bilan bogʻlaning.');
  }
}
function hasCurrentConsent(profile) {
  return Boolean(profile?.offerAccepted && profile.offerVersion === OFFER_VERSION && ['receipt', 'done'].includes(profile.step));
}
async function sendPayment(chatId) {
  const text = paymentText();
  // The raw HTML length is a conservative bound on Telegram's parsed caption.
  // A long configured contact/card value must remain complete, never truncated.
  if (PAYMENT_IMAGE_PATH && fs.existsSync(PAYMENT_IMAGE_PATH) && text.length <= 1024) {
    await sendPhoto(chatId, PAYMENT_IMAGE_PATH, text, paymentKeyboard());
  } else {
    await sendHtml(chatId, text, paymentKeyboard());
  }
}

function emptyDb() {
  return {
    users: {},
    registrations: [],
    payments: [],
    admin_chat_ids: [],
    last_update_id: 0,
    completed_update_ids: [],
  };
}

function loadDb() {
  return storageAction(() => storage().load());
}

function saveDb(db) {
  return storageAction(() => storage().save(db));
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function nowParts() {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
  return {full:parts.day+'.'+parts.month+'.'+parts.year+' '+parts.hour+':'+parts.minute+':'+parts.second,date:parts.year+'-'+parts.month+'-'+parts.day,time:parts.hour+':'+parts.minute+':'+parts.second};
}

async function tg(method, data = {}, priority = 0) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN .env faylida yoq');
  return telegramQueue.run({chatId: data.chat_id, priority, rateLimited: !['getMe','getFile','answerCallbackQuery'].includes(method)}, async () => {
  const payload = await fetchJson(
    `${API}/${method}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    },
    TELEGRAM_TIMEOUT_MS,
    `Telegram ${method}`,
  );
  if (!payload.ok) throw new Error('Telegram soʻrovi bajarilmadi (kod '+Number(payload.error_code||0)+').');
  return payload.result;
  });
}

async function tgMultipart(method, form) {
  return telegramQueue.run({chatId: form.get('chat_id')}, async () => {
  const payload = await fetchJson(
    `${API}/${method}`,
    { method: 'POST', body: form },
    TELEGRAM_FILE_TIMEOUT_MS,
    `Telegram ${method}`,
  );
  if (!payload.ok) throw new Error('Telegram fayl soʻrovi bajarilmadi (kod '+Number(payload.error_code||0)+').');
  return payload.result;
  });
}

function keyboard(rows, oneTime = false) {
  return { keyboard: rows, resize_keyboard: true, one_time_keyboard: oneTime };
}

function removeKeyboard() {
  return { remove_keyboard: true };
}

async function sendMessage(chatId, text, replyMarkup, extra = {}) {
  const data = { chat_id: chatId, text, ...extra };
  if (replyMarkup) data.reply_markup = replyMarkup;
  return tg('sendMessage', data);
}

async function sendHtml(chatId, text, replyMarkup) {
  const data = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (replyMarkup) data.reply_markup = replyMarkup;
  return tg('sendMessage', data);
}

async function sendDocument(chatId, filePath, caption = '') {
  const bytes = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([bytes], { type: path.extname(filePath).toLowerCase() === '.pdf' ? 'application/pdf' : '' }), path.basename(filePath));
  return tgMultipart('sendDocument', form);
}

async function sendPhoto(chatId, filePath, caption = '', replyMarkup) {
  const bytes = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
  form.append('photo', new Blob([bytes]), path.basename(filePath));
  return tgMultipart('sendPhoto', form);
}

function normalizePhone(text) {
  const raw=String(text||'').trim();
  if (!/^\+?[\d ()-]+$/.test(raw)) return null;
  let digits=raw.replace(/\D/g,'');
  if (!raw.startsWith('+') && digits.length===9) digits='998'+digits;
  if(digits.startsWith('998')) return digits.length===12 ? '+'+digits : null;
  return raw.startsWith('+') && /^[1-9]\d{6,14}$/.test(digits) ? '+'+digits : null;
}

function phoneValidationMessage(value, additional = false) {
  const raw = String(value || '').trim();
  const heading = additional ? 'Qoʻshimcha telefon raqamini tekshiring.' : 'Telefon raqamini tekshiring.';
  const example = 'Masalan: +998 90 123 45 67 yoki 90 123 45 67.';
  if (!raw || !/^\+?[\d ()-]+$/.test(raw)) {
    return [heading, 'Telefon raqamini toʻliq, harflarsiz yuboring.', example].join('\n');
  }
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('998') || !raw.startsWith('+')) {
    const hasCountryCode = digits.startsWith('998');
    const count = digits.length - (hasCountryCode ? 3 : 0);
    const difference = 9 - count;
    const requirement = hasCountryCode
      ? '+998 dan keyin 9 ta raqam boʻlishi kerak.'
      : 'Oʻzbekiston raqami +998 kodisiz 9 ta raqamdan iborat boʻlishi kerak.';
    const correction = difference > 0
      ? `${difference} ta raqam yetishmayapti.`
      : `${-difference} ta raqam ortiqcha.`;
    return [heading, `${requirement} Siz ${count} ta kiritdingiz — ${correction}`, example].join('\n');
  }
  return [heading, 'Telefon raqamini + belgisi va mamlakat kodi bilan toʻliq yuboring.', example].join('\n');
}

function userKey(chatId) {
  return String(chatId);
}

function isPrimaryAdmin(from) {
  return PRIMARY_ADMIN_IDS.includes(String(from?.id || ''));
}

function isAdminUser(from) {
  const id = String(from?.id || '');
  return ADMIN_IDS.includes(id);
}

function isAdmin(message) {
  return isAdminUser(message.from) || ADMIN_IDS.includes(String(message.chat?.id || ''));
}

function registerAdmin(db, chatId) {
  if (!db.admin_chat_ids.includes(chatId)) db.admin_chat_ids.push(chatId);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearBroadcast(db) {
  db.broadcast = null;
}

function registeredChatIds(db) {
  const ids = new Set();
  for (const row of db.registrations || []) {
    const id = Number(row.telegram_id);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

function newItemId() {
  return randomUUID();
}

function itemPreview(message) {
  const cut = (s, n = 80) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  if (message.text) return `Matn: ${cut(message.text)}`;
  if (message.photo) return message.caption ? `Rasm: ${cut(message.caption, 60)}` : 'Rasm';
  if (message.video) return message.caption ? `Video: ${cut(message.caption, 60)}` : 'Video';
  if (message.document) {
    const name = message.document.file_name || 'fayl';
    return message.caption ? `Fayl: ${cut(name, 40)} — ${cut(message.caption, 40)}` : `Fayl: ${cut(name, 50)}`;
  }
  if (message.audio) return 'Audio';
  if (message.voice) return 'Ovozli xabar';
  if (message.animation) return 'GIF';
  if (message.sticker) return 'Stiker';
  if (message.video_note) return 'Video-xabar';
  if (message.caption) return cut(message.caption);
  return 'Xabar';
}

function isBroadcastable(message) {
  return Boolean(
    (message.text && !message.text.startsWith('/')) ||
      message.photo ||
      message.document ||
      message.video ||
      message.animation ||
      message.audio ||
      message.voice ||
      message.sticker ||
      message.video_note,
  );
}

function collectKeyboard() {
  return keyboard([['✅ Yuborish'], ['❌ Bekor qilish']]);
}

function assetButtons(itemId, index, total) {
  const row = [];
  if (index > 0) row.push({ text: '⬆️ Yuqoriga', callback_data: `bc:up:${itemId}` });
  if (index < total - 1) row.push({ text: '⬇️ Pastga', callback_data: `bc:dn:${itemId}` });
  row.push({ text: "🗑 O'chirish", callback_data: `bc:del:${itemId}` });
  return [row];
}

async function answerCb(id, text, showAlert = false) {
  try {
    const data = { callback_query_id: id };
    if (text) data.text = text;
    if (showAlert) data.show_alert = true;
    await tg('answerCallbackQuery', data);
  } catch {
    // callback muddati o'tgan bo'lishi mumkin
  }
}

async function refreshAssetControls(db, chatId) {
  const b = db.broadcast;
  if (!b || !Array.isArray(b.items)) return;
  const n = b.items.length;
  for (let i = 0; i < n; i += 1) {
    const item = b.items[i];
    if (!item.controlMessageId) continue;
    try {
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: item.controlMessageId,
        text: `#${i + 1}/${n}  ${item.preview}`,
        reply_markup: { inline_keyboard: assetButtons(item.id, i, n) },
      });
    } catch {
      try {
        await tg('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: item.controlMessageId,
          reply_markup: { inline_keyboard: assetButtons(item.id, i, n) },
        });
      } catch {
        // eski xabar o'chirilgan
      }
    }
  }
}

async function addBroadcastItem(db, message) {
  const chatId = message.chat.id;
  const b = db.broadcast;
  if (!b.items) b.items = [];
  const item = {
    id: newItemId(),
    srcMessageId: message.message_id,
    preview: itemPreview(message),
    controlMessageId: null,
  };
  b.items.push(item);
  const n = b.items.length;
  const ctrl = await sendMessage(
    chatId,
    `#${n}/${n}  ${item.preview}`,
    { inline_keyboard: assetButtons(item.id, n - 1, n) },
    { reply_to_message_id: message.message_id },
  );
  b.items[n - 1].controlMessageId = ctrl.message_id;
  await refreshAssetControls(db, chatId);
}

function runInBackground(label, fn) {
  const task=Promise.resolve().then(fn).catch(err=>console.error(label+': '+safeError(err))).finally(()=>pendingTasks.delete(task));
  pendingTasks.add(task);
}
// Rows enter the durable outbox before any network work. Only a fixed number
// are materialized as promises; the rest stay pending in SQLite.
function pumpDeliveries(db) {
  if (backgroundStopping || storageFailure) return;
  const room = deliveryWorkers - queuedDeliveries.size;
  if (room <= 0) return;
  const jobs = storageAction(() => storage().pendingDeliveries(room, queuedDeliveries));
  for (const { collection, row } of jobs) {
    const key = collection + ':' + row.id;
    queuedDeliveries.add(key);
    runInBackground('Delivery', async () => {
      try {
        await deliveryQueue.run(key, () => collection === 'payments' ? deliverPayment(db, row) : deliverRegistration(db, row));
      } finally {
        queuedDeliveries.delete(key);
        // Let the queue release its active slot before filling it again.
        setImmediate(() => { try { pumpDeliveries(db); } catch (error) { console.error(safeError(error)); } });
      }
    });
  }
}
function claimDelivery(db, collection, row) {
  saveDb(db);
  return storageAction(() => storage().claimDelivery(collection, row.id, ['pending']));
}
function newRegistration(db, profile) {
  const row={id:newItemId(),name:profile.name,phone:profile.phone,additional_phone:profile.additional_phone||'',tariff:SERVICE_NAME,offer:'Roziman',offer_version:profile.offerVersion,date:nowParts().full,telegram_id:profile.chat_id,username:profile.username||'',status:'pending'};
  db.registrations.push(row);
  saveDb(db);
  return db.registrations.at(-1);
}
async function deliverRegistration(db,row) {
  if(row.status==='sent' || registrationFlights.has(row.id)) return;
  if (!claimDelivery(db, 'registrations', row)) return;
  registrationFlights.add(row.id);
  try {
    await google.sendRegistration(profileFor(row));
    row.status='sent'; row.google_result={ok:true};
  } catch(error) {
    if (error.code === 'STATE_STORE_ERROR') throw error;
    row.status='failed'; row.google_result={ok:false,error:'Sheets yuborish tasdiqlanmadi'};
    saveDb(db);
    console.error('Registration: '+safeError(error));
    try { await sendMessage(row.telegram_id,'Maʼlumotlaringiz saqlandi, lekin jadvalga yetkazilgani tasdiqlanmadi. 🔄 Qayta yuborish tugmasini bosishingiz mumkin.',retryKeyboard()); } catch(error) { console.error(safeError(error)); }
  } finally { saveDb(db); registrationFlights.delete(row.id); }
  if(!row.notified && NOTIFY_CHAT_ID) {
    row.notified=await notifyLeadChat('reg',row); saveDb(db);
  }
}
function extractReceipt(message) {
  if(message.photo?.length) {
    const photo=message.photo[message.photo.length-1];
    return {kind:'photo',fileId:photo.file_id,uniqueId:photo.file_unique_id||photo.file_id,fileName:'receipt.jpg',mimeType:'image/jpeg',fileSize:photo.file_size||0};
  }
  const d=message.document;
  if(d && ['image/png','image/jpeg','application/pdf'].includes(d.mime_type) && /\.(png|jpe?g|pdf)$/i.test(d.file_name||'')) {
    return {kind:'document',fileId:d.file_id,uniqueId:d.file_unique_id||d.file_id,fileName:d.file_name||'receipt',mimeType:d.mime_type,fileSize:d.file_size||0};
  }
  return null;
}
async function downloadReceipt(receipt) {
  const info=await tg('getFile',{file_id:receipt.fileId});
  if(receipt.fileSize>10*1024*1024 || info.file_size>10*1024*1024) throw new Error('Chek hajmi 10 MB dan oshmasligi kerak.');
  if(!info.file_path || !/^[\w./-]+$/.test(info.file_path) || info.file_path.includes('..')) throw new Error('Telegram fayl manzili notoʻgʻri.');
  const bytes=await fetchBytes(FILE_API+'/'+info.file_path,{method:'GET'},TELEGRAM_FILE_TIMEOUT_MS);
  return validateReceipt(bytes,receipt.fileName,receipt.mimeType);
}
async function deliverPayment(db,row) {
  if(row.status==='sent' || paymentFlights.has(row.id)) return;
  if (!claimDelivery(db, 'payments', row)) return;
  paymentFlights.add(row.id);
  try {
    const file=await downloadReceipt(row.receipt);
    const result=await google.sendReceipt(profileFor(row),file);
    row.check_url=result.fileUrl; row.check_url_google=result.fileUrl;
    row.google_result={ok:true,fileUrl:result.fileUrl}; row.status='sent';
    saveDb(db);
  } catch(error) {
    if (error.code === 'STATE_STORE_ERROR') throw error;
    row.status=error.code==='INVALID_RECEIPT'?'invalid':'failed'; row.google_result={ok:false,error:'Chek yetkazilgani tasdiqlanmadi'};
    saveDb(db);
    console.error('Receipt: '+safeError(error));
    try { await sendMessage(row.telegram_id,row.status==='invalid'?'Chek faylining formati notoʻgʻri. PNG, JPG yoki PDF formatidagi boshqa faylni yuboring.':'Chek yetkazilgani tasdiqlanmadi. 🔄 Qayta yuborish tugmasini bosishingiz mumkin. Oldingi urinish yetib borgan boʻlsa, takroriy yozuv paydo boʻlishi mumkin.',row.status==='invalid'?undefined:retryKeyboard()); } catch(error) { console.error(safeError(error)); }
  } finally { paymentFlights.delete(row.id); }
  if(row.status==='sent') {
    if(!row.notified && NOTIFY_CHAT_ID) { row.notified=await notifyLeadChat('pay',row,{[row.receipt.kind==='photo'?'photo':'document']:row.receipt.kind==='photo'?[{file_id:row.receipt.fileId,file_unique_id:row.receipt.uniqueId}]:{file_id:row.receipt.fileId,mime_type:row.receipt.mimeType,file_name:row.receipt.fileName}});saveDb(db); }
    try { await sendMessage(row.telegram_id,'✅ Chekingiz tekshirish uchun yuborildi. Natija boʻyicha siz bilan bogʻlanamiz.',paymentKeyboard(true)); } catch(error) { console.error(safeError(error)); }
  }
}
function paymentText() {
  const cards=PAYMENT_CARDS.map(c=>'<b>'+escHtml(c.bank)+'</b>\n<code>'+escHtml(c.number)+'</code>\nKarta egasi: '+escHtml(c.holder)).join('\n\n');
  const contact = normalizePhone(CONTACT_PHONE) ? ['', '☎️ Telefon: '+escHtml(CONTACT_PHONE.trim())] : [];
  return ['✅ <b>Maʼlumotlaringiz qabul qilindi.</b>','','<b>Neo Sisra — '+SERVICE_NAME+'</b>','Hujjatlarni rasmiylashtirish xizmati.','Oddiy narx: <b>'+escHtml(REGULAR_SERVICE_PRICE)+'</b>','Vebinar narxi — toʻlov miqdori: <b>'+escHtml(SERVICE_PRICE)+'</b>','','💳 <b>Toʻlov rekvizitlari:</b>',cards,'','📎 Toʻlov chekini shu yerga yuboring. PNG, JPG yoki PDF, hajmi 10 MB gacha.','Toʻlov admin tomonidan tekshiriladi.',...contact].join('\n');
}

function xmlCell(value) {
  const escaped = String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<Cell><Data ss:Type="String">${escaped}</Data></Cell>`;
}

function xmlRow(values) {
  return `<Row>${values.map(xmlCell).join('')}</Row>`;
}

function xmlSheet(name, rows) {
  return `<Worksheet ss:Name="${name}"><Table>${rows.map(xmlRow).join('')}</Table></Worksheet>`;
}

function exportExcel(db) {
  const regRows = [
    ['Ism', 'Telefon raqam', 'Qoʻshimcha telefon raqam', 'Tarif', 'Oferta', 'Sana', 'Telegram ID', 'Username'],
    ...db.registrations.map((r) => [r.name, r.phone, r.additional_phone || '', r.tariff, r.offer, r.date, r.telegram_id, r.username]),
  ];
  const payRows = [
    ['Ism', 'Telefon raqam', 'Qoʻshimcha telefon raqam', 'Tarif', 'Oferta', 'Check URL', 'Sana', 'vaqt', 'Telegram ID', 'Username'],
    ...db.payments.map((r) => [r.name, r.phone, r.additional_phone || '', r.tariff, r.offer, r.check_url, r.date, r.time, r.telegram_id, r.username]),
  ];
  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
${xmlSheet('Royhatdan otganlar', regRows)}
${xmlSheet('Chek Yuborganlar', payRows)}
</Workbook>`;
  fs.writeFileSync(EXPORT_PATH, xml, 'utf8');
  return EXPORT_PATH;
}

const NAME_PROMPT = [
  "📋 <b>Ro'yxatdan o'tish uchun ismingizni kiriting!</b>",
  '',
  "✍️ <b>Masalan:</b> Zebo Aliyeva",
].join('\n');
const NAME_MAX_LEN = 100;

function isPlainNameText(message) {
  if (!message.text || message.text.startsWith('/')) return false;
  if (
    message.photo ||
    message.document ||
    message.video ||
    message.animation ||
    message.audio ||
    message.voice ||
    message.sticker ||
    message.video_note ||
    message.contact ||
    message.location
  ) {
    return false;
  }
  return true;
}

async function askName(chatId) {
  await sendHtml(chatId, NAME_PROMPT, removeKeyboard());
}

async function askPhone(chatId) {
  await sendHtml(
    chatId,
    [
      "📱 <b>Telefon raqamingizni yuboring.</b>",
      '',
      'Pastdagi tugma orqali yuboring yoki raqamni yozing.',
      'Masalan: +998 90 123 45 67 yoki 90 123 45 67.',
      '+998 dan keyin 9 ta raqam boʻlishi kerak.',
    ].join('\n'),
    keyboard([[{ text: '📱 Telefon raqamni yuborish', request_contact: true }]], true),
  );
}

async function askOffer(chatId) {
  await sendHtml(chatId,'Davom etish uchun oferta shartlariga roziligingizni tasdiqlang.',{inline_keyboard:[[{text:'Oferta shartlarini oʻqish',callback_data:'offer:read'}],[{text:'✅ Roziman',callback_data:'offer:yes'},{text:'Rozimasman',callback_data:'offer:no'}]]});
}

async function askAdditionalPhone(chatId) {
  await sendHtml(chatId, [
    '📱 <b>Qoʻshimcha telefon raqamingizni kiriting.</b>',
    '',
    'Siz bilan bogʻlanishimiz uchun yana bitta boshqa telefon raqamini yuboring.',
    'Masalan: +998 90 123 45 67 yoki 90 123 45 67.',
    '+998 dan keyin 9 ta raqam boʻlishi kerak.',
  ].join('\n'), removeKeyboard());
}

function needsAdditionalPhone(db, profile) {
  const additionalPhone = normalizePhone(profile.additional_phone);
  if (additionalPhone && additionalPhone !== normalizePhone(profile.phone)) return false;
  // Previously registered users can finish payment or renew consent with their
  // historical single-number profile. Every fresh phone step collects two.
  return !profile.offerAccepted && !db.registrations.some(row => String(row.telegram_id) === String(profile.chat_id));
}

async function resumeOffer(db, chatId, profile) {
  if (needsAdditionalPhone(db, profile)) {
    profile.step = 'additional_phone';
    saveDb(db);
    await askAdditionalPhone(chatId);
  } else {
    await askOffer(chatId);
  }
}

async function startRegistration(db, chatId, message) {
  db.users[userKey(chatId)] = {
    chat_id: chatId,
    username: message.from?.username || '',
    step: 'name',
  };
  saveDb(db);
  const welcome = '<b>Neo Sisra</b>\nKoreyada oʻqish va oʻqish davrida rasmiy ishlash imkoniyatlari.\nKoreyaga talaba yuborish va hujjatlarni rasmiylashtirish xizmati.\n\n<b>100 kishi uchun maxsus taklif</b>\n\n' + NAME_PROMPT;
  if(WELCOME_IMAGE_PATH && fs.existsSync(WELCOME_IMAGE_PATH)) {
    await sendPhoto(chatId,WELCOME_IMAGE_PATH,welcome,removeKeyboard());
  } else {
    await sendHtml(chatId,welcome,removeKeyboard());
  }
}

function adminKeyboard() {
  return keyboard([
    ['📥 Excel yuklash', '📊 Statistika'],
    ['📣 Xabar yuborish'],
  ]);
}

async function adminPanel(chatId) {
  await sendMessage(chatId, "Admin bo'limi", adminKeyboard());
}

let broadcastFlight = false;
function startBroadcastWorker(db) {
  if (broadcastFlight || backgroundStopping || db.broadcast_job?.status !== 'running') return;
  broadcastFlight = true;
  runInBackground('Broadcast', async () => {
    const job = db.broadcast_job;
    try {
      while (!backgroundStopping && job.status === 'running' && job.recipient < db.broadcast_recipients.length) {
        const chatId = db.broadcast_recipients[job.recipient];
        const item = job.items[job.item];
        // Persist the cursor before Telegram: a lost acknowledgement is not
        // automatically resent after restart. The uncertainty stays visible.
        job.in_flight = true;
        job.item++;
        if (job.item >= job.items.length) { job.item = 0; job.recipient++; }
        saveDb(db);
        try {
          await tg('copyMessage', { chat_id: chatId, from_chat_id: job.fromChatId, message_id: item.srcMessageId }, 10);
          job.sent++;
        } catch (error) {
          job.failed++;
          console.error('Broadcast delivery: '+safeError(error));
        }
        job.in_flight = false;
        saveDb(db);
      }
      if (job.status === 'running') job.status = job.recipient >= db.broadcast_recipients.length ? 'done' : 'interrupted';
      saveDb(db);
      if (job.status === 'done') await sendMessage(job.fromChatId,
        'Yuborish yakunlandi. Yuborilgan xabarlar: '+job.sent+'; tasdiqlanmagan: '+job.failed+'.', adminKeyboard());
    } finally { broadcastFlight = false; }
  });
}
async function runBroadcast(db, adminChatId) {
  if (broadcastFlight || (db.broadcast_job && ['running','interrupted'].includes(db.broadcast_job.status))) {
    await sendMessage(adminChatId,'Oldingi yuborish hali yakunlanmagan. /broadcast_status orqali tekshiring.');
    return;
  }
  const b = db.broadcast;
  if (!b?.fromChatId || !b.items?.length) {
    await sendMessage(adminChatId,'Yuborish uchun material yoʻq.',adminKeyboard());
    return;
  }
  db.broadcast_recipients = registeredChatIds(db).filter(id => id !== adminChatId);
  db.broadcast_job = { id: newItemId(), status: 'running', fromChatId: b.fromChatId,
    items: b.items.map(item => ({srcMessageId:item.srcMessageId})), recipient: 0, item: 0,
    sent: 0, failed: 0, in_flight: false };
  clearBroadcast(db);
  saveDb(db);
  startBroadcastWorker(db);
  await sendMessage(adminChatId,db.broadcast_recipients.length+' ta foydalanuvchiga xabarlar navbat bilan yuboriladi. Holat: /broadcast_status',adminKeyboard());
}

async function handleAdmin(message, db) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();
  if (['/broadcast_status','/broadcast_resume','/broadcast_cancel'].includes(text)) {
    const job = db.broadcast_job;
    if (!job) { await sendMessage(chatId,'Faol yuborish yoʻq.'); return true; }
    if (text !== '/broadcast_status' && job.fromChatId !== chatId) {
      await sendMessage(chatId,'Bu yuborishni uni boshlagan admin boshqaradi.'); return true;
    }
    if (text === '/broadcast_cancel') job.status = 'cancelled';
    if (text === '/broadcast_resume' && job.status === 'interrupted') job.status = 'running';
    saveDb(db);
    startBroadcastWorker(db);
    await sendMessage(chatId,'Holat: '+job.status+'; yuborilgan xabarlar: '+job.sent+'; tasdiqlanmagan: '+job.failed+'.',adminKeyboard());
    return true;
  }
  const b = db.broadcast;
  const collecting = Boolean(b && b.step === 'collecting' && b.fromChatId === chatId);

  if (/^\/start(?:\s|$)/.test(text) || text === 'Qayta boshlash' || WELCOME_BUTTONS.includes(text)) {
    clearBroadcast(db);
    return false;
  }

  if (['❌ Bekor qilish', 'Bekor qilish', '/cancel'].includes(text)) {
    if (b) {
      clearBroadcast(db);
      await sendMessage(chatId, 'Xabar yuborish bekor qilindi.', adminKeyboard());
      return true;
    }
  }

  if (['/admin', 'Admin', 'admin'].includes(text)) {
    clearBroadcast(db);
    await adminPanel(chatId);
    return true;
  }

  if (text === '📣 Xabar yuborish' || text === '/broadcast') {
    const n = registeredChatIds(db).length;
    db.broadcast = { step: 'collecting', fromChatId: chatId, items: [] };
    await sendHtml(
      chatId,
      [
        `Ro'yxatdan o'tgan <b>${n}</b> ta foydalanuvchiga xabar ketadi.`,
        '',
        "Materiallarni birin-ketin yuboring — matn, rasm, video yoki istalgan fayl.",
        "Har birining ostida ⬆️ ⬇️ 🗑 tugmalari chiqadi.",
        '',
        "Hammasi tayyor bo'lgach <b>✅ Yuborish</b> ni bosing.",
      ].join('\n'),
      collectKeyboard(),
    );
    return true;
  }

  if (collecting) {
    if (text === '✅ Yuborish' || text === 'Yuborish') {
      if (!b.items.length) {
        await sendMessage(chatId, "Avval kamida bitta material yuboring.", collectKeyboard());
        return true;
      }
      await runBroadcast(db, chatId);
      return true;
    }
    if (['📊 Statistika', '📥 Excel yuklash', '/export', '📣 Xabar yuborish'].includes(text)) {
      await sendMessage(
        chatId,
        "Hozir material yig'ilmoqda. Avval ✅ Yuborish yoki ❌ Bekor qilish ni bosing.",
        collectKeyboard(),
      );
      return true;
    }
    if (isBroadcastable(message)) {
      await addBroadcastItem(db, message);
      return true;
    }
    await sendMessage(
      chatId,
      "Matn, rasm, video yoki fayl yuboring. Tayyor bo'lsa ✅ Yuborish.",
      collectKeyboard(),
    );
    return true;
  }

  if (text === '📊 Statistika') {
    await sendMessage(
      chatId,
      `Ro'yxatdan o'tganlar: ${db.registrations.length}\nChek yuborganlar: ${db.payments.length}`,
    );
    return true;
  }
  if (text === '📥 Excel yuklash' || text === '/export') {
    const filePath = exportExcel(db);
    await sendDocument(chatId, filePath, "Ro'yxatdan o'tganlar va chek yuborganlar eksporti");
    return true;
  }
  return false;
}

async function handleOfferCallback(cb,db) {
  const chatId=cb.message?.chat?.id;
  const profile=db.users[userKey(chatId)];
  if(cb.message?.chat?.type!=='private' || cb.from?.id!==chatId || !profile || !['offer','receipt','done'].includes(profile.step)) {await answerCb(cb.id,'Avval maʼlumotlaringizni kiriting.');return;}
  if(cb.data==='offer:read') {
    await answerCb(cb.id);
    if(OFFER_DOC_PATH && fs.existsSync(OFFER_DOC_PATH)) await sendDocument(chatId,OFFER_DOC_PATH,'Neo Sisra — ommaviy oferta');
    return;
  }
  if(profile.step!=='offer') {await answerCb(cb.id,'Avval maʼlumotlaringizni kiriting.');return;}
  if(needsAdditionalPhone(db,profile)) {
    await answerCb(cb.id,'Qoʻshimcha telefon raqamingizni kiriting.');
    await resumeOffer(db,chatId,profile);return;
  }
  if(cb.data!=='offer:yes') {
    await answerCb(cb.id,'Davom etish uchun rozilik kerak.');
    await askOffer(chatId);return;
  }
  profile.offerAccepted=true;profile.offerVersion=OFFER_VERSION;profile.tariff=SERVICE_NAME;profile.step='receipt';
  newRegistration(db,profile);
  pumpDeliveries(db);
  await answerCb(cb.id,'Roziligingiz qabul qilindi');
  await sendPayment(chatId);
}

async function sendStatus(chatId, db) {
  const row=[...db.payments].reverse().find(row=>row.telegram_id===chatId);
  const registration=[...db.registrations].reverse().find(item=>item.telegram_id===chatId);
  if(!row && registration && registration.status!=='sent') {await sendMessage(chatId,['pending','sending'].includes(registration.status)?'Maʼlumotlaringiz jadvalga yuborilyapti.':'Maʼlumotlaringiz jadvalga yetkazilgani tasdiqlanmadi. Qayta yuborishingiz mumkin.',retryKeyboard());return;}
  await sendMessage(chatId,row?(row.status==='sent'?'Chekingiz tekshirish uchun yuborilgan. Toʻlov natijasi boʻyicha siz bilan bogʻlanamiz.':['pending','sending'].includes(row.status)?'Chekingiz yuborilyapti. Natija shu yerda chiqadi.':'Chek yetkazilgani tasdiqlanmadi. Qayta yuborishingiz mumkin.'):'Hali chek yubormagansiz.',row && row.status!=='sent'?retryKeyboard():undefined);
}

async function handlePaymentCallback(cb, db) {
  const chatId = cb.message?.chat?.id;
  const profile = db.users[userKey(chatId)];
  if (cb.message?.chat?.type !== 'private' || cb.from?.id !== chatId || !hasCurrentConsent(profile)) {
    await answerCb(cb.id, 'Avval roʻyxatdan oʻting va oferta shartlariga rozilik bering.', true);
    return;
  }
  const action = cb.data.slice('payment:'.length);
  if (action === 'paynet_qr' || (action === 'paynet' && PAYNET_QR_PATH)) {
    await sendPaynetQr(cb, chatId);
    return;
  }
  if (action === 'menu' || action === 'status') {
    await answerCb(cb.id);
    if (action === 'menu') await sendPayment(chatId);
    else await sendStatus(chatId, db);
    return;
  }
  const provider = PAYMENT_PROVIDERS.find(item => item.id === action);
  // A callback on an older message can outlive an administrator adding a URL.
  if (provider?.url || (action === 'contact' && MANAGER_URL)) {
    await answerCb(cb.id);
    await sendPayment(chatId);
  } else if (provider) {
    await answerCb(cb.id, provider.name + ' orqali toʻlov uchun havola hali berilmagan. Toʻlov maʼlumotlarini menejerdan aniqlashtiring.', true);
  } else if (action === 'contact') {
    const phone = normalizePhone(CONTACT_PHONE);
    await answerCb(cb.id, phone ? 'Menejer bilan bogʻlanish: ' + phone : 'Menejerning aloqa maʼlumoti hali berilmagan.', true);
  } else {
    await answerCb(cb.id, 'Bu tugma topilmadi. /payment orqali toʻlov oynasini oching.', true);
  }
}

async function handleCallback(cb, db) {
  const data = String(cb.data || '');
  if (data.startsWith('offer:')) {
    await handleOfferCallback(cb, db);
    return;
  }
  if (data.startsWith('payment:')) {
    await handlePaymentCallback(cb, db);
    return;
  }
  if (!isAdminUser(cb.from)) {
    await answerCb(cb.id, "Siz admin emassiz");
    return;
  }
  const b = db.broadcast;
  const m = data.match(/^bc:(up|dn|del):(.+)$/);
  if (!m || !b || b.step !== 'collecting' || b.fromChatId !== cb.message?.chat?.id || cb.from?.id !== b.fromChatId) {
    await answerCb(cb.id, "Yig'ish yakunlangan");
    return;
  }
  const action = m[1];
  const itemId = m[2];
  const items = b.items || [];
  const idx = items.findIndex((x) => x.id === itemId);
  if (idx < 0) {
    await answerCb(cb.id, "Material topilmadi");
    return;
  }
  if (action === 'up') {
    if (idx === 0) {
      await answerCb(cb.id, 'Allaqachon birinchi');
      return;
    }
    const tmp = items[idx - 1];
    items[idx - 1] = items[idx];
    items[idx] = tmp;
    await refreshAssetControls(db, b.fromChatId);
    await answerCb(cb.id, "Yuqoriga ko'tarildi");
    return;
  }
  if (action === 'dn') {
    if (idx >= items.length - 1) {
      await answerCb(cb.id, 'Allaqachon oxirgi');
      return;
    }
    const tmp = items[idx + 1];
    items[idx + 1] = items[idx];
    items[idx] = tmp;
    await refreshAssetControls(db, b.fromChatId);
    await answerCb(cb.id, 'Pastga tushirildi');
    return;
  }
  if (action === 'del') {
    const [removed] = items.splice(idx, 1);
    try {
      await tg('deleteMessage', {
        chat_id: b.fromChatId,
        message_id: removed.controlMessageId,
      });
    } catch {
      // control xabar o'chirilgan
    }
    await refreshAssetControls(db, b.fromChatId);
    await answerCb(cb.id, "O'chirildi");
  }
}

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function dash(value) {
  const s = String(value ?? '').trim();
  return s || '-';
}

function formatUsername(username) {
  const s = String(username || '').replace(/^@/, '').trim();
  return s ? `@${s}` : '-';
}

function formatTelegramIdLink(telegramId) {
  const id = String(telegramId || '').replace(/[^\d-]/g, '');
  if (!id) return '-';
  return `<a href="tg://user?id=${id}">${escHtml(id)}</a>`;
}

function leadReport(row,title,withCheck=false) {
  return [title,'','<b>Ism Familiya:</b> '+escHtml(dash(row.name)),'<b>Telefon:</b> '+escHtml(dash(row.phone)),...(row.additional_phone?['<b>Qoʻshimcha telefon:</b> '+escHtml(row.additional_phone)]:[]),'<b>Xizmat:</b> '+SERVICE_NAME,'<b>Oferta:</b> '+escHtml(row.offer),'<b>Telegram ID:</b> '+formatTelegramIdLink(row.telegram_id),'<b>Telegram:</b> '+escHtml(formatUsername(row.username)),'<b>Sheets:</b> '+(row.status==='sent'?'Yuborildi':'Yuborish tasdiqlanmadi'),...(withCheck?['<b>Chek (Google Drive):</b>',escHtml(row.check_url_google||'—')]:[])].join('\n');
}

async function sendToTopic(threadId, text) {
  return tg('sendMessage', {
    chat_id: NOTIFY_CHAT_ID,
    ...(threadId ? {message_thread_id:Number(threadId)} : {}),
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

async function sendReceiptToTopic(threadId, sourceMessage, caption) {
  const receipt = extractReceipt(sourceMessage);
  const data = {
    chat_id: NOTIFY_CHAT_ID,
    ...(threadId ? {message_thread_id:Number(threadId)} : {}),
    caption: caption.slice(0, 1024),
    parse_mode: 'HTML',
  };
  if (receipt?.kind === 'photo') {
    return tg('sendPhoto', { ...data, photo: receipt.fileId });
  }
  if (receipt?.kind === 'video') {
    return tg('sendVideo', { ...data, video: receipt.fileId });
  }
  if (receipt?.kind === 'document') {
    return tg('sendDocument', { ...data, document: receipt.fileId });
  }
  return sendToTopic(threadId, caption);
}

async function notifyLeadChat(kind, row, sourceMessage) {
  if (!NOTIFY_CHAT_ID) return false;
  const isPay = kind === 'pay';
  const threadId = isPay ? NOTIFY_PAY_TOPIC : NOTIFY_REG_TOPIC;
  const title = isPay ? '💳 <b>Chek yuborildi</b>' : "✅ <b>Ro'yxatdan o'tdi</b>";
  const text = leadReport(row, title, isPay);
  try {
    if (isPay && sourceMessage) {
      await sendReceiptToTopic(threadId, sourceMessage, text);
      return true;
    }
    await sendToTopic(threadId, text);
    return true;
  } catch (err) {
    console.error(`Guruhga xabar ketmadi (topic ${threadId}): ${safeError(err)}`);
  }
}

async function handleMessage(message,db) {
  if(message.chat?.type!=='private') return;
  const chatId=message.chat.id;
  const text=(message.text||'').trim();
  if(text==='/id') {await sendMessage(chatId,'Sizning Telegram ID: '+message.from.id);return;}
  if(isAdmin(message)) {registerAdmin(db,chatId);if(await handleAdmin(message,db))return;}
  if(/^\/start(?:\s|$)/.test(text) || text==='Qayta boshlash' || WELCOME_BUTTONS.includes(text)) {await startRegistration(db,chatId,message);return;}
  const profile=db.users[userKey(chatId)];
  if(!profile) {await startRegistration(db,chatId,message);return;}
  if(text==='/payment' || text==='💳 Toʻlov') {
    if (hasCurrentConsent(profile)) await sendPayment(chatId);
    else if (profile.step==='offer') await resumeOffer(db,chatId,profile);
    else if (profile.step==='additional_phone') await askAdditionalPhone(chatId);
    else if (['receipt','done'].includes(profile.step) && typeof profile.name==='string' && profile.name.trim() && normalizePhone(profile.phone)) {
      profile.step='offer';saveDb(db);await resumeOffer(db,chatId,profile);
    }
    else await sendMessage(chatId,'Toʻlov maʼlumotlarini ochish uchun roʻyxatdan oʻtishni yakunlang va oferta shartlariga rozilik bering.');
    return;
  }
  if(text==='🔄 Qayta yuborish' || text==='/retry') {
    const rows=[...db.registrations,...db.payments].filter(row=>row.telegram_id===chatId && ['pending','failed'].includes(row.status));
    if(!rows.length) {await sendMessage(chatId,'Qayta yuboriladigan maʼlumot yoʻq.');return;}
    for (const row of rows) if (row.status === 'failed') row.status = 'pending';
    saveDb(db);
    pumpDeliveries(db);
    await sendMessage(chatId,'Qayta yuborish boshlandi. Natija shu yerda chiqadi.');
    return;
  }
  if(text==='📋 Holat' || text==='/status') {
    await sendStatus(chatId,db);return;
  }
  if(profile.step==='name') {
    if(!isPlainNameText(message)||!text||/[\u0000-\u001f\u007f]/.test(text)) {await askName(chatId);return;}
    if(text.length>NAME_MAX_LEN) {await sendMessage(chatId,'Ism '+NAME_MAX_LEN+' belgidan oshmasin.');return;}
    profile.name=text;profile.step='phone';saveDb(db);await askPhone(chatId);return;
  }
  if(profile.step==='phone') {
    if(message.contact?.user_id && message.contact.user_id!==message.from?.id) {await sendMessage(chatId,'Oʻzingizning telefon raqamingizni yuboring.');return;}
    const phone=normalizePhone(message.contact?.phone_number||text);
    if(!phone) {await sendMessage(chatId,phoneValidationMessage(message.contact?.phone_number||text));return;}
    profile.phone=phone;profile.step='additional_phone';saveDb(db);await askAdditionalPhone(chatId);return;
  }
  if(profile.step==='additional_phone') {
    const phone=normalizePhone(message.contact?.phone_number||text);
    if(!phone) {await sendMessage(chatId,phoneValidationMessage(message.contact?.phone_number||text,true));return;}
    if(phone===normalizePhone(profile.phone)) {await sendMessage(chatId,'Bu raqamni avval kiritdingiz. Qoʻshimcha aloqa uchun boshqa telefon raqamini kiriting.');return;}
    profile.additional_phone=phone;profile.step='offer';saveDb(db);await askOffer(chatId);return;
  }
  if(profile.step==='offer') {await resumeOffer(db,chatId,profile);return;}
  if(profile.step==='receipt'||profile.step==='done') {
    if(!profile.offerAccepted || profile.offerVersion!==OFFER_VERSION) {profile.step='offer';saveDb(db);await resumeOffer(db,chatId,profile);return;}
    const receipt=extractReceipt(message);
    if(!receipt||receipt.fileSize>10*1024*1024) {await sendMessage(chatId,'Toʻlov chekini PNG, JPG yoki PDF qilib yuboring. Hajmi 10 MB dan oshmasin.');return;}
    const existing=storageAction(() => storage().findReceipt({telegram_id:chatId,name:profile.name,phone:profile.phone,offer_version:profile.offerVersion,receipt}));
    if(existing) {await sendMessage(chatId,existing.status==='sent'?'Bu chek tekshirish uchun yuborilgan.':'Bu chek avval qabul qilingan. Holatni tekshirishingiz yoki qayta yuborishingiz mumkin.',existing.status==='sent'?paymentKeyboard(true):retryKeyboard());return;}
    const parts=nowParts();
    const row={id:newItemId(),name:profile.name,phone:profile.phone,additional_phone:profile.additional_phone||'',tariff:SERVICE_NAME,offer:'Roziman',offer_version:profile.offerVersion,date:parts.date,time:parts.time,telegram_id:chatId,username:profile.username||'',receipt,status:'pending',check_url:''};
    db.payments.push(row);profile.step='done';saveDb(db);
    pumpDeliveries(db);
    await sendHtml(chatId,'✅ <b>Chekingiz qabul qilindi.</b>\nUni tekshirish uchun yuboramiz. Natija boʻyicha siz bilan bogʻlanamiz.',paymentKeyboard(true));return;
  }
}
function recoverInterrupted(db) {
  for(const row of [...db.registrations,...db.payments])if(row.status==='sending')row.status='failed';
  if (db.broadcast_job?.status === 'running') {
    db.broadcast_job.status = 'interrupted';
    if (db.broadcast_job.in_flight) { db.broadcast_job.failed++; db.broadcast_job.in_flight = false; }
  }
  return db;
}

async function waitForBackground() {
  do {
    if (pendingTasks.size) await Promise.allSettled([...pendingTasks]);
    await new Promise(resolve => setImmediate(resolve));
    if (storageFailure) throw storageFailure;
  } while (pendingTasks.size || queuedDeliveries.size);
}
function closeStore() { if (store) { store.close(); store = null; } }
function createPollingRuntime({ shutdownTimeoutMs = 240000, onShutdownTimeout = () => process.exit(1), onUpdate } = {}) {
  let stopping = false;
  let shutdownTimer;
  let db;
  const updates = createWorkQueue({ concurrency: updateWorkers, maxPending: 100 });
  function dispose() { clearTimeout(shutdownTimer); }
  function requestStop() {
    if (stopping) return;
    stopping = true;
    backgroundStopping = true;
    console.info('Neo Sisra shutdown requested; finishing current updates and deliveries.');
    shutdownTimer = setTimeout(() => {
      console.error('Neo Sisra shutdown deadline reached; unfinished deliveries require explicit retry.');
      onShutdownTimeout();
    }, shutdownTimeoutMs);
  }
  async function processBatch(batch) {
    if (!Array.isArray(batch) || batch.length > 100 || batch.some(u => !Number.isSafeInteger(u.update_id) || u.update_id < 0)) throw new Error('Telegram update batch is invalid.');
    const ordered = [...new Map(batch.map(u => [u.update_id,u])).values()].sort((a,b) => a.update_id-b.update_id);
    const completed = new Set(db.completed_update_ids || []);
    let prefix = 0;
    const commit = id => {
      completed.add(id);
      while (prefix < ordered.length && (ordered[prefix].update_id <= db.last_update_id || completed.has(ordered[prefix].update_id))) {
        db.last_update_id = Math.max(db.last_update_id, ordered[prefix].update_id);
        completed.delete(ordered[prefix].update_id);
        prefix++;
      }
      db.completed_update_ids = [...completed].filter(value => value > db.last_update_id).sort((a,b) => a-b);
      saveDb(db);
    };
    const work = ordered.map(update => {
      const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? update.callback_query?.from?.id ?? 'other';
      return updates.run(String(chatId), async () => {
        if (storageFailure) throw storageFailure;
        if (update.update_id > db.last_update_id && !completed.has(update.update_id)) {
          try {
            if (onUpdate) await onUpdate(update, db);
            else if (update.message) await handleMessage(update.message, db);
            else if (update.callback_query) await handleCallback(update.callback_query, db);
          } catch (error) {
            if (error.code === 'STATE_STORE_ERROR' || storageFailure) throw storageFailure || error;
            console.error('Update: '+safeError(error));
            try {
              if (update.message) await sendMessage(chatId,'Xatolik yuz berdi. /status orqali holatni tekshiring yoki qayta urinib koʻring.');
              else if (update.callback_query) await answerCb(update.callback_query.id,'Xatolik');
            } catch (replyError) { console.error(safeError(replyError)); }
          }
        }
        // Commit only the completed prefix. Out-of-order completions are durable
        // so a restart can skip them without acknowledging an unfinished gap.
        commit(update.update_id);
      });
    });
    const results = await Promise.allSettled(work);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  async function run() {
    if (stopping) { dispose(); return; }
    backgroundStopping = false;
    db = recoverInterrupted(loadDb());
    saveDb(db);
    pumpDeliveries(db);
    let connected = false;
    try {
      while (!stopping) {
        if (storageFailure) throw storageFailure;
        let payload;
        try {
          const url = API+'/getUpdates?offset='+(Number(db.last_update_id || 0)+1)+'&limit=100&timeout='+POLL_TIMEOUT_SECONDS+'&allowed_updates='+encodeURIComponent(JSON.stringify(['message','callback_query']));
          payload = await fetchJson(url,{method:'GET'},POLL_FETCH_TIMEOUT_MS,'Telegram getUpdates');
          if (!payload.ok) throw new Error('Telegram polling bajarilmadi (kod '+Number(payload.error_code||0)+').');
        } catch (error) {
          console.error('Polling: '+safeError(error));
          if (!stopping) await sleep(5000);
          continue;
        }
        if (!connected) { console.info('Neo Sisra polling ready.'); connected = true; }
        await processBatch(payload.result);
      }
      await waitForBackground();
      await telegramQueue.idle?.();
      saveDb(db);
      console.info('Neo Sisra shutdown complete.');
    } finally {
      backgroundStopping = true;
      dispose();
      while (pendingTasks.size) await Promise.allSettled([...pendingTasks]);
      // All fetched handlers have settled before this point. On fatal storage
      // failure stop rather than acknowledging more Telegram updates.
      if (!storageFailure) closeStore();
    }
  }
  return { run, requestStop, dispose };
}

async function start() {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN .env faylida yoq');
  if (!GOOGLE_SCRIPT_URL) throw new Error('GOOGLE_SCRIPT_URL sozlanishi kerak.');
  // Acquire the data lock before connecting a second polling process.
  loadDb();
  const runtime = createPollingRuntime();
  process.on('SIGTERM',runtime.requestStop);
  process.on('SIGINT',runtime.requestStop);
  try {
    const identity = await tg('getMe');
    if (identity.username !== 'neo_sisrabot') throw new Error('Sozlangan token Neo Sisra botiga tegishli emas.');
    console.info('Neo Sisra bot identity verified: @'+identity.username);
    await runtime.run();
  } finally {
    runtime.dispose();
    process.removeListener('SIGTERM',runtime.requestStop);
    process.removeListener('SIGINT',runtime.requestStop);
    if (!storageFailure) closeStore();
  }
}
return { emptyDb, exportExcel, normalizePhone, paymentText, handleMessage, handleCallback,
  recoverInterrupted, createPollingRuntime, leadReport, waitForBackground, loadDb, saveDb,
  closeStore, pumpDeliveries, start,
  queueStats: () => ({ deliveries: deliveryQueue.stats(), telegram: telegramQueue.stats?.() }) };
}

module.exports = { createBot };
// Preserve the small helper API for consumers; defer configuration and opening
// the database until a helper is actually used.
let defaultBot;
for (const name of ['emptyDb','exportExcel','normalizePhone','paymentText','handleMessage','handleCallback','recoverInterrupted','createPollingRuntime','leadReport','waitForBackground','loadDb','saveDb','closeStore']) {
  module.exports[name] = (...args) => (defaultBot ||= createBot())[name](...args);
}
if (require.main === module) {
  Promise.resolve().then(() => createBot().start()).catch(error => {
    // Do not print transport URLs, bot credentials, or exception causes.
    console.error(String(error.message || 'Bot failed').replace(/https?:\/\/api\.telegram\.org\/[^\s"']+/g,'[Telegram API]').replace(/\b\d{6,12}:[A-Za-z0-9_-]{25,}\b/g,'[TOKEN]'));
    process.exitCode = 1;
  });
}

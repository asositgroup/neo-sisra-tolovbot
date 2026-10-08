'use strict';

const { Buffer } = require('node:buffer');

const SERVICE_NAME = 'Koreyaga talaba yuborish';
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const MIME_EXTENSIONS = new Map([
  ['image/png', new Set(['.png'])],
  ['image/jpeg', new Set(['.jpg', '.jpeg'])],
  ['application/pdf', new Set(['.pdf'])],
]);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalidReceipt() {
  return failure('INVALID_RECEIPT', 'Chek PNG, JPG yoki PDF formatida, 10 MB gacha bo‘lishi kerak.');
}

function validateProfile(profile) {
  if (profile?.offerAccepted !== true || typeof profile.offerVersion !== 'string' ||
      !profile.offerVersion.trim() || profile.offerVersion.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(profile.offerVersion)) {
    throw failure('CONSENT_REQUIRED', 'Oferta shartlariga rozilik talab qilinadi.');
  }
  const name = typeof profile.name === 'string' ? profile.name.trim() : '';
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name) ||
      typeof profile.phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(profile.phone)) {
    throw failure('INVALID_PROFILE', 'Ism va telefon raqamini tekshiring.');
  }
  const additionalPhone = profile.additionalPhone;
  if (additionalPhone !== undefined && additionalPhone !== null && additionalPhone !== '' &&
      (typeof additionalPhone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(additionalPhone) ||
       additionalPhone === profile.phone)) {
    throw failure('INVALID_PROFILE', 'Qo‘shimcha telefon raqamini tekshiring.');
  }
  return { name, phone: profile.phone, additionalPhone: additionalPhone || null };
}

function validateReceipt(bytes, fileName, mimeType) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 ||
      bytes.byteLength > MAX_RECEIPT_BYTES || typeof fileName !== 'string' ||
      !fileName.trim() || fileName.length > 4096 || !MIME_EXTENSIONS.has(mimeType) ||
      /https?:\/\//i.test(fileName)) {
    throw invalidReceipt();
  }

  // Only a local basename is sent; never a Telegram download URL or path.
  const baseName = fileName.replace(/\\/g, '/').split('/').pop().trim();
  const extension = baseName.match(/\.[^.]+$/)?.[0].toLowerCase();
  if (!MIME_EXTENSIONS.get(mimeType).has(extension)) throw invalidReceipt();

  const data = Buffer.from(bytes);
  const signatureMatches = mimeType === 'image/png'
    ? data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mimeType === 'image/jpeg'
      ? data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255
      : data.length >= 5 && data.subarray(0, 5).equals(Buffer.from('%PDF-', 'ascii'));
  if (!signatureMatches) throw invalidReceipt();

  const stem = baseName.slice(0, -extension.length)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '') || 'receipt';
  const safeName = stem.slice(0, 120 - extension.length).replace(/[. ]+$/g, '') + extension;
  return { bytes: data, fileName: safeName, mimeType };
}

function makePayload(profile, receipt) {
  const form = new FormData();
  form.append('sheetName', receipt ? 'Chek Yuborganlar' : 'Royhatdan otganlar');
  form.append('imageUpload', receipt ? 'true' : 'false');
  form.append('Ism', profile.name);
  // Keep the existing Apps Script/Sheets column contract, including legacy leads.
  form.append('Telefon raqam', profile.additionalPhone
    ? `${profile.phone} / ${profile.additionalPhone}` : profile.phone);
  form.append('Tarif', SERVICE_NAME);
  const date = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  const time = `${date.hour}:${date.minute}:${date.second}`;
  if (!receipt) {
    form.append('Oferta', 'Roziman');
    form.append('Sana', `${date.day}.${date.month}.${date.year} ${time}`);
  } else {
    form.append('Offerta', 'Roziman');
    form.append('sana', `${date.year}-${date.month}-${date.day}`);
    form.append('vaqt', time);
    form.append('checkUrlHeader', 'Check URL');
    form.append('file_data', receipt.bytes.toString('base64'));
    form.append('file_filename', receipt.fileName);
    form.append('file_mime', receipt.mimeType);
  }
  return form;
}

function validFileUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com' ||
        url.port || url.username || url.password) return null;
    const id = url.searchParams.get('id') || url.searchParams.get('fileId') ||
      url.pathname.match(/^\/file\/d\/([^/]+)(?:\/|$)/)?.[1];
    if (!id || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) return null;
    return `https://drive.google.com/file/d/${id}/view`;
  } catch {
    return null;
  }
}

function createGoogleDelivery({ endpoint, fetchImpl = globalThis.fetch, timeoutMs } = {}) {
  let parsed;
  try { parsed = new URL(endpoint); } catch { /* Report only the safe configuration error. */ }
  if (!parsed || parsed.protocol !== 'https:' || parsed.hostname !== 'script.google.com' ||
      parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash ||
      !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(parsed.pathname) ||
      typeof fetchImpl !== 'function' || (timeoutMs !== undefined &&
      (!Number.isFinite(timeoutMs) || timeoutMs <= 0))) {
    throw failure('INVALID_CONFIGURATION', 'Google delivery configuration is invalid.');
  }

  async function send(form, expectsFile) {
    const controller = new AbortController();
    let expired = false;
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        reject(failure('DELIVERY_TIMEOUT', 'Yuborish natijasi tasdiqlanmadi.'));
      }, timeoutMs ?? (expectsFile ? 120000 : 45000));
    });
    try {
      const delivery = (async () => {
        const response = await fetchImpl(parsed.href, {
          method: 'POST', body: form, credentials: 'omit', signal: controller.signal,
        });
        if (response?.ok !== true) throw new Error('http');
        const result = await response.json();
        if (!result || result.result !== 'success') throw new Error('acknowledgement');
        if (!expectsFile) return { ok: true };
        const fileUrl = validFileUrl(result.fileUrl);
        if (!fileUrl) throw new Error('receipt-url');
        return { fileUrl };
      })();
      return await Promise.race([delivery, deadline]);
    } catch {
      throw failure(expired ? 'DELIVERY_TIMEOUT' : 'DELIVERY_UNCONFIRMED',
        'Yuborish natijasi tasdiqlanmadi. Qayta yuborish takroriy yozuv yaratishi mumkin.');
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async sendRegistration(profile) {
      return send(makePayload(validateProfile(profile)), false);
    },
    async sendReceipt(profile, receipt) {
      const contact = validateProfile(profile);
      const checked = validateReceipt(receipt?.bytes, receipt?.fileName, receipt?.mimeType);
      return send(makePayload(contact, checked), true);
    },
  });
}

module.exports = { createGoogleDelivery, validateReceipt };

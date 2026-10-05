'use strict';

const { Buffer } = require('node:buffer');

class TelegramHttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function error(code, label) {
  const messages = {
    TELEGRAM_TIMEOUT: 'Javob kutish vaqti tugadi.',
    TELEGRAM_HTTP_ERROR: 'Soʻrov muvaffaqiyatli bajarilmadi.',
    TELEGRAM_JSON_ERROR: 'Server javobini oʻqib boʻlmadi.',
    TELEGRAM_BODY_TOO_LARGE: 'Fayl hajmi ruxsat etilgan chegaradan oshdi.',
    TELEGRAM_NETWORK_ERROR: 'Ulanish yoki faylni oʻqish yakunlanmadi.',
    TELEGRAM_INVALID_OPTIONS: 'Soʻrov sozlamalari notoʻgʻri.',
  };
  return new TelegramHttpError(code, label + ': ' + messages[code]);
}

function safeLabel(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9 _-]{0,59}$/.test(value) ? value : 'Telegram';
}

async function readJson(response, registerCancel, maxBytes, label) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    let cancelled = false;
    const cancelReader = () => {
      if (cancelled) return;
      cancelled = true;
      return reader.cancel();
    };
    registerCancel(cancelReader);
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!ArrayBuffer.isView(value)) throw error('TELEGRAM_JSON_ERROR', label);
        size += value.byteLength;
        if (size > maxBytes) throw error('TELEGRAM_BODY_TOO_LARGE', label);
        chunks.push(Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
      }
      try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
      catch { throw error('TELEGRAM_JSON_ERROR', label); }
    } catch (failure) {
      try { Promise.resolve(cancelReader()).catch(() => {}); } catch { /* Best effort. */ }
      throw failure;
    } finally {
      try { reader.releaseLock(); } catch { /* Timed-out read may still be pending. */ }
    }
  }
  // Some fetch-compatible adapters expose json() without a stream. The common
  // request deadline still covers their entire parser operation.
  try {
    const data = await response.json();
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') > maxBytes) throw error('TELEGRAM_BODY_TOO_LARGE', label);
    return data;
  } catch (failure) {
    if (failure instanceof TelegramHttpError) throw failure;
    throw error('TELEGRAM_JSON_ERROR', label);
  }
}

function httpFailure(label, status, data) {
  const failure = error('TELEGRAM_HTTP_ERROR', label);
  if (Number.isInteger(status) && status >= 100 && status <= 599) failure.status = status;
  if (data?.error_code === 429) failure.errorCode = 429;
  const seconds = data?.parameters?.retry_after;
  if ((status === 429 || data?.error_code === 429) && Number.isFinite(seconds) && seconds > 0 && Number.isFinite(seconds * 1000)) failure.retryAfter = seconds;
  return failure;
}

async function request(url, options, timeoutMs, label, consume) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw error('TELEGRAM_INVALID_OPTIONS', label);
  const controller = new AbortController();
  let expired = false;
  let cancelBody = null;
  let timer;
  const cancel = () => {
    controller.abort();
    try { Promise.resolve(cancelBody?.()).catch(() => {}); } catch { /* Best effort only. */ }
  };
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      cancel();
      reject(error('TELEGRAM_TIMEOUT', label));
    }, timeoutMs);
  });
  try {
    const operation = (async () => {
      const response = await fetch(url, { ...options, signal: controller.signal });
      cancelBody = () => response?.body?.cancel?.();
      if (expired) { cancel(); throw error('TELEGRAM_TIMEOUT', label); }
      if (response?.ok !== true) {
        if (response?.status === 429) {
          let data;
          try { data = await readJson(response, cancellation => { cancelBody = cancellation; }, 64 * 1024, label); }
          catch { /* A malformed rate-limit response is not safe to retry. */ }
          throw httpFailure(label, 429, data);
        }
        throw httpFailure(label, response?.status);
      }
      return consume(response, cancellation => { cancelBody = cancellation; });
    })();
    return await Promise.race([operation, deadline]);
  } catch (failure) {
    cancel();
    if (expired) throw error('TELEGRAM_TIMEOUT', label);
    if (failure instanceof TelegramHttpError) throw failure;
    throw error('TELEGRAM_NETWORK_ERROR', label);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 15000, label = 'Telegram') {
  const operationLabel = safeLabel(label);
  return request(url, options, timeoutMs, operationLabel, async (response, registerCancel) => {
    const data = await readJson(response, registerCancel, 4 * 1024 * 1024, operationLabel);
    if (data?.ok === false && data.error_code === 429) throw httpFailure(operationLabel, response.status, data);
    return data;
  });
}

async function fetchBytes(url, options = {}, timeoutMs = 30000, maxBytes = 10 * 1024 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw error('TELEGRAM_INVALID_OPTIONS', 'Telegram');
  return request(url, options, timeoutMs, 'Telegram', async (response, registerCancel) => {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    let cancelled = false;
    const cancelReader = () => {
      if (cancelled) return;
      cancelled = true;
      return reader.cancel();
    };
    registerCancel(cancelReader);
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!ArrayBuffer.isView(value)) throw error('TELEGRAM_NETWORK_ERROR', 'Telegram');
        size += value.byteLength;
        if (size > maxBytes) throw error('TELEGRAM_BODY_TOO_LARGE', 'Telegram');
        chunks.push(Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
      }
      return Buffer.concat(chunks, size);
    } catch (failure) {
      // Cancel while this reader still owns its lock; cancel() after releaseLock
      // would reject without stopping the underlying native stream.
      try { Promise.resolve(cancelReader()).catch(() => {}); } catch { /* Best effort only. */ }
      throw failure;
    } finally {
      try { reader.releaseLock(); } catch { /* A timed-out read may still be pending. */ }
    }
  });
}

module.exports = { fetchJson, fetchBytes, TelegramHttpError };

'use strict';

const { QueueFullError } = require('./work-queue.cjs');

function createTelegramQueue({
  ratePerSecond = 28, perChatMs = 1050, groupMs = 3100,
  concurrency = 16, maxPending = 500, maxRetries = 3,
  now = Date.now, setTimeout: startTimer = setTimeout, clearTimeout: stopTimer = clearTimeout,
} = {}) {
  for (const value of [ratePerSecond, perChatMs, groupMs]) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError('Invalid Telegram pacing');
  }
  for (const value of [concurrency, maxPending]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid queue capacity');
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) throw new TypeError('Invalid retry limit');
  const pending = [], activeKeys = new Set(), nextChat = new Map(), waiters = [];
  let total = 0, sequence = 0, timer = null, scheduled = false, nextGlobal = 0, cooldown = 0;
  const stats = () => ({ active: activeKeys.size, pending: pending.length, total });
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  }
  function finish(job, failed, result, failure) {
    activeKeys.delete(job.key);
    const seconds = failure?.retryAfter;
    const limited = failure && (failure.status === 429 || failure.errorCode === 429) && Number.isFinite(seconds) && seconds > 0 && Number.isFinite(seconds * 1000);
    if (limited) cooldown = Math.max(cooldown, now() + seconds * 1000);
    if (limited && job.retries < maxRetries) {
      job.retries++;
      pending.push(job);
    } else {
      total--;
      if (failed) job.reject(failure); else job.resolve(result);
      if (!total) for (const done of waiters.splice(0)) done();
    }
    schedule();
  }
  function pump() {
    if (timer !== null) { stopTimer(timer); timer = null; }
    const time = now();
    for (const [key, due] of nextChat) {
      if (due <= time && !activeKeys.has(key) && !pending.some(job => job.key === key)) nextChat.delete(key);
    }
    while (activeKeys.size < concurrency && pending.length) {
      // A retry retains its original sequence, so later messages in that chat
      // cannot overtake it even when they have a higher priority.
      const heads = new Map();
      for (const job of pending) {
        if (!heads.has(job.key) || job.sequence < heads.get(job.key).sequence) heads.set(job.key, job);
      }
      let chosen, earliest = Infinity;
      const current = now();
      for (const job of heads.values()) {
        if (activeKeys.has(job.key)) continue;
        const due = Math.max(cooldown, job.rateLimited ? nextGlobal : 0, job.rateLimited ? (nextChat.get(job.key) || 0) : 0);
        earliest = Math.min(earliest, due);
        if (due > current) continue;
        if (!chosen || job.priority < chosen.priority || (job.priority === chosen.priority && job.sequence < chosen.sequence)) chosen = job;
      }
      if (!chosen) {
        if (Number.isFinite(earliest)) {
          // Cap native timeout range; a very long retry_after must never wrap
          // into an immediate retry. No timers remain when the queue is empty.
          timer = startTimer(() => { timer = null; schedule(); }, Math.min(2147483647, Math.max(1, Math.ceil(earliest - current))));
        }
        break;
      }
      pending.splice(pending.indexOf(chosen), 1);
      activeKeys.add(chosen.key);
      if (chosen.rateLimited) {
        nextGlobal = current + 1000 / ratePerSecond;
        if (chosen.chatId != null) nextChat.set(chosen.key, current + (/^-/.test(String(chosen.chatId)) ? Math.max(groupMs, perChatMs) : perChatMs));
      }
      Promise.resolve().then(chosen.fn).then(result => finish(chosen, false, result), failure => finish(chosen, true, undefined, failure));
    }
  }
  return {
    run({ chatId, priority = 0, rateLimited = true } = {}, fn) {
      if (typeof fn !== 'function' || !Number.isFinite(priority)) return Promise.reject(new TypeError('Invalid Telegram job'));
      if (total >= maxPending) return Promise.reject(new QueueFullError());
      total++;
      return new Promise((resolve, reject) => {
        const id = sequence++;
        pending.push({ chatId, key: chatId == null ? Symbol(id) : String(chatId), priority, rateLimited, sequence: id, fn, resolve, reject, retries: 0 });
        schedule();
      });
    },
    idle() { return total ? new Promise(resolve => waiters.push(resolve)) : Promise.resolve(); },
    stats,
  };
}

module.exports = { createTelegramQueue };

'use strict';

class QueueFullError extends Error {
  constructor() {
    super('Soʻrovlar navbati toʻldi. Keyinroq qayta urinib koʻring.');
    this.name = 'QueueFullError';
    this.code = 'QUEUE_FULL';
  }
}

function createWorkQueue({ concurrency = 16, maxPending = 500 } = {}) {
  for (const value of [concurrency, maxPending]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid queue capacity');
  }
  const queues = new Map(), activeKeys = new Set(), waiters = [];
  let total = 0, sequence = 0, scheduled = false;
  const stats = () => ({ active: activeKeys.size, pending: total - activeKeys.size, total });
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  }
  function pump() {
    while (activeKeys.size < concurrency) {
      let chosen;
      for (const [key, jobs] of queues) {
        if (activeKeys.has(key) || !jobs.length) continue;
        const job = jobs[0];
        if (!chosen || job.priority < chosen.priority || (job.priority === chosen.priority && job.sequence < chosen.sequence)) chosen = job;
      }
      if (!chosen) break;
      const { key, fn, resolve, reject } = chosen;
      const jobs = queues.get(key);
      jobs.shift();
      if (!jobs.length) queues.delete(key);
      activeKeys.add(key);
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        activeKeys.delete(key);
        total--;
        if (!total) for (const done of waiters.splice(0)) done();
        schedule();
      });
    }
  }
  return {
    run(key, fn, { priority = 0 } = {}) {
      if (typeof fn !== 'function' || !Number.isFinite(priority)) return Promise.reject(new TypeError('Invalid queue job'));
      if (total >= maxPending) return Promise.reject(new QueueFullError());
      total++;
      return new Promise((resolve, reject) => {
        if (!queues.has(key)) queues.set(key, []);
        queues.get(key).push({ key, fn, priority, sequence: sequence++, resolve, reject });
        schedule();
      });
    },
    idle() { return total ? new Promise(resolve => waiters.push(resolve)) : Promise.resolve(); },
    stats,
  };
}

module.exports = { createWorkQueue, QueueFullError };

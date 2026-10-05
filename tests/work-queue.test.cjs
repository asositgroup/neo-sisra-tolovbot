'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createWorkQueue, QueueFullError } = require('../work-queue.cjs');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('different users run concurrently while one user keeps FIFO without occupying waiting workers', async () => {
  const queue = createWorkQueue({ concurrency: 2, maxPending: 10 });
  const hold = deferred(), seen = [];
  const jobs = [
    queue.run('a', async () => { seen.push('a1'); await hold.promise; }),
    queue.run('a', () => { seen.push('a2'); }),
    queue.run('b', () => { seen.push('b1'); }),
    queue.run('c', () => { seen.push('c1'); }),
  ];
  await flush();
  assert.deepEqual(seen, ['a1', 'b1', 'c1']);
  assert.deepEqual(queue.stats(), { active: 1, pending: 1, total: 2 });
  hold.resolve();
  await Promise.all(jobs);
  await queue.idle();
  assert.deepEqual(seen, ['a1', 'b1', 'c1', 'a2']);
});

test('capacity includes running jobs and rejects excess work without executing its function', async () => {
  const queue = createWorkQueue({ concurrency: 1, maxPending: 2 });
  const hold = deferred();
  const a = queue.run('a', () => hold.promise);
  const b = queue.run('b', () => 2);
  let ran = false;
  await assert.rejects(queue.run('c', () => { ran = true; }), QueueFullError);
  assert.equal(ran, false);
  hold.resolve(1);
  assert.deepEqual(await Promise.all([a, b]), [1, 2]);
  await queue.idle();
  assert.equal(queue.stats().total, 0);
});

test('normal-priority jobs precede unrelated broadcasts but cannot overtake their own chat', async () => {
  const queue = createWorkQueue({ concurrency: 1 });
  const seen = [];
  const jobs = [
    queue.run('broadcast', () => seen.push('low'), { priority: 10 }),
    queue.run('broadcast', () => seen.push('same-user-normal')),
    queue.run('interactive', () => seen.push('interactive')),
  ];
  await Promise.all(jobs);
  assert.deepEqual(seen, ['interactive', 'low', 'same-user-normal']);
});

test('rejected and synchronously throwing jobs release their keys and idle waits for all work', async () => {
  const queue = createWorkQueue({ concurrency: 2 });
  const one = assert.rejects(queue.run(1, () => { throw new Error('synthetic'); }), /synthetic/);
  const two = queue.run(1, () => 'next');
  const three = assert.rejects(queue.run(2, async () => { throw new Error('offline'); }), /offline/);
  await Promise.all([one, three]);
  assert.equal(await two, 'next');
  await queue.idle();
  assert.deepEqual(queue.stats(), { active: 0, pending: 0, total: 0 });
});

test('large same-user burst does not starve later independent users', async () => {
  const queue = createWorkQueue({ concurrency: 16, maxPending: 200 });
  const hold = deferred();
  const jobs = Array.from({ length: 100 }, () => queue.run('same', () => hold.promise));
  let independent = 0;
  jobs.push(...Array.from({ length: 16 }, (_, index) => queue.run(index, () => { independent++; })));
  await flush();
  assert.equal(independent, 16);
  hold.resolve();
  await Promise.all(jobs);
  await queue.idle();
});

test('invalid capacity and invalid jobs are rejected', async () => {
  for (const options of [{ concurrency: 0 }, { maxPending: 1.5 }, { concurrency: Infinity }]) assert.throws(() => createWorkQueue(options));
  const queue = createWorkQueue();
  await assert.rejects(queue.run('a', null), TypeError);
  await assert.rejects(queue.run('a', () => {}, { priority: NaN }), TypeError);
  assert.equal(queue.stats().total, 0);
});

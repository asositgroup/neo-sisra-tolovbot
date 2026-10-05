'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createStateStore, readState, exportLegacy, SQLITE_NAME } = require('../state-store.cjs');

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-state-store-test-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) try { store.close(); } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    open() { const store = createStateStore({ dataDir }); stores.push(store); return store; },
    legacy(state) { fs.writeFileSync(path.join(dataDir, 'bot_data.json'), typeof state === 'string' ? state : JSON.stringify(state)); },
  };
}

function payment(id, extra = {}) {
  return { id, name: 'TEST Person', phone: '+998000000000', telegram_id: 123, offer_version: 'v1', receipt: { uniqueId: `receipt-${id}`, fileId: 'TEST_FILE' }, status: 'pending', ...extra };
}

test('legacy migration preserves original bytes and assigns stable IDs without losing metadata', t => {
  const f = fixture(t);
  const bytes = '{\n  "users":{"123":{"name":"TEST Person"}}, "registrations":[{"status":"sent"}], "payments":[{"status":"failed"}], "last_update_id":42, "completed_update_ids":[44], "broadcast":{"items":[{"id":"a"}]}\n}\n';
  f.legacy(bytes);
  const first = f.open();
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'bot_data.json.pre-sqlite.bak'), 'utf8'), bytes);
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'bot_data.json'), 'utf8'), bytes);
  const saved = first.snapshot({ persisted: true });
  assert.match(saved.registrations[0].id, /^legacy-registrations-/);
  assert.match(saved.payments[0].id, /^legacy-payments-/);
  assert.deepEqual(saved.completed_update_ids, [44]);
  first.close();
  const second = f.open();
  assert.deepEqual(second.snapshot({ persisted: true }), saved);
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'bot_data.json.pre-sqlite.bak'), 'utf8'), bytes);
});

test('SQLite is authoritative after migration even when the legacy checkpoint is stale', t => {
  const f = fixture(t); const store = f.open();
  store.load().users['1'] = { name: 'SQLite value' }; store.save(); store.close();
  f.legacy({ users: { '1': { name: 'Stale JSON value' } } });
  assert.equal(f.open().load().users['1'].name, 'SQLite value');
});

test('dirty record saves serialize changed records only while nested mutations persist', t => {
  const f = fixture(t); const store = f.open(); const db = store.load();
  for (let index = 0; index < 2000; index++) db.users[String(index)] = { name: `TEST ${index}`, preferences: { labels: ['a'] } };
  for (let index = 0; index < 1000; index++) db.payments.push(payment(`p-${index}`));
  store.save(); const before = store.stats();
  db.users['100'].preferences.labels.push('b');
  db.payments[700].receipt.fileId = 'UPDATED_FILE';
  db.last_update_id = 55;
  store.save(); const after = store.stats();
  assert.equal(after.serializedRecords - before.serializedRecords, 3);
  assert.equal(after.writes - before.writes, 3);
  const saved = readState({ dataDir: f.dataDir });
  assert.deepEqual(saved.users['100'].preferences.labels, ['a', 'b']);
  assert.equal(saved.payments[700].receipt.fileId, 'UPDATED_FILE');
  assert.equal(saved.last_update_id, 55);
  assert.equal(saved.users['101'].name, 'TEST 101');
});

test('appending one delivery does not serialize historical deliveries', t => {
  const f = fixture(t); const store = f.open(); const db = store.load();
  for (let index = 0; index < 2000; index++) db.registrations.push({ id: `r-${index}`, status: 'sent' });
  store.save(); const before = store.stats();
  db.registrations.push({ id: 'new', status: 'pending' }); store.save();
  assert.equal(store.stats().serializedRecords - before.serializedRecords, 1);
  assert.equal(store.stats().writes - before.writes, 1);
});

test('completed update IDs and nested broadcast state survive a restart', t => {
  const f = fixture(t); const store = f.open(); const db = store.load();
  db.completed_update_ids = [102, 104];
  db.broadcast_job = { status: 'pending', recipients: ['1', '2'], cursor: 0 };
  store.save();
  db.completed_update_ids.push(106); db.broadcast_job.cursor = 1; store.save(); store.close();
  const next = f.open().load();
  assert.deepEqual(next.completed_update_ids, [102, 104, 106]);
  assert.equal(next.broadcast_job.cursor, 1);
});

test('claimDelivery atomically permits one claimant and updates cached status', t => {
  const f = fixture(t); const store = f.open(); const db = store.load();
  db.payments.push(payment('claim')); store.save();
  const row = db.payments[0];
  assert.equal(store.claimDelivery('payments', 'claim', ['pending']), true);
  assert.equal(row.status, 'sending');
  assert.equal(store.claimDelivery('payments', 'claim', ['pending']), false);
  assert.equal(readState({ dataDir: f.dataDir }).payments[0].status, 'sending');
  row.status = 'failed'; store.save();
  assert.equal(store.claimDelivery('payments', 'claim', ['failed']), true);
  assert.equal(store.claimDelivery('payments', 'missing', ['pending']), false);
});

test('SQLite receipt uniqueness rejects duplicate payments and rolls back the complete save', t => {
  const f = fixture(t); const store = f.open(); const db = store.load();
  db.payments.push(payment('first')); store.save();
  db.users['new'] = { name: 'Must roll back' };
  db.payments.push(payment('second', { receipt: { uniqueId: 'receipt-first' } }));
  assert.throws(() => store.save(), /no partial changes/);
  const persisted = store.snapshot({ persisted: true });
  assert.equal(persisted.users.new, undefined); assert.equal(persisted.payments.length, 1);
  db.payments.pop(); store.save();
  assert.equal(store.snapshot({ persisted: true }).users.new.name, 'Must roll back');
});

test('duplicate legacy receipts fail closed and leave the source untouched', t => {
  const f = fixture(t);
  const bytes = JSON.stringify({ payments: [payment('first'), payment('second', { receipt: { uniqueId: 'receipt-first' } })] });
  f.legacy(bytes);
  assert.throws(() => f.open(), /Duplicate payment receipt/);
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'bot_data.json'), 'utf8'), bytes);
  assert.equal(fs.existsSync(path.join(f.dataDir, SQLITE_NAME)), false);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'instance.lock')), false);
});

test('live process locking denies another store and rollback export', t => {
  const f = fixture(t); const store = f.open();
  assert.throws(() => f.open(), /already owns/);
  assert.throws(() => exportLegacy({ dataDir: f.dataDir }), /already owns/);
  store.close(); assert.ok(f.open().load());
});

test('stale PID lock is reclaimed without touching an active owner', t => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  fs.writeFileSync(path.join(f.dataDir, 'instance.lock'), JSON.stringify({ pid: Number(child.stdout), nonce: 'dead-child', hostname: os.hostname() }));
  const store = f.open();
  const lock = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'instance.lock'), 'utf8'));
  assert.equal(lock.pid, process.pid); assert.notEqual(lock.nonce, 'dead-child');
  store.close(); assert.equal(fs.existsSync(path.join(f.dataDir, 'instance.lock')), false);
});

test('lock release cannot remove a replacement owner and foreign host locks fail closed', t => {
  const f = fixture(t); const store = f.open();
  const replacement = { pid: process.pid, nonce: 'different-owner', hostname: os.hostname() };
  fs.writeFileSync(path.join(f.dataDir, 'instance.lock'), JSON.stringify(replacement));
  store.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'instance.lock'), 'utf8')), replacement);
  fs.writeFileSync(path.join(f.dataDir, 'instance.lock'), JSON.stringify({ ...replacement, hostname: 'another-host' }));
  assert.throws(() => f.open(), /already owns/);
});

test('malformed JSON and malformed state shapes fail closed', t => {
  const invalid = ['{invalid', 'null', '[]', '{"users":[]}', '{"payments":{}}', '{"registrations":[null]}', '{"last_update_id":-1}'];
  for (const bytes of invalid) {
    const f = fixture(t); f.legacy(bytes);
    assert.throws(() => f.open(), /state|offset|record|JSON/);
    assert.equal(fs.readFileSync(path.join(f.dataDir, 'bot_data.json'), 'utf8'), bytes);
    assert.equal(fs.existsSync(path.join(f.dataDir, SQLITE_NAME)), false);
  }
});

test('checkpoint writes compatibility JSON atomically and close releases the lock', t => {
  const f = fixture(t); const store = f.open();
  store.load().users['1'] = { name: 'Checkpoint' };
  store.checkpoint();
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'bot_data.json'), 'utf8')).users['1'].name, 'Checkpoint');
  assert.ok(!fs.readdirSync(f.dataDir).some(name => name.endsWith('.tmp')));
  store.close(); store.close(); assert.equal(fs.existsSync(path.join(f.dataDir, 'instance.lock')), false);
});

test('rollback export then legacy edits then reupgrade imports the newer JSON once', t => {
  const f = fixture(t); const store = f.open();
  store.load().users['1'] = { name: 'Before rollback' };
  store.load().completed_update_ids = [11]; store.close();
  assert.deepEqual(exportLegacy({ dataDir: f.dataDir }), { exported: true, handoff: true });
  const legacy = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'bot_data.json'), 'utf8'));
  legacy.users['1'].name = 'Legacy edit'; legacy.payments.push(payment('legacy-new')); legacy.last_update_id = 15;
  f.legacy(legacy);
  assert.deepEqual(exportLegacy({ dataDir: f.dataDir }), { exported: false, handoff: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'bot_data.json'), 'utf8')).users['1'].name, 'Legacy edit');
  const next = f.open();
  assert.equal(next.load().users['1'].name, 'Legacy edit');
  assert.equal(next.load().payments.length, 1); assert.equal(next.load().last_update_id, 15);
  assert.deepEqual(next.load().completed_update_ids, [11]);
  assert.ok(fs.readdirSync(f.dataDir).some(name => name.startsWith('bot_state.sqlite.pre-legacy-import.')));
  next.close(); f.legacy({ users: { '1': { name: 'Stale again' } } });
  assert.equal(f.open().load().users['1'].name, 'Legacy edit');
});

test('invalid legacy edits after rollback do not destroy the authoritative SQLite backup', t => {
  const f = fixture(t); const store = f.open();
  store.load().users['1'] = { name: 'Durable' }; store.close();
  exportLegacy({ dataDir: f.dataDir }); f.legacy('{broken');
  assert.throws(() => f.open(), /not valid JSON/);
  assert.equal(readState({ dataDir: f.dataDir }).users['1'].name, 'Durable');
  f.legacy({ users: { '1': { name: 'Repaired legacy' } } });
  assert.equal(f.open().load().users['1'].name, 'Repaired legacy');
});

test('plain snapshots replace prior fixtures while proxy saves retain unrelated users', t => {
  const f = fixture(t); const store = f.open();
  store.save({ users: { first: { name: 'First' } }, payments: [payment('first')] });
  store.save({ users: { second: { name: 'Second' } } });
  assert.deepEqual(Object.keys(store.load().users), ['second']); assert.equal(store.load().payments.length, 0);
  const db = store.load(); db.users.third = { name: 'Third' }; store.save();
  db.users.second.name = 'Updated'; store.save();
  assert.equal(readState({ dataDir: f.dataDir }).users.third.name, 'Third');
});

test('collection removal, reordering and metadata deletion survive reload', t => {
  const f = fixture(t); const store = f.open(); const db = store.load();
  db.registrations.push({ id: 'a' }, { id: 'b' }, { id: 'c' });
  db.broadcast = { stage: 'done' }; db.users.a = { name: 'Delete' }; store.save();
  db.registrations.splice(1, 1); db.registrations.reverse(); delete db.broadcast; delete db.users.a; store.save();
  const saved = store.snapshot({ persisted: true });
  assert.deepEqual(saved.registrations.map(row => row.id), ['c', 'a']);
  assert.equal(saved.broadcast, undefined); assert.equal(saved.users.a, undefined);
});

test('WAL, FULL synchronization and busy timeout are configured', t => {
  const f = fixture(t); const store = f.open();
  const database = new DatabaseSync(path.join(f.dataDir, SQLITE_NAME), { readOnly: true });
  try { assert.equal(database.prepare('PRAGMA journal_mode').get().journal_mode, 'wal'); }
  finally { database.close(); }
  assert.deepEqual(store.snapshot({ persisted: true }).payments, []);
  assert.equal(store.stats().journalMode, 'wal');
  assert.equal(store.stats().synchronous, 2);
  assert.equal(store.stats().busyTimeoutMs, 5000);
});

test('pending delivery queries are bounded, exclude in-flight keys and return tracked rows', t => {
  const f = fixture(t); const store = f.open(); const db = store.load();
  for (let index = 0; index < 1000; index++) db.payments.push(payment(`sent-${index}`, { status: 'sent' }));
  db.payments.push(payment('first'), payment('second'));
  db.registrations.push({ id: 'signup', status: 'pending' }, { id: 'retry', status: 'failed' }); store.save();
  const result = store.pendingDeliveries(2, new Set(['payments:first']));
  assert.deepEqual(result.map(({ collection, row }) => `${collection}:${row.id}`).sort(), ['payments:second', 'registrations:signup']);
  const before = store.stats(); result.find(({ collection }) => collection === 'payments').row.status = 'sending'; store.save();
  assert.equal(store.stats().serializedRecords - before.serializedRecords, 1);
  assert.deepEqual(store.pendingDeliveries(4).map(({ row }) => row.id).sort(), ['first', 'signup']);
  assert.deepEqual(store.pendingDeliveries(0), []);
});

test('invalid completed update metadata rolls back the save before it can corrupt restart state', t => {
  const f = fixture(t); const store = f.open(); const db = store.load();
  db.completed_update_ids = [1, 3]; store.save(); db.completed_update_ids.push(-1);
  assert.throws(() => store.save(), /no partial changes/);
  assert.deepEqual(store.snapshot({ persisted: true }).completed_update_ids, [1, 3]);
  db.completed_update_ids.pop(); store.save();
});

test('unsupported container descriptors fail explicitly instead of silently losing writes', t => {
  const f = fixture(t); const store = f.open(); const db = store.load();
  db.users.a = { name: 'Original' }; db.payments.push(payment('a')); store.save();
  assert.throws(() => Object.defineProperty(db, 'broadcast', { value: {} }), /ordinary assignments/);
  assert.throws(() => Object.defineProperty(db.users, 'a', { value: { name: 'Changed' } }), /ordinary assignments/);
  assert.throws(() => Object.defineProperty(db.payments, '0', { value: payment('b') }), /ordinary assignments/);
  store.save(); assert.equal(store.snapshot({ persisted: true }).users.a.name, 'Original');
});

test('abrupt process exit recovers committed WAL state even without a JSON checkpoint', t => {
  const f = fixture(t);
  const code = `const {createStateStore}=require(process.argv[1]); const store=createStateStore({dataDir:process.argv[2]}); const db=store.load(); db.users.a={name:'Crash durable',nested:{value:1}}; db.last_update_id=71; db.completed_update_ids=[73]; store.save(); db.users.a.nested.value=2; store.save(); process.exit(0);`;
  const child = spawnSync(process.execPath, ['-e', code, path.resolve(__dirname, '../state-store.cjs'), f.dataDir], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'bot_data.json')), false);
  const store = f.open();
  assert.equal(store.load().users.a.nested.value, 2);
  assert.equal(store.load().last_update_id, 71);
  assert.deepEqual(store.load().completed_update_ids, [73]);
  store.close(); assert.ok(fs.existsSync(path.join(f.dataDir, 'bot_data.json')));
});

test('pending deliveries remain FIFO across registrations and receipts', t => {
  const f = fixture(t); const store = f.open(); const db = store.load();
  db.registrations.push({ id: 'signup-first', status: 'pending' }); store.save();
  db.payments.push(payment('receipt-next')); store.save();
  db.registrations.push({ id: 'signup-last', status: 'pending' }); store.save();
  assert.deepEqual(store.pendingDeliveries(3).map(({ row }) => row.id), ['signup-first', 'receipt-next', 'signup-last']);
});

test('indexed receipt lookup matches the whole consent/profile key and returns a tracked record', t => {
  const f = fixture(t); const store = f.open(); const db = store.load();
  for (let index = 0; index < 2000; index++) db.payments.push(payment(`lookup-${index}`));
  store.save();
  const candidate = payment('lookup-1750');
  const existing = store.findReceipt(candidate);
  assert.equal(existing.id, 'lookup-1750');
  assert.equal(store.findReceipt({ ...candidate, phone: '+998000000001' }), null);
  assert.equal(store.findReceipt({ ...candidate, name: 'Different name' }), null);
  assert.equal(store.findReceipt({ ...candidate, offer_version: 'v2' }), null);
  assert.equal(store.findReceipt({ ...candidate, telegram_id: 124 }), null);
  assert.equal(store.findReceipt({ receipt: { uniqueId: candidate.receipt.uniqueId } }), null);
  const before = store.stats(); existing.status = 'failed'; store.save();
  assert.equal(store.stats().serializedRecords - before.serializedRecords, 1);
  assert.equal(store.snapshot({ persisted: true }).payments[1750].status, 'failed');
});

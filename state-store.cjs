'use strict';

// One local bot process owns this store. SQLite transactions protect durable
// records; the PID lock also protects the bot's cached conversation state.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SQLITE_NAME = 'bot_state.sqlite';
const LEGACY_NAME = 'bot_data.json';
const COLLECTIONS = ['registrations', 'payments'];
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = value => JSON.stringify(value);
const clone = value => JSON.parse(json(value));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const baseState = () => ({ users: {}, registrations: [], payments: [], admin_chat_ids: [], last_update_id: 0 });

function stateError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'STATE_STORE_ERROR';
  return error;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
}

function readLock(filename) {
  let value;
  try { value = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw stateError('Bot instance lock is unreadable; inspect it before restarting.'); }
  if (!object(value) || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.nonce !== 'string' || !value.nonce || typeof value.hostname !== 'string') {
    throw stateError('Bot instance lock is invalid; inspect it before restarting.');
  }
  return value;
}

function acquireLock(dataDir) {
  const filename = path.join(dataDir, 'instance.lock');
  const reclaim = `${filename}.reclaim`;
  const owner = { pid: process.pid, nonce: crypto.randomUUID(), hostname: os.hostname() };
  const writeOwner = () => {
    const fd = fs.openSync(filename, 'wx', 0o600);
    try { fs.writeFileSync(fd, json(owner)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  };
  // A reclaim lock serializes stale-PID cleanup. An abandoned reclaim marker
  // deliberately fails closed rather than risking removal of a fresh owner.
  if (fs.existsSync(reclaim)) throw stateError('Bot instance lock recovery is already in progress; inspect the recovery marker.');
  try { writeOwner(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let recoveryFd;
    try { recoveryFd = fs.openSync(reclaim, 'wx', 0o600); }
    catch { throw stateError('Another bot process is acquiring the instance lock.'); }
    try {
      const current = readLock(filename);
      if (current && (current.hostname !== os.hostname() || processAlive(current.pid))) {
        throw stateError('Another bot process already owns this data directory.');
      }
      if (current) fs.unlinkSync(filename);
      try { writeOwner(); }
      catch { throw stateError('Another bot process acquired the instance lock.'); }
    } finally {
      fs.closeSync(recoveryFd);
      fs.unlinkSync(reclaim);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = readLock(filename);
    if (current && current.nonce === owner.nonce && current.pid === owner.pid && current.hostname === owner.hostname) fs.unlinkSync(filename);
  };
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicWrite(filename, bytes) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, filename);
    syncDirectory(path.dirname(filename));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function backupLegacy(dataDir, bytes) {
  let filename = path.join(dataDir, `${LEGACY_NAME}.pre-sqlite.bak`);
  if (fs.existsSync(filename)) {
    if (fs.readFileSync(filename).equals(bytes)) return filename;
    filename = path.join(dataDir, `${LEGACY_NAME}.pre-sqlite.${crypto.randomUUID()}.bak`);
  }
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(dataDir);
  return filename;
}

function deliveryKey(row) {
  if (!row.receipt || typeof row.receipt.uniqueId !== 'string' || !row.receipt.uniqueId || row.telegram_id === undefined ||
      typeof row.name !== 'string' || typeof row.phone !== 'string' || typeof row.offer_version !== 'string') return null;
  return digest(json([String(row.telegram_id), row.name, row.phone, row.offer_version, row.receipt.uniqueId]));
}

function rowId(row, collection, index) {
  if (!object(row)) throw stateError(`Invalid ${collection} record in saved bot state.`);
  if (row.id === undefined || row.id === null || row.id === '') {
    row.id = `legacy-${collection}-${index}-${digest(json(row)).slice(0, 24)}`;
  }
  if (typeof row.id !== 'string' || row.id.length > 200) throw stateError(`Invalid ${collection} record ID in saved bot state.`);
  return row.id;
}

function normalizeState(value, defaults = baseState()) {
  if (!object(value) || !object(defaults)) throw stateError('Saved bot state must be a JSON object.');
  const state = { ...baseState(), ...defaults, ...value };
  if (!object(state.users) || !Array.isArray(state.registrations) || !Array.isArray(state.payments) || !Array.isArray(state.admin_chat_ids)) {
    throw stateError('Saved bot state has invalid collections.');
  }
  if (!Number.isSafeInteger(state.last_update_id) || state.last_update_id < 0) throw stateError('Saved Telegram update offset is invalid.');
  if (state.completed_update_ids !== undefined && (!Array.isArray(state.completed_update_ids) || state.completed_update_ids.some(id => !Number.isSafeInteger(id) || id < 0))) {
    throw stateError('Saved completed Telegram update IDs are invalid.');
  }
  for (const profile of Object.values(state.users)) if (!object(profile)) throw stateError('Saved bot user profile is invalid.');
  for (const collection of COLLECTIONS) {
    const ids = new Set();
    const receipts = new Set();
    state[collection].forEach((row, index) => {
      const id = rowId(row, collection, index);
      if (ids.has(id)) throw stateError(`Duplicate ${collection} record ID; operator review is required.`);
      ids.add(id);
      const key = collection === 'payments' ? deliveryKey(row) : null;
      if (key && receipts.has(key)) throw stateError('Duplicate payment receipt; operator review is required before migration.');
      if (key) receipts.add(key);
    });
  }
  return state;
}

function validateMetadata(key, value) {
  if (key === 'last_update_id' && (!Number.isSafeInteger(value) || value < 0)) throw stateError('Saved Telegram update offset is invalid.');
  if (key === 'admin_chat_ids' && !Array.isArray(value)) throw stateError('Saved admin chat IDs must be an array.');
  if (key === 'completed_update_ids' && (!Array.isArray(value) || value.some(id => !Number.isSafeInteger(id) || id < 0))) throw stateError('Saved completed Telegram update IDs are invalid.');
}

function parseLegacy(dataDir, defaults, required = false) {
  const filename = path.join(dataDir, LEGACY_NAME);
  let bytes;
  try { bytes = fs.readFileSync(filename); }
  catch (error) { if (error.code === 'ENOENT' && !required) return { state: normalizeState({}, defaults), bytes: null }; throw stateError('Legacy bot state could not be read.'); }
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { throw stateError('Legacy bot state is not valid JSON; no data was replaced.'); }
  return { state: normalizeState(parsed, defaults), bytes };
}

function configureDatabase(database) {
  database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
}

function createSchema(database) {
  database.exec(`
    CREATE TABLE store_control (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE records (
      collection TEXT NOT NULL CHECK (collection IN ('registrations','payments')),
      id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL,
      status TEXT, dedupe_key TEXT,
      PRIMARY KEY (collection,id), UNIQUE (collection,dedupe_key)
    );
    CREATE INDEX records_position ON records(collection,position);
    CREATE INDEX records_pending_fifo ON records(status);
    CREATE TABLE meta (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
    INSERT INTO store_control(key,value) VALUES ('schema_version','1');
  `);
}

function assertSchema(database) {
  try {
    if (database.prepare("SELECT value FROM store_control WHERE key='schema_version'").get()?.value !== '1') throw new Error();
    const check = database.prepare('PRAGMA quick_check').get();
    if (check.quick_check !== 'ok') throw new Error();
  } catch { throw stateError('SQLite bot state is invalid or uses an unsupported schema; no data was replaced.'); }
}

function readDatabase(database) {
  const state = {};
  for (const row of database.prepare('SELECT key,payload FROM meta').all()) Object.defineProperty(state, row.key, { value: JSON.parse(row.payload), enumerable: true, writable: true, configurable: true });
  state.users = {};
  for (const row of database.prepare('SELECT id,payload FROM users').all()) Object.defineProperty(state.users, row.id, { value: JSON.parse(row.payload), enumerable: true, writable: true, configurable: true });
  for (const collection of COLLECTIONS) {
    state[collection] = database.prepare('SELECT id,payload FROM records WHERE collection=? ORDER BY position,id').all(collection).map(row => {
      const value = JSON.parse(row.payload);
      if (value.id !== row.id) throw stateError('SQLite bot record ID is inconsistent.');
      return value;
    });
  }
  return normalizeState(state);
}

function transaction(database, run) {
  database.exec('BEGIN IMMEDIATE');
  try { const result = run(); database.exec('COMMIT'); return result; }
  catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
}

function replaceDatabase(database, state) {
  database.exec('DELETE FROM users; DELETE FROM records; DELETE FROM meta;');
  const insertUser = database.prepare('INSERT INTO users(id,payload) VALUES (?,?)');
  const insertRow = database.prepare('INSERT INTO records(collection,id,position,payload,status,dedupe_key) VALUES (?,?,?,?,?,?)');
  const insertMeta = database.prepare('INSERT INTO meta(key,payload) VALUES (?,?)');
  for (const [key, value] of Object.entries(state.users)) insertUser.run(key, json(value));
  for (const collection of COLLECTIONS) state[collection].forEach((row, index) => insertRow.run(collection, row.id, index, json(row), typeof row.status === 'string' ? row.status : null, collection === 'payments' ? deliveryKey(row) : null));
  for (const [key, value] of Object.entries(state)) if (key !== 'users' && !COLLECTIONS.includes(key)) insertMeta.run(key, json(value));
}

function createStateStore({ dataDir, emptyDb = baseState } = {}) {
  if (!dataDir) throw stateError('A bot data directory is required.');
  dataDir = path.resolve(dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const releaseLock = acquireLock(dataDir);
  const filename = path.join(dataDir, SQLITE_NAME);
  const existed = fs.existsSync(filename);
  let database;
  try {
    const defaults = clone(typeof emptyDb === 'function' ? emptyDb() : emptyDb);
    // Parse and back up before creating SQLite, so invalid JSON remains untouched.
    const initial = existed ? null : parseLegacy(dataDir, defaults);
    if (initial?.bytes) backupLegacy(dataDir, initial.bytes);
    database = new DatabaseSync(filename);
    fs.chmodSync(filename, 0o600);
    configureDatabase(database);
    if (!existed) transaction(database, () => { createSchema(database); replaceDatabase(database, initial.state); });
    assertSchema(database);
    database.exec('CREATE INDEX IF NOT EXISTS records_pending_fifo ON records(status)');
    const handoff = database.prepare("SELECT value FROM store_control WHERE key='legacy_handoff'").get();
    if (handoff) {
      const legacy = parseLegacy(dataDir, defaults, true);
      backupLegacy(dataDir, legacy.bytes);
      const backup = path.join(dataDir, `${SQLITE_NAME}.pre-legacy-import.${crypto.randomUUID()}.bak`);
      database.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
      transaction(database, () => {
        replaceDatabase(database, legacy.state);
        database.prepare("DELETE FROM store_control WHERE key='legacy_handoff'").run();
      });
    }
    const state = readDatabase(database);
    return attachStore(database, state, releaseLock, dataDir);
  } catch (error) {
    try {
      database?.close();
      // Keep the exclusive lock during cleanup: a new owner must not create a
      // SQLite file between our lock release and failed-migration cleanup.
      if (!existed) for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(filename + suffix); } catch (removeError) { if (removeError.code !== 'ENOENT') throw removeError; } }
    } finally { releaseLock(); }
    if (error.code === 'STATE_STORE_ERROR') throw error;
    throw stateError('Bot state initialization failed; saved data was not replaced.', error);
  }
}

function attachStore(database, state, releaseLock, dataDir) {
  let closed = false;
  let writes = 0;
  let commits = 0;
  let serializations = 0;
  const dirtyUsers = new Set();
  const dirtyMeta = new Set();
  const dirtyRows = { registrations: new Set(), payments: new Set() };
  const full = new Set();
  const indexes = { registrations: new Map(), payments: new Map() };
  const proxies = new WeakMap();
  const rawByProxy = new WeakMap();
  const ensureOpen = () => { if (closed) throw stateError('Bot state store is closed.'); };
  const serialize = value => { serializations++; const result = json(value); if (result === undefined) throw stateError('Undefined top-level bot state cannot be saved.'); return result; };
  const unwrap = value => rawByProxy.get(value) || value;
  function rebuild(collection) {
    const map = new Map();
    for (let index = 0; index < state[collection].length; index++) if (!own(state[collection], index)) throw stateError('Sparse bot delivery collections are not supported.');
    state[collection].forEach((row, index) => {
      const id = rowId(row, collection, index);
      if (map.has(id)) throw stateError(`Duplicate ${collection} record ID.`);
      map.set(id, index);
    });
    indexes[collection] = map;
  }
  COLLECTIONS.forEach(rebuild);
  function nested(target, token, mark, rootRecord = false) {
    if (!target || typeof target !== 'object') return target;
    let variants = proxies.get(target);
    if (!variants) { variants = new Map(); proxies.set(target, variants); }
    if (variants.has(token)) return variants.get(token);
    const proxy = new Proxy(target, {
      get(objectValue, key) { return nested(Reflect.get(objectValue, key), token, mark); },
      set(objectValue, key, value) {
        ensureOpen();
        if (rootRecord && key === 'id' && value !== objectValue.id) throw stateError('Saved bot record IDs are immutable.');
        value = unwrap(value);
        if (!Object.is(objectValue[key], value)) { Reflect.set(objectValue, key, value); mark(); }
        return true;
      },
      deleteProperty(objectValue, key) {
        ensureOpen();
        if (rootRecord && key === 'id') throw stateError('Saved bot record IDs are immutable.');
        if (own(objectValue, key)) { Reflect.deleteProperty(objectValue, key); mark(); }
        return true;
      },
      defineProperty(objectValue, key, descriptor) {
        ensureOpen();
        if (rootRecord && key === 'id') throw stateError('Saved bot record IDs are immutable.');
        Reflect.defineProperty(objectValue, key, descriptor); mark(); return true;
      },
    });
    variants.set(token, proxy); rawByProxy.set(proxy, target); return proxy;
  }
  function usersProxy() {
    return new Proxy(state.users, {
      get(target, key) { return nested(Reflect.get(target, key), `user:${String(key)}`, () => dirtyUsers.add(String(key))); },
      set(target, key, value) { ensureOpen(); value = unwrap(value); if (!object(value)) throw stateError('Bot user profile must be an object.'); Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true }); dirtyUsers.add(String(key)); return true; },
      deleteProperty(target, key) { ensureOpen(); Reflect.deleteProperty(target, key); dirtyUsers.add(String(key)); return true; },
      defineProperty() { throw stateError('Use ordinary assignments for saved bot user profiles.'); },
    });
  }
  function collectionProxy(collection) {
    return new Proxy(state[collection], {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && value) {
          const id = rowId(value, collection, Number(key));
          return nested(value, `${collection}:${id}`, () => dirtyRows[collection].add(id), true);
        }
        return value;
      },
      set(target, key, value) {
        ensureOpen(); value = unwrap(value);
        if (key === 'length') {
          if (value !== target.length) full.add(collection);
          Reflect.set(target, key, value); return true;
        }
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) throw stateError('Invalid delivery collection property.');
        const index = Number(key);
        if (index > target.length) throw stateError('Sparse bot delivery collections are not supported.');
        const id = rowId(value, collection, index);
        if (index === target.length && !full.has(collection)) {
          if (indexes[collection].has(id)) throw stateError(`Duplicate ${collection} record ID.`);
          indexes[collection].set(id, index); dirtyRows[collection].add(id);
        } else full.add(collection);
        Reflect.set(target, key, value); return true;
      },
      deleteProperty(target, key) { ensureOpen(); Reflect.deleteProperty(target, key); full.add(collection); return true; },
      defineProperty() { throw stateError('Use ordinary assignments for saved bot delivery collections.'); },
    });
  }
  let users = usersProxy();
  const arrays = Object.fromEntries(COLLECTIONS.map(collection => [collection, collectionProxy(collection)]));
  const proxy = new Proxy(state, {
    get(target, key) {
      if (key === 'users') return users;
      if (COLLECTIONS.includes(key)) return arrays[key];
      return nested(Reflect.get(target, key), `meta:${String(key)}`, () => dirtyMeta.add(String(key)));
    },
    set(target, key, value) {
      ensureOpen(); value = unwrap(value);
      if (key === 'users') {
        if (!object(value)) throw stateError('Bot users must be an object.');
        target.users = value; users = usersProxy(); full.add('users');
      } else if (COLLECTIONS.includes(key)) {
        if (!Array.isArray(value)) throw stateError('Bot deliveries must be arrays.');
        target[key] = value; arrays[key] = collectionProxy(key); full.add(key);
      } else { Reflect.set(target, key, value); dirtyMeta.add(String(key)); }
      return true;
    },
    deleteProperty(target, key) {
      ensureOpen();
      if (key === 'users' || COLLECTIONS.includes(key)) throw stateError('Bot state collections cannot be deleted.');
      Reflect.deleteProperty(target, key); dirtyMeta.add(String(key)); return true;
    },
    defineProperty() { throw stateError('Use ordinary assignments for saved bot metadata.'); },
  });
  rawByProxy.set(proxy, state);

  const statements = {
    user: database.prepare('SELECT payload FROM users WHERE id=?'),
    upsertUser: database.prepare('INSERT INTO users(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload'),
    deleteUser: database.prepare('DELETE FROM users WHERE id=?'),
    row: database.prepare('SELECT payload,position FROM records WHERE collection=? AND id=?'),
    upsertRow: database.prepare('INSERT INTO records(collection,id,position,payload,status,dedupe_key) VALUES (?,?,?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET position=excluded.position,payload=excluded.payload,status=excluded.status,dedupe_key=excluded.dedupe_key'),
    deleteRow: database.prepare('DELETE FROM records WHERE collection=? AND id=?'),
    meta: database.prepare('SELECT payload FROM meta WHERE key=?'),
    upsertMeta: database.prepare('INSERT INTO meta(key,payload) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload'),
    deleteMeta: database.prepare('DELETE FROM meta WHERE key=?'),
  };

  function save(input = proxy) {
    ensureOpen();
    if (input !== proxy && input !== state) {
      // Compatibility for isolated tests/tools using plain snapshots. Runtime
      // callers always retain load()'s proxy and never take this full-diff path.
      const replacement = normalizeState(clone(input));
      for (const key of Object.keys(state)) if (!own(replacement, key)) delete proxy[key];
      for (const [key, value] of Object.entries(replacement)) proxy[key] = value;
      full.add('users'); COLLECTIONS.forEach(collection => full.add(collection));
    }
    if (!dirtyUsers.size && !dirtyMeta.size && !dirtyRows.registrations.size && !dirtyRows.payments.size && !full.size) return;
    for (const collection of COLLECTIONS) if (full.has(collection)) rebuild(collection);
    if (full.has('users')) {
      for (const { id } of database.prepare('SELECT id FROM users').all()) dirtyUsers.add(id);
      for (const id of Object.keys(state.users)) dirtyUsers.add(id);
    }
    for (const collection of COLLECTIONS) if (full.has(collection)) {
      for (const { id } of database.prepare('SELECT id FROM records WHERE collection=?').all(collection)) dirtyRows[collection].add(id);
      for (const id of indexes[collection].keys()) dirtyRows[collection].add(id);
    }
    let changes = 0;
    try {
      transaction(database, () => {
        for (const id of dirtyUsers) {
          if (!own(state.users, id)) { changes += statements.deleteUser.run(id).changes; continue; }
          if (!object(state.users[id])) throw stateError('Bot user profile must be an object.');
          const payload = serialize(state.users[id]);
          if (statements.user.get(id)?.payload !== payload) changes += statements.upsertUser.run(id, payload).changes;
        }
        for (const collection of COLLECTIONS) {
          // Remove absent rows before upserts, including receipt dedupe keys.
          for (const id of dirtyRows[collection]) if (!indexes[collection].has(id)) changes += statements.deleteRow.run(collection, id).changes;
          for (const id of dirtyRows[collection]) {
            const index = indexes[collection].get(id);
            if (index === undefined) continue;
            const row = state[collection][index];
            const payload = serialize(row);
            const existing = statements.row.get(collection, id);
            if (existing?.payload !== payload || existing.position !== index) changes += statements.upsertRow.run(collection, id, index, payload, typeof row.status === 'string' ? row.status : null, collection === 'payments' ? deliveryKey(row) : null).changes;
          }
        }
        for (const key of dirtyMeta) {
          if (!own(state, key)) { changes += statements.deleteMeta.run(key).changes; continue; }
          validateMetadata(key, state[key]);
          const payload = serialize(state[key]);
          if (statements.meta.get(key)?.payload !== payload) changes += statements.upsertMeta.run(key, payload).changes;
        }
      });
    } catch (error) { throw stateError('Bot state transaction failed; no partial changes were committed.', error); }
    writes += changes; commits++;
    dirtyUsers.clear(); dirtyMeta.clear(); COLLECTIONS.forEach(collection => dirtyRows[collection].clear()); full.clear();
  }

  function claimDelivery(collection, id, allowedStatuses = ['pending']) {
    ensureOpen();
    if (!COLLECTIONS.includes(collection) || typeof id !== 'string' || !Array.isArray(allowedStatuses) || !allowedStatuses.length || allowedStatuses.some(value => typeof value !== 'string')) throw stateError('Invalid delivery claim.');
    save();
    const index = indexes[collection].get(id);
    if (index === undefined) return false;
    const row = state[collection][index];
    const result = transaction(database, () => {
      const saved = database.prepare('SELECT payload,status FROM records WHERE collection=? AND id=?').get(collection, id);
      if (!saved || !allowedStatuses.includes(saved.status)) return false;
      const value = JSON.parse(saved.payload); value.status = 'sending';
      const changed = database.prepare('UPDATE records SET status=?,payload=? WHERE collection=? AND id=? AND status=?').run('sending', serialize(value), collection, id, saved.status).changes;
      return changed === 1;
    });
    if (result) { row.status = 'sending'; writes++; commits++; }
    return result;
  }

  function checkpoint() {
    ensureOpen(); save();
    atomicWrite(path.join(dataDir, LEGACY_NAME), json(state));
  }

  function pendingDeliveries(limit, excludeKeys = new Set()) {
    ensureOpen();
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000 || !(excludeKeys instanceof Set)) throw stateError('Invalid pending delivery query.');
    if (limit === 0) return [];
    const result = [];
    // The status index includes SQLite's rowid, so this is FIFO across both
    // collections without sorting/scanning historical deliveries.
    const rows = database.prepare("SELECT collection,id FROM records WHERE status='pending' ORDER BY rowid LIMIT ?").all(limit + excludeKeys.size);
    for (const { collection, id } of rows) {
      if (excludeKeys.has(`${collection}:${id}`)) continue;
      const index = indexes[collection].get(id);
      if (index === undefined) throw stateError('Pending delivery is missing from the cached bot state.');
      const row = arrays[collection][index];
      if (row.status !== 'pending') throw stateError('Pending delivery query requires saved bot state.');
      result.push({ collection, row });
      if (result.length === limit) break;
    }
    return result;
  }

  function findReceipt(candidate) {
    ensureOpen();
    if (!object(candidate)) throw stateError('Invalid receipt lookup.');
    const key = deliveryKey(candidate);
    if (!key) return null;
    const saved = database.prepare("SELECT id FROM records WHERE collection='payments' AND dedupe_key=?").get(key);
    if (!saved) return null;
    const index = indexes.payments.get(saved.id);
    if (index === undefined) throw stateError('Receipt lookup is inconsistent with cached bot state.');
    return arrays.payments[index];
  }

  function close() {
    if (closed) return;
    let error;
    try { checkpoint(); database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (caught) { error = caught; }
    try { database.close(); } catch (caught) { error ||= caught; }
    closed = true;
    try { releaseLock(); } catch (caught) { error ||= caught; }
    if (error) throw error;
  }

  return {
    load() { ensureOpen(); return proxy; }, save, close, checkpoint, claimDelivery, pendingDeliveries, findReceipt,
    stats() { ensureOpen(); return { users: Object.keys(state.users).length, registrations: state.registrations.length, payments: state.payments.length, writes, commits, serializedRecords: serializations, journalMode: database.prepare('PRAGMA journal_mode').get().journal_mode, synchronous: database.prepare('PRAGMA synchronous').get().synchronous, busyTimeoutMs: database.prepare('PRAGMA busy_timeout').get().timeout }; },
    snapshot({ persisted = false } = {}) { ensureOpen(); return persisted ? readDatabase(database) : clone(state); },
  };
}

function readState({ dataDir }) {
  const filename = path.join(path.resolve(dataDir), SQLITE_NAME);
  if (!fs.existsSync(filename)) return parseLegacy(path.resolve(dataDir), baseState()).state;
  const database = new DatabaseSync(filename, { readOnly: true });
  try { database.exec('PRAGMA busy_timeout=5000; BEGIN'); assertSchema(database); return readDatabase(database); }
  finally { database.close(); }
}

function exportLegacy({ dataDir }) {
  dataDir = path.resolve(dataDir);
  const filename = path.join(dataDir, SQLITE_NAME);
  if (!fs.existsSync(filename)) return { exported: false };
  const releaseLock = acquireLock(dataDir);
  let database;
  try {
    database = new DatabaseSync(filename);
    configureDatabase(database); assertSchema(database);
    // If already handed off, JSON may contain newer legacy-bot writes. Never
    // overwrite it on a repeated rollback attempt.
    if (database.prepare("SELECT value FROM store_control WHERE key='legacy_handoff'").get()) {
      parseLegacy(dataDir, baseState(), true);
      return { exported: false, handoff: true };
    }
    const state = readDatabase(database);
    atomicWrite(path.join(dataDir, LEGACY_NAME), json(state));
    transaction(database, () => database.prepare("INSERT INTO store_control(key,value) VALUES ('legacy_handoff',?)").run(new Date().toISOString()));
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { exported: true, handoff: true };
  } finally { try { database?.close(); } finally { releaseLock(); } }
}

module.exports = { createStateStore, readState, exportLegacy, SQLITE_NAME, LEGACY_NAME };

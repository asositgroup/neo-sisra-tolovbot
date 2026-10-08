/**
 * Add this file to the existing payment Apps Script project. Dispatch JSON
 * actions updatePhone / phone_* before its existing doPost logging and lock:
 *   return ContentService.createTextOutput(JSON.stringify(phoneSyncDispatch_(data)))
 *     .setMimeType(ContentService.MimeType.JSON);
 *
 * Script properties (never place the shared secret in client-side code):
 * PHONE_UPDATE_SECRET, PHONE_CONTACT_SHEET_ID, PHONE_PAYMENT_SHEET_ID,
 * PHONE_UPDATE_TARGETS = contacts | payments | both.
 * Only existing column B cells are updated. No new sheets, rows, or columns.
 */
function phoneSyncDispatch_(request) {
  var properties = PropertiesService.getScriptProperties();
  var secret = properties.getProperty('PHONE_UPDATE_SECRET');
  if (!request || !phoneSyncSecretEqual_(secret, request.secret)) {
    return { result: 'error', ok: false, code: 'UNAUTHORIZED' };
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { result: 'error', ok: false, code: 'BUSY' };
  try {
    var config = phoneSyncConfig_(properties);
    if (request.action === 'phone_health') return phoneSyncHealth_(config);
    if (request.action === 'phone_seed') return phoneSyncSeed_(properties, config, request);
    if (request.action === 'updatePhone') return phoneSyncUpdate_(properties, config, request);
    return { result: 'error', ok: false, code: 'UNKNOWN_ACTION' };
  } catch (error) {
    // Never expose exceptions: Apps Script exceptions can contain cell values.
    var allowed = ['CONFIG_REQUIRED', 'INVALID_REQUEST', 'INVALID_SEED', 'INVALID_STATE',
      'SHEET_MISSING', 'HEADER_MISMATCH', 'ROW_NOT_FOUND', 'AMBIGUOUS_ROW',
      'FORMULA_PROTECTED', 'REVISION_CONFLICT', 'SEED_CONFLICT', 'STATE_TOO_LARGE'];
    return { result: 'error', ok: false,
      code: allowed.indexOf(error && error.message) >= 0 ? error.message : 'RETRY_REQUIRED' };
  } finally {
    lock.releaseLock();
  }
}

function phoneSyncSecretEqual_(expected, provided) {
  if (typeof expected !== 'string' || expected.length < 24 ||
      typeof provided !== 'string' || provided.length !== expected.length) return false;
  var difference = 0;
  for (var i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return difference === 0;
}

function phoneSyncFail_(code) { throw new Error(code); }

function phoneSyncConfig_(properties) {
  var config = { targets: properties.getProperty('PHONE_UPDATE_TARGETS'),
    contacts: properties.getProperty('PHONE_CONTACT_SHEET_ID'),
    payments: properties.getProperty('PHONE_PAYMENT_SHEET_ID') };
  if (['contacts', 'payments', 'both'].indexOf(config.targets) < 0) phoneSyncFail_('CONFIG_REQUIRED');
  ['contacts', 'payments'].forEach(function (target) {
    if ((config.targets === target || config.targets === 'both') &&
        !/^[A-Za-z0-9_-]{20,}$/.test(config[target] || '')) phoneSyncFail_('CONFIG_REQUIRED');
  });
  return config;
}

function phoneSyncTable_(spreadsheetId, sheetId) {
  var book = SpreadsheetApp.openById(spreadsheetId);
  var sheet = sheetId === 'contacts' ? book.getSheetByName('Sheet1') :
    book.getSheets().filter(function (item) { return item.getSheetId() === sheetId; })[0];
  if (!sheet) phoneSyncFail_('SHEET_MISSING');
  var rows = sheet.getDataRange().getDisplayValues();
  var expected = sheetId === 'contacts' ?
    ['Ism (botda kiritilgan)', 'Telefon (botda kiritilgan)', 'Telegram username',
      'Telegram profil havolasi', 'Telegram ID'] : sheetId === 0 ?
      ['Ism', 'Telefon raqam', 'Tarif', 'Offerta', 'Check URL', 'sana', 'vaqt'] :
      ['Ism', 'Telefon raqam', 'Tarif', 'Oferta', 'Sana'];
  if (!rows.length || expected.some(function (header, column) {
    return String(rows[0][column] || '').trim() !== header;
  })) phoneSyncFail_('HEADER_MISMATCH');
  return { sheet: sheet, rows: rows };
}

function phoneSyncHealth_(config) {
  var checked = [];
  if (config.targets === 'contacts' || config.targets === 'both') {
    phoneSyncTable_(config.contacts, 'contacts');
    checked.push('contacts');
  }
  if (config.targets === 'payments' || config.targets === 'both') {
    phoneSyncTable_(config.payments, 1596542810);
    phoneSyncTable_(config.payments, 0);
    checked.push('payments');
  }
  return { result: 'success', ok: true, targets: checked, headersValid: true };
}

function phoneSyncId_(id) { return typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id); }

function phoneSyncPhone_(phone) {
  return typeof phone === 'string' && /^\+[1-9]\d{6,14}$/.test(phone) &&
    (phone.indexOf('+998') !== 0 || /^\+998\d{9}$/.test(phone));
}

function phoneSyncStateKey_(id) { return 'PHONE_SYNC_USER_' + id; }

function phoneSyncState_(properties, id) {
  return phoneSyncParseState_(properties.getProperty(phoneSyncStateKey_(id)));
}

function phoneSyncParseState_(raw) {
  if (!raw) return { revision: 0, payload: null, status: 'new', entries: [], pendingPhones: [] };
  var state;
  try { state = JSON.parse(raw); } catch (error) { phoneSyncFail_('INVALID_STATE'); }
  if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !Array.isArray(state.entries) || !Array.isArray(state.pendingPhones)) phoneSyncFail_('INVALID_STATE');
  return state;
}

function phoneSyncSerialize_(state) {
  var json = JSON.stringify(state);
  // ScriptProperties has a 9 KB per-value ceiling; measure UTF-8, not characters.
  if (Utilities.newBlob(json).getBytes().length > 8500) phoneSyncFail_('STATE_TOO_LARGE');
  return json;
}

function phoneSyncEntry_(value) {
  if (!value || [0, 1596542810].indexOf(value.sheetId) < 0 ||
      ['name', 'originalPhone', 'date'].some(function (field) {
        return typeof value[field] !== 'string' || !value[field] || value[field].length > 500;
      }) || (value.sheetId === 0 &&
        (typeof value.time !== 'string' || typeof value.checkUrl !== 'string' || !value.checkUrl))) {
    phoneSyncFail_('INVALID_SEED');
  }
  return { sheetId: value.sheetId, name: value.name, originalPhone: value.originalPhone,
    currentPhone: value.originalPhone, date: value.date,
    time: value.sheetId === 0 ? value.time : '',
    checkUrl: value.sheetId === 0 ? value.checkUrl : '' };
}

function phoneSyncFingerprint_(entry, includePhone) {
  return JSON.stringify([entry.sheetId, entry.name, phoneSyncDateKey_(entry.date) || entry.date,
    phoneSyncTimeKey_(entry.time) || entry.time, phoneSyncDriveId_(entry.checkUrl) || entry.checkUrl]
    .concat(includePhone ? [entry.originalPhone] : []));
}

function phoneSyncTimeKey_(text) {
  var match = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(text || '');
  if (!match || Number(match[1]) > 23) return null;
  return ('0' + match[1]).slice(-2) + ':' + match[2] + ':' + match[3];
}

function phoneSyncDateKey_(text) {
  var match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{1,2}:[0-5]\d:[0-5]\d))?$/.exec(text || '');
  var year, month, day, time;
  if (match) {
    year = match[1]; month = match[2]; day = match[3]; time = match[4];
  } else {
    match = /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{1,2}:[0-5]\d:[0-5]\d))?$/.exec(text || '');
    if (!match) return null;
    year = match[3]; month = match[2]; day = match[1]; time = match[4];
  }
  var date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) ||
      date.getUTCDate() !== Number(day) || (time && !phoneSyncTimeKey_(time))) return null;
  return year + '-' + month + '-' + day + (time ? ' ' + phoneSyncTimeKey_(time) : '');
}

function phoneSyncDriveId_(text) {
  if (typeof text !== 'string') return null;
  var path = /^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,})\/(?:view|preview)(?:\?[^\s#]*)?$/.exec(text);
  if (path) return path[1];
  var query = /^https:\/\/drive\.google\.com\/(?:uc|open|thumbnail)\?([^\s#]+)$/.exec(text);
  if (!query) return null;
  var ids = query[1].split('&').filter(function (part) { return part.indexOf('id=') === 0; });
  if (ids.length !== 1 || !/^id=[A-Za-z0-9_-]{10,}$/.test(ids[0])) return null;
  return ids[0].slice(3);
}

function phoneSyncEquivalent_(left, right, normalizer) {
  if (left === right) return true;
  var leftKey = normalizer(left), rightKey = normalizer(right);
  return leftKey !== null && rightKey !== null && leftKey === rightKey;
}

function phoneSyncResolveEntry_(table, entry) {
  var matches = [];
  table.rows.forEach(function (row, index) {
    if (index === 0 || row[0] !== entry.name || row[1] !== entry.originalPhone) return;
    if (entry.sheetId === 0 ?
      !phoneSyncEquivalent_(row[4], entry.checkUrl, phoneSyncDriveId_) ||
      !phoneSyncEquivalent_(row[5], entry.date, phoneSyncDateKey_) ||
      !phoneSyncEquivalent_(row[6], entry.time, phoneSyncTimeKey_) :
      !phoneSyncEquivalent_(row[4], entry.date, phoneSyncDateKey_)) return;
    matches.push(index);
  });
  if (matches.length > 1) phoneSyncFail_('AMBIGUOUS_ROW');
  if (matches.length === 0) phoneSyncFail_('ROW_NOT_FOUND');
  var row = table.rows[matches[0]];
  phoneSyncCell_(table.sheet, matches[0] + 1);
  // Persist the verified Sheet display values, never a guessed row number or
  // a normalization of its original phone/name. Subsequent updates stay exact.
  return { sheetId: entry.sheetId, name: row[0], originalPhone: row[1], currentPhone: row[1],
    date: entry.sheetId === 0 ? row[5] : row[4],
    time: entry.sheetId === 0 ? row[6] : '', checkUrl: entry.sheetId === 0 ? row[4] : '' };
}

function phoneSyncPaymentRow_(table, entry, pendingPhones) {
  var phones = [entry.currentPhone].concat(pendingPhones || []);
  var matches = [];
  table.rows.forEach(function (row, index) {
    if (index === 0 || row[0] !== entry.name || phones.indexOf(row[1]) < 0) return;
    if (entry.sheetId === 0 ? row[4] !== entry.checkUrl || row[5] !== entry.date || row[6] !== entry.time :
        row[4] !== entry.date) return;
    matches.push(index + 1);
  });
  if (matches.length > 1) phoneSyncFail_('AMBIGUOUS_ROW');
  if (matches.length === 0) phoneSyncFail_('ROW_NOT_FOUND');
  return phoneSyncCell_(table.sheet, matches[0]);
}

function phoneSyncCell_(sheet, row) {
  var cell = sheet.getRange(row, 2, 1, 1);
  if (cell.getFormula()) phoneSyncFail_('FORMULA_PROTECTED');
  return cell;
}

function phoneSyncSeed_(properties, config, request) {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(config.payments || '') || !Array.isArray(request.records) ||
      request.records.length === 0 || request.records.length > 100) phoneSyncFail_('INVALID_SEED');
  var tables = {}, owners = {}, changes = {}, seenIds = {}, count = 0;
  var all = properties.getProperties();
  Object.keys(all).filter(function (key) { return key.indexOf('PHONE_SYNC_USER_') === 0; })
    .forEach(function (key) {
      var id = key.slice('PHONE_SYNC_USER_'.length);
      var state = phoneSyncParseState_(all[key]);
      state.entries.forEach(function (entry) { owners[phoneSyncFingerprint_(entry, false)] = id; });
    });
  request.records.forEach(function (record) {
    if (!record || !phoneSyncId_(record.telegramId) || seenIds[record.telegramId] ||
        !Array.isArray(record.entries) || record.entries.length > 40) phoneSyncFail_('INVALID_SEED');
    seenIds[record.telegramId] = true;
    var state = phoneSyncState_(properties, record.telegramId);
    record.entries.forEach(function (rawEntry) {
      var entry = phoneSyncEntry_(rawEntry);
      var fingerprint = phoneSyncFingerprint_(entry, true);
      var ownership = phoneSyncFingerprint_(entry, false);
      if (owners[ownership] && owners[ownership] !== record.telegramId) phoneSyncFail_('SEED_CONFLICT');
      if (state.entries.some(function (existing) { return phoneSyncFingerprint_(existing, true) === fingerprint; })) return;
      if (!tables[entry.sheetId]) tables[entry.sheetId] = phoneSyncTable_(config.payments, entry.sheetId);
      entry = phoneSyncResolveEntry_(tables[entry.sheetId], entry);
      owners[ownership] = record.telegramId;
      state.entries.push(entry);
      count++;
    });
    changes[phoneSyncStateKey_(record.telegramId)] = phoneSyncSerialize_(state);
  });
  properties.setProperties(changes, false);
  return { result: 'success', ok: true, addedMappings: count };
}

function phoneSyncUpdate_(properties, config, request) {
  if (!phoneSyncId_(request.telegramId) || !phoneSyncPhone_(request.phone) ||
      (request.additionalPhone !== null && !phoneSyncPhone_(request.additionalPhone)) ||
      request.additionalPhone === request.phone || !Number.isSafeInteger(request.revision) ||
      request.revision < 1 || typeof request.updatedAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(request.updatedAt) ||
      !Number.isFinite(Date.parse(request.updatedAt)) ||
      (request.entries !== undefined && (!Array.isArray(request.entries) || request.entries.length > 40))) {
    phoneSyncFail_('INVALID_REQUEST');
  }
  var payload = JSON.stringify([request.phone, request.additionalPhone, request.updatedAt]);
  var state = phoneSyncState_(properties, request.telegramId);
  if (request.revision < state.revision) {
    return { result: 'error', ok: false, code: 'STALE_REVISION' };
  }
  if (request.revision === state.revision && payload !== state.payload) phoneSyncFail_('REVISION_CONFLICT');
  if (request.entries !== undefined && request.entries.length) {
    // Entries come only from the authenticated bot's captured successful append
    // payload. Validate request/revision first, then resolve every new mapping
    // under this same script lock. Stale requests may not change identity state.
    phoneSyncSeed_(properties, config, {
      records: [{ telegramId: request.telegramId, entries: request.entries }]
    });
    state = phoneSyncState_(properties, request.telegramId);
  }
  var value = request.phone + (request.additionalPhone ? ' / ' + request.additionalPhone : '');
  var cells = [], tables = {}, matchedEntries = [], missingEntries = false;
  if (config.targets === 'contacts' || config.targets === 'both') {
    var contacts = phoneSyncTable_(config.contacts, 'contacts');
    var matches = [];
    contacts.rows.forEach(function (row, index) {
      if (index > 0 && row[4] === request.telegramId) matches.push(index + 1);
    });
    if (matches.length > 1) phoneSyncFail_('AMBIGUOUS_ROW');
    if (matches.length === 1) cells.push(phoneSyncCell_(contacts.sheet, matches[0]));
  }
  if (config.targets === 'payments' || config.targets === 'both') {
    state.entries.forEach(function (entry) {
      if (!tables[entry.sheetId]) tables[entry.sheetId] = phoneSyncTable_(config.payments, entry.sheetId);
      try {
        cells.push(phoneSyncPaymentRow_(tables[entry.sheetId], entry, state.pendingPhones));
        matchedEntries.push(entry);
      } catch (error) {
        if (!error || error.message !== 'ROW_NOT_FOUND') throw error;
        // Existing verified rows may have been removed externally. Continue
        // only when another verified destination remains; never guess a row.
        missingEntries = true;
      }
    });
  }
  if (!cells.length) phoneSyncFail_('ROW_NOT_FOUND');
  // Fence before the first mutation. A newer revision can safely supersede a
  // partial update; its lookup accepts all fenced, possibly-written values.
  state.revision = request.revision;
  state.payload = payload;
  state.status = 'pending';
  if (state.pendingPhones.indexOf(value) < 0) state.pendingPhones.push(value);
  properties.setProperty(phoneSyncStateKey_(request.telegramId), phoneSyncSerialize_(state));
  cells.forEach(function (cell) { cell.setValue(value); });
  SpreadsheetApp.flush();
  if (config.targets === 'payments' || config.targets === 'both') {
    matchedEntries.forEach(function (entry) { entry.currentPhone = value; });
    // A missing row can reappear with a value written before an interrupted
    // request. Keep its original/current fingerprint and recovery phone values.
    if (!missingEntries) state.pendingPhones = [];
  }
  state.status = 'committed';
  state.matchedRows = cells.length;
  properties.setProperty(phoneSyncStateKey_(request.telegramId), phoneSyncSerialize_(state));
  return { result: 'success', ok: true, updated: true, telegramId: request.telegramId,
    revision: request.revision, matchedRows: cells.length };
}

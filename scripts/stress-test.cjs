'use strict';

// An OFFLINE burst through the actual long-polling runtime, SQLite store and
// paced Telegram queue. This is not a webhook or real-Telegram delivery test.
// Usage: node scripts/stress-test.cjs [--users 1500] [--latency-ms 100]
//                                   [--output /outside/temp/report.json]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const { createHash } = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');

const RUNTIME_FILES = ['bot.js', 'google-delivery.cjs', 'telegram-http.cjs',
  'state-store.cjs', 'work-queue.cjs', 'telegram-queue.cjs'];
const FAKE_TOKEN = '123456:OFFLINE_STRESS_TEST_ONLY';
const CHAT_BASE = 1000000;
const EXPECTED_START_MESSAGE = [
  '<b>Neo Sisra</b>',
  'Koreyada oʻqish va oʻqish davrida rasmiy ishlash imkoniyatlari.',
  'Koreyaga talaba yuborish va hujjatlarni rasmiylashtirish xizmati.',
  '',
  '<b>100 kishi uchun maxsus taklif</b>',
  '',
  "📋 <b>Ro'yxatdan o'tish uchun ismingizni kiriting!</b>",
  '',
  '✍️ <b>Masalan:</b> Zebo Aliyeva',
].join('\n');
const DEADLINE_MS = 300000;
const FORCE_EXIT_MS = 450000;
const root = path.resolve(__dirname, '..');
const errors = Object.create(null);
const recordError = code => { errors[code] = (errors[code] || 0) + 1; };
const original = {
  fetch: globalThis.fetch, info: console.info, error: console.error,
  connect: net.Socket.prototype.connect, createSocket: dgram.createSocket,
};
let scratch, bot, runtime, sampler, progressTimer, deadlineTimer, forceTimer;
let started, cpuStarted, cpuFinished, finished, histogram, sourceHashes = {};
let pollCalls = 0, maxBatch = 0, admitted = 0, outbound = 0, delivered = 0;
let active = 0, peakActive = 0, pendingPeak = 0, totalQueuePeak = 0;
let rssPeak = 0, heapPeak = 0, googleRequests = 0, blockedNetworkCalls = 0;
let messageErrors = 0, protocolErrors = 0, batchBarrierErrors = 0, timedOut = false, runningFinished = false;
let sqliteExperimentalWarnings = 0, burst = [];
let outputWritten = false, config, durable = null, lastOffset = 0;
let firstReplies = [], namePrompts = [], admissions = [], requested = [], received = [];
let sendStarted = [], sourceConfigurationVerified = false;
const round = (value, digits = 3) => Number(value.toFixed(digits));
const elapsed = () => started === undefined ? 0 : performance.now() - started;

function parseArgs() {
  const result = { users: 1500, latencyMs: 100, output: null };
  const names = new Set();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const [name, ...inline] = args[index].split('=');
    if (!['--users', '--latency-ms', '--output'].includes(name) || names.has(name)) {
      throw new Error('INVALID_ARGUMENTS');
    }
    names.add(name);
    const value = inline.length ? inline.join('=') : args[++index];
    if (!value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    if (name === '--output') result.output = path.resolve(value);
    else {
      const number = Number(value);
      const maximum = name === '--users' ? 1500 : 1000;
      if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
        throw new Error('INVALID_ARGUMENTS');
      }
      result[name === '--users' ? 'users' : 'latencyMs'] = number;
    }
  }
  return result;
}

function distribution(values) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = p => ordered.length ? round(ordered[Math.ceil(ordered.length * p) - 1] / 1000) : null;
  return { count: ordered.length, p50: percentile(0.50), p95: percentile(0.95),
    p99: percentile(0.99), max: percentile(1) };
}

function sample() {
  const memory = process.memoryUsage();
  rssPeak = Math.max(rssPeak, memory.rss);
  heapPeak = Math.max(heapPeak, memory.heapUsed);
  if (bot) {
    const queue = bot.queueStats().telegram;
    pendingPeak = Math.max(pendingPeak, queue.pending);
    totalQueuePeak = Math.max(totalQueuePeak, queue.total);
  }
}

function stopForError(code) {
  recordError(code);
  runtime?.requestStop();
  throw new Error(code);
}

function verifyDefaults(source) {
  // Fail closed if runtime defaults change instead of mislabelling a run.
  const checks = [
    /setting\('UPDATE_WORKERS',\s*100,\s*100\)/,
    /setting\('DELIVERY_WORKERS',\s*4,\s*10\)/,
    /ratePerSecond:\s*setting\('TELEGRAM_MESSAGES_PER_SECOND',\s*28,\s*30\)/,
    /perChatMs:\s*1050,\s*groupMs:\s*3100,\s*concurrency:\s*16,\s*maxPending:\s*500/,
  ];
  if (checks.some(check => !check.test(source))) throw new Error('RUNTIME_DEFAULTS_CHANGED');
  sourceConfigurationVerified = true;
}

function prepare() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-sisra-stress-'));
  fs.chmodSync(scratch, 0o700);
  if (config.output && (config.output === scratch || config.output.startsWith(scratch + path.sep))) {
    throw new Error('OUTPUT_INSIDE_TEMP');
  }
  let source = '';
  for (const filename of RUNTIME_FILES) {
    const bytes = fs.readFileSync(path.join(root, filename));
    sourceHashes[filename] = createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(scratch, filename), bytes, { mode: 0o600 });
    source += bytes.toString('utf8') + '\n';
  }
  verifyDefaults(source);
  // No .env is copied, and inherited bot settings must not select production
  // data, assets, addresses, or alter the production defaults under test.
  const envKeys = new Set([...source.matchAll(/process\.env\.([A-Z_][A-Z_0-9]*)/g)].map(match => match[1]));
  for (const name of ['UPDATE_WORKERS', 'DELIVERY_WORKERS', 'TELEGRAM_MESSAGES_PER_SECOND']) envKeys.add(name);
  for (const name of envKeys) delete process.env[name];
  Object.assign(process.env, {
    BOT_TOKEN: FAKE_TOKEN,
    GOOGLE_SCRIPT_URL: 'https://script.google.com/macros/s/OFFLINE_ONLY/exec',
    DATA_DIR: path.join(scratch, 'data'),
    PRIMARY_ADMIN_IDS: '', EXTRA_ADMIN_IDS: '', ADMIN_IDS: '', NOTIFY_CHAT_ID: '',
    WELCOME_IMAGE_PATH: '', OFFER_DOC_PATH: '',
  });
  // The six modules use fetch. Also deny raw TCP/UDP as defense in depth if a
  // future module bypasses it. No network exception contains a URL or payload.
  const denyNetwork = () => { blockedNetworkCalls++; return stopForError('RAW_NETWORK_BLOCKED'); };
  net.Socket.prototype.connect = denyNetwork;
  dgram.createSocket = denyNetwork;
  globalThis.fetch = mockedFetch;
  console.info = () => {};
  console.error = (...args) => {
    // Node 22's native SQLite warning also uses console.error. It is not a
    // runtime failure; recognize only this exact, known warning prefix.
    if (typeof args[0] === 'string' && /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time/.test(args[0])) {
      sqliteExperimentalWarnings++; return;
    }
    recordError('RUNTIME_LOGGED_ERROR');
  };
  ({ createBot: prepare.createBot } = require(path.join(scratch, 'bot.js')));
}

async function mockedFetch(value, options = {}) {
  let url;
  try { url = new URL(String(value)); } catch { return stopForError('UNEXPECTED_URL'); }
  if (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com') googleRequests++;
  if (url.origin !== 'https://api.telegram.org' || url.username || url.password ||
      !url.pathname.startsWith('/bot' + FAKE_TOKEN + '/')) return stopForError('UNEXPECTED_ENDPOINT');
  const method = url.pathname.slice(('/bot' + FAKE_TOKEN + '/').length);
  if (method === 'getUpdates') {
    pollCalls++;
    if (delivered !== admitted || active !== 0) {
      batchBarrierErrors++;
      return stopForError('BATCH_BARRIER_ERROR');
    }
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    if (options.method !== 'GET' || !Number.isSafeInteger(offset) || offset !== admitted + 1 ||
        offset <= lastOffset || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      protocolErrors++;
      return stopForError('POLL_PROTOCOL_ERROR');
    }
    lastOffset = offset;
    const batch = burst.slice(offset - 1, offset - 1 + limit);
    // All synthetic updates already exist at T0, including those that cannot
    // be admitted until earlier batches finish. Never return >100 updates.
    const admittedAt = elapsed();
    for (const update of batch) admissions[update.update_id - 1] = admittedAt;
    admitted += batch.length;
    maxBatch = Math.max(maxBatch, batch.length);
    if (!batch.length) runtime.requestStop();
    sample();
    return Response.json({ ok: true, result: batch });
  }
  if (method !== 'sendMessage' || options.method !== 'POST') return stopForError('UNEXPECTED_ENDPOINT');
  let payload;
  try { payload = JSON.parse(options.body); } catch { return stopForError('INVALID_OUTBOUND_JSON'); }
  const index = payload.chat_id - CHAT_BASE - 1;
  if (!Number.isSafeInteger(index) || index < 0 || index >= config.users || typeof payload.text !== 'string') {
    return stopForError('UNEXPECTED_MESSAGE');
  }
  const sequence = (requested[index] || 0) + 1;
  requested[index] = sequence;
  // Exact content checks both complete sections and their order in the same
  // HTML message, with the name prompt visible immediately and no keyboard.
  const correctCombinedReply = sequence === 1 && !received[index] &&
    payload.text === EXPECTED_START_MESSAGE && payload.parse_mode === 'HTML' &&
    payload.reply_markup?.remove_keyboard === true &&
    Object.keys(payload.reply_markup).length === 1;
  if (!correctCombinedReply) messageErrors++;
  outbound++;
  const messageId = outbound;
  active++;
  peakActive = Math.max(peakActive, active);
  sendStarted.push(elapsed());
  sample();
  try {
    await new Promise(resolve => setTimeout(resolve, config.latencyMs));
    if (options.signal?.aborted) return stopForError('MOCKED_REQUEST_ABORTED');
    received[index] = (received[index] || 0) + 1;
    delivered++;
    if (sequence === 1) {
      const deliveredAt = elapsed();
      firstReplies[index] = deliveredAt;
      if (correctCombinedReply) namePrompts[index] = deliveredAt;
    }
    return Response.json({ ok: true, result: { message_id: messageId, chat: { id: payload.chat_id, type: 'private' } } });
  } finally { active--; }
}

function progress() {
  const first = firstReplies.filter(Number.isFinite).length;
  const completed = namePrompts.filter(Number.isFinite).length;
  process.stderr.write(JSON.stringify({ kind: 'offline-stress-progress', elapsedSeconds: round(elapsed() / 1000),
    admitted, firstReplies: first, completedUsers: completed, deliveredMessages: delivered,
    usersStillWaitingForFirstReply: config.users - first, usersStillPending: config.users - completed }) + '\n');
}

function report() {
  const wallMs = (finished ?? performance.now()) - (started ?? performance.now());
  const cpu = cpuFinished || (cpuStarted ? process.cpuUsage(cpuStarted) : { user: 0, system: 0 });
  const first = distribution(firstReplies), prompt = distribution(namePrompts);
  const durableUsers = durable ? Object.values(durable.users || {}) : [];
  const exactRecipients = requested.filter(value => value === 1).length === config?.users &&
    received.filter(value => value === 1).length === config?.users;
  let windowPeak = 0, lower = 0;
  for (let upper = 0; upper < sendStarted.length; upper++) {
    while (sendStarted[upper] - sendStarted[lower] >= 1000) lower++;
    windowPeak = Math.max(windowPeak, upper - lower + 1);
  }
  const invariants = {
    runtimeCompleted: runningFinished,
    deadlineMet: !timedOut && wallMs <= DEADLINE_MS,
    productionDefaultsVerified: sourceConfigurationVerified,
    allUpdatesAdmitted: admitted === config?.users,
    pollBatchAtMost100: maxBatch > 0 && maxBatch <= 100,
    expectedPollCount: pollCalls === Math.ceil((config?.users || 0) / 100) + 1,
    pollOffsetsValid: protocolErrors === 0,
    eachPollWaitedForPriorBatch: batchBarrierErrors === 0,
    oneDeliveredMessagePerUser: exactRecipients && outbound === config?.users && delivered === config?.users,
    combinedWelcomeThenNamePrompt: messageErrors === 0 && first.count === config?.users && prompt.count === config?.users,
    firstReplyAndNamePromptAreSameMessage: prompt.count === config?.users &&
      firstReplies.every((value, index) => value === namePrompts[index]),
    persistedUserCount: durableUsers.length === config?.users,
    allPersistedUsersAwaitName: durableUsers.length === config?.users && durableUsers.every(user => user.step === 'name'),
    persistedLastUpdateId: durable?.last_update_id === config?.users,
    emptyCompletedUpdateIds: Array.isArray(durable?.completed_update_ids) && durable.completed_update_ids.length === 0,
    noRegistrationOrPaymentRows: !!durable && durable.registrations.length === 0 && durable.payments.length === 0,
    noGoogleRequests: googleRequests === 0,
    noNetworkBypassAttempts: blockedNetworkCalls === 0,
    telegramConcurrencyBound: peakActive <= 16,
    telegramQueueDrained: !!bot && bot.queueStats().telegram.total === 0,
    noErrors: Object.keys(errors).length === 0,
  };
  return {
    kind: 'offline-long-polling-stress-test', passed: Object.values(invariants).every(Boolean),
    scenario: 'All synthetic /start updates arrive at a common T0; real polling admits batches of at most 100; each user receives one combined welcome and name-prompt message.',
    limitations: ['Telegram transport is mocked; no real Telegram delivery or 429 behavior is measured.',
      'No HTTP webhook endpoint, Google registration, payment, or file-upload workload is exercised.',
      'The user count is incoming JSON updates, not simultaneous handlers or webhook virtual users.',
      'Per-fetch simulated latency applies to outgoing sendMessage; getUpdates responds immediately.',
      'Welcome image is disabled; the optional single-photo caption path is covered by bot-flow tests.'],
    configuration: { users: config?.users, simulatedSendLatencyMs: config?.latencyMs,
      updateWorkers: 100, telegramMessagesPerSecond: 28, telegramConcurrency: 16,
      telegramMaxPending: 500, perChatPacingMs: 1050, deadlineSeconds: DEADLINE_MS / 1000,
      node: process.version, platform: process.platform, arch: process.arch },
    sourceSha256: sourceHashes,
    totals: { wallSeconds: round(Math.max(0, wallMs) / 1000), inputUpdates: config?.users, admittedUpdates: admitted,
      pollCalls, maxPollBatch: maxBatch, outboundMessages: outbound, deliveredMessages: delivered,
      googleRequests, messageErrors, protocolErrors, batchBarrierErrors,
      safeErrorCount: Object.values(errors).reduce((a, b) => a + b, 0) },
    latencySecondsFromCommonBurstT0: { firstReply: first, namePrompt: prompt, pollingAdmissionWait: distribution(admissions) },
    resources: { peakTelegramActive: peakActive, peakTelegramPendingSampled: pendingPeak,
      peakTelegramTotalSampled: totalQueuePeak, maxSendStartsInRollingSecond: windowPeak,
      peakRssMiB: round(Math.max(rssPeak, process.resourceUsage().maxRSS * 1024) / 1048576),
      peakHeapUsedMiBSampled: round(heapPeak / 1048576), sampleIntervalMs: 50,
      cpuUserSeconds: round(cpu.user / 1000000), cpuSystemSeconds: round(cpu.system / 1000000),
      cpuPercentOfOneCore: wallMs > 0 ? round((cpu.user + cpu.system) / (wallMs * 10), 2) : null,
      eventLoopDelayMs: histogram ? { p95: round(histogram.percentile(95) / 1000000), max: round(histogram.max / 1000000), resolutionMs: 20 } : null },
    persisted: { users: durableUsers.length, lastUpdateId: durable?.last_update_id ?? null,
      completedUpdateIds: durable?.completed_update_ids?.length ?? null },
    invariants, errors, warnings: { sqliteExperimentalWarnings },
  };
}

function emitReport() {
  if (outputWritten) return;
  let result = report();
  if (config?.output) {
    try { fs.writeFileSync(config.output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); }
    catch { recordError('REPORT_WRITE_FAILED'); result = report(); }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  outputWritten = true;
  process.exitCode = result.passed ? 0 : 1;
}

function cleanup() {
  for (const timer of [sampler, progressTimer, deadlineTimer, forceTimer]) clearTimeout(timer);
  histogram?.disable();
  runtime?.dispose();
  try { bot?.closeStore(); } catch { recordError('STORE_CLOSE_FAILED'); }
  globalThis.fetch = original.fetch;
  net.Socket.prototype.connect = original.connect;
  dgram.createSocket = original.createSocket;
  console.info = original.info;
  console.error = original.error;
  if (scratch) {
    const resolved = path.resolve(scratch);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('neo-sisra-stress-')) {
      recordError('UNEXPECTED_TEMP_PATH'); return;
    }
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { recordError('TEMP_CLEANUP_FAILED'); }
  }
}

async function main() {
  config = parseArgs();
  prepare();
  bot = prepare.createBot({ dataDir: path.join(scratch, 'data') });
  // Initialize the actual empty SQLite store before the shared arrival clock.
  bot.loadDb();
  const burstDate = Math.floor(Date.now() / 1000);
  burst = Array.from({ length: config.users }, (_, index) => {
    const id = index + 1;
    return { update_id: id, message: { message_id: id, date: burstDate,
      chat: { id: CHAT_BASE + id, type: 'private' },
      from: { id: CHAT_BASE + id, is_bot: false, first_name: 'Offline' }, text: '/start' } };
  });
  runtime = bot.createPollingRuntime({ shutdownTimeoutMs: 120000,
    onShutdownTimeout: () => { recordError('RUNTIME_SHUTDOWN_TIMEOUT'); emitReport(); process.exit(1); } });
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  sample();
  cpuStarted = process.cpuUsage();
  started = performance.now();
  sampler = setInterval(sample, 50);
  progressTimer = setInterval(progress, 15000);
  deadlineTimer = setTimeout(() => { timedOut = true; recordError('TEST_DEADLINE_EXCEEDED'); runtime.requestStop(); }, DEADLINE_MS);
  forceTimer = setTimeout(() => { timedOut = true; recordError('FORCED_DEADLINE_EXIT'); emitReport(); process.exit(1); }, FORCE_EXIT_MS);
  await runtime.run();
  runningFinished = true;
  finished = performance.now();
  cpuFinished = process.cpuUsage(cpuStarted);
  histogram.disable();
  sample();
  // A new read-only SQLite connection verifies persisted state after the
  // runtime closed its writer, rather than inspecting cached JavaScript state.
  const { readState } = require(path.join(scratch, 'state-store.cjs'));
  durable = readState({ dataDir: path.join(scratch, 'data') });
}

main().catch(error => {
  // Only this fixed allowlist is printed; exception messages and causes may
  // contain runtime inputs and are intentionally excluded from the report.
  const known = ['INVALID_ARGUMENTS', 'OUTPUT_INSIDE_TEMP', 'RUNTIME_DEFAULTS_CHANGED'];
  recordError(known.includes(error.message) ? error.message : 'HARNESS_FAILURE');
}).finally(() => {
  finished ??= performance.now();
  cleanup();
  emitReport();
});

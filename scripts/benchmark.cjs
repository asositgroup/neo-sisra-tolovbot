'use strict';

// Reuse the isolated offline stress harness so each benchmark also verifies
// real polling batches, common-T0 latency, persisted state and exact replies.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const harness = path.join(__dirname, 'stress-test.cjs');
const results = [];

try {
  for (const users of [10, 50, 100]) {
    const run = spawnSync(process.execPath, [harness, '--users', String(users), '--latency-ms', '100'], {
      encoding: 'utf8', timeout: 460000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    // Never print arbitrary child errors, which could include local inputs.
    if (run.error || run.signal) throw new Error('BENCHMARK_CHILD_FAILED');
    let report;
    try { report = JSON.parse(run.stdout); } catch { throw new Error('BENCHMARK_INVALID_REPORT'); }
    if (run.status !== 0 || report.passed !== true || !Object.values(report.invariants).every(value => value === true)) {
      throw new Error('BENCHMARK_INVARIANT_FAILED');
    }
    const latency = report.latencySecondsFromCommonBurstT0;
    results.push({
      users, messages: report.totals.deliveredMessages,
      maxParallelSends: report.resources.peakTelegramActive,
      lastFirstReplySeconds: latency.firstReply.max,
      p95NamePromptSeconds: latency.namePrompt.p95,
      lastNamePromptSeconds: latency.namePrompt.max,
      pollCalls: report.totals.pollCalls, maxPollBatch: report.totals.maxPollBatch,
      passed: report.passed, invariants: report.invariants,
    });
  }
  console.log(JSON.stringify({
    kind: 'Offline simulation, not measured production capacity',
    node: process.version, simulatedTelegramLatencyMs: 100, telegramMessagesPerSecond: 28,
    perChatPacingMs: 1050, updateWorkers: 100,
    scenario: 'Simultaneous /start at a common T0; one combined welcome and name prompt per user; real polling batches of at most 100.',
    firstReplyAndNamePromptAreSameMessage: true, results,
  }, null, 2));
} catch (error) {
  const known = ['BENCHMARK_CHILD_FAILED', 'BENCHMARK_INVALID_REPORT', 'BENCHMARK_INVARIANT_FAILED'];
  console.error(known.includes(error.message) ? error.message : 'BENCHMARK_FAILURE');
  process.exitCode = 1;
}

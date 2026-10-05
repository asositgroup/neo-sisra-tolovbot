#!/usr/bin/node
'use strict';

// Operator-installed at /usr/local/libexec/neo-sisra-export-state, root:root
// 0755. This file and the fixed module below are reviewed/installed separately
// from downloadable releases. Run only as neo-sisra-bot after systemd stops it.
// exportLegacy acquires the state lock and records a durable legacy handoff so
// a later SQLite release reimports changes made by the legacy bot.
async function main() {
  if (process.argv.length !== 2 || typeof process.getuid !== 'function' || process.getuid() === 0) {
    throw new Error('invalid invocation');
  }
  const { exportLegacy } = require('/usr/local/lib/neo-sisra-bot/state-store.cjs');
  await exportLegacy({ dataDir: '/opt/neo-sisra-pay-bot/data' });
}

main().catch(() => {
  // Never echo state, paths supplied by input, database errors or credentials.
  process.stderr.write('Legacy state export failed; operator recovery required.\n');
  process.exitCode = 1;
});

'use strict';

// Offline preview: the actual bot worker and SQLite state run with a fake
// Telegram transport. No polling, Google requests, or real Telegram sends.
const fs = require('node:fs');
const path = require('node:path');
const { provision } = require('./setup-admin.cjs');
const { createAdminServer } = require('../admin-server.cjs');
const dataDir = path.join(__dirname, '..', '.local', 'admin-demo', 'data');
const output = path.join(__dirname, '..', '.local', 'admin-demo', 'access.txt');
process.env.BOT_TOKEN = '123456:OFFLINE_DEMO_TOKEN';
process.env.GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/OFFLINE_DEMO_ONLY/exec';
process.env.PRIMARY_ADMIN_IDS = '999999999';
process.env.EXTRA_ADMIN_IDS = '';
process.env.ADMIN_IDS = '999999999';
process.env.PHONE_UPDATE_SCRIPT_URL = '';
process.env.PHONE_UPDATE_SECRET = '';
process.env.NOTIFY_CHAT_ID = '';
globalThis.fetch = async (url, options = {}) => {
  if (!String(url).startsWith('https://api.telegram.org/bot123456:OFFLINE_DEMO_TOKEN/') || !String(url).endsWith('/sendMessage')) throw new Error('Demo transport only permits fake Telegram sendMessage.');
  const payload = JSON.parse(options.body);
  await new Promise(resolve => setTimeout(resolve, 180));
  if (payload.chat_id % 8 === 0) return Response.json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, { status: 403 });
  if (payload.chat_id % 11 === 0) return Response.json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, { status: 400 });
  return Response.json({ ok: true, result: { message_id: 1 } });
};

async function main() {
  if (!fs.existsSync(path.join(dataDir, 'admin-account.json'))) await provision({ dataDir, output });
  const { createBot } = require('../bot.js');
  const bot = createBot({ dataDir });
  const db = bot.recoverInterrupted(bot.loadDb());
  for (let id = 1001; id <= 1024; id++) db.users[String(id)] = { chat_id: id, step: 'name' };
  bot.saveDb(db);
  const port = Number(process.env.ADMIN_PORT || 8787);
  const origin = process.env.ADMIN_ORIGIN || `http://127.0.0.1:${port}`;
  const demoBot = { ...bot, getAdminDashboard: () => ({ ...bot.getAdminDashboard(), demoMode: true }) };
  const panel = createAdminServer({ bot: demoBot, dataDir, origin, port });
  const runtime = bot.createPollingRuntime();
  await panel.start();
  console.info('OFFLINE DEMO — haqiqiy xabar yuborilmaydi. 24 ta sunʼiy foydalanuvchi.');
  console.info('Local: ' + origin);
  console.info('Demo login va parol: ' + output);
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    runtime.requestStop();
    await panel.close();
    await bot.waitForBackground();
    runtime.dispose();
    bot.closeStore();
  }
  process.once('SIGINT', () => stop().catch(() => { process.exitCode = 1; }));
  process.once('SIGTERM', () => stop().catch(() => { process.exitCode = 1; }));
}
main().catch(error => {
  const message = String(error.message || 'Hisob va port sozlamalarini tekshiring.').replace(/https?:\/\/api\.telegram\.org\/[^\s"']+/g, '[Telegram API]').replace(/\b\d{6,12}:[A-Za-z0-9_-]{25,}\b/g, '[TOKEN]');
  console.error('Demo ishga tushmadi: ' + message);
  process.exitCode = 1;
});

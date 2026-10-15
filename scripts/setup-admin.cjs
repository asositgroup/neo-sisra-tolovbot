'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { makeAccount, accountPath } = require('../admin-auth.cjs');

async function provision({ dataDir, output, rotate = false }) {
  const target = accountPath(dataDir);
  output = path.resolve(output);
  if (target === output) throw new Error('Parol va hisob fayli alohida boʻlishi kerak.');
  if (!rotate && fs.existsSync(target)) throw new Error('Admin hisobi mavjud. Almashtirish uchun --rotate ishlating.');
  if (fs.existsSync(output)) throw new Error('Parol fayli mavjud. --output orqali yangi fayl nomini tanlang.');
  const password = randomBytes(24).toString('base64url');
  const account = await makeAccount(password);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  // Plaintext is delivered only to the operator's chosen ignored local file.
  // The runtime reads only the salted password hash in its data directory.
  fs.writeFileSync(output, `Neo Sisra admin\nLogin: neo-admin\nParol: ${password}\n\nParolni klientga shaxsiy kanal orqali bering.\nHisobni almashtirgandan keyin botni qayta ishga tushiring.\n`, { flag: 'wx', mode: 0o600 });
  let temporary;
  try {
    if (rotate) {
      temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(account, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, target);
    } else fs.writeFileSync(target, JSON.stringify(account, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    fs.unlinkSync(output);
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
  return { accountPath: target, output, username: account.username };
}

async function main() {
  const args = process.argv.slice(2);
  const options = { dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'), output: path.join(__dirname, '..', '.local', 'admin-access.txt'), rotate: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--rotate') options.rotate = true;
    else if (['--data-dir', '--output'].includes(arg) && args[index + 1] && !args[index + 1].startsWith('--')) options[arg === '--data-dir' ? 'dataDir' : 'output'] = args[++index];
    else throw new Error('Foydalanish: node scripts/setup-admin.cjs [--data-dir papka] [--output fayl] [--rotate]');
  }
  const result = await provision(options);
  console.info('Admin yaratildi: ' + result.username);
  console.info('Kirish maʼlumotlari: ' + result.output);
  console.info('Parol xeshi: ' + result.accountPath);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { provision };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, scrypt, timingSafeEqual, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const accountPath = dataDir => path.join(path.resolve(dataDir), 'admin-account.json');

async function makeAccount(password, username = 'neo-admin') {
  if (typeof password !== 'string' || password.length < 16 || password.length > 256) throw new Error('Parol 16–256 belgidan iborat boʻlishi kerak.');
  if (username !== 'neo-admin') throw new Error('Admin foydalanuvchi nomi neo-admin boʻlishi kerak.');
  const salt = randomBytes(24).toString('hex');
  const hash = (await derive(password, salt, 64, SCRYPT)).toString('hex');
  return { version: 1, username, salt, hash, createdAt: new Date().toISOString() };
}

function readAccount(dataDir) {
  let account;
  try { account = JSON.parse(fs.readFileSync(accountPath(dataDir), 'utf8')); }
  catch { throw new Error('Admin hisobi tayyor emas. Avval npm run admin:setup buyrugʻini bajaring.'); }
  if (account.version !== 1 || account.username !== 'neo-admin' || !/^[a-f0-9]{48}$/.test(account.salt) || !/^[a-f0-9]{128}$/.test(account.hash)) {
    throw new Error('Admin hisobi fayli notoʻgʻri. Hisobni qayta sozlang.');
  }
  return account;
}

function createAuth({ account, now = Date.now, sessionMs = 8 * 60 * 60 * 1000, maxAttempts = 8, windowMs = 15 * 60 * 1000 } = {}) {
  const sessions = new Map(), attempts = new Map();
  let activeVerifications = 0;
  const digest = token => createHash('sha256').update(token).digest('hex');
  function prune() {
    for (const [key, value] of sessions) if (value.expires <= now()) sessions.delete(key);
    for (const [key, value] of attempts) if (value.until <= now()) attempts.delete(key);
  }
  async function login(username, password, address) {
    prune();
    const key = String(address || 'unknown');
    const limiter = attempts.get(key) || { count: 0, until: now() + windowMs };
    if (limiter.count >= maxAttempts || activeVerifications >= 4 || attempts.size >= 1000 && !attempts.has(key)) {
      throw Object.assign(new Error('Urinishlar koʻpayib ketdi. 15 daqiqadan soʻng qayta urinib koʻring.'), { statusCode: 429 });
    }
    limiter.count++; attempts.set(key, limiter); activeVerifications++;
    let matches = false;
    try {
      const candidate = typeof password === 'string' && password.length <= 256 ? password : '';
      const derived = await derive(candidate, account.salt, 64, SCRYPT);
      matches = timingSafeEqual(derived, Buffer.from(account.hash, 'hex')) && username === account.username;
    } finally { activeVerifications--; }
    if (!matches) throw Object.assign(new Error('Login yoki parol notoʻgʻri.'), { statusCode: 401 });
    attempts.delete(key);
    if (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    const session = { username: account.username, csrfToken: randomBytes(32).toString('base64url'), expires: now() + sessionMs };
    sessions.set(digest(token), session);
    return { token, ...session };
  }
  function get(token) {
    prune();
    return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? sessions.get(digest(token)) : undefined;
  }
  function logout(token) { if (typeof token === 'string') sessions.delete(digest(token)); }
  return { login, get, logout, sessionMs };
}

module.exports = { makeAccount, readAccount, accountPath, createAuth };

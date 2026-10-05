'use strict';

// Local preview by default. Publishing never starts the bot or reads chat updates.
const fs = require('node:fs');
const path = require('node:path');
const { Blob } = require('node:buffer');

const USERNAME = 'neo_sisrabot';
const DEFAULT_CONFIG = path.join(__dirname, '..', 'assets', 'bot-profile.json');
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const LOCALES = ['', 'uz'];
const FIELDS = [
  ['name', 'getMyName', 'setMyName', 64],
  ['short_description', 'getMyShortDescription', 'setMyShortDescription', 120],
  ['description', 'getMyDescription', 'setMyDescription', 512],
];
const METHODS = new Set(['getMe', 'getUserProfilePhotos', 'getFile', 'setMyProfilePhoto', ...FIELDS.flatMap(f => [f[1], f[2]])]);

class ProfileError extends Error {
  constructor(code) { super(code); this.name = 'ProfileError'; this.code = code; }
}
function fail(code) { throw new ProfileError(code); }

function parseArgs(args) {
  const options = { apply: false, config: DEFAULT_CONFIG };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) fail('ARGUMENTS_INVALID');
    seen.add(flag);
    if (flag === '--apply') options.apply = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (['--config', '--env-file', '--backup'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail('ARGUMENTS_INVALID');
      options[{ '--config': 'config', '--env-file': 'envFile', '--backup': 'backup' }[flag]] = path.resolve(value);
    } else fail('ARGUMENTS_INVALID');
  }
  if (options.apply && (options.dryRun || !options.envFile || !options.backup)) fail('APPLY_REQUIRES_ENV_AND_BACKUP');
  if (!options.apply && (options.envFile || options.backup)) fail('CREDENTIAL_OPTIONS_REQUIRE_APPLY');
  if (options.backup && (!/\.json$/i.test(options.backup) || options.backup === options.config || options.backup === options.envFile)) fail('BACKUP_PATH_INVALID');
  return options;
}

function validateProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) fail('PROFILE_SCHEMA_INVALID');
  const keys = Object.keys(profile).sort();
  if (keys.join(',') !== ['name', 'short_description', 'description', 'photo'].sort().join(',')) fail('PROFILE_SCHEMA_INVALID');
  for (const [field, , , limit] of FIELDS) {
    const value = profile[field];
    if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) fail('PROFILE_TEXT_INVALID');
    if (field !== 'description' && /[\r\n\t]/u.test(value)) fail('PROFILE_TEXT_INVALID');
  }
  if (typeof profile.photo !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}\.jpe?g$/i.test(profile.photo)) fail('PROFILE_PHOTO_PATH_INVALID');
  return profile;
}

function isJpeg(bytes) {
  return bytes.length >= 6 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
}

function loadProfile(configPath) {
  let profile, photo;
  try {
    if (fs.statSync(configPath).size > 16384) fail('PROFILE_CONFIG_TOO_LARGE');
    profile = validateProfile(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    const directory = fs.realpathSync(path.dirname(configPath));
    const photoPath = fs.realpathSync(path.join(directory, profile.photo));
    if (path.dirname(photoPath) !== directory) fail('PROFILE_PHOTO_PATH_INVALID');
    const stat = fs.statSync(photoPath);
    if (!stat.isFile() || stat.size > MAX_PHOTO_BYTES) fail('PROFILE_PHOTO_SIZE_INVALID');
    photo = fs.readFileSync(photoPath);
    if (!isJpeg(photo)) fail('PROFILE_PHOTO_FORMAT_INVALID');
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    fail('PROFILE_FILES_INVALID');
  }
  return { profile, photo };
}

function readToken(envFile) {
  try {
    if (fs.statSync(envFile).size > 65536) fail('ENV_FILE_INVALID');
    const source = fs.readFileSync(envFile, 'utf8');
    const lines = source.split(/\r?\n/).filter(line => /^\s*(?:export\s+)?BOT_TOKEN\s*=/u.test(line));
    if (lines.length !== 1) fail('BOT_TOKEN_INVALID');
    let token = lines[0].replace(/^\s*(?:export\s+)?BOT_TOKEN\s*=\s*/u, '').trim();
    if (/^["']/u.test(token)) {
      const match = token.match(/^(["'])([^"']+)\1\s*(?:#.*)?$/u);
      if (!match) fail('BOT_TOKEN_INVALID');
      token = match[2];
    } else token = token.replace(/\s+#.*$/u, '').trim();
    if (!/^\d{5,}:[a-zA-Z0-9_-]{20,}$/u.test(token)) fail('BOT_TOKEN_INVALID');
    return token;
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    fail('ENV_FILE_INVALID');
  }
}

async function limitedBody(response, limit) {
  if (!response.ok || !response.body) fail('HTTP_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) fail('HTTP_BODY_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    // Do not let a stalled cancellation extend the fixed request deadline.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function telegramClient(token, fetchFn) {
  async function request(url, options, limit, decode, code) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => decode(await limitedBody(await fetchFn(url, { ...options, redirect: 'error', signal: controller.signal }), limit)))(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ProfileError(code)); }, 15000); }),
      ]);
    } catch { fail(code); }
    finally { clearTimeout(timer); }
  }
  return {
    async api(method, values = {}, multipart = false) {
      if (!METHODS.has(method)) fail('API_METHOD_INVALID');
      return request(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        ...(multipart ? { body: values } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) }),
      }, 1024 * 1024, bytes => {
        const result = JSON.parse(bytes.toString('utf8'));
        if (result.ok !== true || !Object.hasOwn(result, 'result')) fail('API_RESPONSE_INVALID');
        return result.result;
      }, 'API_' + method.toUpperCase() + '_FAILED');
    },
    async download(filePath) {
      if (typeof filePath !== 'string' || !/^[a-zA-Z0-9_/-]+\.[a-zA-Z0-9]+$/u.test(filePath) || filePath.startsWith('/')) fail('BACKUP_PHOTO_PATH_INVALID');
      return request(`https://api.telegram.org/file/bot${token}/${filePath}`, { method: 'GET' }, MAX_PHOTO_BYTES, bytes => {
        if (!isJpeg(bytes)) fail('BACKUP_PHOTO_FORMAT_INVALID');
        return bytes;
      }, 'BACKUP_PHOTO_DOWNLOAD_FAILED');
    },
  };
}

async function readMetadata(client) {
  const metadata = {};
  for (const language_code of LOCALES) {
    const locale = metadata[language_code || 'default'] = {};
    for (const [field, getter] of FIELDS) {
      const result = await client.api(getter, { language_code });
      if (!result || typeof result[field] !== 'string') fail('METADATA_RESPONSE_INVALID');
      locale[field] = result[field];
    }
  }
  return metadata;
}

async function readPhoto(client, userId) {
  const result = await client.api('getUserProfilePhotos', { user_id: userId, offset: 0, limit: 1 });
  if (!result || !Number.isInteger(result.total_count) || result.total_count < 0 || !Array.isArray(result.photos)) fail('PHOTO_RESPONSE_INVALID');
  const sizes = result.photos[0] || [];
  if (!Array.isArray(sizes) || (result.total_count > 0 && sizes.length === 0)) fail('PHOTO_RESPONSE_INVALID');
  const safeSizes = sizes.map(photo => {
    if (!photo || typeof photo.file_id !== 'string' || typeof photo.file_unique_id !== 'string' || !Number.isInteger(photo.width) || !Number.isInteger(photo.height)) fail('PHOTO_RESPONSE_INVALID');
    return { file_id: photo.file_id, file_unique_id: photo.file_unique_id, width: photo.width, height: photo.height };
  });
  safeSizes.sort((a, b) => b.width * b.height - a.width * a.height);
  return { total_count: result.total_count, sizes: safeSizes };
}

async function saveBackup(client, identity, backupPath) {
  if (fs.existsSync(backupPath)) fail('BACKUP_ALREADY_EXISTS');
  const metadata = await readMetadata(client);
  const photo = await readPhoto(client, identity.id);
  const backup = {
    version: 1, created_at: new Date().toISOString(),
    bot: { id: identity.id, username: identity.username }, metadata, photo,
    limitations: [
      'Only default and Uzbek profile text is captured; other languages are untouched.',
      'Language getters may resolve fallback values rather than expose whether an override existed.',
      'Only the latest static photo is backed up; animations and older photos are not preserved.',
      'Photo file IDs cannot be reused by setMyProfilePhoto; restoration requires a JPEG upload.',
    ],
  };
  if (photo.sizes.length) {
    let jpeg;
    try {
      const file = await client.api('getFile', { file_id: photo.sizes[0].file_id });
      if (!file || (file.file_size !== undefined && file.file_size > MAX_PHOTO_BYTES)) fail('BACKUP_PHOTO_SIZE_INVALID');
      jpeg = await client.download(file.file_path);
    } catch (error) {
      backup.photo_backup = { status: 'file_ids_only', reason: error instanceof ProfileError ? error.code : 'BACKUP_PHOTO_FAILED' };
      backup.limitations.push('The previous photo could not be downloaded; this backup alone cannot restore its image.');
    }
    if (jpeg) {
      const photoPath = backupPath.replace(/\.json$/i, '.photo.jpg');
      try { fs.writeFileSync(photoPath, jpeg, { flag: 'wx', mode: 0o600 }); }
      catch { fail('BACKUP_PHOTO_WRITE_FAILED'); }
      backup.photo_backup = { status: 'jpeg_saved', file: path.basename(photoPath) };
    }
  } else backup.photo_backup = { status: 'no_previous_photo' };
  try { fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch { fail('BACKUP_WRITE_FAILED'); }
  return backup;
}

async function run(args, { fetchFn = globalThis.fetch } = {}) {
  const options = parseArgs(args);
  const { profile, photo } = loadProfile(options.config);
  if (!options.apply) return { mode: 'dry-run', username: USERNAME, languages: ['default', 'uz'], profile, photo_bytes: photo.length };
  const client = telegramClient(readToken(options.envFile), fetchFn);
  const identity = await client.api('getMe');
  if (!identity || identity.username !== USERNAME || identity.is_bot !== true || !Number.isSafeInteger(identity.id) || identity.id < 1) fail('BOT_IDENTITY_MISMATCH');
  const backup = await saveBackup(client, identity, options.backup);
  const applied = [];
  let attempted = null;
  try {
    for (const language_code of LOCALES) {
      for (const [field, , setter] of FIELDS) {
        attempted = setter + ':' + (language_code || 'default');
        if (await client.api(setter, { [field]: profile[field], language_code }) !== true) fail('PROFILE_WRITE_NOT_CONFIRMED');
        applied.push(attempted);
      }
    }
    attempted = 'setMyProfilePhoto';
    const form = new FormData();
    form.set('photo', JSON.stringify({ type: 'static', photo: 'attach://avatar' }));
    form.set('avatar', new Blob([photo], { type: 'image/jpeg' }), profile.photo);
    if (await client.api('setMyProfilePhoto', form, true) !== true) fail('PROFILE_WRITE_NOT_CONFIRMED');
    applied.push(attempted);
    attempted = 'verify_profile';
    const actual = await readMetadata(client);
    for (const locale of Object.values(actual)) {
      for (const [field] of FIELDS) if (locale[field] !== profile[field]) fail('PROFILE_READBACK_MISMATCH');
    }
    const actualPhoto = await readPhoto(client, identity.id);
    if (actualPhoto.total_count < 1 || actualPhoto.sizes.length === 0 || actualPhoto.sizes[0].file_id === backup.photo.sizes[0]?.file_id) fail('PHOTO_READBACK_MISMATCH');
    return { mode: 'applied', username: USERNAME, verified: true, applied_steps: applied, photo_backup: backup.photo_backup.status, backup_limitations: backup.limitations };
  } catch (error) {
    const safe = new ProfileError(error instanceof ProfileError ? error.code : 'PROFILE_APPLY_FAILED');
    safe.applied_steps = applied;
    safe.attempted_step = attempted;
    throw safe;
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify({ ok: false, code: error instanceof ProfileError ? error.code : 'PROFILE_SETUP_FAILED', applied_steps: error.applied_steps || [], attempted_step: error.attempted_step || null }));
    process.exitCode = 1;
  });
}

module.exports = { run, parseArgs, validateProfile, loadProfile, ProfileError };

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { run, parseArgs, validateProfile, loadProfile, ProfileError } = require('../configure-profile.cjs');

const TOKEN = '123456789:OFFLINE_SECRET_FOR_PROFILE_TESTS';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0xff, 0xd9]);
const PROFILE = { name: 'Neo Sisra | Toʻlov', short_description: 'Koreyaga talaba yuborish.', description: 'Roʻyxatdan oʻtish uchun /start ni bosing.', photo: 'avatar.jpg' };
const oldPhoto = { file_id: 'old_photo', file_unique_id: 'old_unique', width: 640, height: 640 };
const newPhoto = { file_id: 'new_photo', file_unique_id: 'new_unique', width: 640, height: 640 };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-profile-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = path.join(directory, 'profile.json');
  const env = path.join(directory, 'private.env');
  const backup = path.join(directory, 'backup.json');
  fs.writeFileSync(config, JSON.stringify(PROFILE));
  fs.writeFileSync(path.join(directory, PROFILE.photo), JPEG);
  fs.writeFileSync(env, 'BOT_TOKEN="' + TOKEN + '"\nOTHER_TOKEN=ignored\n');
  return { directory, config, env, backup, args: ['--config', config, '--apply', '--env-file', env, '--backup', backup] };
}

function safeError(code) {
  return error => {
    assert.ok(error instanceof ProfileError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.stack + JSON.stringify(error), /OFFLINE_SECRET|https?:|server\.env/u);
    return true;
  };
}

function harness(f, overrides = {}) {
  const calls = [];
  const metadata = {
    '': { name: 'Old name', short_description: 'Old short description', description: 'Old description' },
    uz: { name: 'Old Uzbek name', short_description: 'Old Uzbek short', description: 'Old Uzbek description' },
  };
  let photoWritten = false;
  return {
    calls,
    fetchFn: async (url, options) => {
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      if (url.includes('/file/bot')) {
        calls.push({ method: 'download' });
        if (overrides.downloadFails) throw new Error(url + '/OFFLINE_SECRET');
        return new Response(JPEG);
      }
      const method = url.slice(url.lastIndexOf('/') + 1);
      assert.ok(url.startsWith('https://api.telegram.org/bot' + TOKEN + '/'));
      const params = options.body instanceof FormData ? options.body : JSON.parse(options.body);
      calls.push({ method, params });
      if (overrides.failMethod === method) {
        if (overrides.failure === 'api') return Response.json({ ok: false, description: url });
        if (overrides.failure === 'http') return new Response(url, { status: 500 });
        if (overrides.failure === 'json') return new Response('not-json:' + url);
        throw new Error(url + '/OFFLINE_SECRET');
      }
      let result;
      if (method === 'getMe') result = { id: 123456789, username: overrides.wrongIdentity ? 'different_bot' : 'neo_sisrabot', is_bot: true };
      else if (method === 'getUserProfilePhotos') result = { total_count: 1, photos: [[photoWritten && !overrides.unchangedPhoto ? newPhoto : oldPhoto]] };
      else if (method === 'getFile') result = { file_id: oldPhoto.file_id, file_path: 'photos/file_1.jpg', file_size: JPEG.length };
      else if (method.startsWith('getMy')) {
        const field = { getMyName: 'name', getMyShortDescription: 'short_description', getMyDescription: 'description' }[method];
        assert.ok(field);
        result = { [field]: metadata[params.language_code][field] };
      } else {
        // A durable metadata snapshot must exist before the first remote mutation.
        assert.equal(JSON.parse(fs.readFileSync(f.backup, 'utf8')).bot.username, 'neo_sisrabot');
        if (method === 'setMyProfilePhoto') {
          assert.deepEqual(JSON.parse(params.get('photo')), { type: 'static', photo: 'attach://avatar' });
          assert.equal(params.get('avatar').type, 'image/jpeg');
          assert.deepEqual(Buffer.from(await params.get('avatar').arrayBuffer()), JPEG);
          photoWritten = true;
        } else {
          const field = { setMyName: 'name', setMyShortDescription: 'short_description', setMyDescription: 'description' }[method];
          assert.ok(field, 'Unexpected API method');
          assert.ok(['', 'uz'].includes(params.language_code));
          if (!overrides.ignoreTextWrites) metadata[params.language_code][field] = params[field];
        }
        result = true;
      }
      return Response.json({ ok: true, result });
    },
  };
}

test('default preview validates only public files without credentials or network', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.env);
  const result = await run(['--config', f.config], { fetchFn: () => assert.fail('Preview must never access network') });
  assert.equal(result.mode, 'dry-run');
  assert.deepEqual(result.profile, PROFILE);
  assert.equal(result.photo_bytes, JPEG.length);
  assert.equal(fs.existsSync(f.backup), false);
});

test('publishing requires explicit apply, credential file and backup; ambiguous flags fail', () => {
  for (const args of [
    ['--apply'], ['--apply', '--env-file', 'private.env'], ['--apply', '--dry-run', '--env-file', 'a', '--backup', 'b.json'],
  ]) assert.throws(() => parseArgs(args), safeError('APPLY_REQUIRES_ENV_AND_BACKUP'));
  assert.throws(() => parseArgs(['--env-file', 'private.env']), safeError('CREDENTIAL_OPTIONS_REQUIRE_APPLY'));
  for (const args of [['--config'], ['--config', '--apply'], ['--apply', '--apply'], ['--token', 'x']]) {
    assert.throws(() => parseArgs(args), safeError('ARGUMENTS_INVALID'));
  }
});

test('profile schema, field limits and image paths cannot broaden the publish scope', () => {
  for (const profile of [null, [], { ...PROFILE, username: 'another_bot' }, { ...PROFILE, name: 1 }]) {
    assert.throws(() => validateProfile(profile), ProfileError);
  }
  for (const [field, limit] of [['name', 64], ['short_description', 120], ['description', 512]]) {
    assert.equal(validateProfile({ ...PROFILE, [field]: 'a'.repeat(limit) })[field].length, limit);
    assert.throws(() => validateProfile({ ...PROFILE, [field]: 'a'.repeat(limit + 1) }), safeError('PROFILE_TEXT_INVALID'));
  }
  for (const photo of ['../avatar.jpg', 'C:\\private.jpg', '/private.jpg', 'https://host/avatar.jpg', 'avatar.png']) {
    assert.throws(() => validateProfile({ ...PROFILE, photo }), safeError('PROFILE_PHOTO_PATH_INVALID'));
  }
});

test('JPEG extension without JPEG bytes is rejected locally', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, PROFILE.photo), 'not a JPEG');
  assert.throws(() => loadProfile(f.config), safeError('PROFILE_PHOTO_FORMAT_INVALID'));
});

test('wrong bot identity stops after getMe without reading or changing profiles', async t => {
  const f = fixture(t), h = harness(f, { wrongIdentity: true });
  await assert.rejects(run(f.args, h), safeError('BOT_IDENTITY_MISMATCH'));
  assert.deepEqual(h.calls.map(c => c.method), ['getMe']);
  assert.equal(fs.existsSync(f.backup), false);
});

test('publish backs up public metadata and JPEG before writes, then verifies both locales and changed photo', async t => {
  const f = fixture(t), h = harness(f);
  const result = await run(f.args, h);
  assert.equal(result.verified, true);
  assert.equal(result.applied_steps.length, 7);
  assert.equal(result.photo_backup, 'jpeg_saved');
  const backup = JSON.parse(fs.readFileSync(f.backup, 'utf8'));
  assert.equal(backup.metadata.default.name, 'Old name');
  assert.equal(backup.metadata.uz.name, 'Old Uzbek name');
  assert.equal(backup.photo.sizes[0].file_id, 'old_photo');
  assert.deepEqual(fs.readFileSync(path.join(f.directory, backup.photo_backup.file)), JPEG);
  assert.doesNotMatch(JSON.stringify(backup) + JSON.stringify(result), /OFFLINE_SECRET|https?:/u);
  assert.equal(h.calls.filter(c => c.method.startsWith('set')).length, 7);
  assert.equal(h.calls.filter(c => c.method === 'getMyName').length, 4);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.backup).mode & 0o777, 0o600);
});

test('an existing backup is never overwritten and prevents remote writes', async t => {
  const f = fixture(t), h = harness(f);
  fs.writeFileSync(f.backup, 'KEEP');
  await assert.rejects(run(f.args, h), safeError('BACKUP_ALREADY_EXISTS'));
  assert.equal(fs.readFileSync(f.backup, 'utf8'), 'KEEP');
  assert.deepEqual(h.calls.map(c => c.method), ['getMe']);
});

test('unavailable old JPEG is explicitly reported as file IDs only', async t => {
  const f = fixture(t), h = harness(f, { downloadFails: true });
  const result = await run(f.args, h);
  assert.equal(result.photo_backup, 'file_ids_only');
  assert.ok(result.backup_limitations.some(text => text.includes('cannot restore')));
  const backup = fs.readFileSync(f.backup, 'utf8');
  assert.doesNotMatch(backup, /OFFLINE_SECRET|https?:/u);
  assert.equal(JSON.parse(backup).photo.sizes[0].file_id, 'old_photo');
});

test('transport, API, HTTP and JSON failures report fixed codes without token-bearing errors', async t => {
  for (const failure of ['transport', 'api', 'http', 'json']) {
    await t.test(failure, async t => {
      const f = fixture(t), h = harness(f, { failMethod: 'setMyShortDescription', failure });
      await assert.rejects(run(f.args, h), error => {
        safeError('API_SETMYSHORTDESCRIPTION_FAILED')(error);
        assert.deepEqual(error.applied_steps, ['setMyName:default']);
        assert.equal(error.attempted_step, 'setMyShortDescription:default');
        return true;
      });
      assert.equal(h.calls.at(-1).method, 'setMyShortDescription');
    });
  }
});

test('readback must confirm the text and a changed profile photo', async t => {
  for (const [overrides, code] of [[{ ignoreTextWrites: true }, 'PROFILE_READBACK_MISMATCH'], [{ unchangedPhoto: true }, 'PHOTO_READBACK_MISMATCH']]) {
    await t.test(code, async t => {
      const f = fixture(t), h = harness(f, overrides);
      await assert.rejects(run(f.args, h), error => {
        safeError(code)(error);
        assert.equal(error.applied_steps.length, 7);
        assert.equal(error.attempted_step, 'verify_profile');
        return true;
      });
    });
  }
});

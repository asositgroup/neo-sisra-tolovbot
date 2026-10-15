'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateConfig, validateMessage, remoteCommand, createRelay } = require('../scripts/admin-personal-test.cjs');

// Synthetic recipient and helper; these tests never execute SSH or Telegram.
const config = { chatId: 777001, username: 'offline_person', sshHelper: path.join(os.tmpdir(), 'offline-only-helper.cjs') };
const acknowledgement = response => ({ stdout: 'SSH host verified\r\nNEO_ADMIN_RESPONSE=' + JSON.stringify(response) + '\r\n', stderr: '' });
const safeError = /Shaxsiy test soʻrovi tasdiqlanmadi/;
const urlButton = { text: 'Saytga oʻtish', url: 'https://example.com/join?from=telegram' };
const markupFor = button => ({ inline_keyboard: [[button]] });
const invalidMarkups = [null, [], {}, { inline_keyboard: [] }, { inline_keyboard: [[]] },
  { inline_keyboard: [[urlButton], [urlButton]] }, { inline_keyboard: [[urlButton, urlButton]] },
  { inline_keyboard: [[urlButton]], resize_keyboard: true },
  markupFor({ text: 'Action', callback_data: 'payment:menu' }),
  markupFor({ text: 'Web app', web_app: { url: 'https://example.com/' } }),
  markupFor({ ...urlButton, pay: true }), markupFor({ ...urlButton, callback_data: 'ignored' }),
  markupFor({ text: '', url: urlButton.url }), markupFor({ text: 'a'.repeat(65), url: urlButton.url }),
  markupFor({ text: '😀'.repeat(33), url: urlButton.url }), markupFor({ text: 'New\nline', url: urlButton.url }),
  ...['javascript:alert(1)', 'tg://resolve?domain=example', 'http://example.com/', 'ftp://example.com/',
    'https://user:pass@example.com/', 'https://example.com/ bad', 'https://example.com\\bad',
    'https://example.com/\n', 'https://', 'https://example.com/' + 'x'.repeat(2048)]
    .map(url => markupFor({ text: 'Open', url })),
];
function commandInput(command) {
  const match = command.match(/^command=json\.loads\(base64\.b64decode\('([A-Za-z0-9+/=]+)'\)\)$/m);
  assert.ok(match, 'The command must contain only a base64-encoded JSON input literal');
  return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
}
function fixture(t, run) {
  const commandDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-personal-relay-test-'));
  t.after(() => fs.rmSync(commandDir, { recursive: true, force: true }));
  return { commandDir, relay: createRelay(config, { commandDir, run }) };
}

test('personal test configuration requires an exact positive private ID, username and absolute helper path', () => {
  for (const invalid of [undefined, null, {},
    { ...config, chatId: 0 }, { ...config, chatId: -777001 }, { ...config, chatId: 1.5 },
    { ...config, chatId: '777001' }, { ...config, chatId: Number.MAX_SAFE_INTEGER + 1 },
    { ...config, username: 'ab' }, { ...config, username: '@offline_person' },
    { ...config, username: 'offline_person;bad' }, { ...config, username: '$(bad)' },
    { ...config, sshHelper: 'relative-helper.cjs' }, { ...config, sshHelper: null }]) {
    assert.throws(() => validateConfig(invalid), /Shaxsiy test uchun/);
    assert.throws(() => createRelay(invalid, { run: () => assert.fail('Invalid config must never run the helper') }), /Shaxsiy test uchun/);
  }
  const result = validateConfig({ ...config, username: 'OFFLINE_Person' });
  assert.deepEqual(result, config);
  assert.ok(Object.isFrozen(result));
});

test('wrong recipients, unsupported fields and invalid actions are rejected before helper execution or temp-file creation', async t => {
  let calls = 0;
  const f = fixture(t, () => { calls++; assert.fail('Rejected input must never reach the SSH helper'); });
  for (const value of [undefined, null, {},
    { chat_id: 777002, text: 'Wrong recipient' }, { chat_id: '@offline_person', text: 'Username destination' },
    { chat_id: -777001, text: 'Wrong chat type' }, { chat_id: 777001, text: '' },
    { chat_id: 777001, text: '  \n ' }, { chat_id: 777001, text: 'a'.repeat(4097) },
    { chat_id: 777001, text: 42 }, { chat_id: 777001, text: 'Text', parse_mode: 'HTML' },
    { chat_id: 777001, text: 'Text', from_chat_id: 777002 }]) {
    assert.throws(() => validateMessage(config, value), /tasdiqlangan shaxsiy profilga/);
    await assert.rejects(f.relay('sendMessage', value), /tasdiqlangan shaxsiy profilga/);
  }
  for (const action of ['getUpdates', 'copyMessage', 'deleteMessage', 'sendPhoto', 'sendMessage;bad']) {
    await assert.rejects(f.relay(action, { chat_id: config.chatId, text: 'Text' }), /ruxsat etilmagan/);
  }
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(f.commandDir), []);
});

test('remote command transports shell-sensitive and Unicode message content only as base64 JSON', () => {
  const text = 'Salom 👋 Oʻzbekcha\nPY\n$(echo SHOULD_NOT_RUN) `whoami` $HOME\n\'"; exit 1; # & | > < \\ \r\n';
  const command = remoteCommand(config, 'sendMessage', { chat_id: config.chatId, text });
  const input = commandInput(command);
  assert.deepEqual(input, { action: 'sendMessage', chatId: config.chatId, username: config.username,
    message: { chat_id: config.chatId, text } });
  assert.doesNotMatch(command, /SHOULD_NOT_RUN|whoami|\$HOME|Salom/);
  assert.equal(command.split('\n').filter(line => line.replace(/\r$/, '') === 'PY').length, 1, 'Input must not inject a second heredoc terminator');
  assert.match(command, /python3 -I - <<'PY'/);
  assert.doesNotMatch(command, /777001|offline_person/, 'Destination identity must also be carried in the encoded input');
});

test('verify relay invokes the configured helper without shell interpolation and removes the command file', async t => {
  let commandFile;
  const controller = new AbortController();
  const response = { status: 200, payload: { ok: true, result: { botUsername: 'neo_sisrabot', chatId: config.chatId, username: config.username } } };
  const f = fixture(t, async (executable, args, options) => {
    assert.equal(executable, process.execPath);
    assert.equal(args.length, 2);
    assert.equal(args[0], config.sshHelper);
    commandFile = args[1];
    assert.equal(path.dirname(commandFile), f.commandDir);
    assert.match(path.basename(commandFile), /^[0-9a-f-]{36}\.sh$/);
    const input = commandInput(fs.readFileSync(commandFile, 'utf8'));
    assert.deepEqual(input, { action: 'verify', chatId: config.chatId, username: config.username });
    assert.equal(options.cwd, path.dirname(config.sshHelper));
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 60000);
    assert.equal(options.maxBuffer, 128 * 1024);
    assert.equal(options.signal, controller.signal);
    assert.ok(!options.shell, 'The helper must run as an executable, not through shell parsing');
    return acknowledgement(response);
  });
  assert.deepEqual(await f.relay('verify', undefined, controller.signal), response);
  assert.equal(fs.existsSync(commandFile), false);
  assert.deepEqual(fs.readdirSync(f.commandDir), []);
});

test('send relay encodes only the allowed target and text and returns the safe acknowledgement', async t => {
  const text = 'Only this profile gets a test.\nLine 2.';
  const response = { status: 200, payload: { ok: true, result: { message_id: 123 } } };
  let calls = 0;
  const f = fixture(t, async (_executable, args) => {
    calls++;
    const input = commandInput(fs.readFileSync(args[1], 'utf8'));
    assert.deepEqual(input, { action: 'sendMessage', chatId: config.chatId, username: config.username,
      message: { chat_id: config.chatId, text } });
    return acknowledgement(response);
  });
  assert.deepEqual(await f.relay('sendMessage', { chat_id: config.chatId, text }), response);
  assert.equal(calls, 1);
  assert.deepEqual(fs.readdirSync(f.commandDir), []);
});

test('optional one-link button is normalized and transported with its sole personal recipient', async t => {
  const message = { chat_id: config.chatId, text: 'Havola orqali kiring.',
    reply_markup: markupFor({ text: '  Saytga oʻtish  ', url: 'HTTPS://EXAMPLE.COM/join?from=telegram' }) };
  const expected = { chat_id: config.chatId, text: message.text, reply_markup: markupFor(urlButton) };
  assert.deepEqual(validateMessage(config, message), expected);
  const response = { status: 200, payload: { ok: true, result: { message_id: 124 } } };
  const f = fixture(t, async (_executable, args) => {
    const input = commandInput(fs.readFileSync(args[1], 'utf8'));
    assert.deepEqual(input, { action: 'sendMessage', chatId: config.chatId, username: config.username, message: expected });
    return acknowledgement(response);
  });
  assert.deepEqual(await f.relay('sendMessage', message), response);
  assert.deepEqual(fs.readdirSync(f.commandDir), []);
  assert.deepEqual(validateMessage(config, { chat_id: config.chatId, text: 'Plain' }), { chat_id: config.chatId, text: 'Plain' });
});

test('button actions, multiple buttons, unsafe URLs and a wrong target with a button fail before helper execution', async t => {
  let calls = 0;
  const f = fixture(t, () => { calls++; assert.fail('Invalid markup must never reach SSH'); });
  for (const markup of invalidMarkups) {
    const message = { chat_id: config.chatId, text: 'Message', reply_markup: markup };
    assert.throws(() => validateMessage(config, message), Error);
    await assert.rejects(f.relay('sendMessage', message), Error);
  }
  await assert.rejects(f.relay('sendMessage', { chat_id: config.chatId + 1, text: 'Wrong recipient', reply_markup: markupFor(urlButton) }), /tasdiqlangan shaxsiy profilga/);
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(f.commandDir), []);
});

test('generated Python independently enforces target, identity and optional URL button without any live I/O', t => {
  const python = (process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']).find(executable => {
    const result = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return !result.error && result.status === 0 && /Python 3\./.test(result.stdout + result.stderr);
  });
  if (!python) { t.skip('Python 3 is not installed; all JavaScript relay tests still run.'); return; }
  const baseMessage = { chat_id: config.chatId, text: 'Offline Python test 👋' };
  const makeCase = (name, message, expectedStatus = 200, remoteOverrides = {}) => {
    // Start from generated, valid code, then alter only its encoded input to
    // prove the remote checks also reject data that bypassed local validation.
    const command = remoteCommand(config, 'sendMessage', baseMessage);
    const input = { ...commandInput(command), message };
    const encoded = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
    const script = command.replace(/base64\.b64decode\('[A-Za-z0-9+/=]+'\)/, "base64.b64decode('" + encoded + "')")
      .split(/\r?\n/).slice(2, -2).join('\n');
    assert.match(script, /^import base64/);
    return { name, script, expectedStatus, message, ...remoteOverrides };
  };
  const cases = [
    makeCase('plain text without markup', baseMessage),
    makeCase('single HTTPS URL button', { ...baseMessage, reply_markup: markupFor(urlButton) }),
    makeCase('URL port zero matches JS normalization', { ...baseMessage, reply_markup: markupFor({ text: 'Open', url: 'https://example.com:0/' }) }),
    makeCase('wrong message target with valid button', { ...baseMessage, chat_id: config.chatId + 1, reply_markup: markupFor(urlButton) }, 403),
    makeCase('wrong bot identity', baseMessage, 409, { botUsername: 'other_offline_bot' }),
    makeCase('wrong verified chat ID', baseMessage, 409, { returnedChatId: config.chatId + 1 }),
    makeCase('wrong verified chat username', baseMessage, 409, { returnedUsername: 'other_person' }),
    makeCase('non-private target', baseMessage, 409, { returnedChatType: 'supergroup' }),
    ...invalidMarkups.map((markup, index) => makeCase('invalid markup ' + index, { ...baseMessage, reply_markup: markup }, 400)),
    makeCase('tampered extra message action', { ...baseMessage, parse_mode: 'HTML' }, 403),
    makeCase('tampered missing text', { chat_id: config.chatId }, 403),
    makeCase('tampered oversized emoji text', { ...baseMessage, text: '😀'.repeat(2049) }, 400),
  ];
  const encodedCases = Buffer.from(JSON.stringify(cases), 'utf8').toString('base64');
  const harness = `import base64, contextlib, io, json, pathlib, socket, urllib.request
cases=json.loads(base64.b64decode('${encodedCases}'))
expected_id=${config.chatId}
expected_username='${config.username}'
def forbidden_io(*args,**kwargs):
    raise AssertionError('Network access is forbidden in offline tests')
socket.socket=forbidden_io
socket.create_connection=forbidden_io
def fake_read_text(path,*args,**kwargs):
    assert path.as_posix()=='/opt/neo-sisra-pay-bot/.env'
    return 'BOT_TOKEN=OFFLINE_SYNTHETIC_TOKEN_ONLY\\n'
pathlib.Path.read_text=fake_read_text
class FakeResponse(io.StringIO):
    status=200
for case in cases:
    calls=[]
    def fake_urlopen(request,timeout):
        assert timeout==8
        assert request.full_url.startswith('https://api.telegram.org/botOFFLINE_SYNTHETIC_TOKEN_ONLY/')
        method=request.full_url.rsplit('/',1)[1]
        data=json.loads(request.data)
        calls.append({'method':method,'data':data})
        if method=='getMe':
            result={'username':case.get('botUsername','neo_sisrabot')}
        elif method=='getChat':
            result={'id':case.get('returnedChatId',expected_id),'username':case.get('returnedUsername',expected_username),'type':case.get('returnedChatType','private')}
        elif method=='sendMessage':
            result={'message_id':123,'chat':{'id':data['chat_id']}}
        else:
            raise AssertionError('Unsupported offline API method')
        return FakeResponse(json.dumps({'ok':True,'result':result}))
    urllib.request.urlopen=fake_urlopen
    capture=io.StringIO()
    with contextlib.redirect_stdout(capture):
        try:
            exec(compile(case['script'],'generated-relay.py','exec'),{'__name__':'__main__'})
        except SystemExit as error:
            if error.code not in (0,None): raise
    print(json.dumps({'name':case['name'],'calls':calls,'stdout':capture.getvalue()},ensure_ascii=True))
`;
  const result = spawnSync(python, ['-I', '-'], { input: harness, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const actual = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(actual.length, cases.length);
  for (let index = 0; index < cases.length; index++) {
    const expected = cases[index], observed = actual[index];
    assert.equal(observed.name, expected.name);
    const line = observed.stdout.split(/\r?\n/).find(value => value.startsWith('NEO_ADMIN_RESPONSE='));
    assert.ok(line, expected.name + ': remote script must return a safe acknowledgement');
    const response = JSON.parse(line.slice('NEO_ADMIN_RESPONSE='.length));
    assert.equal(response.status, expected.expectedStatus, expected.name);
    const sends = observed.calls.filter(call => call.method === 'sendMessage');
    if (expected.expectedStatus === 200) {
      assert.deepEqual(sends, [{ method: 'sendMessage', data: expected.message }], expected.name);
      assert.deepEqual(observed.calls.map(call => call.method), ['getMe', 'getChat', 'sendMessage']);
      assert.deepEqual(response.payload, { ok: true, result: { message_id: 123 } });
    } else {
      assert.equal(sends.length, 0, expected.name + ': invalid payload must never call sendMessage');
      assert.equal(response.payload.ok, false);
    }
    assert.doesNotMatch(observed.stdout, /OFFLINE_SYNTHETIC_TOKEN_ONLY/);
  }
});

test('safe blocked-user and rate-limit responses preserve delivery classification without helper diagnostics', async t => {
  const responses = [
    { status: 403, payload: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } },
    { status: 429, payload: { ok: false, error_code: 429, description: 'Telegram request rejected', parameters: { retry_after: 3 } } },
  ];
  const f = fixture(t, async () => ({ ...acknowledgement(responses[0]), stderr: 'PRIVATE_HELPER_DIAGNOSTIC' }));
  for (const response of [...responses]) {
    const actual = await f.relay('sendMessage', { chat_id: config.chatId, text: 'Test' });
    assert.deepEqual(actual, response);
    assert.doesNotMatch(JSON.stringify(actual), /PRIVATE_HELPER_DIAGNOSTIC/);
    assert.deepEqual(fs.readdirSync(f.commandDir), []);
    responses.shift();
  }
});

test('helper errors and malformed acknowledgements expose only a fixed safe error and clean temp files', async t => {
  const sensitive = 'SYNTHETIC_PRIVATE_TOKEN password=DO_NOT_EXPOSE https://api.telegram.org/botPRIVATE_TOKEN/sendMessage';
  const outputs = [
    new Error('SSH error: ' + sensitive),
    { stdout: sensitive, stderr: sensitive },
    { stdout: 'NEO_ADMIN_RESPONSE={' + sensitive, stderr: sensitive },
    acknowledgement({ status: 199, payload: { ok: true, details: sensitive } }),
    acknowledgement({ status: 600, payload: { ok: true, details: sensitive } }),
    acknowledgement({ status: '200', payload: { ok: true, details: sensitive } }),
    acknowledgement({ status: 200, payload: { ok: 'true', details: sensitive } }),
    acknowledgement({ status: 200, details: sensitive }),
    { stderr: sensitive },
  ];
  const f = fixture(t, async () => {
    const result = outputs.shift();
    if (result instanceof Error) throw result;
    return result;
  });
  while (outputs.length) {
    await assert.rejects(f.relay('sendMessage', { chat_id: config.chatId, text: 'Test' }), error => {
      assert.match(error.message, safeError);
      assert.doesNotMatch(error.message + error.stack, /SYNTHETIC_PRIVATE_TOKEN|DO_NOT_EXPOSE|api\.telegram\.org/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.deepEqual(fs.readdirSync(f.commandDir), []);
  }
});

'use strict';

// Local, send-only test panel. The production token stays on the bot server;
// the existing SSH helper reads its own credentials and verifies the host key.
// No Telegram polling, production DB writes, deployments or service restarts.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createAdminServer } = require('../admin-server.cjs');
const { readAccount } = require('../admin-auth.cjs');
const execute = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const TEST_ROOT = path.join(ROOT, '.local', 'admin-test');
const RELAY_TOKEN = '123456:PERSONAL_TEST_SSH_RELAY';
// The SSH helper can spend 20s connecting, then perform three Telegram calls.
// Its own deadline is 55s. Let it finish and report before the outer deadline.
const RELAY_TIMEOUT_MS = 60000;
const PERSONAL_TELEGRAM_TIMEOUT_MS = 65000;

function validateConfig(value) {
  if (!value || !Number.isSafeInteger(value.chatId) || value.chatId <= 0 ||
      typeof value.username !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value.username) ||
      typeof value.sshHelper !== 'string' || !path.isAbsolute(value.sshHelper)) {
    throw new Error('Shaxsiy test uchun aniq chatId, username va SSH helper yoʻli kerak.');
  }
  return Object.freeze({ chatId: value.chatId, username: value.username.toLowerCase(), sshHelper: value.sshHelper });
}

function validateMessage(config, value) {
  if (!value || Number(value.chat_id) !== config.chatId || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 4096 ||
      Object.keys(value).some(key => !['chat_id', 'text', 'reply_markup'].includes(key))) {
    throw new Error('Test xabari faqat tasdiqlangan shaxsiy profilga yuborilishi mumkin.');
  }
  const message = { chat_id: config.chatId, text: value.text };
  if (Object.prototype.hasOwnProperty.call(value, 'reply_markup')) {
    const markup = value.reply_markup;
    if (!markup || typeof markup !== 'object' || Array.isArray(markup) ||
        Object.keys(markup).length !== 1 || !Array.isArray(markup.inline_keyboard) ||
        markup.inline_keyboard.length !== 1 || !Array.isArray(markup.inline_keyboard[0]) ||
        markup.inline_keyboard[0].length !== 1) {
      throw new Error('Test xabariga faqat bitta havolali tugma qoʻshish mumkin.');
    }
    const { normalizeBroadcastButton } = require('../bot.js');
    const button = normalizeBroadcastButton(markup.inline_keyboard[0][0]);
    if (!button) throw new Error('Test xabariga faqat bitta havolali tugma qoʻshish mumkin.');
    message.reply_markup = { inline_keyboard: [[button]] };
  }
  return message;
}

function remoteCommand(config, action, data = {}) {
  if (!['verify', 'sendMessage'].includes(action)) throw new Error('Relay amali ruxsat etilmagan.');
  const input = { action, chatId: config.chatId, username: config.username,
    ...(action === 'sendMessage' ? { message: validateMessage(config, data) } : {}) };
  const encoded = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
  return `set -eu
python3 -I - <<'PY'
import base64, json, urllib.request, urllib.error, urllib.parse
from pathlib import Path
command=json.loads(base64.b64decode('${encoded}'))
def output(status,payload):
    print('NEO_ADMIN_RESPONSE='+json.dumps({'status':status,'payload':payload},ensure_ascii=True))
def failure(status,description):
    output(status,{'ok':False,'error_code':status,'description':description})
    raise SystemExit(0)
entries={}
try:
    for raw in Path('/opt/neo-sisra-pay-bot/.env').read_text().splitlines():
        if '=' in raw and not raw.lstrip().startswith('#'):
            key,value=raw.split('=',1); entries[key.strip()]=value.strip().strip(chr(34)+chr(39))
    token=entries['BOT_TOKEN']
except Exception:
    failure(503,'Bot configuration unavailable')
def call(method,data):
    request=urllib.request.Request('https://api.telegram.org/bot'+token+'/'+method,data=json.dumps(data).encode(),headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(request,timeout=8) as response:
            return response.status,json.load(response)
    except urllib.error.HTTPError as error:
        try: payload=json.loads(error.read(65536))
        except Exception: payload={'ok':False,'error_code':error.code}
        return error.code,payload
    except Exception:
        failure(502,'Telegram response was not confirmed')
_,identity=call('getMe',{})
if not identity.get('ok') or identity.get('result',{}).get('username')!='neo_sisrabot':
    failure(409,'Bot identity does not match Neo Sisra')
_,recipient=call('getChat',{'chat_id':command['chatId']})
chat=recipient.get('result',{})
if not recipient.get('ok') or chat.get('type')!='private' or chat.get('id')!=command['chatId'] or str(chat.get('username','')).lower()!=command['username']:
    failure(409,'Personal test recipient could not be verified')
if command['action']=='verify':
    output(200,{'ok':True,'result':{'botUsername':'neo_sisrabot','chatId':chat['id'],'username':chat['username']}})
elif command['action']=='sendMessage':
    message=command['message']
    if not isinstance(message,dict) or message.get('chat_id')!=command['chatId'] or not {'chat_id','text'}<=set(message) or not set(message)<={'chat_id','text','reply_markup'}:
        failure(403,'Recipient outside personal test scope')
    text=message['text']
    if not isinstance(text,str) or not text.strip() or len(text.encode('utf-16-le'))//2>4096:
        failure(400,'Invalid message text')
    if 'reply_markup' in message:
        markup=message['reply_markup']
        if not isinstance(markup,dict) or set(markup)!={'inline_keyboard'}:
            failure(400,'Only one URL button is supported')
        rows=markup['inline_keyboard']
        if not isinstance(rows,list) or len(rows)!=1 or not isinstance(rows[0],list) or len(rows[0])!=1:
            failure(400,'Only one URL button is supported')
        button=rows[0][0]
        if not isinstance(button,dict) or set(button)!={'text','url'} or not isinstance(button['text'],str) or not isinstance(button['url'],str):
            failure(400,'Invalid URL button')
        label,url=button['text'],button['url']
        try:
            parsed=urllib.parse.urlsplit(url)
            valid=bool(label.strip()) and len(label.encode('utf-16-le'))//2<=64 and len(url)<=2048 and url.startswith('https://') and bool(parsed.hostname) and parsed.username is None and parsed.password is None
            valid=valid and not any(ord(c)<32 or ord(c)==127 for c in label+url) and not any(c.isspace() or ord(c)==92 for c in url)
        except Exception:
            valid=False
        if not valid: failure(400,'Invalid URL button')
    status,payload=call('sendMessage',message)
    if payload.get('ok'):
        result=payload.get('result',{})
        if result.get('chat',{}).get('id')!=command['chatId']:
            failure(502,'Telegram recipient acknowledgement was not confirmed')
        output(200,{'ok':True,'result':{'message_id':result.get('message_id')}})
    else:
        code=payload.get('error_code',status)
        description='Telegram request rejected'
        if code==403 and 'bot was blocked by the user' in str(payload.get('description','')).lower(): description='Forbidden: bot was blocked by the user'
        safe={'ok':False,'error_code':code,'description':description}
        retry=payload.get('parameters',{}).get('retry_after')
        if code==429 and isinstance(retry,(int,float)) and retry>0: safe['parameters']={'retry_after':retry}
        output(status,safe)
else:
    failure(403,'Relay action denied')
PY
`;
}

function createRelay(config, { commandDir = path.join(TEST_ROOT, 'commands'), run = execute } = {}) {
  config = validateConfig(config);
  return async (action, data, signal) => {
    const command = remoteCommand(config, action, data);
    fs.mkdirSync(commandDir, { recursive: true, mode: 0o700 });
    const filename = path.join(commandDir, randomUUID() + '.sh');
    fs.writeFileSync(filename, command, { flag: 'wx', mode: 0o600 });
    try {
      const result = await run(process.execPath, [config.sshHelper, filename], {
        cwd: path.dirname(config.sshHelper), windowsHide: true, timeout: RELAY_TIMEOUT_MS,
        maxBuffer: 128 * 1024, signal,
      });
      const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('NEO_ADMIN_RESPONSE='));
      if (!line) throw new Error('Relay acknowledgement missing');
      const response = JSON.parse(line.slice('NEO_ADMIN_RESPONSE='.length));
      if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599 || !response.payload || typeof response.payload.ok !== 'boolean') throw new Error('Relay acknowledgement invalid');
      return response;
    } catch {
      throw new Error('Shaxsiy test soʻrovi tasdiqlanmadi. Takroriy xabar yubormaslik uchun holatni tekshiring.');
    } finally { fs.unlinkSync(filename); }
  };
}

async function main() {
  let config;
  try { config = validateConfig(JSON.parse(fs.readFileSync(path.join(TEST_ROOT, 'config.json'), 'utf8'))); }
  catch { throw new Error('.local/admin-test/config.json ichida tasdiqlangan shaxsiy profil va SSH helper sozlanishi kerak.'); }
  const relay = createRelay(config);
  const verified = await relay('verify');
  if (!verified.payload.ok) throw new Error('Neo Sisra bot yoki shaxsiy profil tasdiqlanmadi.');
  process.env.BOT_TOKEN = RELAY_TOKEN;
  process.env.GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/PERSONAL_TEST_NO_GOOGLE/exec';
  process.env.BROADCAST_TEST_CHAT_ID = String(config.chatId);
  process.env.BROADCAST_TEST_LABEL = '@' + config.username;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) !== `https://api.telegram.org/bot${RELAY_TOKEN}/sendMessage` || options.method !== 'POST') throw new Error('Personal test only permits a scoped sendMessage.');
    const data = validateMessage(config, JSON.parse(options.body));
    const result = await relay('sendMessage', data, options.signal);
    return Response.json(result.payload, { status: result.status });
  };
  const { createBot } = require('../bot.js');
  const bot = createBot({ dataDir: path.join(TEST_ROOT, 'data'), telegramTimeoutMs: PERSONAL_TELEGRAM_TIMEOUT_MS,
    broadcastTestRecipient: { chatId: config.chatId, label: '@' + config.username } });
  const db = bot.recoverInterrupted(bot.loadDb());
  bot.saveDb(db);
  const port = Number(process.env.ADMIN_PORT || 8787);
  const origin = `http://127.0.0.1:${port}`;
  const panel = createAdminServer({ bot, account: readAccount(path.join(ROOT, 'data')), origin, port, host: '127.0.0.1' });
  const runtime = bot.createPollingRuntime();
  await panel.start();
  console.info('Personal test panel: ' + origin);
  console.info('Only recipient: @' + config.username + ' (' + config.chatId + '). Bot: @neo_sisrabot.');
  console.info('Login: neo-admin. Password file: .local/admin-access.txt');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    runtime.requestStop();
    await panel.close();
    await bot.waitForBackground();
    runtime.dispose();
    bot.closeStore();
  };
  process.once('SIGINT', () => stop().catch(() => { process.exitCode = 1; }));
  process.once('SIGTERM', () => stop().catch(() => { process.exitCode = 1; }));
}

if (require.main === module) main().catch(() => { console.error('Shaxsiy test paneli ishga tushmadi. SSH ulanishi, profil sozlamasi va portni tekshiring.'); process.exitCode = 1; });
module.exports = { validateConfig, validateMessage, remoteCommand, createRelay, RELAY_TIMEOUT_MS, PERSONAL_TELEGRAM_TIMEOUT_MS };

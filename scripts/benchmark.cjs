'use strict';

// Offline simulation only: every HTTP request is intercepted before it can
// reach Telegram or Google. A temporary code copy cannot load the real .env.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-sisra-benchmark-'));
for (const name of ['bot.js','google-delivery.cjs','telegram-http.cjs','state-store.cjs','work-queue.cjs','telegram-queue.cjs']) {
  fs.copyFileSync(path.join(root,name),path.join(scratch,name));
}
Object.assign(process.env, {
  BOT_TOKEN: '123456:OFFLINE_CAPACITY_TEST',
  GOOGLE_SCRIPT_URL: 'https://script.google.com/macros/s/OFFLINE_TEST_ONLY/exec',
  PRIMARY_ADMIN_IDS: '', EXTRA_ADMIN_IDS: '', ADMIN_IDS: '', NOTIFY_CHAT_ID: '',
  WELCOME_IMAGE_PATH: '', OFFER_DOC_PATH: '', UPDATE_WORKERS: '32',
  DELIVERY_WORKERS: '4', TELEGRAM_MESSAGES_PER_SECOND: '25',
});
let runtime, burst, started, inflight, peak, calls, first, last;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(url);
  if (target.hostname !== 'api.telegram.org') throw new Error('Unexpected mocked host');
  if (target.pathname.endsWith('/getUpdates')) {
    runtime.requestStop();
    return Response.json({ok:true,result:Array.from({length:burst},(_,i)=>({
      update_id:i+1,message:{message_id:i+1,chat:{id:10000+i,type:'private'},from:{id:10000+i},text:'/start'},
    }))});
  }
  if (!target.pathname.endsWith('/sendMessage')) throw new Error('Unexpected mocked method');
  const data = JSON.parse(options.body);
  inflight++; calls++; peak = Math.max(peak,inflight);
  await new Promise(resolve=>setTimeout(resolve,100));
  inflight--;
  const elapsed = performance.now()-started;
  if (!first.has(data.chat_id)) first.set(data.chat_id,elapsed);
  last.set(data.chat_id,elapsed);
  return Response.json({ok:true,result:{message_id:calls}});
};
async function main() {
  const {createBot} = require(path.join(scratch,'bot.js'));
  const results = [];
  for (const count of [10,50,100]) {
    burst=count; inflight=0; peak=0; calls=0; first=new Map(); last=new Map();
    const bot=createBot({dataDir:path.join(scratch,'data-'+count)});
    runtime=bot.createPollingRuntime();
    started=performance.now();
    try { await runtime.run(); } finally { runtime.dispose(); bot.closeStore(); }
    const finalTimes=[...last.values()].sort((a,b)=>a-b);
    const seconds=value=>Number((value/1000).toFixed(2));
    results.push({users:count,messages:calls,maxParallelSends:peak,
      lastFirstReplySeconds:seconds(Math.max(...first.values())),
      p95BothMessagesSeconds:seconds(finalTimes[Math.ceil(count*0.95)-1]),
      lastBothMessagesSeconds:seconds(finalTimes.at(-1))});
  }
  console.log(JSON.stringify({kind:'Offline simulation, not measured production capacity',
    node:process.version,simulatedTelegramLatencyMs:100,telegramMessagesPerSecond:25,
    perChatPacingMs:1050,updateWorkers:32,scenario:'simultaneous /start; two replies per user',results},null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>{
  globalThis.fetch=originalFetch;
  const resolved=path.resolve(scratch);
  if (path.dirname(resolved)!==path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('neo-sisra-benchmark-')) throw new Error('Unexpected fixture path');
  fs.rmSync(resolved,{recursive:true,force:true});
});

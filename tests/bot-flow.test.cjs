const {test,after,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'neo-sisra-bot-test-'));
process.env.DATA_DIR=directory;
process.env.BOT_TOKEN='123456:FAKE_TOKEN_FOR_OFFLINE_TESTS';
process.env.GOOGLE_SCRIPT_URL='https://script.google.com/macros/s/TEST_ONLY/exec';
process.env.PRIMARY_ADMIN_IDS='42';
process.env.NOTIFY_CHAT_ID='';
const requests=[];
let responseHook=null;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options={})=>{
  const request={url:String(url),body:options.body instanceof FormData?Object.fromEntries(options.body):options.body?JSON.parse(options.body):null};
  requests.push(request);
  if(responseHook){const result=await responseHook(request);if(result)return result;}
  if(request.url.startsWith('https://script.google.com/'))return Response.json({result:'success',fileUrl:'https://drive.google.com/uc?id=TEST_RECEIPT_FILE&export=view'});
  if(request.url.includes('/file/bot'))return new Response(Buffer.from([255,216,255,1,2,3]),{status:200});
  if(request.url.endsWith('/getFile'))return Response.json({ok:true,result:{file_path:'photos/receipt.jpg',file_size:6}});
  return Response.json({ok:true,result:{message_id:123}});
};
const {createBot}=require('../bot.js');
const {readState}=require('../state-store.cjs');
let bot, testDirectory, savedWelcomeImagePath;
function openBot(){return createBot({dataDir:testDirectory,telegramQueue:{run:(_,fn)=>Promise.resolve().then(fn),idle:()=>Promise.resolve()}});}
beforeEach(()=>{
  savedWelcomeImagePath=process.env.WELCOME_IMAGE_PATH;
  process.env.WELCOME_IMAGE_PATH='';
  testDirectory=fs.mkdtempSync(path.join(directory,'case-'));
  bot=openBot();
});
afterEach(async()=>{
  try {await bot.waitForBackground();bot.closeStore();}
  finally {
    if(savedWelcomeImagePath===undefined)delete process.env.WELCOME_IMAGE_PATH;
    else process.env.WELCOME_IMAGE_PATH=savedWelcomeImagePath;
  }
});
after(()=>{globalThis.fetch=originalFetch;fs.rmSync(directory,{recursive:true,force:true});});
const msg=(id,text,extra={})=>({chat:{id,type:'private'},from:{id,username:'test'},text,message_id:1,...extra});
const cb=(id,data)=>({id:'cb-'+id,from:{id},message:{chat:{id,type:'private'}},data});
const sheetRequests=()=>requests.filter(r=>r.url.startsWith('https://script.google.com/'));
const photo={photo:[{file_id:'TEST_PHOTO',file_unique_id:'TEST_UNIQUE',file_size:6}]};
async function fill(db,id){await bot.handleMessage(msg(id,'/start'),db);await bot.handleMessage(msg(id,'TEST Neo Sisra'),db);await bot.handleMessage(msg(id,'+998901234567'),db);}
for(const withImage of [false,true])test(`start preserves separate welcome${withImage?', image':''} and name prompt in order`,{timeout:5000},async()=>{
  if(withImage){
    const imagePath=path.join(testDirectory,'welcome.png');
    fs.writeFileSync(imagePath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=','base64'));
    bot.closeStore();process.env.WELCOME_IMAGE_PATH=imagePath;bot=openBot();
  }
  let releaseWelcome, welcomeStarted, releaseImage, imageStarted;
  const welcomeGate=new Promise(resolve=>{releaseWelcome=resolve;});
  const firstSend=new Promise(resolve=>{welcomeStarted=resolve;});
  const imageGate=new Promise(resolve=>{releaseImage=resolve;});
  const imageSend=new Promise(resolve=>{imageStarted=resolve;});
  responseHook=async request=>{
    if(request.body?.text?.includes('<b>Neo Sisra</b>')){welcomeStarted();await welcomeGate;}
    if(request.url.endsWith('/sendPhoto')){imageStarted();await imageGate;}
    return null;
  };
  requests.length=0;const db=bot.loadDb();
  const starting=bot.handleMessage(msg(111,'/start'),db);
  try {
    await firstSend;
    assert.equal(requests.length,1,'Later steps must wait until the welcome send finishes');
    assert.match(requests[0].body.text,/50 kishi uchun maxsus taklif/);
    assert.doesNotMatch(requests[0].body.text,/ismingizni kiriting/);
    assert.equal(readState({dataDir:testDirectory}).users['111'].step,'name');
    releaseWelcome();
    if(withImage){
      await imageSend;
      assert.equal(requests.length,2,'The name prompt must wait until the optional image finishes');
      assert.equal(requests[1].body.caption,undefined);
      releaseImage();
    }
    await starting;
    assert.deepEqual(requests.map(request=>request.url.slice(request.url.lastIndexOf('/')+1)),withImage?['sendMessage','sendPhoto','sendMessage']:['sendMessage','sendMessage']);
    const prompt=requests.at(-1).body;
    assert.match(prompt.text,/ismingizni kiriting/);
    assert.doesNotMatch(prompt.text,/Neo Sisra/);
    assert.deepEqual(prompt.reply_markup,{remove_keyboard:true});
    await bot.handleMessage(msg(111,'Offline Person'),db);
    assert.equal(db.users['111'].step,'phone');
    assert.match(requests.at(-1).body.text,/Telefon raqamingizni yuboring/);
  } finally {
    releaseWelcome();releaseImage();
    try {await starting;} finally {responseHook=null;}
  }
});

test('consent is mandatory, one-service copy is used, and accepting twice cannot duplicate registration',async()=>{
  requests.length=0;const db=bot.loadDb();await fill(db,101);
  assert.equal(db.users['101'].step,'offer');assert.equal(sheetRequests().length,0);
  await bot.handleCallback(cb(101,'offer:no'),db);assert.equal(sheetRequests().length,0);
  await bot.handleMessage(msg(101,'',photo),db);assert.equal(db.payments.length,0);
  await bot.handleCallback(cb(101,'offer:yes'),db);await bot.waitForBackground();
  assert.equal(db.users['101'].step,'receipt');assert.equal(db.registrations.length,1);
  assert.equal(sheetRequests()[0].body.Oferta,'Roziman');assert.equal(sheetRequests()[0].body.Tarif,'Koreyaga talaba yuborish');
  await bot.handleCallback(cb(101,'offer:yes'),db);await bot.waitForBackground();assert.equal(sheetRequests().length,1);
  const copy=bot.paymentText();assert.match(copy,/Neo Sisra/);assert.doesNotMatch(copy,/Navola|Takhirov|Erkatoy|kurs|Malika|8600/);
});
test('invalid phone letters and another person’s contact are rejected',async()=>{
  const db=bot.loadDb();await bot.handleMessage(msg(102,'/start'),db);await bot.handleMessage(msg(102,'Test name'),db);
  await bot.handleMessage(msg(102,'abc901234567'),db);assert.equal(db.users['102'].step,'phone');
  await bot.handleMessage(msg(102,'',{contact:{phone_number:'998901234567',user_id:777}}),db);assert.equal(db.users['102'].step,'phone');
  assert.equal(bot.normalizePhone('+82 10 1234 5678'),'+821012345678');
});
test('receipt acknowledgment is immediate while Google is held; exact file is not reposted and secrets stay out of persistence',async()=>{
  const db=bot.loadDb();await fill(db,103);await bot.handleCallback(cb(103,'offer:yes'),db);await bot.waitForBackground();requests.length=0;
  let release;const held=new Promise(resolve=>{release=resolve;});
  let receiptStarted;const started=new Promise(resolve=>{receiptStarted=resolve;});
  responseHook=async r=>{if(r.body?.imageUpload==='true'){receiptStarted();await held;}return null;};
  try {
    await bot.handleMessage(msg(103,'',photo),db);await started;
    assert.equal(db.users['103'].step,'done');assert.equal(db.payments[0].status,'sending');
    assert.ok(requests.some(r=>r.body?.text?.includes('Chekingiz qabul qilindi')));
    assert.ok(JSON.stringify(readState({dataDir:testDirectory})).includes('TEST_PHOTO'));
    release();await bot.waitForBackground();assert.equal(db.payments[0].status,'sent');
    assert.equal(db.payments[0].check_url,'https://drive.google.com/file/d/TEST_RECEIPT_FILE/view');
    const serialized=JSON.stringify(db);assert.doesNotMatch(serialized,/FAKE_TOKEN|api\.telegram\.org/);
    await bot.handleMessage(msg(103,'',photo),db);await bot.waitForBackground();assert.equal(sheetRequests().length,1);
  } finally {release();responseHook=null;}
});
test('failed delivery remains durable and retries reuse one local payment record',async()=>{
  const db=bot.loadDb();await fill(db,104);await bot.handleCallback(cb(104,'offer:yes'),db);await bot.waitForBackground();requests.length=0;
  responseHook=async r=>r.body?.imageUpload==='true'?Response.json({result:'error',error:'PRIVATE_BACKEND_TEXT'}):null;
  await bot.handleMessage(msg(104,'',photo),db);await bot.waitForBackground();assert.equal(db.payments[0].status,'failed');
  assert.doesNotMatch(JSON.stringify(db),/PRIVATE_BACKEND_TEXT/);
  responseHook=null;await bot.handleMessage(msg(104,'/retry'),db);await bot.waitForBackground();
  assert.equal(db.payments.length,1);assert.equal(db.payments[0].status,'sent');assert.equal(sheetRequests().length,2);
});
test('invalid receipt metadata is rejected before upload and groups cannot register',async()=>{
  const db=bot.loadDb();await fill(db,105);await bot.handleCallback(cb(105,'offer:yes'),db);await bot.waitForBackground();requests.length=0;
  await bot.handleMessage(msg(105,'',{video:{file_id:'video'}}),db);
  await bot.handleMessage(msg(105,'',{document:{file_id:'huge',mime_type:'application/pdf',file_name:'x.pdf',file_size:11*1024*1024}}),db);
  assert.equal(db.payments.length,0);assert.equal(sheetRequests().length,0);
  await bot.handleMessage(msg(106,'/start',{chat:{id:-106,type:'group'}}),db);assert.equal(db.users['-106'],undefined);
});
test('admin actions require the configured user and callbacks cannot edit another admin’s broadcast',async()=>{
  const db=bot.loadDb();requests.length=0;
  await bot.handleMessage(msg(108,'/export'),db);assert.ok(!requests.some(r=>r.url.endsWith('/sendDocument')));
  db.broadcast={step:'collecting',fromChatId:108,items:[{id:'one',preview:'private',controlMessageId:1}]};
  await bot.handleCallback({id:'admin-cb',from:{id:42},message:{chat:{id:108,type:'private'}},data:'bc:del:one'},db);
  assert.equal(db.broadcast.items.length,1);
});
test('recovery keeps unsent jobs pending and marks ambiguous sending jobs for explicit retry',()=>{
  const db=bot.emptyDb();db.registrations.push({status:'pending'});db.payments.push({status:'sending'},{status:'sent'});
  bot.recoverInterrupted(db);assert.deepEqual(db.payments.map(r=>r.status),['failed','sent']);assert.equal(db.registrations[0].status,'pending');
});
test('failed signup is visible through status and retry succeeds without another registration',async()=>{
  const db=bot.loadDb();await fill(db,109);requests.length=0;
  responseHook=async r=>r.body?.imageUpload==='false'?Response.json({result:'error'}):null;
  await bot.handleCallback(cb(109,'offer:yes'),db);await bot.waitForBackground();
  assert.equal(db.registrations[0].status,'failed');
  await bot.handleMessage(msg(109,'/status'),db);
  assert.ok(requests.some(r=>r.body?.text?.includes('jadvalga yetkazilgani tasdiqlanmadi')));
  responseHook=null;await bot.handleMessage(msg(109,'/retry'),db);await bot.waitForBackground();
  assert.equal(db.registrations.length,1);assert.equal(db.registrations[0].status,'sent');
});
test('id command only returns the requester ID and does not register or grant admin access',async()=>{
  const db=bot.loadDb();requests.length=0;await bot.handleMessage(msg(110,'/id'),db);
  assert.equal(requests[0].body.text,'Sizning Telegram ID: 110');assert.equal(db.registrations.length,0);assert.deepEqual(db.admin_chat_ids,[]);
});

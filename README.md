# Neo Sisra toʻlov boti

[@neo_sisrabot](https://t.me/neo_sisrabot) — Koreyaga talaba yuborish xizmati uchun roʻyxatdan oʻtish va toʻlov cheklarini qabul qiladigan Telegram bot. Roʻyxatdan oʻtish maʼlumotlari Google Sheets’ga, chek fayllari esa mavjud Google Apps Script orqali Google Drive’ga yuboriladi.

- Repozitoriy: [asositgroup/neo-sisra-tolovbot](https://github.com/asositgroup/neo-sisra-tolovbot)
- Mahalliy ishga tushirish: quyidagi qoʻllanma.
- Yangi Linux serverga oʻrnatish, CI/CD va tiklash: [server qoʻllanmasi](docs/DEPLOYMENT.md).

## Bot qanday ishlaydi?

1. Foydalanuvchi `/start` orqali roʻyxatdan oʻtadi, ism-familiyasi va telefon raqamini kiritadi.
2. Oferta shartlariga majburiy rozilik bildiradi.
3. Xizmat narxi va karta rekvizitlarini oladi, PNG, JPG/JPEG yoki PDF chek yuboradi. Chek hajmi 10 MiB gacha.
4. Maʼlumotlar avval botning mahalliy bazasiga saqlanadi. Google’ga yuborish fonda davom etadi; foydalanuvchi jarayon tugashini kutib qolmaydi.
5. `/status` orqali yuborilish holatini tekshiradi. Tasdiqlanmagan yuborishni `/retry` orqali qayta urinishi mumkin.

Chekning qabul qilinishi yoki Drive’ga yetkazilishi toʻlov tasdiqlanganini anglatmaydi. Toʻlovni administrator tekshiradi. Xizmat nomi **Koreyaga talaba yuborish**; bot kurs sotish uchun moʻljallanmagan.

## Talablar

- Git, Node.js **22** va u bilan birga keladigan npm. [Node.js rasmiy yuklash sahifasida](https://nodejs.org/en/download) 22.x ni tanlang. CI va amaldagi server Node 22 bilan tekshirilgan; `package.json` dagi eng past chegara Node 18.
- Jonli ishga tushirish uchun bot tokeni va ishlaydigan Google Apps Script `/exec` manzili.
- Telegram va Google xizmatlariga internet orqali chiqish.
- Server uchun systemd mavjud Linux va Python 3; batafsil talablar [server qoʻllanmasida](docs/DEPLOYMENT.md).

Tashqi npm paketlari yoʻq: `npm install` talab qilinmaydi. Bot Telegram long polling orqali ishlaydi, lokal HTTP server yoki domen ochish shart emas.

## Lokal kompyuterda ishga tushirish

### 1. Loyihani olish

```sh
git clone https://github.com/asositgroup/neo-sisra-tolovbot.git
cd neo-sisra-tolovbot
node --version
npm --version
```

### 2. Avval kodni tekshirish

```sh
npm run check
npm test
```

Bu tekshiruvlar uchun haqiqiy token yoki `.env` kerak emas. Testlar soxta maʼlumotlar, vaqtinchalik baza va almashtirilgan tarmoq funksiyalaridan foydalanadi; Telegram’ga xabar yoki Google Sheets’ga yozuv yubormaydi.

Deploy testlarini Linuxda yoki WSL’da ishga tushirish:

```sh
python3 -m unittest discover -s deploy/tests -v
```

### 3. `.env` yaratish

Windows PowerShell:

```powershell
if (!(Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
notepad .env
```

Linux/macOS:

```sh
test -e .env || cp .env.example .env
chmod 600 .env
nano .env
```

Bu nusxalash buyruqlarini yangi oʻrnatishda bajaring; mavjud `.env` ustiga qayta nusxalamang. `BOT_TOKEN` qiymatini loyiha administratoridan xavfsiz kanal orqali oling. `GOOGLE_SCRIPT_URL` namunada Neo Sisra’ning amaldagi endpointiga sozlangan: undan jonli ishga tushirilsa, yozuvlar haqiqiy loyihaning jadvaliga tushadi. Sinov uchun alohida mos Apps Script va jadvaldan foydalaning.

**Token tekshiruvi:** hozirgi kod ishga tushishda token aynan `@neo_sisrabot` ga tegishli ekanini tekshiradi. Boshqa bot tokenini qoʻyishning oʻzi yetarli emas. Alohida sinov boti kerak boʻlsa, local branchda `bot.js` oxiridagi `identity.username !== 'neo_sisrabot'` tekshiruvini test bot username’iga (`@` belgisiz), Google endpointini esa test jadvaliga moslang. Test bot sozlamasini ishlab turgan `main` ga yubormang: server ham shu kodni oladi. Boshqa loyiha uchun moslashda matnlar, `SERVICE_NAME`, `CHANNEL_URL` va `google-delivery.cjs` dagi xizmat nomi ham oʻzgartiriladi.

**Bir token — bir polling jarayoni.** Shu token bilan serverdagi bot ishlayotgan boʻlsa, lokal botni parallel boshlamang. Jonli nusxani localga koʻchirishda operator avval timer va davom etayotgan poll/deploy’ni, soʻng bot xizmatini toʻxtatadi; yopiq `.env` va `data` holati saqlanib koʻchiriladi. Serverga qaytishda ham eng oxirgi holat tiklanadi. Lokal va server bazalari avtomatik sinxronlashmaydi; boʻsh yoki eskirgan baza bilan ishga tushirmang. [Koʻchirish va tiklash tartibini](docs/DEPLOYMENT.md) bajaring. Oddiy kod tekshiruvi uchun yuqoridagi offline testlar yetarli.

### 4. Botni boshlash va toʻxtatish

```sh
npm start
```

Terminalda quyidagi yozuvlar chiqishi kerak:

```text
Neo Sisra bot identity verified: @neo_sisrabot
Neo Sisra polling ready.
```

Shundan keyin Telegram’da botga `/start` yuborib sinash mumkin. Jarayon terminal ochiq turgan vaqtda ishlaydi. Toʻxtatish uchun `Ctrl+C` bosing: bot davom etayotgan yuborishlarni tugatishga 240 soniyagacha vaqt oladi. Jonli lokal sinov tugagach, server operatori xizmatni qayta ishga tushiradi. Doimiy ishlash uchun [systemd oʻrnatish qoʻllanmasidan](docs/DEPLOYMENT.md) foydalaning.

## `.env` sozlamalari

Bot `.env` faylini `bot.js` joylashgan papkadan oʻqiydi. Operatsion tizim yoki shell muhitida kalitning **boʻsh boʻlmagan qiymati** allaqachon mavjud boʻlsa, u `.env` qiymatidan ustun turadi. Sozlamalarni oʻzgartirgandan keyin botni qayta ishga tushirish kerak.

Har bir qatorda `KALIT=qiymat` yozing. Izohlarni alohida `#` qatoriga yozing; parser `export`, oʻzgaruvchi almashtirish yoki qiymat oxiridagi izohlarni dotenv kutubxonasi kabi qayta ishlamaydi.

| Kalit | Vazifasi |
| --- | --- |
| `BOT_TOKEN` | Majburiy. Neo Sisra botining Telegram tokeni. Git’ga kiritilmaydi. |
| `GOOGLE_SCRIPT_URL` | Majburiy. Google Apps Script web app’ning `https://script.google.com/macros/s/.../exec` manzili. Sheet yoki Drive papkasi havolasi emas. |
| `PRIMARY_ADMIN_IDS` | Vergul bilan ajratilgan raqamli Telegram foydalanuvchi IDlari. Asosiy administratorlar. |
| `EXTRA_ADMIN_IDS` | Qoʻshimcha administratorlarning raqamli IDlari. |
| `NOTIFY_CHAT_ID` | Ixtiyoriy. Roʻyxatdan oʻtish va chek bildirishnomalari yuboriladigan guruh IDsi. |
| `NOTIFY_REG_TOPIC` | Ixtiyoriy. Roʻyxatdan oʻtish xabarlari uchun forum mavzusi IDsi. |
| `NOTIFY_PAY_TOPIC` | Ixtiyoriy. Cheklar uchun forum mavzusi IDsi. |
| `CONTACT_PHONE`, `CONTACT_ADMIN` | Foydalanuvchiga koʻrsatiladigan aloqa telefoni va administrator kontakti. `CONTACT_ADMIN` admin huquqini bermaydi. |
| `SERVICE_PRICE` | Xizmat narxining koʻrsatiladigan matni; valyutani ham qiymat ichida yozing. |
| `UZCARD_NUMBER`, `UZCARD_HOLDER` | UZCARD karta raqami va egasi. |
| `VISA_NUMBER`, `VISA_HOLDER` | Visa karta raqami va egasi. |
| `OFFER_DOC_PATH` | Ixtiyoriy. Foydalanuvchiga yuboriladigan tasdiqlangan oferta fayli yoʻli. |
| `OFFER_VERSION` | Oferta versiyasi. Hujjat shartlari yangilansa, yangi qiymat qoʻying: yangi chek yuborishda qayta rozilik talab qilinadi. |
| `WELCOME_IMAGE_PATH` | Ixtiyoriy. Kirish xabariga qoʻshiladigan rasm yoʻli. |
| `DATA_DIR` | Ixtiyoriy. Baza va eksportlar papkasi. Standartda bot papkasidagi `data`; nisbiy qiymat jarayonning ishchi papkasiga nisbatan olinadi. |

`ADMIN_IDS` eski sozlama nomi sifatida qoʻllab-quvvatlanadi; yangi oʻrnatishda `PRIMARY_ADMIN_IDS` dan foydalaning. Telegram username’i yoki kanal havolasi administrator huquqini bermaydi. Oʻz raqamli ID’ingizni botdagi `/id` buyrugʻi orqali olish mumkin.

Admin IDlari boʻsh boʻlsa, admin vositalari oʻchiq qoladi. `NOTIFY_CHAT_ID` boʻsh boʻlsa, guruh bildirishnomalari yuborilmaydi; bu Google’ga maʼlumot yuborishni toʻxtatmaydi. Guruhdan foydalanilganda botni oʻsha guruhga qoʻshing va xabar yuborish ruxsatini bering.

`OFFER_DOC_PATH` va `WELCOME_IMAGE_PATH` uchun nisbiy yoʻl bot fayli joylashgan papkadan hisoblanadi. Release papkalari almashadigan serverda fayllarni alohida saqlab, mutlaq yoʻl koʻrsating. Standart systemd xizmati faqat `/opt/neo-sisra-pay-bot/data` ga yozishga ruxsat beradi; serverda `DATA_DIR` oʻzgartirilsa, unit ruxsatlari ham moslanishi kerak.

### Yakuniy ishga tushirish uchun administrator beradigan maʼlumotlar

- Tasdiqlangan xizmat narxi, karta raqamlari va karta egalarining ism-familiyasi.
- Aloqa telefoni va administrator kontakti.
- Raqamli administrator IDlari; kerak boʻlsa, bildirishnoma guruhi va mavzu IDlari.
- Tasdiqlangan oferta fayli va versiyasi; kerak boʻlsa, kirish rasmi.

Namunada narx va rekvizitlar `XXX`, oferta versiyasi esa `pending-2026-10-04`. Ular yakuniy maʼlumotlar bilan almashtirilishi kerak. Botning majburiy rozilik mexanizmi tayyor; oferta hujjati alohida taqdim etiladi.

## Google Sheets va Drive integratsiyasi

Apps Script kodi ushbu repozitoriyda yoʻq. Mavjud Neo Sisra integratsiyasi bilan ishlash uchun uning deploy manzili `.env.example` da berilgan. Boshqa jadvalga koʻchirishda Sheets va Drive’ga ruxsati bor mos Apps Script web app ham tayyor boʻlishi kerak; faqat jadval URL’ini almashtirish yetarli emas. Backend botning autentifikatsiyasiz POST soʻrovini qabul qilishi kerak; bot Google akkauntiga interaktiv kirmaydi. [Apps Script web app qoʻllanmasi](https://developers.google.com/apps-script/guides/web).

Mavjud varaq nomlari va ustunlar aynan saqlanadi:

| Varaq | Ustunlar |
| --- | --- |
| `Royhatdan otganlar` | `Ism`, `Telefon raqam`, `Tarif`, `Oferta`, `Sana` |
| `Chek Yuborganlar` | `Ism`, `Telefon raqam`, `Tarif`, `Offerta`, `Check URL`, `sana`, `vaqt` |

Rozilik mavjud `Oferta` va `Offerta` ustunlariga `Roziman` sifatida tushadi; yangi rozilik ustuni yaratilmaydi. `Tarif` qiymati — `Koreyaga talaba yuborish`. Sana va vaqt `Asia/Tashkent` boʻyicha yuboriladi.

Bot endpointga `multipart/form-data` POST yuboradi. Roʻyxatdan oʻtishda `sheetName`, `imageUpload=false` va tegishli ustunlar yuboriladi. Chek uchun `imageUpload=true`, `checkUrlHeader=Check URL`, `file_data` (base64), `file_filename` va `file_mime` qoʻshiladi. Drive papkasi Apps Script tomonida sozlanadi; botga Drive papkasi IDsi kerak emas.

Bot quyidagi JSON javoblarini kutadi:

```json
{"result":"success"}
```

Chek uchun javobda haqiqiy Google Drive fayl manzili ham boʻlishi kerak:

```json
{"result":"success","fileUrl":"https://drive.google.com/file/d/FILE_ID/view"}
```

Payload va javob tekshiruvining aniq manbasi: [google-delivery.cjs](google-delivery.cjs). Telegram tokeni qatnashgan fayl yuklab olish URL’i Sheets’ga yoki bazaga yozilmaydi.

Yuborish javobi kelmasa, Google soʻrovni qabul qilgan-qilmagani nomaʼlum boʻlishi mumkin. Shuning uchun bot bunday yozuvni avtomatik qayta yubormaydi. `/retry` dan oldin jadvalni tekshirish maʼqul: takroriy yozuv yuzaga kelishi mumkin.

## Bot buyruqlari

| Buyruq | Vazifasi |
| --- | --- |
| `/start` | Roʻyxatdan oʻtishni boshlash |
| `/id` | Telegram raqamli ID maʼlumotini olish |
| `/status` | Maʼlumot va chek yuborilish holatini koʻrish |
| `/retry` | Tasdiqlanmagan yuborishni qoʻlda qayta urinish |
| `/admin` | Ruxsat berilgan administrator paneli |
| `/export` | Administrator uchun mahalliy yozuvlarni eksport qilish |

## CI/CD qanday ulangan?

**Amaldagi usul — serverdagi systemd timer.** Server repo’ning `main` branchini tekshiradi; har bir tekshiruv tugagandan keyin taxminan 60 soniya oʻtib navbatdagi tekshiruv boshlanadi. GitHub saytidan faylni tahrirlab `main` ga commit qilish ham avtomatik yangilanishni boshlaydi.

1. Yangi commit kodi serverga olinadi.
2. Alohida `neo-sisra-ci-test` foydalanuvchisi nomidan, tarmoq va bot bazasiga kirishsiz testlar bajariladi.
3. Testlardan oʻtgan runtime fayllari `/opt/neo-sisra-pay-bot/releases/<commit-SHA>` ga oʻrnatiladi.
4. `current` havolasi yangi release’ga oʻtkaziladi va bot xizmati qayta ishga tushiriladi.
5. Yangi jarayonning Telegram polling tayyorligi tekshiriladi. Ishga tushish tekshiruvi oʻtmasa, oldingi release tiklanadi va uning tayyorligi ham tekshiriladi.

`.env` va `data` release tashqarisida saqlanadi; deploy ularni almashtirmaydi. Yangilanish odatda bir necha daqiqa oladi. Test yoki deploydan oʻtmagan commit har daqiqada qayta urinilmaydi: xatoni tuzatib yangi commit qilish kerak. Pull request va boshqa branchlar serverga avtomatik joylashtirilmaydi.

### Oʻzgarish yuborish

```sh
npm run check
npm test
git add bot.js
git commit -m "Update bot messages"
git push origin main
```

`git add` da oʻzgartirgan fayllaringizni aniq koʻrsating. Haqiqiy `.env`, mijozlar bazasi yoki eksportlarni commit qilmang. Serverdagi faol release’ni qoʻlda tahrirlash oʻrniga oʻzgarishlarni repo orqali kiriting. README kabi hujjat commitlari ham yangi SHA boʻlgani uchun test/deploy jarayonini boshlaydi.

### Serverda holatni tekshirish

```sh
sudo systemctl status neo-sisra-bot-poll.timer neo-sisra-pay-bot.service
sudo journalctl -u neo-sisra-bot-poll.service -n 30 --no-pager
sudo journalctl -u neo-sisra-bot-tests.service -n 80 --no-pager
readlink /opt/neo-sisra-pay-bot/current
```

`poll.service` bir martalik jarayon: muvaffaqiyatli tugagach `inactive (dead)` boʻlishi tabiiy. Timer `active (waiting)`, bot `active (running)` boʻlishi va poll xizmatining `Result=success` holati tekshiriladi.

Kutmasdan tekshirishni boshlash:

```sh
sudo systemctl start neo-sisra-bot-poll.service
```

Avtomatik deployni vaqtincha toʻxtatish:

```sh
sudo systemctl disable --now neo-sisra-bot-poll.timer
```

Keyin qayta yoqish: `sudo systemctl enable --now neo-sisra-bot-poll.timer`. Timerni toʻxtatish bot xizmatini yoki allaqachon boshlangan deploy’ni toʻxtatmaydi. Xatolarni tekshirish, oldingi versiyaga qaytish va yangi serverni sozlash: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### GitHub Actions holati

[Workflow](.github/workflows/deploy.yml) ham tayyor. 2026-10-05 dagi birinchi ishga tushirish GitHub billing blokirovkasi sabab runner boshlanmasdan rad etilgan; shu sabab workflow repo sozlamasida oʻchirilgan. Hozirgi avtomatik deploy server timeri orqali ishlaydi. Actions’dagi holat server deployining natijasi emas.

Actions’ga oʻtish tartibi server qoʻllanmasida keltirilgan: billing muammosini hal qilish, server timerini oʻchirish, workflow’ni yoqish va repository variable `DEPLOY_WITH_ACTIONS=true` ni oʻrnatish kerak. Ikki deploy usulini bir vaqtda yoqmang.

Actions secrets: `DEPLOY_HOST` (server), `DEPLOY_PORT` (SSH port), `DEPLOY_USER` (cheklangan deploy foydalanuvchisi), `DEPLOY_SSH_KEY` (maxsus private deploy kaliti), `DEPLOY_KNOWN_HOSTS` (tekshirilgan server host key yozuvi). Amaldagi repo/server uchun ular sozlangan; yangi server uchun qiymatlar alohida moslanadi. Bot tokeni bu secrets ichida turmaydi; u serverdagi yopiq `.env` da saqlanadi. [Workflow’ni yoqish boʻyicha GitHub qoʻllanmasi](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows).

### Avtomatik deploy chegaralari

Avtomatik oʻrnatiladigan runtime fayllari: `bot.js`, `google-delivery.cjs`, `telegram-http.cjs`, `package.json`. Yangi modul yoki npm dependency qoʻshilsa, poll/deploy fayl roʻyxatlari va workflow ham moslanishi kerak. Hozirgi deploy tashqi runtime dependency qabul qilmaydi.

Systemd unitlari, poll/deploy skriptlari va test runner oʻzgarishlari operator tomonidan alohida oʻrnatiladi. Oferta va kirish rasmi ham alohida saqlanadi. Server ochiq repo’dan GitHub tokenisiz oʻqiydi; repo private qilinsa, oʻqish ruxsati alohida sozlanishi zarur.

## Fayllar tuzilishi

| Fayl yoki papka | Vazifasi |
| --- | --- |
| `bot.js` | Telegram suhbatlari, admin paneli, mahalliy baza va polling |
| `google-delivery.cjs` | Sheets payload’i, chek tekshiruvi va Drive javobini tekshirish |
| `telegram-http.cjs` | Telegram soʻrovlari va vaqt cheklovlari |
| `.env.example` | Maxfiy qiymatlarsiz sozlama namunasi |
| `tests/` | Botning offline JavaScript testlari |
| `deploy/` | Server yangilash, tekshiruv va systemd fayllari |
| `deploy/tests/` | Linux deploy va poll testlari |
| `.github/workflows/deploy.yml` | Muqobil GitHub Actions CI/CD |
| `docs/DEPLOYMENT.md` | Server oʻrnatish va texnik xizmat qoʻllanmasi |
| `data/` | Ishlash paytida yaratiladigan baza va eksportlar; Git’ga kiritilmaydi |

## Maʼlumotlar va zaxira nusxasi

Mahalliy yozuvlar `data/bot_data.json` da, administrator eksporti `data/neo-sisra-pay-export.xls` da saqlanadi. Baza avval vaqtinchalik faylga yozilib, keyin atomar almashtiriladi. Bu papka foydalanuvchilarning shaxsiy maʼlumotlarini saqlaydi.

`.env`, `data` va alohida oferta/rasm fayllarining yopiq zaxira nusxasini saqlang. Izchil baza nusxasi yoki tiklash vaqtida botni toʻxtating; tiklangandan soʻng fayl egasi va ruxsatlarini tekshiring. Baza fayli oʻqilmasa, uni oʻchirish orqali “tuzatmang”: avval nusxa olib, JSON va fayl ruxsatlarini tekshiring.

## Koʻp uchraydigan muammolar

| Holat | Tekshirish |
| --- | --- |
| `BOT_TOKEN .env faylida yoq` | `.env` bot papkasidami, token qiymati kiritilganmi? |
| `Google delivery configuration is invalid.` | `GOOGLE_SCRIPT_URL` toʻliq Apps Script `/exec` manzilimi? Query yoki Sheet URL’i qoʻyilmaganmi? |
| `Sozlangan token Neo Sisra botiga tegishli emas.` | Token username’i `neo_sisrabot` boʻlishi kerak; boshqa bot uchun koddagi tekshiruv ham moslanadi. |
| Telegram polling `409` xatosi | Shu token bilan boshqa polling jarayoni yoki webhook ishlamayaptimi? Bitta faol bot jarayoni qoldiring. |
| `.env` oʻzgarishi koʻrinmayapti | Bot qayta ishga tushirildimi? Shell/systemd muhitidagi boʻsh boʻlmagan qiymat ustun kelmayaptimi? |
| Google’ga yuborish tasdiqlanmadi | Apps Script deploy ruxsatlari, Sheet/Drive ruxsatlari va JSON javobini tekshiring. Qayta urinishdan oldin jadvalda yozuv borligini tekshiring. |
| `/admin` ochilmayapti | `.env` da raqamli foydalanuvchi IDsi berilganmi? Username yoki chat ID qoʻyilmaganmi? |
| Guruhga xabar tushmayapti | `NOTIFY_CHAT_ID`, mavzu IDlari, guruhda bot mavjudligi va xabar yuborish ruxsatlarini tekshiring. |
| GitHub’dagi oʻzgarish serverga kelmadi | Commit `main` dami? Timer va poll/test jurnallarini tekshiring. Xatoli commit yangi commitgacha qayta urinilmaydi. |

Bot webhook’ni oʻzi olib tashlamaydi. Pollingga oʻtishda operator [Telegram `getWebhookInfo` / `deleteWebhook`](https://core.telegram.org/bots/api#getwebhookinfo) orqali holatni tekshiradi; navbatdagi update’larni oʻchiradigan parametrni yoqmang.

## Tekshirilgan holat

2026-10-05 kuni server timeri `3502546b3e8e427d263558694bd20b9992fa1964` commitini avtomatik olib, 34 ta JavaScript va 62 ta Linux testidan oʻtkazgan va joylashtirgan. Yangi jarayonda `Neo Sisra polling ready.` yozuvi tasdiqlangan. Bu tarixiy tekshiruv; hozirgi versiyani serverdagi `current` havolasi orqali aniqlang.

Google integratsiyasining alohida belgilangan sinov yozuvi va PNG cheki mavjud Sheets/Drive’da tekshirilgan. Telegram foydalanuvchisi bilan toʻliq jonli suhbat sinovi hali qayd etilmagan. Yakuniy narx, rekvizitlar, admin IDlari va oferta hujjati loyiha administratoridan olinadi.

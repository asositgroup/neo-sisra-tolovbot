# Neo Sisra xabar yuborish paneli

Panel `neo-admin` hisobi bilan ochiladi. Admin matn yozadi, ko‘rinishini tekshiradi va yuborishni tasdiqlaydi. Bot kampaniya boshlangandagi foydalanuvchilarga xabar yuboradi; jarayon va yakuniy natija panelda ko‘rinadi. Yuborilgan, botni bloklagan, boshqa yetkazilmagan va natijasi noma’lum holatlar alohida hisoblanadi. Akkaunti mavjud bo‘lmagan yoki boshqa sabab bilan yetkazilmagan xabarlar umumiy xato hisobiga kiradi; ular bloklagan deb ko‘rsatilmaydi. Telegram javobini olishdan oldin aloqa uzilsa, xabar yetib borgan bo‘lishi mumkin; bunday qabul qiluvchiga avtomatik qayta yuborilmaydi.

React/Vite interfeys `admin/` ichida. Productionda uning tayyor natijasi `admin-assets.cjs` orqali mavjud bot jarayonidan beriladi. Serverga npm paketlari o‘rnatilmaydi. Bot tokeni va parol frontend paketiga kirmaydi. Admin panel standart holatda o‘chiq; mavjud bot uchun `ADMIN_ENABLED=true` qo‘yilmaguncha qo‘shimcha port ochilmaydi.

## Xabarga ixtiyoriy tugma qo‘shish

“Tugma qo‘shish” ni yoqing, tugma nomi va to‘liq HTTPS havolasini kiriting. Masalan, nomi “👤 Admin bilan bog‘lanish”, havolasi esa kerakli adminning `https://t.me/username` manzili bo‘lishi mumkin. Ko‘rinish va yuborishni tasdiqlash oynasida tugma xabar ostida chiqadi. Bu tanlov o‘chiq bo‘lsa, faqat matn yuboriladi.

Panel bir xabarga bitta havolali tugmani qo‘llaydi: nomi 1–64 belgi, HTTPS havolasi 2048 belgigacha. Tugma kampaniya va yuborish tarixida saqlanadi; aloqa uzilgandan keyingi takroriy so‘rov ham ayni matn va tugma bilan tekshiriladi. Shaxsiy test rejimida tugmali xabarlar ham faqat tasdiqlangan bitta profilga yuboriladi.

## Lokal ko‘rish va sinash

Node.js 22.13 yoki undan yangi 22.x talab qilinadi. Loyiha papkasida:

```powershell
npm ci --prefix admin
npm run admin:build
npm run admin:demo
```

Demo manzili `http://127.0.0.1:8787`. Demo o‘zining `.local/admin-demo/data` papkasini va `.local/admin-demo/access.txt` login faylini ishlatadi. Parol konsolga chiqarilmaydi; shu faylni mahalliy muharrirda oching. Demo 24 ta sun’iy foydalanuvchi bilan haqiqiy navbat va holat mexanizmini sinaydi; Telegram chaqiruvlari soxta javoblar bilan almashtirilgan, polling boshlanmaydi. Oddiy yuborish yakunida 18 ta yuborilgan, 3 ta bloklagan va 3 ta boshqa yetkazilmagan natija chiqadi. Demo ma’lumotlarini productionga ko‘chirmang.

Port band bo‘lsa, `ADMIN_PORT` va `ADMIN_ORIGIN` qiymatlarini birga o‘zgartiring:

```powershell
$env:ADMIN_PORT = '8788'
$env:ADMIN_ORIGIN = 'http://127.0.0.1:8788'
npm run admin:demo
```

Haqiqiy bot uchun hisob tayyorlash:

```powershell
npm run admin:setup -- --data-dir ./data --output .local/admin-access.txt
```

Skript `neo-admin` uchun tasodifiy parol yaratadi, scrypt bilan hosil qilingan parol tekshiruvini `data/admin-account.json` ga yozadi. Ochiq parol faqat ko‘rsatilgan mahalliy faylga yoziladi; `.local/` Git’dan chiqarilgan. Mavjud hisobni tasodifan almashtirmaydi. Parolni almashtirishda `--rotate` va mavjud bo‘lmagan yangi output fayl nomi beriladi:

```powershell
npm run admin:setup -- --data-dir ./data --output .local/admin-access-rotated.txt --rotate
```

Keyin botni qayta ishga tushiring: yangi parol va avvalgi sessiyalar bekor bo‘lishi shundan keyin kuchga kiradi. Yangi login faylini mijozga yopiq kanal orqali bering. `DATA_DIR` ishlatilsa, setup va bot bir xil papkani ko‘rsatishi kerak; setup skripti `.env` ni o‘zi yuklamaydi, shuning uchun mos `--data-dir` yo‘lini aniq bering.

`.env` dagi haqiqiy bot sozlamalariga quyidagilarni qo‘shish mumkin:

```dotenv
ADMIN_ENABLED=true
ADMIN_HOST=127.0.0.1
ADMIN_PORT=8787
ADMIN_ORIGIN=http://127.0.0.1:8787
```

Keyin mavjud `npm start` ishlatiladi. Bu komanda haqiqiy botning polling va yuborish jarayonini boshlaydi: production bot ishlayotgan bo‘lsa, ayni token bilan ikkinchi nusxasini ochmang. Interfeysni xavfsiz tekshirish uchun yuqoridagi demo yetarli. Production origin HTTPS bo‘lishi kerak; HTTP faqat lokal manzil uchun.

## Faqat oʻz profilingizga haqiqiy test xabari

`npm run admin:test-personal` lokal panelni haqiqiy Neo Sisra boti orqali **bitta tasdiqlangan shaxsiy profilga** yuborish uchun ochadi. Login `neo-admin`, parol `.local/admin-access.txt` faylida. Bu demo parolidan alohida. Test panelining bazasi `.local/admin-test/data` ichida; production mijozlar bazasi ochilmaydi. Production polling jarayoni davom etadi, lokal panel polling boshlamaydi.

Operator `.local/admin-test/config.json` faylida `chatId` (musbat raqam), `username` (`@` belgisiz) va `sshHelper` (mavjud, host kaliti tekshiriladigan `run.cjs` faylining mutlaq yoʻli) ni sozlaydi. Skript ishga tushishda va har bir yuborishdan oldin `@neo_sisrabot` hamda qabul qiluvchining ID/username mosligini Telegram orqali tekshiradi. Bot tokeni serverda qoladi; lokal konfiguratsiyaga token yoki SSH paroli yozilmaydi.

Shaxsiy testda SSH ulanishi va uchta Telegram soʻrovi uchun relay 60 soniyagacha, tashqi bot soʻrovi 65 soniyagacha kutadi. Odatiy production soʻrovlarining 15 soniyalik chegarasi oʻzgarmaydi. Telegram tasdigʻi kelgach “yetkazildi” hisoblanadi; tasdiq kelmasa “nomaʼlum” saqlanadi va avtomatik qayta yuborilmaydi.

Frontenddan boshqa ID yoki umumiy auditoriya tanlash mumkin emas; shaxsiy test cheklovi worker va SSH relay ichida ham tekshiriladi. Minimal interfeysda test profili haqidagi izohlar ko‘rsatilmaydi. Eski umumiy kampaniyani test rejimida davom ettirish rad etiladi. Xabarlar faqat paneldagi tasdiqlashdan keyin yuboriladi; panelni ishga tushirish oʻzi xabar joʻnatmaydi.

Botning odatiy jarayonida ham shu cheklov kerak boʻlsa, `BROADCAST_TEST_CHAT_ID` va `BROADCAST_TEST_LABEL` ishlatiladi. Hammaga yuborishga qaytish alohida operator amali: faol testlar yakunlangach, ikkala cheklov sozlamasi olib tashlanadi va tegishli jarayon qayta ishga tushiriladi. Shaxsiy test runneri doim bitta profil bilan cheklangan.

## Haqiqiy auditoriya

Productionda `BROADCAST_TEST_CHAT_ID` va `BROADCAST_TEST_LABEL` sozlamalari olib tashlanadi. Auditoriya haqiqiy bot bazasidan olinadi: shaxsiy chatlar takrorlanmaydi, adminlar va guruhlar chiqarib tashlanadi. Yuborish boshlanganda qabul qiluvchilar roʻyxati saqlanadi. Jarayon serverdagi mavjud bot navbatida davom etadi; brauzer yopilishi boshlangan kampaniyani toʻxtatmaydi. Login uchun oldingi admin hisobi saqlanishi mumkin; serverga faqat parolning scrypt tekshiruvi oʻtkaziladi. Panelni ulashning oʻzi xabar yubormaydi.

## Tekshiruv va tayyor assetlar

```powershell
npm run admin:build
npm run check
npm test
python -m unittest discover -s deploy/tests -v
```

`admin-assets.cjs` generatsiya qilingan fayl bo‘lsa ham Git’da saqlanadi. Frontend o‘zgarganda uni qayta yig‘ib commitga kiriting. Actions `npm ci --prefix admin` va `npm run build --prefix admin` bilan qayta yig‘adi, natijani saqlangan fayl bilan solishtiradi. Linux server faqat tayyor assetlarni oladi. Python deploy testlari Linux uchun; Windowsda ular aniq sabab bilan skip qilinadi. Test unitida `PrivateNetwork=yes` saqlanadi, HTTP testlari ajratilgan tarmoqdagi loopback manziliga ulanadi.

## Mavjud serverni yangilash

Bu bosqich [asosiy deploy qo‘llanmasidagi](DEPLOYMENT.md) oldingi yetti faylli runtime ro‘yxatini yangi o‘n faylli ro‘yxatga kengaytiradi. Avval botning `.env` va butun `data` papkasidan izchil zaxira oling. Botning xizmat foydalanuvchisi `neo-sisra-bot`, yoziladigan joyi `/opt/neo-sisra-pay-bot/data` bo‘lib qoladi.

**Runtime commitini deploy qilishdan oldin operator root egasidagi deployer, poller, test runner va test unitini alohida yangilashi shart.** GitHub’dan odatiy runtime yangilanishi `/usr/local/` yoki `/etc/systemd/system/` dagi bu nusxalarni almashtirmaydi. Eski deployer yangi admin fayllarini rad etadi; eski poller ularni arxivga qo‘shmaydi.

Quyidagi amallar operator tomonidan tekshirilgan yangi commit nusxasidan bajariladi. `BOT_SOURCE` o‘sha nusxaning mutlaq yo‘li bo‘lsin. Avval timer va davom etayotgan poll to‘xtatiladi; Actions deploy ishlatilsa, uni ham texnik ish davomida to‘xtating.

```bash
sudo -i
set -euo pipefail
systemctl disable --now neo-sisra-bot-poll.timer
systemctl stop neo-sisra-bot-poll.service
BOT_SOURCE=/usr/local/src/neo-sisra-tolovbot

# Avval shu to‘rtta faylning review qilingan commitga tegishli ekanini tekshiring.
install -o root -g root -m 0755 "$BOT_SOURCE/deploy/server-deploy.py" \
  /usr/local/sbin/neo-sisra-bot-deploy
install -o root -g root -m 0755 "$BOT_SOURCE/deploy/server-poll.py" \
  /usr/local/sbin/neo-sisra-bot-poll
install -o root -g root -m 0755 "$BOT_SOURCE/deploy/test-runner.sh" \
  /usr/local/libexec/neo-sisra-bot-tests
install -o root -g root -m 0644 "$BOT_SOURCE/deploy/neo-sisra-bot-tests.service" \
  /etc/systemd/system/neo-sisra-bot-tests.service
systemd-analyze verify /etc/systemd/system/neo-sisra-bot-tests.service
systemctl daemon-reload
```

Yangi runtime to‘liq quyidagi fayllardan iborat:

```text
bot.js
google-delivery.cjs
telegram-http.cjs
state-store.cjs
work-queue.cjs
telegram-queue.cjs
admin-server.cjs
admin-auth.cjs
admin-assets.cjs
package.json
```

`admin/`, `node_modules`, setup skriptlari, `.env`, hisob va demo ma’lumotlari runtime arxiviga kirmaydi. Poller test nusxasiga setup/demo skriptlarini ham qo‘shadi; ularni bot release’iga o‘rnatmaydi. Admin dastlab o‘chiq turgan holatda yangi runtime’ni odatiy deploy orqali chiqarib, `Neo Sisra polling ready.` va bot xizmatining ishlayotganini tekshiring.

## Production hisobi va HTTPS

Panelni Vercel manzili yoki mijoz domenida ochish mumkin. `neo-admin.example.com` quyidagi misollarda o‘rinbosar, tayyor manzil emas. DNS va TLS sertifikat operatorning amaldagi tartibida sozlanadi.

Hisobni tekshirilgan manbadan bot foydalanuvchisi nomidan yarating. Parol fayli vaqtinchalik, yopiq `/run/` papkasiga yoziladi:

```bash
install -d -o neo-sisra-bot -g neo-sisra-bot -m 0700 /run/neo-sisra-admin-setup
runuser -u neo-sisra-bot -- /usr/bin/node "$BOT_SOURCE/scripts/setup-admin.cjs" \
  --data-dir /opt/neo-sisra-pay-bot/data \
  --output /run/neo-sisra-admin-setup/admin-access.txt
```

`data/admin-account.json` bot foydalanuvchisi egasida, ruxsati `0600` bo‘lsin. Hisob allaqachon mavjud bo‘lsa, odatiy deployda uni qayta yaratish kerak emas; ataylab parol almashtirish uchun `--rotate`, mavjud bo‘lmagan `--output` fayli va keyin bot restarti kerak. Parol faylini mijozga yopiq usulda topshirgach `/run/neo-sisra-admin-setup/admin-access.txt` ni o‘chiring. Parolni buyruq argumenti, log, Git commit yoki nginx fayliga yozmang.

Mavjud server `.env` faylida:

```dotenv
ADMIN_ENABLED=true
ADMIN_HOST=127.0.0.1
ADMIN_PORT=8787
ADMIN_ORIGIN=https://neo-admin.example.com
ADMIN_TRUST_PROXY=true
```

[nginx namunasini](../deploy/neo-sisra-admin.nginx.example) tekshiring, domen va ikkita sertifikat yo‘lini haqiqiy qiymatlarga almashtirib nginx konfiguratsiyasiga qo‘shing. Namuna `https://.../` ni faqat `127.0.0.1:8787` dagi mavjud bot jarayoniga yo‘naltiradi. `ADMIN_TRUST_PROXY=true` faqat shu loopback reverse proxy bilan ishlatiladi: nginx kiruvchi `X-Forwarded-For` ni saqlamasdan, uni o‘zi ko‘rgan bitta mijoz IP manziliga almashtiradi. Server tekshirilgan manzil bo‘yicha login urinishlarini cheklaydi; noma’lum tashqi proxy headerlariga ishonilmaydi. Bevosita lokal ishlatishda bu sozlama o‘chiq qolsin. Portni tashqi internetga ochish shart emas; alohida `npm start`, PM2 yoki ikkinchi systemd bot xizmati kerak emas.

```bash
nginx -t
systemctl restart neo-sisra-pay-bot.service
systemctl reload nginx
systemctl status neo-sisra-pay-bot.service --no-pager
```

Tanlangan HTTPS manzilda login sahifasi, noto‘g‘ri parolning rad etilishi, to‘g‘ri login va auditoriya hisobini tekshiring. Login tekshiruvi kampaniya yubormaydi. Haqiqiy foydalanuvchilarga yuborish faqat mijoz tasdiqlagan matn bilan paneldagi tasdiqlash orqali bajariladi. Poll timerini faqat barcha tekshiruvlardan keyin, oldin ishlatilgan bo‘lsa qayta yoqing. `ADMIN_ORIGIN` brauzerdagi aniq origin bilan mos bo‘lsin: protokol, domen va nostandart port ham hisobga olinadi.

## Vercel production paneli

Panel: `https://neo-sisra-admin.vercel.app`, Vercel loyihasi `muhammadrasuls-projects/neo-sisra-admin`. Frontend Vercel’da, API va yuborish workeri mavjud bot serverida ishlaydi. Botning production sozlamalari:

```dotenv
ADMIN_ENABLED=true
ADMIN_HOST=127.0.0.1
ADMIN_PORT=18887
ADMIN_ORIGIN=https://neo-sisra-admin.vercel.app
ADMIN_TRUST_PROXY=true
```

`admin/vercel.json` faqat `/api/admin/` so‘rovlarini `https://neo-sisra-admin.91-98-95-234.sslip.io` manziliga yo‘naltiradi. Serverdagi alohida `neo-sisra-admin` nginx konfiguratsiyasi ularni loopback `18887` portiga uzatadi, upstream Host’ni `neo-sisra-admin.vercel.app` qilib belgilaydi va brauzer Origin’ini saqlaydi. Login cookie’si Secure/HttpOnly/SameSite=Strict; API javoblari keshlanmaydi. Login urinishlari nginx ko‘rgan Vercel proxy IP’si bo‘yicha cheklanadi.

Frontendni yangilashda `npm run admin:build` bajaring. Toza staging papkaga faqat `admin/dist/` ichidagi fayllar va `admin/vercel.json` nusxasini joylang; repozitoriy yoki `admin/` manba papkasini shu konfiguratsiya bilan yuklamang. `.local/vercel-admin-site` joriy staging papka. Shu papkadan `npx vercel deploy --prod --yes --scope muhammadrasuls-projects` ishlatiladi. Vercel uchun bot tokeni, SSH kaliti yoki admin paroli kerak emas. Loyiha Git bilan avtomatik ulanmagan; frontend yangilanishi alohida deploy qilinadi.

Faqat doimiy production alias’dan foydalaning: tasodifiy deployment/preview manzili API Origin tekshiruviga mos kelmaydi. Bot kodi esa Git main’dagi commitni tekshiradigan mavjud server polleri orqali yangilanadi. `.local/admin-live/` operator tayyorlov fayllari va serverdagi `admin-upgrade-20261015/backups` zaxirasi Git/Vercel’ga kirmaydi. TLS sertifikati serverdagi certbot renewal orqali yangilanadi.

## Qaytish va zaxira

Yangilangan deployer to‘liq tarixiy 4 faylli JSON runtime, oldingi 7 faylli SQLite runtime va yangi 10 faylli admin runtime’ni qabul qiladi. Aralash yoki chala to‘plam rad etiladi. Oddiy server polleri yangi commit uchun 10 faylni talab qiladi; eski 7 faylli commitga qo‘lda qaytish operator deployeri orqali bajariladi.

Panelni vaqtincha o‘chirish uchun `ADMIN_ENABLED=false` qilib mavjud bot xizmatini qayta ishga tushiring. Hisob va kampaniya holati `data` ichida saqlanadi. 7 faylli oldingi release’ga qaytishda avval timer/Actions deploy’ini to‘xtating, botdagi faol kampaniya tugashini kuting yoki panel orqali to‘xtating, adminni o‘chiring. Eski release’ning to‘liq yetti faylini ustar arxiv qilib, tekshirilgan SHA bilan `/usr/local/sbin/neo-sisra-bot-deploy` orqali qaytaring. `data` yoki `admin-account.json` ni o‘chirmang. Eski bot admin panelini ochmaydi; qayta yangilaganda hisob saqlanadi.

Tarixiy 4 faylli JSON release’ga qaytish uchun [SQLite holatini eksport qilib qaytish tartibiga](DEPLOYMENT.md#eski-json-releasega-xavfsiz-qaytish) rioya qiling. `current` symlinkini o‘zboshimchalik bilan almashtirish kerak emas. Mavjud deployer polling readiness bajarilmasa oldingi release’ni qayta tiklaydi; HTTPS va loginni operator alohida tekshiradi.

Zaxira tarkibiga yopiq `.env` va butun `data` papkasi, jumladan `admin-account.json`, SQLite/WAL hamda kampaniya holati kiradi. Ishlayotgan botdan faqat bitta SQLite faylni ko‘chirmang. Demo papkasi va ochiq parol topshirish fayli production zaxirasining qismi bo‘lmasin. Qaytish/tiklashda oldin yuborilgan kampaniyani qayta tasdiqlash takroriy xabarga olib kelishi mumkin.

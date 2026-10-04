# Neo Sisra toʻlov boti

Bot: [@neo_sisrabot](https://t.me/neo_sisrabot). Mavjud bot kodi asosida Neo Sisra uchun alohida moslashtirilgan. Avvalgi faol bot oʻzgartirilmagan; uning `.env` fayli va mijozlar bazasi koʻchirilmagan. Yangi xizmat manzili: `/opt/neo-sisra-pay-bot`.

## Ishlash tartibi

Foydalanuvchi ismi va telefonini kiritadi, ofertaga majburiy rozilik bildiradi va yagona **Koreyaga talaba yuborish** xizmati uchun chek yuboradi. PNG, JPG/JPEG yoki PDF qabul qilinadi; fayl imzosi, kengaytmasi va MIME turi mos boʻlishi, hajmi 10 MiB dan oshmasligi kerak. Google’ga yuborish fonda bajariladi. Chek yetkazilgani toʻlov tasdiqlanganini anglatmaydi.

Mavjud Google Sheet ustunlari saqlanadi; qoʻshimcha ustun yaratilmaydi:

- `Royhatdan otganlar`: `Ism`, `Telefon raqam`, `Tarif`, `Oferta`, `Sana`.
- `Chek Yuborganlar`: `Ism`, `Telefon raqam`, `Tarif`, `Offerta`, `Check URL`, `sana`, `vaqt`.

`Tarif` — `Koreyaga talaba yuborish`, rozilik — `Roziman`; vaqt `Asia/Tashkent` boʻyicha. Chek Google’ga base64 sifatida yuboriladi va tasdiqlangan Drive havolasi olinadi. Telegram tokenini oʻz ichiga olgan yuklab olish URL manzili bazaga saqlanmaydi va Google Sheet’ga yuborilmaydi.

## Buyruqlar

| Buyruq | Vazifasi |
| --- | --- |
| `/start` | Roʻyxatdan oʻtish jarayonini boshlash |
| `/id` | Telegram raqamli ID maʼlumotini olish |
| `/status` | Maʼlumot va chek yuborilish holatini koʻrish |
| `/retry` | Tasdiqlanmagan yuborishni qoʻlda qayta urinish |
| `/admin` | Ruxsat berilgan administrator paneli |
| `/export` | Administrator uchun mahalliy yozuvlarni eksport qilish |

Yuborish uzilsa yoki javob kelmasa, natija nomaʼlum boʻlishi mumkin. `/retry` qoʻlda ishlatiladi; avvalgi soʻrov qabul qilinib, javobi yoʻqolgan boʻlsa, takroriy yozuv paydo boʻlishi mumkin.

## Sozlamalar

Bot oʻz papkasidagi `.env` faylini oʻqiydi. Kalitlar namunasi `.env.example` da; haqiqiy tokenni README, Git yoki sayt fayllariga kiritmang.

- `BOT_TOKEN` — faqat yangi Neo Sisra botining tokeni; `GOOGLE_SCRIPT_URL` — Neo Sisra toʻlov jadvalining mavjud Apps Script endpointi.
- `PRIMARY_ADMIN_IDS` va `EXTRA_ADMIN_IDS` — vergul bilan ajratilgan **raqamli Telegram foydalanuvchi IDlari**. Username administrator huquqini bermaydi. `ADMIN_IDS` eski sozlama nomi sifatida qoʻllab-quvvatlanadi.
- `NOTIFY_CHAT_ID`, `NOTIFY_REG_TOPIC`, `NOTIFY_PAY_TOPIC` — ixtiyoriy guruh va mavzular. Standart holatda boʻsh: sozlanmaguncha administratorlar va guruh bildirishnomalari yoqilmaydi.
- `CONTACT_PHONE`, `CONTACT_ADMIN`, `SERVICE_PRICE`, `UZCARD_NUMBER`, `UZCARD_HOLDER`, `VISA_NUMBER`, `VISA_HOLDER` — tasdiqlangan aloqa va toʻlov rekvizitlari.
- `OFFER_DOC_PATH`, `OFFER_VERSION` — tasdiqlangan oferta hujjati va uning versiyasi; `WELCOME_IMAGE_PATH` — ixtiyoriy kirish rasmi.
- `DATA_DIR` — standartda bot papkasidagi `data`. Quyidagi systemd xizmati aynan shu papkaga yozishga ruxsat beradi.

Hozir narx va karta egasi `XXX`, karta raqamlari `XXXX XXXX XXXX XXXX`; oferta hujjati hali berilmagan, versiya `pending-2026-10-04`. Haqiqiy hujjat va rekvizitlarni administrator taqdim etishi kerak. Mavjud Telegram kanal havolasi administrator akkaunti hisoblanmaydi.

## GitHub orqali avtomatik yangilash

Repozitoriy: https://github.com/asositgroup/neo-sisra-tolovbot

Server har 60 soniyada shu repozitoriyning `main` branchini tekshiradi. Yangi commit boʻlsa, aynan oʻsha commit kodi yuklanadi, alohida yopiq muhitda JavaScript va deploy testlari bajariladi. Testlar muvaffaqiyatli boʻlsa, bot yangilanadi. GitHub saytidagi faylni tahrirlab `main` ga commit qilish ham shu jarayonni ishga tushiradi. Yangilanish odatda bir necha daqiqa ichida tugaydi; davom etayotgan yuborishlar boʻlsa, bot ularni tugatishni kutadi.

Testlar alohida `neo-sisra-ci-test` foydalanuvchisi nomidan, tarmoq va bot maʼlumotlariga kirishsiz bajariladi. Testdan oʻtgan fayllarning aynan oʻzi joylashtiriladi. Repo kodi root huquqi bilan bajarilmaydi. Pull request va boshqa branchlar avtomatik joylashtirilmaydi.

Har bir versiya `/opt/neo-sisra-pay-bot/releases/<commit-SHA>` papkasida saqlanadi. `current` havolasi faol versiyani koʻrsatadi. `.env` va `data` asosiy server papkasida qoladi; deploy ularni almashtirmaydi. Bot yangilanishdan oldin davom etayotgan yuborishlarni tugatishga 240 soniyagacha vaqt oladi. Juda uzoq operatsiya uzilsa, saqlangan yozuv `/retry` orqali qayta yuboriladi.

Yangi botning aynan yangi ishga tushishida Telegram polling tayyorligi tekshiriladi. Tekshiruv muvaffaqiyatsiz boʻlsa, oldingi kodga qaytiladi va uning ham tayyorligi tekshiriladi. Deploylar bir vaqtda ishlamaydi. Test yoki deploydan oʻtmagan commit har daqiqada qayta urinilmaydi: xatoni tuzatib yangi commit qilish kerak.

Serverda holatni tekshirish:

```sh
systemctl status neo-sisra-bot-poll.timer neo-sisra-pay-bot.service
journalctl -u neo-sisra-bot-poll.service -n 30 --no-pager
journalctl -u neo-sisra-bot-tests.service -n 80 --no-pager
readlink /opt/neo-sisra-pay-bot/current
```

Tekshiruvni kutmasdan boshlash: `sudo systemctl start neo-sisra-bot-poll.service`. Avtomatik yangilashni toʻxtatish: `sudo systemctl disable --now neo-sisra-bot-poll.timer`; bu ishlayotgan botni toʻxtatmaydi. Qayta yoqish: `sudo systemctl enable --now neo-sisra-bot-poll.timer`.

Oldin xato bilan tugagan commitni aynan oʻzini qayta urinish zarur boʻlsa, sababni tekshirgandan keyin operator `/var/lib/neo-sisra-ci-test/.last-failed-sha` faylini oʻchiradi va poll xizmatini boshlaydi. Xatoni yangi commit bilan tuzatish odatda yetarli.

GitHub Actions uchun workflow ham tayyor, lekin 2026-10-05 dagi birinchi ishga tushirish GitHub hisobidagi billing muammosi sabab runner boshlanmasdan rad etildi. Shuning uchun workflow vaqtincha oʻchirilgan; amaldagi avtomatik yangilash serverdagi timer orqali bajariladi. Actions holati serverdagi deploy holatini koʻrsatmaydi.

Keyinchalik Actions’ga oʻtish uchun avval billingni tiklash, serverdagi timerni oʻchirish, workflow’ni yoqish va repository variable `DEPLOY_WITH_ACTIONS=true` ni oʻrnatish kerak. Ikki deploy usulini bir vaqtda yoqmang. Actions yoqilganda pull requestlarda faqat testlar, `main` da esa test va deploy ishlaydi.

GitHub Actions secrets: `DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`. Alohida SSH kalitiga faqat shu botni joylashtirish komandasi ruxsat etilgan. Bot tokeni va administrator sozlamalari serverdagi yopiq `.env` faylida turadi; ularni GitHub fayllariga yozmang.

Avtomatik joʻnatiladigan runtime fayllari: `bot.js`, `google-delivery.cjs`, `telegram-http.cjs`, `package.json`. Yangi runtime modul yoki npm dependency qoʻshilsa, workflow hamda serverdagi poll/deploy qabul qiladigan fayllar moslanishi kerak. Unit, test runner yoki poll/deploy mexanizmini oʻzgartirish operator orqali alohida oʻrnatiladi. Oferta yoki kirish rasmi serverda alohida saqlanib, `.env` da mutlaq yoʻl bilan koʻrsatiladi. Server ochiq GitHub repodan tokensiz oʻqiydi; repo private qilinsa, oʻqish ruxsati alohida sozlanishi kerak.

Mahalliy tekshiruv: `npm run check`, `npm test`. Deploy testlari Linuxdagi Python3 bilan: `python3 -m unittest discover -s deploy/tests -v`. Tashqi runtime npm paketlari yoʻq. Node22 ishlatiladi. Testlar foydalanuvchilarga Telegram xabari yubormaydi.

### Tekshirilgan joylashtirish — 2026-10-05

Server timeri GitHub’dan `3502546b3e8e427d263558694bd20b9992fa1964` commitini avtomatik oldi, 96 ta testni oʻtkazdi va shu versiyani joylashtirdi. Poll xizmati muvaffaqiyatli tugadi, timer keyingi tekshiruvni kutmoqda; bot `active/running` va yangi ishga tushishdagi `Neo Sisra polling ready.` yozuvi tasdiqlandi.

`@neo_sisrabot` `/opt/neo-sisra-pay-bot` da alohida `neo-sisra-pay-bot.service` orqali ishga tushirildi. Tekshiruvda xizmat `active/running`, qayta ishga tushishlar soni `0`; Telegram `getMe` aynan shu botni tasdiqladi va birinchi polling javobi muvaffaqiyatli keldi. Uchta JS modulning server SHA-256 qiymatlari mahalliy fayllar bilan bir xil. Avvalgi bot kodi oʻzgarmagan va uning xizmati ham faol.

34 ta JavaScript testi va 62 ta Linux testi (41 deploy, 21 avtomatik tekshiruv) serverdagi alohida test muhitida oʻtdi. Botning Google yuborish moduli orqali alohida belgilangan `TEST Neo Sisra bot SSH 2026-10-05` yozuvi yuborildi: mavjud roʻyxatdan oʻtish varagʻida 6-qator va cheklar varagʻida 4-qator tekshirildi. Rozilik mavjud `Oferta`/`Offerta` ustunlariga tushdi. Sinov PNG fayli Drive’da bor (14803 bayt). Bu haqiqiy toʻlov emas. Telegram foydalanuvchisi bilan toʻliq jonli suhbat hali sinovdan oʻtkazilmagan.

`/start`, `/status`, `/retry`, `/id`, `/admin` buyruqlari menyusi Telegram API orqali saqlandi va qayta oʻqib tasdiqlandi. Raqamli admin IDlari hamda bildirishnoma guruhi hali berilmagan: admin vositalari va guruhga yuborish yoqilmagan. Oferta hujjati va toʻlov rekvizitlari hamon kutilmoqda.

## Maʼlumotlarni saqlash

Yozuvlar `data/bot_data.json` da saqlanadi: avval vaqtinchalik fayl yoziladi, soʻng asosiy fayl atomar almashtiriladi. `data` papkasining muntazam zaxira nusxasini saqlang; izchil nusxa olish uchun xizmatni qisqa muddat toʻxtatish mumkin. Tiklangan fayllar egasi va yopiq ruxsatlarini tekshiring.

Haqiqiy `.env`, `data` va eksportlar Git’ga kiritilmaydi. Bot sayt repozitoriysidan alohida saqlanadi. Foydalanuvchi maʼlumotlarini saytning ochiq papkalariga koʻchirmang.

# Yuklama, navbatlar va tiklash

Bot bir nechta foydalanuvchining xabarini parallel qayta ishlaydi. Bir odamning xabarlari esa o‘z tartibida bajariladi: ism, telefon, oferta va chek bosqichlari aralashmaydi. Bu sozlamalar **bir vaqtda nechta odamga kechikishsiz xizmat kafolati** emas. Javob vaqti Telegram, Google, tarmoq, fayl hajmi va navbatdagi ishga bog‘liq.

## Amaldagi chegaralar

| Qism | Standart qiymat | Izoh |
| --- | --- | --- |
| Telegram update ishlovchilari | `UPDATE_WORKERS=32` | 1–64 oralig‘ida; turli chatlar parallel, bir chat ketma-ket. |
| Olingan update paketi | 100 tagacha | Keyingi `getUpdates` oldidan olingan paket tugatiladi; xotirada cheksiz paket yig‘ilmaydi. |
| Google yuborish ishlovchilari | `DELIVERY_WORKERS=4` | 1–10 oralig‘ida; qolgan yozuvlar SQLite’da `pending` holatda turadi. |
| Telegram xabarlar tezligi | `TELEGRAM_MESSAGES_PER_SECOND=25` | 1–30 oralig‘ida; butun bot uchun umumiy yuborish tezligi. |
| Bir shaxsiy chatga xabar oralig‘i | 1050 ms | Bitta suhbatdagi xabarlar tartibi saqlanadi. |
| Bir guruhga xabar oralig‘i | 3100 ms | Guruhdagi topiclar ham bir chat limitini bo‘lishadi. |
| Telegram tarmoq chaqiruvlari | 8 tagacha faol | Turli chatlar orasida; bir chatga ikkita chaqiruv parallel yuborilmaydi. |
| Telegram chiqish navbati | 500 ta jami ish | Faol, kutayotgan va 429’dan keyin qayta urinishlar birga hisoblanadi; to‘lganda yangi ish rad etiladi. |
| Chek fayli | 10 MiB gacha | PNG, JPG/JPEG yoki PDF; hajm, kengaytma va fayl boshlanishi tekshiriladi. |
| Ommaviy xabar | Bitta fon ishi | Oddiy foydalanuvchi javoblari boshqa chatlardagi ommaviy xabarlardan ustun. |

Uchta muhit sozlamasi `.env` orqali boshqariladi:

```dotenv
UPDATE_WORKERS=32
DELIVERY_WORKERS=4
TELEGRAM_MESSAGES_PER_SECOND=25
```

O‘zgartirgach botni qayta ishga tushiring. Sonlarni kattalashtirish Telegram yoki Google kvotasini oshirmaydi. Masalan, 25 xabar/soniya sozlamasida 100 ta alohida xabarning yuborilishi ideal sharoitda ham bir necha soniyaga taqsimlanadi. `/start` esa bir nechta chiqish xabarini yaratadi; foydalanuvchi sonini xabar tezligiga tenglashtirib bo‘lmaydi.

Telegram bepul yuborish uchun bir chatda taxminan 1 xabar/soniya, guruhda 20 xabar/daqiqa va ommaviy yuborishda taxminan 30 xabar/soniya chegaralarini tavsiya qiladi. Ushbu bot pullik broadcast rejimini yoqmaydi. [Telegram rasmiy FAQ](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this).

`getMe`, `getFile` va `answerCallbackQuery` xabarlar oralig‘ini kutmaydi, lekin tarmoq parallelizmi, navbat hajmi va global 429 tanaffusiga bo‘ysunadi. Telegram `429` va yaroqli musbat `retry_after` qaytarsa, yangi chaqiruvlar ko‘rsatilgan muddatga to‘xtaydi; shu chaqiruv ko‘pi bilan uch marta qayta urinadi. Javobi noaniq timeout, tarmoq uzilishi va 5xx xatolari avtomatik takrorlanmaydi. [Telegram `ResponseParameters`](https://core.telegram.org/bots/api#responseparameters).

Google Apps Script’da ham hisob turi, xizmat va bir vaqtdagi bajarilishlar bo‘yicha kvotalar bor. To‘rtta fon ishlovchisi bu limitlarni bekor qilmaydi; real kvota xatolari va yuborish vaqtlarini kuzatish kerak. [Google Apps Script kvotalari](https://developers.google.com/apps-script/guides/services/quotas).

## Ma’lumot va chek qanday saqlanadi

Ro‘yxatdan o‘tish yoki chek yozuvi avval `data/bot_state.sqlite` ichiga yoziladi. Foydalanuvchiga qabul qilingani bildiriladi, Google Sheets/Drive’ga yetkazish fonda davom etadi. Chekni olish uchun Telegram `file_id` saqlanadi; bot tokeni bor Telegram fayl URL’i Sheets yoki bazaga yozilmaydi.

Yuborish holatlari:

| Holat | Ma’nosi | Keyingi harakat |
| --- | --- | --- |
| `pending` | Saqlangan, tashqi yuborish boshlanmagan | Bo‘sh ishlovchi oladi; restartdan keyin ham davom etadi. |
| `sending` | Yuborish atomik ravishda band qilingan | Hozir bajariladi; jarayon uzilsa keyingi startda `failed` bo‘ladi. |
| `sent` | Google muvaffaqiyatni tasdiqlagan | Qayta yuborilmaydi. Bu to‘lov admin tomonidan tasdiqlandi degani emas. |
| `failed` | Yetkazish tasdiqlanmagan | Foydalanuvchi `/status`, so‘ng zarur bo‘lsa `/retry` ishlatadi. |
| `invalid` | Chek fayli yaroqsiz | Boshqa to‘g‘ri fayl yuboriladi. |

Google yuborish deadline’i ro‘yxatdan o‘tishda 45 soniya, chekda 120 soniya; Telegram JSON so‘rovlarida 15 soniya, faylda 30 soniya. Bu alohida tarmoq operatsiyasi vaqtidir; navbatda kutish bu raqamlarga kirmaydi.

Tarmoq uzilganda Google yozuvni saqlagan, lekin javobi botga yetib kelmagan bo‘lishi mumkin. Shu sabab `failed` yozuvlar avtomatik qayta yuborilmaydi. `/retry` oldidan Sheets/Drive holatini solishtiring: qo‘lda takrorlash dublikat yaratishi mumkin. Lokal chek identifikatori va atomik band qilish bir jarayon ichidagi takroriy ishni cheklaydi; tashqi Google yozuviga umumiy “aynan bir marta” kafolati berilmaydi.

## SQLite, restart va bitta jarayon

Node.js **22.13 yoki undan yangi** kerak. Bot tashqi DB paketisiz `node:sqlite` ishlatadi. SQLite WAL rejimi va `busy_timeout` qo‘llanadi; har saqlashda o‘zgargan user/yozuv/meta tranzaksiyada yoziladi. Eski `bot_data.json` birinchi startda import qilinadi, boshlang‘ich nusxasi saqlanadi. Keyingi startlarda SQLite asosiy manba; JSON odatiy saqlashda to‘liq qayta yozilmaydi, checkpoint/toza yopilish va eski release’ga qaytish uchun chiqariladi.

Parallel update’lar tugashi turli vaqtda bo‘lishi mumkin. Bot faqat oldingi barcha olingan update’lar tugagan chegaragacha Telegram offsetini oshiradi. Keyinroq tugagan update ID’lari ham durable saqlanadi, shunda restart ularni qayta bajarmaydi va tugallanmagan oldingi update’ni tashlab ketmaydi. Telegram tashqi javobi yuborilib, lokal yakunlashdan oldin jarayon uzilishi kabi holatlarda javob takrorlanishi ehtimoli butunlay yo‘qolmaydi.

`SIGTERM`/`SIGINT` kelganda yangi polling va yangi fon ishlari boshlanmaydi. Olingan update paketi va ishlayotgan fon chaqiruvlari tugatiladi; hali boshlanmagan `pending` yozuvlar keyingi startga qoladi. Botda 240 soniyalik shutdown deadline’i, systemd unitida 260 soniyalik stop chegarasi bor. Restartdan keyin noaniq `sending` ishlar qo‘lda tekshiriladi.

Bir token uchun **bitta polling jarayoni** ishlating. `data/instance.lock` bir ma’lumot papkasini ikkita jarayon ochishidan saqlaydi. Boshqa server yoki boshqa `DATA_DIR` ichidagi ikkinchi nusxani bu lock to‘xtatmaydi. PM2 cluster, bir nechta container replica yoki ikkita serverni bir token bilan yonma-yon ishga tushirmang. Ko‘p process kerak bo‘lsa, avval umumiy navbat, yagona polling egasi va DB session koordinatsiyasi loyihalanadi.

Hozir user va yuborishlar holati xotirada ham saqlanadi; SQLite sinxron ishlaydi. Tarix juda kattalashsa RAM, disk fsync va ayrim qidiruv/Excel export amallari javob vaqtiga ta’sir qiladi. To‘liq DB’dan sahifalab o‘qish, alohida eksport ishlovchisi yoki tashqi DB bu versiyada yo‘q. Zaxira uchun faqat JSON’ni olish yetarli emas: [butun `data` papkasini izchil nusxalash](DEPLOYMENT.md#zaxira-va-tiklash) tartibidan foydalaning.

## Ommaviy xabarni boshqarish

Admin `/broadcast` orqali materiallarni yig‘adi va `✅ Yuborish`ni bosadi. Yuborish foydalanuvchi update ishlovchisini band qilmaydigan alohida fon ishida ketadi. Oddiy javoblar ustun, lekin allaqachon yuborilayotgan HTTP so‘rov bekor qilinmaydi. Juda doimiy trafikda ommaviy yuborish sekinlashishi mumkin.

| Komanda | Vazifasi |
| --- | --- |
| `/broadcast_status` | Holat, yuborilgan va tasdiqlanmagan xabarlar soni. |
| `/broadcast_cancel` | Keyingi xabarlarni to‘xtatadi. Hozir yuborilayotgan bitta xabar yakunlanishi mumkin. |
| `/broadcast_resume` | Restartdan keyin `interrupted` bo‘lgan ishni qolgan joyidan davom ettiradi. |

Davom ettirish/bekor qilishni yuborishni boshlagan admin boshqaradi. Hisoblagichlar **xabarlar** soni; bitta odamga bir nechta material yuborilishi mumkin. Restartdan keyin ommaviy yuborish avtomatik boshlanmaydi. Telegram’ga chaqiruvdan oldin kursor saqlanadi: uzilish paytida natijasi noma’lum xabar `failed` hisobiga qo‘shiladi va resume uni avtomatik takrorlamaydi. Bunday xabar aslida borgan yoki yuborilmasdan qolgan bo‘lishi mumkin; admin tekshiradi.

## Yuklama sinovini qanday talqin qilish kerak

`npm test` testlarida Telegram va Google chaqiruvlari mock qilinadi; haqiqiy foydalanuvchilarga xabar yoki Sheets yozuvi yuborilmaydi. Sinovlar bir chat tartibi, parallel ishlovchilar chegarasi, navbat to‘lishi, 429, duplicate claim, saqlash va restart xatti-harakatini tekshiradi. Bu natija “100/1000 foydalanuvchi kechikishsiz ishlaydi” degan ishlab chiqarish sig‘imi kafolati emas.

Qayta bajariladigan offline yuklama sinovi:

```bash
node scripts/benchmark.cjs
```

2026-10-05 kuni Linux serverda Node 22.23.0 bilan, tarmoqdan ajratilgan alohida foydalanuvchi ostida o‘lchandi. Har Telegram javobi sun’iy 100 ms; haqiqiy 25 xabar/soniya va 1050 ms chat oralig‘i ishlatildi. Har bir foydalanuvchi bir paytda `/start` yuboradi va ikkita javob oladi; har senariy yangi vaqtinchalik baza bilan boshlanadi. Google, haqiqiy Telegram, katta fayllar va uzoq muddatli trafik bu sinovga kirmaydi.

| Birdan kelgan foydalanuvchi | Chiqish xabarlari | Ikkala javob uchun p95 | Oxirgi foydalanuvchiga ikkala javob |
| --- | --- | --- | --- |
| 10 | 20 | 1,55 soniya | 1,55 soniya |
| 50 | 100 | 4,36 soniya | 4,44 soniya |
| 100 | 200 | 7,77 soniya | 9,02 soniya |

Bu yangi botning konkret simulyatsiyadagi natijasi. Reklamadagi haqiqiy javob vaqti tashqi xizmatlar va trafik tarkibiga qarab o‘zgaradi. Tekshiruvda 91 ta Node testi va 84 ta Python deploy testi ham serverning offline test muhitida o‘tdi.

Reklama oqimini oshirishda oddiy javoblarning p95 vaqti, `pending` ishlarning soni/yoshi, Google va Telegram xatolari, RAM va diskni kuzating. Yuborish ishlovchilari yoki Telegram tezligini faqat kuzatilgan ehtiyoj va xizmat limitlari asosida o‘zgartiring. Hozir monitoring uchun tashqi dashboard va avtomatik alert sozlanmagan; xizmat loglari [server qo‘llanmasida](DEPLOYMENT.md#kundalik-boshqaruv) berilgan.

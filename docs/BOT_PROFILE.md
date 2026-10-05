# Bot profili va to‘lov oynasi

Neo Sisra botida profil rasmi, bio, boshlashdan oldingi tavsif hamda rasmli to‘lov oynasi tayyorlangan. [Foydalanuvchi bergan namuna bot](https://t.me/Rustili_19_bot) Telegram Web’da tekshirildi: rasm, Payme, Click, Paynet va menejer tugmalari bor. Neo Sisra o‘z matni va rasmidan foydalanadi; namuna loyihaning to‘lov manzillari yoki rekvizitlari ko‘chirilmagan.

## Foydalanuvchi oqimi

1. `/start`: salomlashuv va ism so‘rash bitta xabarda.
2. Ism, telefon va majburiy oferta roziligi.
3. To‘lov rasmi, xizmat va karta ma’lumotlari, sozlangan to‘lov usullari va menejer tugmalari.
4. PNG, JPG yoki PDF chek; Google Sheets/Drive’ga yetkazish fonda davom etadi.
5. Chek qabul qilingani va holat/to‘lov tugmalari. `/payment` rozilik bergan foydalanuvchiga to‘lov oynasini qayta ochadi; yangi ro‘yxat yozuvi yaratmaydi.

Havola sozlangan tugmalar tashqi to‘lov sahifasini ochadi. Paynet PDF sozlangan bo‘lsa, bot QR-kodli hujjatni yuboradi. Bot hozir provayderdan avtomatik to‘lov tasdig‘ini olmaydi; chekni qo‘lda tekshirish tartibi saqlangan. Yetkazilgan chek to‘lov tasdiqlandi degani emas.

## Havolalar va rasm

Server `.env` faylida:

```dotenv
PAYMENT_IMAGE_PATH=/opt/neo-sisra-pay-bot/assets/neo-sisra-bot-v1.jpg
PAYME_URL=
CLICK_URL=
PAYNET_URL=
PAYNET_QR_PATH=/opt/neo-sisra-pay-bot/assets/paynet-qr.pdf
CONTACT_ADMIN=
```

Provayder havolalari mos ravishda `payme.uz`, `click.uz`, `paynet.uz` yoki ularning subdomenidagi HTTPS manzil bo‘lishi kerak. `CONTACT_ADMIN` uchun menejerning `@username` yoki `https://t.me/username` manzili ishlatiladi. Kanalga taklif havolasi menejer kontakti o‘rniga qo‘yilmaydi.

Havola bo‘sh yoki yaroqsiz bo‘lgan provayder tugmasi yashiriladi. Payme va Click shartnomalari tayyor bo‘lmaguncha ularning sozlamalari bo‘sh qoladi. Menejer tugmasi avvalgidek ko‘rinadi; username yo‘q bo‘lsa, sozlangan telefon yoki aloqa ma’lumoti berilmagani haqida bildirishnoma chiqaradi. Eski xabarlardagi provayder tugmalari ham rost holatni ko‘rsatadi.

### Paynet QR PDF

Foydalanuvchi bergan bir sahifali [asl QR hujjati](../assets/paynet-qr.pdf) o‘zgartirilmaydi. Uning QR ma’lumoti EMV formatida; brauzer havolasi yoki deep-link emas va ichida to‘lov summasi belgilanmagan. Shu hujjat uchun `PAYNET_URL` bo‘sh qoladi. QR ma’lumotidan sun’iy checkout URL yasalmaydi.

`PAYNET_QR_PATH` bot o‘qiy oladigan `.pdf` faylni ko‘rsatishi kerak. Fayl haqiqiy PDF sarlavhasiga ega, oddiy fayl va 50 MiB dan oshmasligi tekshiriladi. Paynet tugmasi bosilganda avval Telegram callback tasdiqlanadi, keyin asl PDF yuboriladi. Izohda sozlangan `SERVICE_PRICE`, QR-kodni qo‘llab-quvvatlaydigan ilovada ochish, summa so‘ralsa uni kiritish, qabul qiluvchi/summani tekshirish va chekni botga yuborish ko‘rsatiladi. Tugma faqat joriy oferta roziligiga ega foydalanuvchining shaxsiy chatida ishlaydi; yangi lead yoki to‘lov yozuvi yaratmaydi, bosqichni o‘zgartirmaydi.

PDF yagona sozlama bo‘lsa, `Paynet orqali toʻlash` tugmasi hujjatni yuboradi. Kelajakda haqiqiy `PAYNET_URL` ham berilsa, asosiy tugma havolani ochadi va yoniga alohida `Paynet QR-kodi` tugmasi qo‘shiladi. PDF yo‘q/o‘qilmasa tugmasi yashiriladi; eski tugma tushunarli xatolik beradi. Yuklashda xatolik bo‘lsa, qayta bosish tavsiya qilinadi.

Operator PDFni release tashqarisidagi `assets/` papkasiga alohida ko‘chiradi va `.env` yo‘lini sozlaydi. Yettita runtime faylli CI/CD arxivi PDFni o‘zi yetkazmaydi. Asset bot foydalanuvchisi uchun o‘qiladigan bo‘lishi kerak; `.env` o‘zgargach faqat Neo Sisra bot xizmati qayta ishga tushiriladi. QR yoki PDF yuborish avtomatik to‘lov tasdig‘i hisoblanmaydi.

Rasm izohiga matn sig‘masa yoki fayl mavjud bo‘lmasa, to‘liq matn va tugmalar yuboriladi. Rasm release tashqarisida saqlanadi; CI/CD uni o‘chirmaydi. `.env` o‘zgargach bot qayta ishga tushiriladi. `WELCOME_IMAGE_PATH` alohida sozlama; to‘lov rasmini qo‘shish `/start` xabarini o‘zgartirmaydi.

## Karta rekvizitlari

To‘lov oynasi HUMO, UZCARD va Visa kartalarini shu tartibda ko‘rsatadi. Server `.env` faylida raqam va karta egasi alohida sozlanadi; raqamni o‘qish qulay bo‘lishi uchun to‘rttadan guruhlab yozing:

```dotenv
HUMO_NUMBER=XXXX XXXX XXXX XXXX
HUMO_HOLDER=XXX
UZCARD_NUMBER=XXXX XXXX XXXX XXXX
UZCARD_HOLDER=XXX
VISA_NUMBER=XXXX XXXX XXXX XXXX
VISA_HOLDER=XXX
```

Bo‘sh qiymatlar `XXX` bilan ko‘rsatiladi. Amal qilish muddati va CVV to‘lovni qabul qilish uchun ko‘rsatilmaydi va ushbu sozlamalarda saqlanmaydi. `.env.example` karta rekvizitlari uchun faqat namuna qiymatlarini saqlaydi; haqiqiy rekvizitlar server `.env` fayliga kiritiladi.

Xizmatning oddiy narxi va vebinar uchun to‘lanadigan summa alohida ko‘rsatiladi. `SERVICE_PRICE` aynan vebinar taklifi bo‘yicha to‘lov miqdori; `REGULAR_SERVICE_PRICE` oddiy narx:

```dotenv
REGULAR_SERVICE_PRICE=5 000 000 soʻm
SERVICE_PRICE=4 400 000 soʻm
```

Qiymat berilmagan bo‘lsa, bot `XXX` ko‘rsatadi. Narxlar xabarda aks etadi; bot chekdagi summani avtomatik tekshirmaydi.

## Profilni o‘rnatish

Ommaviy matnlar [bot-profile.json](../assets/bot-profile.json) ichida. [JPG rasm](../assets/neo-sisra-bot-v1.jpg) profil va to‘lov oynasiga mos; [PNG manba](../assets/neo-sisra-bot-v1.png) ham saqlangan. Rasm built-in `image_gen` bilan yaratilgan, o‘lchami 1254×1254. [Aniq generatsiya prompti](../assets/imagegen-prompt.txt) saqlangan.

Lokal ko‘rib chiqish va alohida operator skripti testlari:

```bash
node scripts/configure-profile.cjs --dry-run
node --test scripts/tests/profile-setup.test.cjs
```

Dry-run token o‘qimaydi va Telegram’ga so‘rov yubormaydi. Jonli o‘rnatish:

```bash
node scripts/configure-profile.cjs --apply --env-file /opt/neo-sisra-pay-bot/.env --backup /private/writable/directory/profile-before.json
```

Zaxira papkasi oldindan mavjud va buyruqni ishlatayotgan foydalanuvchiga yozish uchun ochiq bo‘lsin. Backup fayli mavjud bo‘lsa, ustidan yozilmaydi. `--config` bilan JSON uchun boshqa yo‘l berish mumkin; JPG shu JSON bilan bir papkada bo‘ladi.

Skript yozishdan oldin bot aynan `@neo_sisrabot` ekanini tekshiradi, oldingi profilni zaxiralaydi, umumiy va o‘zbekcha nom/bio/tavsifni hamda rasmni o‘rnatadi, so‘ng API’dan qayta o‘qib tekshiradi. Boshqa tillarga tegmaydi. Oldingi rasm yuklab olinmasa, backup natijasida cheklov qayd etiladi. Skript polling boshlamaydi, foydalanuvchilarga xabar yoki Google yozuvi yubormaydi; tokenni chiqarish yoki buyruq argumentida berish kerak emas.

Profil, rasm va operator skripti odatiy yettita runtime faylli deploy arxiviga kirmaydi. Ularni yangilaganda operator aktivlarni serverga ko‘chirib, profil buyrug‘ini alohida bajaradi. Bot handlerlari esa GitHub → server CI/CD orqali yangilanadi. Operator skripti testlari `scripts/tests/` ichida, runtime testlari `npm test` orqali bajariladi.

## Yakunlash uchun kerak

- Payme va Click ishlatiladigan bo‘lsa, Neo Sisraga tegishli shartnoma va to‘lov havolalari. Paynet uchun asl QR PDF olingan; checkout havolasi berilmagan.
- Menejer Telegram username’i va aloqa telefoni.
- HUMO, UZCARD va Visa raqamlari, karta egasi Baxtiyor Jamalov va oddiy/vebinar narxlari foydalanuvchidan tasdiqlangan; ular server `.env` orqali sozlanadi. Bu ma’lumotlar tayyor.
- Tasdiqlangan oferta hujjati va versiyasi.
- Yakuniy brend rasmi yoki logotip, agar hozirgi rasm almashtirilsa.

Avtomatik to‘lov tasdig‘i kerak bo‘lsa, bu havola tugmalaridan alohida integratsiya: provayder shartnomasi, merchant sozlamalari va server callback protokoli kerak bo‘ladi.

# Bot profili va to‘lov oynasi

Neo Sisra botida profil rasmi, bio, boshlashdan oldingi tavsif hamda rasmli to‘lov oynasi tayyorlangan. [Foydalanuvchi bergan namuna bot](https://t.me/Rustili_19_bot) Telegram Web’da tekshirildi: rasm, Payme, Click, Paynet va menejer tugmalari bor. Neo Sisra o‘z matni va rasmidan foydalanadi; namuna loyihaning to‘lov manzillari yoki rekvizitlari ko‘chirilmagan.

## Foydalanuvchi oqimi

1. `/start`: salomlashuv va ism so‘rash bitta xabarda.
2. Ism, telefon va majburiy oferta roziligi.
3. To‘lov rasmi, xizmat va karta ma’lumotlari, Payme / Click / Paynet / menejer tugmalari.
4. PNG, JPG yoki PDF chek; Google Sheets/Drive’ga yetkazish fonda davom etadi.
5. Chek qabul qilingani va holat/to‘lov tugmalari. `/payment` rozilik bergan foydalanuvchiga to‘lov oynasini qayta ochadi; yangi ro‘yxat yozuvi yaratmaydi.

Tugmalar tashqi to‘lov sahifalariga havoladir. Bot hozir provayderdan avtomatik to‘lov tasdig‘ini olmaydi; chekni qo‘lda tekshirish tartibi saqlangan. Yetkazilgan chek to‘lov tasdiqlandi degani emas.

## Havolalar va rasm

Server `.env` faylida:

```dotenv
PAYMENT_IMAGE_PATH=/opt/neo-sisra-pay-bot/assets/neo-sisra-bot-v1.jpg
PAYME_URL=
CLICK_URL=
PAYNET_URL=
CONTACT_ADMIN=
```

Provayder havolalari mos ravishda `payme.uz`, `click.uz`, `paynet.uz` yoki ularning subdomenidagi HTTPS manzil bo‘lishi kerak. `CONTACT_ADMIN` uchun menejerning `@username` yoki `https://t.me/username` manzili ishlatiladi. Kanalga taklif havolasi menejer kontakti o‘rniga qo‘yilmaydi.

Havola bo‘sh yoki yaroqsiz bo‘lsa, tugma ko‘rinadi va bosilganda ma’lumot hali berilmagani haqida bildirishnoma chiqaradi. Shu holatda interfeys adminlar ko‘rib chiqishi uchun tayyor, provayder orqali real to‘lov hali ulanmagan.

Rasm izohiga matn sig‘masa yoki fayl mavjud bo‘lmasa, to‘liq matn va tugmalar yuboriladi. Rasm release tashqarisida saqlanadi; CI/CD uni o‘chirmaydi. `.env` o‘zgargach bot qayta ishga tushiriladi. `WELCOME_IMAGE_PATH` alohida sozlama; to‘lov rasmini qo‘shish `/start` xabarini o‘zgartirmaydi.

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

- Neo Sisraga tegishli Payme, Click va, ishlatilsa, Paynet to‘lov havolalari.
- Menejer Telegram username’i va aloqa telefoni.
- Xizmat narxi, karta raqamlari, bank va karta egasi ma’lumotlari; hozir `XXX`.
- Tasdiqlangan oferta hujjati va versiyasi.
- Yakuniy brend rasmi yoki logotip, agar hozirgi rasm almashtirilsa.

Avtomatik to‘lov tasdig‘i kerak bo‘lsa, bu havola tugmalaridan alohida integratsiya: provayder shartnomasi, merchant sozlamalari va server callback protokoli kerak bo‘ladi.

# Neo Sisra toʻlov boti

Telegram toʻlov va roʻyxatdan oʻtish boti, `neo-admin` uchun React/Vite xabar yuborish paneli.

Lokal panelni haqiqiy foydalanuvchilarga xabar yubormasdan koʻrish:

```sh
npm ci --prefix admin
npm run admin:build
npm run admin:demo
```

Panel: `http://127.0.0.1:8787`. Demo login/parol fayli: `.local/admin-demo/access.txt`.
Demo 24 ta sunʼiy foydalanuvchida haqiqiy yuborish navbati va natijalarini tekshiradi.

Haqiqiy bot uchun hisob: `npm run admin:setup`. Parol `.local/admin-access.txt` fayliga,
uning xeshi esa `data/admin-account.json` fayliga yoziladi. Bu fayllar Gitʼga kirmaydi.

Panelni sozlash, parol almashtirish va serverga oʻrnatish: [admin qoʻllanmasi](docs/ADMIN.md).
Mavjud bot serveri: [deploy qoʻllanmasi](docs/DEPLOYMENT.md).

Tekshiruvlar: `npm run check` va `npm test`. Node.js 22.13+ talab qilinadi.

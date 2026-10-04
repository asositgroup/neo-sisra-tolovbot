# Serverga o‘rnatish va xizmatni boshqarish

Bu yo‘riqnoma **yangi Ubuntu 24.04 serveriga** birinchi o‘rnatish uchun. Ishlayotgan Neo Sisra serverida boshlang‘ich o‘rnatish buyruqlarini qayta bajarmang. Mavjud serverda yangilash uchun GitHub’dagi `main` branchiga commit yuborish yetarli; holatni tekshirish buyruqlari quyida berilgan.

Hozirgi kod `@neo_sisrabot` uchun: ishga tushishda Telegram’dan olingan username aynan `neo_sisrabot` ekanini tekshiradi. Boshqa bot tokenini kiritishning o‘zi yetarli emas. Boshqa loyihaga moslashda shu tekshiruv, bot matnlari va havolalari, Google endpointi, deploy fayllaridagi qat’iy yo‘llar hamda repo manzillari ham alohida moslanadi.

Bir token bilan bir vaqtning o‘zida faqat bitta polling jarayoni ishlasin. Hozirgi botni boshqa serverga ko‘chirsangiz, avval eski serverdagi yangilash timerini va botni to‘xtating, so‘ng `.env` va butun `data` papkasini xavfsiz kanal orqali ko‘chiring. `data` ichida mijozlar, yuborishlar va oxirgi Telegram update holati bor; uni tashlab yuborish tugallanmagan ishlar yoki eski update’larni qayta ishlashga olib kelishi mumkin. Eski va yangi nusxani yonma-yon ishga tushirmang.

Quyidagi yangi server o‘rnatish ketma-ketligi kod va unit fayllariga mos yozilgan. Uni alohida toza serverda boshidan oxirigacha bajarish ushbu hujjatni yozish doirasida sinovdan o‘tkazilmagan.

## 1. Talablar

- `sudo` huquqi bor Ubuntu 24.04 va `systemd`.
- `/usr/bin/node` manzilida **Node.js 22**. Versiyani [Node.js rasmiy yuklash sahifasidan](https://nodejs.org/en/download) tanlang; unit fayllari interaktiv shell’dagi `nvm` sozlamasini ishlatmaydi.
- Git, Python 3, CA sertifikatlari va SSH orqali boshqaruv.
- Telegram API, Google Apps Script/Drive, `github.com` va `codeload.github.com` manzillariga tashqi HTTPS ulanish.

Bot long polling ishlatadi; bot uchun domen, kiruvchi HTTP port yoki reverse proxy shart emas. Hozir tashqi npm runtime paketi yo‘q, shuning uchun serverda `npm install` bajarilmaydi.

Quyidagi buyruqlar **Bash** uchun. SSH bilan yangi serverga kirib, bir xil root shell ichida bosqichma-bosqich bajaring:

```bash
sudo -i
set -euo pipefail
apt-get update
apt-get install -y git python3 ca-certificates nano
/usr/bin/node --version
/usr/bin/node -e 'if (process.versions.node.split(".")[0] !== "22") process.exit(1)'
```

Node tekshiruvi xato bersa, davom etishdan oldin `/usr/bin/node` yo‘lini Node 22 uchun sozlang. Bot runtime fayllari, skriptlar va release papkalari `root` egasida bo‘ladi; botning o‘zi cheklangan alohida foydalanuvchi nomidan ishlaydi.

## 2. Yangi o‘rnatish ekanini tekshirish va kodni olish

Quyidagi tekshiruv mavjud o‘rnatish ustiga yozishni to‘xtatadi:

```bash
for bot_path in \
  /opt/neo-sisra-pay-bot \
  /usr/local/src/neo-sisra-tolovbot \
  /var/lib/neo-sisra-ci-test \
  /var/lib/neo-sisra-deploy \
  /etc/systemd/system/neo-sisra-pay-bot.service \
  /etc/systemd/system/neo-sisra-bot-poll.service \
  /etc/systemd/system/neo-sisra-bot-poll.timer \
  /etc/systemd/system/neo-sisra-bot-tests.service \
  /usr/local/sbin/neo-sisra-bot-deploy \
  /usr/local/sbin/neo-sisra-bot-poll \
  /usr/local/libexec/neo-sisra-bot-tests; do
  if [ -e "$bot_path" ] || [ -L "$bot_path" ]; then
    printf 'Mavjud yo‘l topildi; yangi o‘rnatish to‘xtadi: %s\n' "$bot_path"
    exit 1
  fi
done
for bot_user in neo-sisra-bot neo-sisra-ci-test; do
  if getent passwd "$bot_user" >/dev/null || getent group "$bot_user" >/dev/null; then
    printf 'Mavjud foydalanuvchi/guruh topildi: %s\n' "$bot_user"
    exit 1
  fi
done

install -d -o root -g root -m 0755 /usr/local/src
git clone --branch main --single-branch \
  https://github.com/asositgroup/neo-sisra-tolovbot.git \
  /usr/local/src/neo-sisra-tolovbot
BOT_SOURCE=/usr/local/src/neo-sisra-tolovbot
BOT_REV=$(git -C "$BOT_SOURCE" rev-parse HEAD)
[[ "$BOT_REV" =~ ^[0-9a-f]{40}$ ]]
git -C "$BOT_SOURCE" checkout --detach "$BOT_REV"
```

Keyingi amallar shu aniq commit fayllaridan foydalanadi. Ishlatishdan oldin `deploy/server-deploy.py`, `deploy/server-poll.py`, `deploy/test-runner.sh` va systemd unitlarini operator tekshirib chiqishi kerak: ular tizimga ishonchli boshqaruv fayllari sifatida o‘rnatiladi. Avtomatik yangilash bu boshqaruv fayllarining o‘rnatilgan nusxalarini almashtirmaydi.

## 3. Foydalanuvchilar, papkalar va unitlarni tayyorlash

```bash
useradd --system --user-group --no-create-home \
  --home-dir /nonexistent --shell /usr/sbin/nologin neo-sisra-bot
useradd --system --user-group --no-create-home \
  --home-dir /nonexistent --shell /usr/sbin/nologin neo-sisra-ci-test

install -d -o root -g root -m 0755 \
  /opt/neo-sisra-pay-bot \
  /opt/neo-sisra-pay-bot/releases \
  /var/lib/neo-sisra-ci-test \
  /var/lib/neo-sisra-deploy \
  /usr/local/libexec
install -d -o neo-sisra-bot -g neo-sisra-bot -m 0700 \
  /opt/neo-sisra-pay-bot/data

install -o root -g root -m 0755 "$BOT_SOURCE/deploy/server-deploy.py" \
  /usr/local/sbin/neo-sisra-bot-deploy
install -o root -g root -m 0755 "$BOT_SOURCE/deploy/server-poll.py" \
  /usr/local/sbin/neo-sisra-bot-poll
install -o root -g root -m 0755 "$BOT_SOURCE/deploy/test-runner.sh" \
  /usr/local/libexec/neo-sisra-bot-tests
install -o root -g root -m 0644 "$BOT_SOURCE/neo-sisra-pay-bot.service" \
  /etc/systemd/system/neo-sisra-pay-bot.service
for bot_unit in neo-sisra-bot-tests.service neo-sisra-bot-poll.service neo-sisra-bot-poll.timer; do
  install -o root -g root -m 0644 "$BOT_SOURCE/deploy/$bot_unit" \
    "/etc/systemd/system/$bot_unit"
done
```

`/var/lib/neo-sisra-deploy` hozircha bo‘sh bo‘lsa ham kerak: test unitining `InaccessiblePaths` sozlamasi uni talab qiladi. Faqat server timeridan foydalanishda SSH deploy foydalanuvchisi va GitHub Actions secretlari kerak emas.

## 4. Dastlabki commitni ajratilgan muhitda tekshirish

Testlar root huquqi bilan bajarilmaydi. Quyida aynan tanlangan commitdan olingan, oddiy foydalanuvchi o‘zgartira olmaydigan nusxa yaratiladi:

```bash
BOT_SNAPSHOT=/var/lib/neo-sisra-ci-test/snapshot
install -d -o root -g root -m 0755 \
  "$BOT_SNAPSHOT" "$BOT_SNAPSHOT/tests" \
  "$BOT_SNAPSHOT/deploy" "$BOT_SNAPSHOT/deploy/tests"
for bot_file in bot.js google-delivery.cjs telegram-http.cjs package.json; do
  install -o root -g root -m 0644 "$BOT_SOURCE/$bot_file" "$BOT_SNAPSHOT/$bot_file"
done
for bot_file in "$BOT_SOURCE"/tests/*.test.cjs; do
  install -o root -g root -m 0644 "$bot_file" "$BOT_SNAPSHOT/tests/"
done
for bot_file in server-deploy.py server-poll.py ssh-entry.sh; do
  install -o root -g root -m 0644 "$BOT_SOURCE/deploy/$bot_file" "$BOT_SNAPSHOT/deploy/$bot_file"
done
for bot_file in "$BOT_SOURCE"/deploy/tests/*.py; do
  install -o root -g root -m 0644 "$bot_file" "$BOT_SNAPSHOT/deploy/tests/"
done

systemd-analyze verify \
  /etc/systemd/system/neo-sisra-pay-bot.service \
  /etc/systemd/system/neo-sisra-bot-tests.service \
  /etc/systemd/system/neo-sisra-bot-poll.service \
  /etc/systemd/system/neo-sisra-bot-poll.timer
systemctl daemon-reload
systemctl start neo-sisra-bot-tests.service
systemctl show neo-sisra-bot-tests.service --property=Result --property=ExecMainStatus
journalctl -u neo-sisra-bot-tests.service -n 100 --no-pager
```

Natija `Result=success`, `ExecMainStatus=0` bo‘lishi kerak. Test unit `oneshot` bo‘lgani uchun test tugagach `inactive` bo‘lishi odatiy holat. Xato bo‘lsa, keyingi bosqichga o‘tmang. Bu testlar tashqi tarmoqqa chiqmaydi va Telegram foydalanuvchilariga xabar yubormaydi.

## 5. `.env`, umumiy ma’lumotlar va birinchi release

Yangi sozlamani yopiq faylda kiriting:

```bash
install -o neo-sisra-bot -g neo-sisra-bot -m 0600 \
  "$BOT_SOURCE/.env.example" /opt/neo-sisra-pay-bot/.env
nano /opt/neo-sisra-pay-bot/.env
chown neo-sisra-bot:neo-sisra-bot /opt/neo-sisra-pay-bot/.env
chmod 0600 /opt/neo-sisra-pay-bot/.env
```

Majburiy `BOT_TOKEN` va `GOOGLE_SCRIPT_URL` hamda ixtiyoriy sozlamalar [README’dagi jadvalda](../README.md) izohlangan. Tokenni terminal komandasiga, GitHub fayliga yoki umumiy logga yozmang. Mavjud Neo Sisra botini ko‘chirishda shu yerda yangi bo‘sh holatni ishlatish o‘rniga, to‘xtatilgan eski serverdan olingan `.env` va `data` nusxasini tiklang. Nusxadagi barcha `data` fayllari `neo-sisra-bot` egasida, papkalar `0700`, fayllar `0600` bo‘lsin.

`DATA_DIR` standart qiymatda qolsin: barcha release’lar bitta `/opt/neo-sisra-pay-bot/data` papkasini ishlatadi. Oferta va rasm kerak bo‘lsa, ularni release tashqarisida, masalan `/opt/neo-sisra-pay-bot/assets` ichida saqlang; `.env` ga mutlaq yo‘l kiriting. Bot bu fayllarni o‘qiy olishi kerak. Ushbu aktivlar Git deploy arxiviga kirmaydi va ularning zaxira nusxasi alohida olinadi.

Testdan o‘tgan aynan o‘sha fayllardan birinchi release’ni yarating:

```bash
BOT_RELEASE="/opt/neo-sisra-pay-bot/releases/$BOT_REV"
install -d -o root -g root -m 0755 "$BOT_RELEASE"
for bot_file in bot.js google-delivery.cjs telegram-http.cjs package.json; do
  install -o root -g root -m 0644 "$BOT_SNAPSHOT/$bot_file" "$BOT_RELEASE/$bot_file"
done
ln -s /opt/neo-sisra-pay-bot/.env "$BOT_RELEASE/.env"
ln -s /opt/neo-sisra-pay-bot/data "$BOT_RELEASE/data"
ln -s "$BOT_RELEASE" /opt/neo-sisra-pay-bot/current

systemctl enable --now neo-sisra-pay-bot.service
systemctl status neo-sisra-pay-bot.service --no-pager
BOT_INVOCATION=$(systemctl show neo-sisra-pay-bot.service --property=InvocationID --value)
journalctl -u neo-sisra-pay-bot.service \
  "_SYSTEMD_INVOCATION_ID=$BOT_INVOCATION" -n 30 --no-pager
```

Hozirgi ishga tushish logida **`Neo Sisra polling ready.`** chiqishini va xizmat `active/running` ekanini tekshiring. Birinchi polling javobi uchun biroz vaqt ketishi mumkin; kerak bo‘lsa oxirgi ikki komandani qayta bajaring. Token, internet yoki username tekshiruvi xato bo‘lsa, timer’ni yoqishdan oldin sababini bartaraf qiling.

Bu dastlabki ishlaydigan `current` release keyingi deploy xato qilsa qaytish uchun kerak. Deployer bo‘sh serverga o‘zi birinchi release’ni yaratmaydi.

## 6. GitHub’dan avtomatik yangilashni yoqish

```bash
systemctl start neo-sisra-bot-poll.service
systemctl show neo-sisra-bot-poll.service --property=Result --property=ExecMainStatus
journalctl -u neo-sisra-bot-poll.service -n 30 --no-pager
systemctl enable --now neo-sisra-bot-poll.timer
systemctl list-timers neo-sisra-bot-poll.timer --no-pager
readlink /opt/neo-sisra-pay-bot/current
```

Birinchi qo‘lda tekshiruv muvaffaqiyatli bo‘lsin. `main` o‘zgarmagan bo‘lsa, logda `Repository main already matches the active bot release.` chiqadi: 4-bosqichdagi testlar aynan shu dastlabki fayllar uchun bajarilgan. Yangi commit bo‘lsa, poller uni alohida yuklab, test qilib, keyin deploy qiladi.

Timer ish tugagandan taxminan 60 soniya o‘tib navbatdagi tekshiruvni boshlaydi. Har bir commit uchun JavaScript va Python testlari bajariladi, yangi bot polling holati tekshiriladi. Xatoda avvalgi release tiklanadi; `.env` va `data` almashtirilmaydi. Ishlayotgan yuborishlarni tugatish sabab deploy bir necha daqiqa davom etishi mumkin.

**Repo manzili kodda belgilangan:** `deploy/server-poll.py` dagi `REPOSITORY` va `CODELOAD` aynan ochiq `asositgroup/neo-sisra-tolovbot` reposiga qaraydi. Fork’ni clone qilish yoki uning Git remote’ini almashtirish server pollerining manbasini o‘zgartirmaydi. Fork uchun operator ikkala qiymatni va mos testlarni yangilaydi; repo nomi o‘zgarsa, `snapshot_files()` ichidagi `neo-sisra-tolovbot-` arxiv prefiksi ham moslanadi. Tekshirilgan poller nusxasi serverga alohida o‘rnatiladi. Private repo uchun hozirgi tokensiz yuklash yo‘li mos emas.

Avtomatik runtime arxivida faqat quyidagi fayllar bor:

```text
bot.js
google-delivery.cjs
telegram-http.cjs
package.json
```

Yangi modul yoki npm dependency qo‘shishdan oldin poller, deployer, testlar va Actions arxiv ro‘yxati operator tomonidan moslanadi. `package.json` ga dependency qo‘shishning o‘zi uni serverga o‘rnatmaydi; amaldagi deployer buni rad etadi. Unitlar, root skriptlar, test runner, `.env`, `data`, oferta va rasmlar odatiy GitHub commit bilan almashtirilmaydi.

## Kundalik boshqaruv

Quyidagilar oddiy SSH shell’da `sudo` bilan bajariladi:

```bash
sudo systemctl status neo-sisra-pay-bot.service neo-sisra-bot-poll.timer --no-pager
sudo journalctl -u neo-sisra-pay-bot.service -n 50 --no-pager
sudo journalctl -u neo-sisra-bot-poll.service -n 50 --no-pager
sudo journalctl -u neo-sisra-bot-tests.service -n 100 --no-pager
sudo readlink /opt/neo-sisra-pay-bot/current
```

- Tekshiruvni hozir boshlash: `sudo systemctl start neo-sisra-bot-poll.service`.
- Botni qayta ishga tushirish: `sudo systemctl restart neo-sisra-pay-bot.service`.
- Sozlama tahriri: `sudo nano /opt/neo-sisra-pay-bot/.env`, so‘ng botni qayta ishga tushirish.
- Yangilash timerini to‘xtatish: `sudo systemctl disable --now neo-sisra-bot-poll.timer`.
- Timerni qayta yoqish: `sudo systemctl enable --now neo-sisra-bot-poll.timer`.

Timerni o‘chirish avval boshlangan poll/deploy’ni bekor qilmaydi. Texnik ish yoki zaxira olishdan oldin `sudo systemctl stop neo-sisra-bot-poll.service` bilan davom etayotgan ish tugashini/to‘xtashini ham kuting; rollback sabab bu komanda vaqt olishi mumkin. Keyin kerak bo‘lsa botni to‘xtating. Yangilash yoqilgan paytda botni ataylab to‘xtatib qoldirsangiz, keyingi deploy uni qayta ishga tushirishi mumkin.

Test/deploy muvaffaqiyatsiz bo‘lgan commit qayta-qayta joylashtirilmaydi. Odatda tuzatish kiritib yangi commit yuboriladi. Faqat tashqi xatoni tuzatgandan keyin aynan o‘sha commitni qayta urinish kerak bo‘lsa, server timeridan foydalanilayotgan o‘rnatishda:

```bash
sudo systemctl disable --now neo-sisra-bot-poll.timer
sudo systemctl stop neo-sisra-bot-poll.service
sudo rm -f -- /var/lib/neo-sisra-ci-test/.last-failed-sha
sudo systemctl start neo-sisra-bot-poll.service
sudo journalctl -u neo-sisra-bot-poll.service -n 30 --no-pager
sudo systemctl enable --now neo-sisra-bot-poll.timer
```

Ishlayotgan kodni avvalgi holatga qaytarishning oddiy usuli — kerakli o‘zgarishni Git’da revert qilib `main` ga yangi commit yuborish. Deployer ishga tushishda xato bo‘lsa avtomatik rollback qiladi, lekin biznes mantig‘idagi har qanday xatoni aniqlash kafolatlanmaydi. `current` ni qo‘lda o‘zgartirishdan oldin timer to‘xtatiladi; aks holda poller uni yana `main` ga qaytaradi.

## Zaxira va tiklash

`.env`, butun `data` papkasi va alohida saqlangan aktivlarni zaxiralang. Kod Git’da bor, mijozlar holati esa Git’da yo‘q. Quyidagi namuna faqat `.env` va `data` uchun izchil nusxa oladi; ishlash vaqtida bot qisqa muddat to‘xtaydi. Namuna oldindan ishlayotgan bot va yoqilgan poll timerini nazarda tutadi. Timer ataylab o‘chirilgan yoki Actions ishlatilayotgan bo‘lsa, oxirgi `enable` komandasini bajarmang; avvalgi holatni saqlang. Actions’dan foydalanishda zaxira/tiklash davomida u yerdagi deploy’lar ham to‘xtatiladi.

```bash
sudo -i
set -euo pipefail
systemctl disable --now neo-sisra-bot-poll.timer
systemctl stop neo-sisra-bot-poll.service
systemctl stop neo-sisra-pay-bot.service
install -d -o root -g root -m 0700 /var/backups/neo-sisra-bot
BOT_BACKUP="/var/backups/neo-sisra-bot/state-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
umask 077
tar -czf "$BOT_BACKUP" -C /opt/neo-sisra-pay-bot .env data
chmod 0600 "$BOT_BACKUP"
systemctl start neo-sisra-pay-bot.service
systemctl enable --now neo-sisra-bot-poll.timer
```

`set -e` sabab zaxira olish xato qilsa keyingi komandalar bajarilmaydi va bot to‘xtagan holatda qolishi mumkin. Xato sababini va ma’lumotlar holatini tekshirgach, `systemctl start neo-sisra-pay-bot.service` bilan botni qayta yoqing; oldin yoqilgan bo‘lsa timerini ham tiklang.

Arxivda token va shaxsiy ma’lumotlar bor. Uni ochiq repo yoki sayt papkasiga joylamang; ruxsatlari cheklangan zaxira joyiga ko‘chiring. Oferta/rasmlar bo‘lsa, ularni ham alohida nusxalang.

Tiklashda timer, poll xizmati va botni to‘xtating; hozirgi holatning ham nusxasini oling. O‘zingizga tegishli tekshirilgan zaxirani vaqtinchalik yopiq papkaga ochib, `.env` va `data` ni asosiy bot papkasiga tiklang. Release fayllarini yoki `current/.env` symlinkini oddiy faylga almashtirmang. `.env` egasi `neo-sisra-bot:neo-sisra-bot`, ruxsati `0600`; `data` egasi shu foydalanuvchi, papkalari `0700`, fayllari `0600` bo‘lsin. So‘ng botni ishga tushirib polling holatini tekshiring va timerni yoqing.

Eski zaxira Google’ga allaqachon yuborilgan yozuvdan oldingi holatni qaytarishi mumkin. `/retry` yoki boshqa qayta yuborishni ishlatishdan oldin Sheets’dagi holatni solishtiring.

## GitHub Actions muqobili

Amaldagi yo‘l yuqoridagi server timeridir. Reponing `.github/workflows/deploy.yml` fayli Actions uchun ham tayyor. Hozirgi loyiha hisobida billing sabab Actions ishlashi bloklanganligi uchun timer ishlatilmoqda; Actions’da yashil belgi yo‘qligi server deploy’i bajarilmaganini anglatmaydi.

Yangi serverdagi yuqoridagi o‘rnatish **SSH orqali Actions deploy’ini o‘zi sozlamaydi**. Actions’ga o‘tishda administrator quyidagilarni alohida tayyorlaydi:

1. GitHub Actions ishlash ruxsati/billing holatini tiklaydi va workflow’ni yoqadi.
2. `deploy/ssh-entry.sh` ni root egasida `0755` bilan `/usr/local/libexec/neo-sisra-bot-ssh` manziliga o‘rnatadi.
3. Alohida `neo-sisra-deploy` SSH foydalanuvchisi, alohida kalit va faqat `/usr/local/sbin/neo-sisra-bot-deploy` komandasi uchun sudo ruxsatini sozlaydi. Kalitning `authorized_keys` qatori `restrict,command="/usr/local/libexec/neo-sisra-bot-ssh"` bilan cheklangan bo‘lishi kerak; sudoers `visudo -cf` bilan tekshiriladi.
4. `DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` repository secretlarini o‘rnatadi. Host kaliti avval ishonchli kanal orqali tekshiriladi. Bot tokeni bu secretlar qatoriga kirmaydi: serverning yopiq `.env` faylida qoladi.
5. Server timerini o‘chirib, davom etayotgan poll tugashini kutadi; keyin repository variable `DEPLOY_WITH_ACTIONS=true` ni o‘rnatadi.
6. Workflow’ni qo‘lda boshlaydi yoki `main` ga commit yuboradi, Actions logi, serverdagi `current` SHA va yangi polling holatini tekshiradi.

Bir vaqtning o‘zida timer va Actions orqali deploy’ni yoqmang. Alohida SSH kalitini umumiy shell huquqiga ega server kaliti bilan almashtirmang. Actions ham aynan to‘rtta runtime faylini yuboradi va shu release/rollback mexanizmidan foydalanadi.

# Broodle — Kukikoe POS

A web-based point of sale (kasir) for Kukikoe. Transactions go to Google Sheets through an Apps Script, receipts print to a Bluetooth thermal printer through Cleanter, and the kasir keeps working offline (unsent transactions are queued on the device and uploaded when the connection returns).

- **Kasir** — product grid, cart, payment by Cash, QRIS, Transfer BCA, Debit, Grab (Grab prices) or Utang (credit), receipt printing, receipt preview
- **Menu** (superadmin) — products, prices, Best Seller, photos, optional variants (e.g. flavors) each with their own price, and categories (create — even before any product uses them — rename, merge, delete empty ones, and set the order of the category buttons on the kasir; the product form picks from this list)
- **Utang** (kasir & superadmin) — sales on credit: list of unpaid invoices, paid off in full in one payment (no installments), reprints
- **Laporan** (superadmin) — sales report from Google Sheets
- **Riwayat** (kasir & superadmin) — paid invoices; edit or cancel them (kasir needs the superadmin's correction password)
- **Akun** (superadmin) — kasir accounts

No npm dependencies — only Node.js built-ins.

---

## Requirements

- **Node.js 20.12 or newer** (uses `process.loadEnvFile` and the built-in `fetch`)
- A Google Apps Script web app (see [Apps Script contract](#apps-script-contract))
- For printing: Cleanter running on the kasir device with the RPP02N printer paired over Bluetooth

---

## Run locally

```bash
# 1. Configure
cp .env.example .env
#    then edit .env: fill both APPS_SCRIPT_* URLs and SESSION_SECRET
#    generate a secret with:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Create the first superadmin (password is asked interactively)
node scripts/user.js add admin superadmin

# 3. Start
npm start          # or: npm run dev   (restarts on file changes)
```

Open http://localhost:8080 and log in.

On first start the server creates `data/menus.json` with the default 14 products. After that, the menu is managed from the **Menu** tab.

---

## Configuration (`.env`)

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | HTTP port. Default `8080`. |
| `APPS_SCRIPT_SUBMIT_URL` | yes | Apps Script web app URL (`doPost`) that receives transactions. |
| `APPS_SCRIPT_REPORT_URL` | yes | Apps Script URL (`doGet`) that returns the sales rows for the report. |
| `SESSION_SECRET` | yes | At least 32 characters. Changing it logs everyone out. |
| `ADMIN_SESSION_MINUTES` | no | Superadmin is logged out after this many minutes **without activity** (each action renews it; a warning appears one minute before). Default `15`. Kasir stay logged in until they log out themselves. |
| `SECURE_COOKIE` | no | `true` when served over HTTPS (required in production). |
| `TRUST_PROXY` | no | `true` **only** behind Nginx/Caddy, so login rate-limiting uses the real client IP. Leave `false` otherwise — the header can be spoofed. |
| `DATA_DIR` | no | Where accounts and menu are stored. Default `./data`. |
| `UPLOADS_DIR` | no | Where product photos are stored. Default `./uploads`. |
| `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` | no | Creates the first superadmin on startup **only if no account exists yet**. For hosts without an interactive terminal. Remove both after the first login. |

Locally these come from `.env` (loaded automatically if the file exists). On a hosting platform, set them in its dashboard instead — `.env` is not needed there.

`.env` must never be committed (already in `.gitignore`).

---

## Managing accounts

Kasir accounts can be created, reset and deleted from the **Akun** tab.
Superadmin accounts can **only** be created from the server terminal, on purpose — a stolen browser session cannot create new superadmins.

```bash
node scripts/user.js add <username> <kasir|superadmin>
node scripts/user.js passwd <username>
node scripts/user.js list
node scripts/user.js remove <username>
```

The last superadmin cannot be removed.

---

## Why not GitHub Pages?

GitHub Pages only serves static files. This app needs `server.js` running for login, permissions, hiding the Apps Script URLs, and saving the menu/accounts/photos. On Pages the screens would load but every `/api/...` call would fail. Host the Node server on a platform that runs Node **and has a persistent disk** — Railway (below) or a VPS.

---

## Deploy to Railway (easiest)

Railway runs `npm start` straight from the GitHub repo. Persistent storage (a volume) needs the paid Hobby plan.

1. **Rotate the Apps Script URLs first.** Older commits of this repo contain them in plain text. In Apps Script: *Deploy → New deployment* (Web app), copy the new URL, then *Deploy → Manage deployments* and archive the old ones. Only ever put the new URL in Railway variables, never in code.
2. Push the repo to GitHub.
3. In Railway: **New Project → Deploy from GitHub repo →** pick `broodle`.
4. **Add a volume** to the service, mount path `/data`.
5. **Variables** tab:
   ```ini
   APPS_SCRIPT_SUBMIT_URL=<new submit URL>
   APPS_SCRIPT_REPORT_URL=<new report URL>
   SESSION_SECRET=<64 hex chars from the generate command above>
   SECURE_COOKIE=true
   TRUST_PROXY=true
   DATA_DIR=/data
   UPLOADS_DIR=/data/uploads
   INITIAL_ADMIN_USERNAME=admin
   INITIAL_ADMIN_PASSWORD=<strong password, 8+ chars>
   ```
   Don't set `PORT` — Railway provides it.
6. **Settings → Networking → Generate Domain.** You get `https://<name>.up.railway.app` (or add your own domain there).
7. Open the domain, log in as `admin`, then **delete** `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD` from Variables.
8. Create kasir accounts from the **Akun** tab.

Every push to the deployed branch redeploys automatically. Accounts, menu and photos survive redeploys because they live on the `/data` volume.

### Pointing the old github.io address to the new app

If `https://<user>.github.io/broodle/` should keep working as a bookmark, put this as `index.html` in the **repo root** (not in `public/` — the Node server never serves the repo root, so it doesn't affect the app):

```html
<!DOCTYPE html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=https://YOUR-APP.up.railway.app/">
<title>Kukikoe</title>
<a href="https://YOUR-APP.up.railway.app/">Buka kasir Kukikoe</a>
```

Otherwise turn Pages off: repo **Settings → Pages → Source: None**. Without either, Pages would publish this README as the homepage.

---

## Deploy (VPS, Ubuntu example)

The app is a single Node process. Put it behind a reverse proxy that handles HTTPS.

### 1. Install Node and the app

```bash
# Node 20+ (NodeSource or nvm), then:
sudo useradd --system --create-home --home-dir /opt/broodle broodle
sudo -u broodle git clone <repo-url> /opt/broodle/app
cd /opt/broodle/app
sudo -u broodle cp .env.example .env
sudo -u broodle nano .env
```

Production `.env` values:

```ini
PORT=8080
SECURE_COOKIE=true
TRUST_PROXY=true
```

Create the superadmin:

```bash
sudo -u broodle node scripts/user.js add admin superadmin
```

### 2. Run it as a service (systemd)

`/etc/systemd/system/broodle.service`:

```ini
[Unit]
Description=Broodle POS
After=network.target

[Service]
User=broodle
WorkingDirectory=/opt/broodle/app
ExecStart=/usr/bin/node --env-file=.env server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now broodle
sudo journalctl -u broodle -f      # logs
```

Adjust `ExecStart` if `node` is not at `/usr/bin/node` (`which node`).

### 3. HTTPS with Caddy (simplest)

`/etc/caddy/Caddyfile`:

```
kasir.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo systemctl reload caddy
```

Caddy gets and renews the certificate automatically. Point the domain's DNS A record to the server first.

<details>
<summary>Nginx alternative</summary>

```nginx
server {
    server_name kasir.example.com;

    client_max_body_size 4m;   # product photo uploads
    gzip on;
    gzip_types text/css application/javascript image/svg+xml application/json;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then `sudo certbot --nginx -d kasir.example.com`.
</details>

Keep port 8080 closed to the outside (firewall); only 80/443 should be public.

### 4. Updating

```bash
cd /opt/broodle/app
sudo -u broodle git pull
sudo systemctl restart broodle
```

Sessions survive restarts as long as `SESSION_SECRET` stays the same. Browsers pick up new HTML/CSS/JS immediately (they revalidate on every load).

---

## Grab orders

- **Prices.** Each product (and each variant) has its own **Harga Grab**, set by the superadmin in the Menu tab. The form suggests "+25%" as a starting point; type the rounded price used in the Grab app. The menu list flags products that have no Grab price yet.
- **Selling.** Add products as usual, then choose **Grab** as the payment method. All prices in the cart switch to the Grab prices; switching back restores the normal prices. Bayar is blocked while any product in the cart has no Grab price.
- **Invoice vs. sales.** The invoice prints the Grab prices. What is saved as the sale (Google Sheets, Laporan, setoran) is each Grab price **minus the Grab commission** — e.g. Grab Rp50.000 with 20% → Rp40.000. The gross total and the commission used are sent along (`grabTotal`, `grabPotongan`).
- **Commission.** Set in the **Pengaturan** tab (default 20%). It applies to new sales only.
- **Totalan / Laporan.** Grab has its own row and chart slice. It is kept out of the drawer, *Total diterima* and *Uang masuk*, because Grab pays out separately.

---

## Split payment (Bagi 2 metode)

One sale paid in full with two methods, e.g. Rp50.000 = Rp25.000 Cash + Rp25.000 QRIS.

- At the kasir, switch on **Bagi 2 metode** under the payment tiles. Two methods are selected (tap another tile to swap one out); Grab and Utang can't be part of a split.
- Type the amount for either method; the other fills in with the rest of the total. Bayar is enabled only when both parts are above 0 and add up to the total. With Cash in the split, enter the cash handed over — change is counted against the cash part only.
- The invoice lists both parts. Totalan/setoran and Laporan count each part under its own method.
- Google Sheets receives `pembayaran` as `Cash 25000 + QRIS 25000` (plus a `pembayaranBagi` array your Apps Script may ignore). Laporan splits that text back into the two methods, so no Apps Script change is needed.

## Edit & cancel a paid invoice (Riwayat)

The **Riwayat** tab lists paid invoices. Tap one to **Ubah nota** (change item quantities — 0 removes an item — and the payment method Cash / QRIS / Transfer BCA / Debit) or **Batalkan nota**. A reason is required, and every change is kept in the invoice's history. After an edit the corrected receipt can be reprinted.

- **Kasir** only sees invoices from their own current setoran and must enter the **correction password**. Superadmin sees any date range and is never asked for a password.
- **Setting the password.** Superadmin: **Pengaturan → Koreksi nota → Atur password** (min. 6 characters, use something different from the account password). Until it is set, kasir cannot correct anything. Five wrong attempts lock that kasir out for 5 minutes. The password is checked on the server and stored hashed.
- **Not editable.** Grab and split-payment invoices can only be cancelled (then re-entered). Prices cannot be changed. Credit sales (Utang) are cancelled from the Utang tab.
- **Totalan / Laporan.** The kasir's running Totalan is adjusted right away (only for the setoran in progress). Laporan applies the corrections on top of the Google Sheets rows. **The sheet itself is not changed**, so fix the row there if you need the sheet to match.
- **Data.** Invoices are copied to `data/sales.json` (included in the backup) when they are submitted. Invoices from before this feature existed, or still waiting in the offline queue, are not listed. Editing / cancelling needs the internet.

---

## Setoran (kasir shifts)

Only **kasir** accounts open and close a setoran; superadmin is never asked.

1. **Login → Buka kasir.** The kasir confirms the cash in the drawer (*uang modal*, pre-filled Rp300.000) and starts selling.
2. **Totalan tab.** Shows the running total of the current setoran only: *Tunai di laci* (modal + cash sales + debt payments in cash), *QRIS*, *Transfer BCA* and *Debit* (sales + debt payments by that method).
3. **Logout → Tutup kasir.** The same totals are shown so the kasir can match them with the physical cash and the QRIS / bank statements, then the setoran is closed and they are logged out. Nothing has to be typed. Logging in again starts a new setoran.
4. **Left open?** Closing the browser during a setoran shows the browser's own "leave page?" warning (some tablets cannot show it). If a setoran is still open at the next login, the kasir must close it first before opening a new one.

Every sale is tagged with the kasir and setoran (extra fields `kasir`, `setoran` sent to Google Sheets). Setoran records are saved in `data/shifts.json` and listed for the superadmin under **Laporan → Setoran kasir** for the selected dates. Totals are counted on the tablet, so sales made offline are included.

---

## Utang (sales on credit)

1. At the kasir, choose **Utang** as the payment method and press **Catat utang**. Enter the customer's name (required), and optionally a phone number, due date and note. The invoice prints immediately, marked **UTANG – BELUM LUNAS** with the balance.
2. The debt appears in the **Utang** tab (the tab shows how many are open). Tap one to see the invoice, then pick the method (Cash, QRIS, Transfer BCA or Debit) and press **Lunasi**. A debt is always paid off in full in one payment — no installments (the server rejects any other amount). A payment receipt prints and the debt becomes **Lunas**. Debts that were partly paid before this rule keep their history; the remaining balance is paid in one go.
3. **Cetak ulang nota** reprints the invoice with the latest paid/remaining amounts. Each payment in the history has its own reprint button.
4. Only a superadmin can **cancel** a debt (a reason is required). It is kept, marked *Dibatalkan*, and can no longer be paid.

**Where the data lives.** The sale itself goes to Google Sheets like any other, with payment `Utang` (plus `pelanggan`, `telepon`, `jatuhTempo`, `catatan` fields your Apps Script may ignore). The debt and its payments live in `data/debts.json` on the server — **back this file up**; it is the only record of who still owes what. Debt payments are not sent to Google Sheets.

**Offline.** A sale on credit made offline waits in the device queue like any sale, shows in the Utang tab as *Menunggu terkirim*, and becomes a normal debt when the connection returns. Recording a *payment* needs the internet.

**In Laporan.** *Pendapatan* counts sales on the day they were made, including credit sales. *Uang masuk* is money actually received in the range (Cash + QRIS + Transfer BCA + Debit sales + debt payments). *Piutang berjalan* is what is still owed right now. Cancelling a debt does not remove its sale from Google Sheets, so fix that row in the sheet if the sale really did not happen.

---

## Seeding the menu

The whole menu is defined in `scripts/seeds/` so a new server can be filled in one command:

| Seeder | Products |
|---|---|
| `01-cheesecake.js` | Cheesecake, 10 variants |
| `02-scoopable.js` | Scoopable, 4 variants |
| `03-produk-lain.js` | Dubai Chewy Cookie, Strawberry Dubai Choco, London Choco Cake, Mooncake Pudding, Milk Cheese Bread, Bakwan Goreng, Risol, Bagia Ori / Mocha, Bagia Kacang, Lain-lain, Snack Box |

```bash
npm run seed -- --remove-old      # everything; recommended on a new deploy
npm run seed                      # everything, keep the old single products
npm run seed -- cheesecake        # one seeder (file name without the number)
```

`--remove-old` deletes Cheesecake A/B and Scoopable Kunafa/Nutella, which the two variant products replace. A brand-new server first creates the old 14 default products, so use `--remove-old` there to end up with exactly the 13 products above.

**Where to run it**
- **Railway:** open the service shell and run `npm run seed -- --remove-old`. The variables (`DATA_DIR=/data`) are already set there.
- **VPS:** `cd /opt/broodle/app && sudo -u broodle npm run seed -- --remove-old` (it reads `DATA_DIR` from `.env`).
- **Local:** `npm run seed -- --remove-old`.

**Safe to repeat.** Products are matched by name, so running it again updates prices and variants instead of adding duplicates, and a photo uploaded in the Menu tab is kept. Products that are not in any seeder are left alone, and seeded products are placed first in the menu in file order. It can run while the server is up.

**Photos.** Photos in `public/images` ship with the repo, so they come with the seed. Photos uploaded from the admin page live in `uploads/` on the server and cannot be seeded. Bagia, Lain-lain and Snack Box have none by default; add them in the Menu tab once.

**Changing the menu for good.** Edit the seed file and run the seeder again, or edit in the Menu tab. If you edit in the Menu tab, running the seeder later will put the seed values back for those products.

---

## Backups

Everything that matters at runtime lives in two folders, both outside git:

| Folder | Contents |
|---|---|
| `data/` | `users.json` (password hashes), `menus.json` (menu & Grab prices), `debts.json` (customer debts & payments), `shifts.json` (kasir setoran), `settings.json` (Grab commission), `sales.json` (invoice copies, corrections, correction password hash) |
| `uploads/` | product photos |

Transactions themselves are in Google Sheets.

**From the app (any host, any plan):** as superadmin, open **Pengaturan → Data → Unduh**. You get one file, `broodle-cadangan-YYYY-MM-DD.json`, with everything in `data/` plus the product photos. Keep it private: it contains password hashes and customer debts. **Pulihkan** uploads such a file and replaces all data with it. Before replacing, the server saves the current data to `data/backups/sebelum-pulihkan-*.json` (last 3 kept), so a wrong restore can be undone by restoring that file. A backup must contain at least one superadmin account.

**From the server shell:**

```bash
# example: daily backup via cron
tar czf /backup/broodle-$(date +%F).tgz -C /opt/broodle/app data uploads
```

---

## Kasir device setup

1. Pair the **RPP02N** printer over Bluetooth.
2. Install and run **Cleanter**, select RPP02N as the printer. The app sends receipts to `http://localhost:9100/print` on the same device.
3. Open the app URL in Chrome and log in with a kasir account. Allow the browser if it asks for permission to access devices on the local network — that is the printer bridge.
4. Optional: "Add to Home screen" for a full-screen kasir.

If printing fails, the transaction is **already recorded**. The order panel shows "Cetak ulang" (reprint) and "Lanjut tanpa cetak nota" (continue without receipt). Do not re-enter the order — it would be recorded twice.

### Offline behaviour

- Once the page is open, the kasir keeps working without internet. Transactions are queued in the browser and uploaded automatically when back online; the top bar shows how many are pending (tap it to retry).
- Logging out with pending transactions is allowed — they stay on the device and upload after the next login on **that same device and browser**.
- Reloading the page while offline does not work yet (no service worker).
- Receipt numbers are counted per device. The report separates transactions by their unique `transactionId`, so duplicate numbers across devices are harmless.

---

## Apps Script contract

**Submit (`APPS_SCRIPT_SUBMIT_URL`, `doPost`)** — receives one transaction per request as a JSON string body (`Content-Type: text/plain`):

```json
{
  "transactionId": "1790920853544-gphoj4",
  "tanggal": "2/10/2026",
  "jam": "13.00",
  "nota": "021026001",
  "pembayaran": "Cash",
  "cashReceived": 100000,
  "change": 45000,
  "total": 55000,
  "items": [
    { "nama": "Cheesecake A", "qty": 1, "harga": 40000, "subtotal": 40000 }
  ]
}
```

For a product with variants, `nama` is written as `Product (Variant)`, e.g. `Cheesecake A (Blueberry)`, with that variant's own `harga`. Each variant therefore appears as its own product in the sales report. Renaming a variant later does not change past rows.

Any 2xx response counts as success; anything else keeps the transaction in the queue for retry.

**Report (`APPS_SCRIPT_REPORT_URL`, `doGet`)** — returns one row per item:

```json
{
  "status": "success",
  "data": [
    { "tanggal": "2/10/2026", "jam": 13.0, "nota": 1, "pembayaran": "Cash",
      "nama": "Cheesecake A", "qty": 1, "harga": 40000, "subtotal": 40000,
      "transactionId": "1790920853544-gphoj4" }
  ]
}
```

`tanggal` is `D/M/YYYY`. A bare array instead of `{status, data}` is also accepted. On error return `{ "status": "error", "message": "..." }`. The server caches this response for 60 seconds; the **Muat ulang** button in Laporan forces a fresh fetch.

---

## Project structure

```
server.js           HTTP server, routing, access control, Apps Script proxy
auth.js             password hashing (scrypt), signed session cookies, user store
menu.js             menu store (data/menus.json) + validation
debts.js            customer debts & payments (data/debts.json)
shifts.js           kasir setoran records (data/shifts.json)
settings.js         store settings, e.g. Grab commission (data/settings.json)
backup.js           backup download / restore (Pengaturan → Data)
scripts/user.js     account CLI
public/             the only folder served to browsers
  index.html        app shell: Kasir / Menu / Laporan / Akun
  login.html
  assets/
    app.css         all styles
    app.js          shared: API, session, router, dialogs, toasts
    kasir.js        cart, payment, offline queue
    printer.js      receipt layouts + sending to Cleanter
    utang.js        debts list, payments, reprints
    setoran.js      kasir shift: modal, running totals, closing at logout
    admin.js        menu & account management
    report.js       sales report & charts
    icons.svg       icon sprite
  images/           default product photos
data/               runtime data (gitignored)
uploads/            uploaded product photos (gitignored)
```

Access rules are enforced in `server.js`: everything except the login page and static assets requires a session, and menu changes, reports and account management require `superadmin`. Hiding tabs in the UI is only cosmetic.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Server exits with "ENV belum lengkap" | Fill both `APPS_SCRIPT_*` URLs in `.env`. |
| Server exits about `SESSION_SECRET` | Must be at least 32 characters. |
| "Belum ada akun" warning | Run `node scripts/user.js add admin superadmin`. |
| Login works locally but not on the domain | Over HTTPS set `SECURE_COOKIE=true`; over plain HTTP it must be `false`. |
| "Terlalu banyak percobaan" for everyone | Behind a proxy without `TRUST_PROXY=true`, all users share the proxy's IP. Set it to `true`. |
| "Printer tidak terhubung" | Check Bluetooth pairing, that Cleanter is running, and RPP02N is selected in Cleanter. |
| Pending count never goes down | Check internet, then that the session is still valid (log in again), then the Apps Script deployment/permissions. |
| Report says failed to fetch data | Check `APPS_SCRIPT_REPORT_URL` opens in a browser and returns JSON. |

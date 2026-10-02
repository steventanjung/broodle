# Broodle — Kukikoe POS

A web-based point of sale (kasir) for Kukikoe. Transactions go to Google Sheets through an Apps Script, receipts print to a Bluetooth thermal printer through Cleanter, and the kasir keeps working offline (unsent transactions are queued on the device and uploaded when the connection returns).

- **Kasir** — product grid, cart, Cash/QRIS payment, receipt printing
- **Menu** (superadmin) — products, prices, categories, Best Seller, photos
- **Laporan** (superadmin) — sales report from Google Sheets
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
| `SESSION_HOURS` | no | Session length in hours. Default `12`. |
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

## Backups

Everything that matters at runtime lives in two folders, both outside git:

| Folder | Contents |
|---|---|
| `data/` | `users.json` (password hashes), `menus.json` (menu) |
| `uploads/` | product photos |

Transactions themselves are in Google Sheets.

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
  "nota": "001",
  "pembayaran": "Cash",
  "cashReceived": 100000,
  "change": 45000,
  "total": 55000,
  "items": [
    { "nama": "Cheesecake A", "qty": 1, "harga": 40000, "subtotal": 40000 }
  ]
}
```

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
scripts/user.js     account CLI
public/             the only folder served to browsers
  index.html        app shell: Kasir / Menu / Laporan / Akun
  login.html
  assets/
    app.css         all styles
    app.js          shared: API, session, router, dialogs, toasts
    kasir.js        cart, payment, offline queue, printing
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

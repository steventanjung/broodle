/*
 * Server statis + proxy Apps Script + autentikasi + menu.
 *
 * Browser hanya melihat /api/... , URL Apps Script
 * tidak pernah keluar dari server ini.
 *
 * Hak akses dipaksakan DI SINI, bukan di browser:
 * menyembunyikan tombol saja tidak mengamankan apa pun.
 */

const http = require("node:http");
const fs   = require("node:fs");
const path = require("node:path");

/*
 * Lokal: baca .env kalau ada. Di hosting (Railway, VPS
 * dengan systemd, dll) variabel diisi dari dashboard /
 * service, jadi file .env tidak wajib ada.
 * Harus sebelum require auth.js (membaca DATA_DIR).
 */
if(fs.existsSync(path.join(__dirname, ".env"))){
    process.loadEnvFile(path.join(__dirname, ".env"));
}

const auth = require("./auth.js");
const menu = require("./menu.js");
const debts = require("./debts.js");
const sales = require("./sales.js");
const shifts = require("./shifts.js");
const settings = require("./settings.js");
const backup   = require("./backup.js");


/* =====================================================
   KONFIGURASI
   ===================================================== */

const PORT          = process.env.PORT || 8080;
const SUBMIT_URL    = process.env.APPS_SCRIPT_SUBMIT_URL;
const REPORT_URL    = process.env.APPS_SCRIPT_REPORT_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;
/*
 * Lama sesi per peran:
 *   superadmin: berakhir setelah N menit TIDAK aktif (tiap permintaan memperpanjang).
 *   kasir: tidak dibatasi — cookie 400 hari (batas maksimal browser) yang terus
 *          diperpanjang; hanya berakhir kalau kasir keluar sendiri.
 */
const ADMIN_SESSION_MINUTES = Number(process.env.ADMIN_SESSION_MINUTES) || 15;
const KASIR_SESSION_SECONDS = 400 * 24 * 3600;

const sessionTtl = role =>
    role === "superadmin" ? ADMIN_SESSION_MINUTES * 60 : KASIR_SESSION_SECONDS;

/* true kalau dilayani lewat HTTPS (mis. di belakang Nginx / Caddy). */
const SECURE_COOKIE = process.env.SECURE_COOKIE === "true";

/*
 * true HANYA kalau di belakang reverse proxy yang mengisi
 * X-Forwarded-For. Tanpa proxy, header itu bisa dipalsukan
 * siapa saja untuk lolos dari rate limit login.
 */
const TRUST_PROXY = process.env.TRUST_PROXY === "true";

/* Data laporan di-cache sebentar: Apps Script lambat (2-5 detik). */
const REPORT_CACHE_MS = 60 * 1000;


const missing = [
    !SUBMIT_URL && "APPS_SCRIPT_SUBMIT_URL",
    !REPORT_URL && "APPS_SCRIPT_REPORT_URL"
].filter(Boolean);

if(missing.length){
    console.error(
        "ENV belum lengkap. Belum diisi: " + missing.join(", ") + ".\n" +
        "  Lokal: isi di file .env.  Railway / hosting: isi di tab Variables, lalu deploy ulang."
    );
    process.exit(1);
}

if(!SESSION_SECRET || SESSION_SECRET.length < 32){
    console.error(
        "SESSION_SECRET (di .env, atau tab Variables di hosting) harus ada dan minimal 32 karakter.\n" +
        "Buat dengan: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
    process.exit(1);
}

/*
 * Hosting tanpa terminal interaktif (Railway, dll):
 * superadmin pertama dibuat dari env, HANYA kalau belum
 * ada akun sama sekali. Hapus kedua variabel ini setelah
 * berhasil login.
 */
if(
    auth.loadUsers().length === 0 &&
    process.env.INITIAL_ADMIN_USERNAME &&
    process.env.INITIAL_ADMIN_PASSWORD
){
    const result = auth.createUser(
        process.env.INITIAL_ADMIN_USERNAME,
        process.env.INITIAL_ADMIN_PASSWORD,
        "superadmin"
    );

    console.log(
        result.ok
            ? `[akun] superadmin "${process.env.INITIAL_ADMIN_USERNAME}" dibuat dari env. ` +
              "Hapus INITIAL_ADMIN_USERNAME & INITIAL_ADMIN_PASSWORD sekarang."
            : "[akun] gagal membuat superadmin dari env: " + result.error
    );
}

if(auth.loadUsers().length === 0){
    console.warn(
        "\n[!] Belum ada akun. Buat superadmin dulu:\n" +
        "    node scripts/user.js add admin superadmin\n"
    );
}


/*
 * Hanya folder public/ dan uploads/ yang pernah dilayani
 * sebagai file. Kode server, .env, dan data/ ada di luar
 * keduanya, jadi tidak perlu daftar blokir.
 */

const PUBLIC_DIR  = path.join(__dirname, "public");
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, "uploads");
const PRODUCT_DIR = path.join(UPLOADS_DIR, "products");

fs.mkdirSync(PRODUCT_DIR, { recursive: true });

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js":   "text/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg":  "image/svg+xml",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png":  "image/png",
    ".webp": "image/webp",
    ".ico":  "image/x-icon"
};

const BASE_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin"
};


/* =====================================================
   HELPER
   ===================================================== */

function json(res, status, body, headers){

    res.writeHead(status, {
        ...BASE_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...headers
    });

    res.end(JSON.stringify(body));

}


function readBody(req, limit = 1_000_000){

    return new Promise((resolve, reject) => {

        const chunks = [];
        let size = 0;

        req.on("data", c => {

            size += c.length;

            if(size > limit){
                reject(Object.assign(new Error("Body terlalu besar"), { status: 413 }));
                req.destroy();
                return;
            }

            chunks.push(c);

        });

        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);

    });

}


async function readJson(req){

    try{
        return JSON.parse((await readBody(req)).toString("utf8")) || {};
    }catch(error){
        throw Object.assign(new Error("Permintaan tidak valid."), { status: error.status || 400 });
    }

}


function sessionCookie(value, maxAgeSeconds){

    return [
        auth.COOKIE_NAME + "=" + encodeURIComponent(value),
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=" + maxAgeSeconds,
        SECURE_COOKIE ? "Secure" : null
    ].filter(Boolean).join("; ");

}


/* Terbitkan / perpanjang cookie sesi di respons ini. */
function issueSession(res, user){

    const ttl = sessionTtl(user.role);
    const token = auth.createSession(user, SESSION_SECRET, ttl);

    res.setHeader("Set-Cookie", sessionCookie(token, ttl));

    return ttl;

}


function currentUser(req){

    const cookies = auth.parseCookies(req.headers.cookie);

    return auth.validateSession(auth.readSession(cookies[auth.COOKIE_NAME], SESSION_SECRET));

}


function clientIp(req){

    if(TRUST_PROXY){

        const forwarded =
            String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();

        if(forwarded){
            return forwarded;
        }

    }

    return req.socket.remoteAddress || "unknown";

}


/* =====================================================
   RATE LIMIT LOGIN
   Cegah percobaan password beruntun: hitungan per IP.
   ===================================================== */

const loginAttempts = new Map();

const MAX_ATTEMPTS = 8;
const WINDOW_MS    = 10 * 60 * 1000;


function loginBlocked(ip){

    const entry = loginAttempts.get(ip);

    return !!entry &&
        Date.now() - entry.first <= WINDOW_MS &&
        entry.count >= MAX_ATTEMPTS;

}


function recordFailure(ip){

    const entry = loginAttempts.get(ip);

    if(!entry || Date.now() - entry.first > WINDOW_MS){
        loginAttempts.set(ip, { count: 1, first: Date.now() });
        return;
    }

    entry.count++;

}


/* Buang entri kadaluarsa supaya Map tidak tumbuh terus. */
setInterval(() => {

    const now = Date.now();

    loginAttempts.forEach((entry, ip) => {
        if(now - entry.first > WINDOW_MS){
            loginAttempts.delete(ip);
        }
    });

}, WINDOW_MS).unref();


/* =====================================================
   AUTENTIKASI
   ===================================================== */

async function handleLogin(req, res){

    const ip = clientIp(req);

    if(loginBlocked(ip)){
        return json(res, 429, { error: "Terlalu banyak percobaan. Coba lagi 10 menit." });
    }

    const payload = await readJson(req);

    const user = await auth.authenticate(payload.username, payload.password);

    if(!user){
        recordFailure(ip);
        /* Jangan bocorkan username mana yang ada. */
        return json(res, 401, { error: "Username atau password salah." });
    }

    loginAttempts.delete(ip);

    const ttl = issueSession(res, user);

    console.log(`[login] ${user.username} (${user.role}) dari ${ip}`);

    json(res, 200, { ...user, sessionMinutes: user.role === "superadmin" ? ttl / 60 : null });

}


function handleLogout(req, res){

    json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });

}


function handleMe(req, res, user){

    json(res, 200, {
        username: user.username,
        role: user.role,
        /* Superadmin: dipakai halaman untuk logout otomatis saat tidak aktif. */
        sessionMinutes: user.role === "superadmin" ? ADMIN_SESSION_MINUTES : null,
        /* Untuk uji lokal: SETORAN_ASK_MODAL=false melewati form "Buka kasir". */
        askModal: process.env.SETORAN_ASK_MODAL !== "false"
    });

}


/* =====================================================
   KELOLA AKUN (superadmin)
   -----------------------------------------------------
   Akun superadmin HANYA bisa dibuat lewat CLI
   (node scripts/user.js add <user> superadmin) —
   sengaja tidak diekspos lewat endpoint ini, supaya
   satu sesi web yang bocor tidak bisa mencetak
   superadmin baru. Panel ini cuma bisa bikin akun kasir.
   ===================================================== */

function handleUsersList(req, res){

    const users = auth.loadUsers().map(u => ({
        username: u.username,
        role: u.role,
        createdAt: u.createdAt || null
    }));

    json(res, 200, { users });

}


async function handleUsersCreate(req, res, user){

    const payload = await readJson(req);

    const result = auth.createUser(payload.username, payload.password, "kasir");

    if(!result.ok){
        return json(res, 400, { error: result.error });
    }

    console.log(`[akun] kasir baru oleh ${user.username}: ${payload.username}`);

    json(res, 201, { ok: true });

}


function handleUsersDelete(req, res, user, target){

    if(target.toLowerCase() === user.username.toLowerCase()){
        return json(res, 400, {
            error: "Tidak bisa menghapus akun sendiri yang sedang login."
        });
    }

    const result = auth.removeUser(target);

    if(!result.ok){
        return json(res, 400, { error: result.error });
    }

    console.log(`[akun] dihapus oleh ${user.username}: ${target}`);

    json(res, 200, { ok: true });

}


async function handleUsersResetPassword(req, res, user, target){

    const payload = await readJson(req);

    const result = auth.resetPassword(target, payload.password);

    if(!result.ok){
        return json(res, 400, { error: result.error });
    }

    if(target.toLowerCase() === user.username.toLowerCase()){
        issueSession(res, user);
    }

    console.log(`[akun] password direset oleh ${user.username}: ${target}`);

    json(res, 200, { ok: true });

}


/*
 * Ganti password akun sendiri. Percobaan password lama
 * yang salah dibatasi seperti login (per akun).
 */

async function handleChangePassword(req, res, user){

    const key = "pw:" + user.username.toLowerCase();

    if(loginBlocked(key)){
        return json(res, 429, { error: "Terlalu banyak percobaan. Coba lagi 10 menit." });
    }

    const payload = await readJson(req);

    const result = await auth.changePassword(
        user.username,
        String(payload.currentPassword || ""),
        payload.newPassword
    );

    if(!result.ok){

        if(result.wrongCurrent){
            recordFailure(key);
        }

        return json(res, 400, { error: result.error });

    }

    loginAttempts.delete(key);

    /* Perangkat lain keluar; perangkat yang mengganti tetap masuk dengan sesi baru. */
    issueSession(res, user);

    console.log(`[akun] ${user.username} mengganti passwordnya sendiri`);

    json(res, 200, { ok: true });

}


/* =====================================================
   MENU
   Semua user boleh membaca; hanya superadmin mengubah.
   ===================================================== */

function handleMenuList(req, res){

    /* Pengaturan ikut dikirim: kasir butuh potongan Grab, juga saat offline (disalin di tablet). */
    json(res, 200, { ...menu.list(), settings: settings.get() });

}


async function handleSettingsSave(req, res, user){

    const result = settings.update(await readJson(req));

    if(!result.ok){
        return json(res, 400, { error: result.error });
    }

    console.log(`[pengaturan] diubah oleh ${user.username}: ${JSON.stringify(result.settings)}`);

    json(res, 200, result.settings);

}


/* Cadangan: semua data + foto produk dalam satu file JSON. */
function handleBackupDownload(req, res, user){

    const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });

    console.log(`[cadangan] diunduh oleh ${user.username}`);

    json(res, 200, backup.create(PRODUCT_DIR), {
        "Content-Disposition": `attachment; filename="broodle-cadangan-${day}.json"`
    });

}


async function handleBackupRestore(req, res, user){

    let input;

    try{
        input = JSON.parse((await readBody(req, MAX_BACKUP_BYTES)).toString("utf8"));
    }catch(error){
        return json(res, error.status || 400, { error: error.status === 413 ? "File cadangan terlalu besar." : "File ini bukan cadangan Broodle." });
    }

    const result = backup.restore(input, PRODUCT_DIR);

    if(!result.ok){
        return json(res, 400, { error: result.error });
    }

    console.log(`[cadangan] dipulihkan oleh ${user.username} dari cadangan ${input.createdAt}: ${JSON.stringify(result.summary)} (data lama disimpan di ${result.safety})`);

    json(res, 200, result.summary);

}


async function handleCategoriesSave(req, res, user){

    const payload = await readJson(req);
    const result = menu.saveCategories(payload.categories);

    if(!result.ok){
        return json(res, 400, { error: result.error });
    }

    console.log(`[menu] kategori diatur oleh ${user.username}: ${result.data.categories.join(", ")}`);

    json(res, 200, result.data);

}


async function handleMenuCreate(req, res, user){

    const result = menu.create(await readJson(req));

    if(!result.ok){
        return json(res, 400, { error: result.error });
    }

    console.log(`[menu] ditambah oleh ${user.username}: ${result.menu.nama}`);

    json(res, 201, result.menu);

}


async function handleMenuUpdate(req, res, user, id){

    const result = menu.update(id, await readJson(req));

    if(!result.ok){
        return json(res, 400, { error: result.error });
    }

    json(res, 200, result.menu);

}


function handleMenuDelete(req, res, user, id){

    const result = menu.remove(id);

    if(!result.ok){
        return json(res, 404, { error: result.error });
    }

    /* Foto ikut dibuang; abaikan kalau memang tidak ada. */
    fs.promises.unlink(path.join(PRODUCT_DIR, id + ".jpg")).catch(() => {});

    console.log(`[menu] dihapus oleh ${user.username}: ${id}`);

    json(res, 200, { ok: true });

}


/*
 * Upload foto produk. Browser sudah mengompres jadi JPEG
 * kecil; server cuma validasi ulang lalu simpan.
 *
 * Nama file SELALU "<id>.jpg" dengan id produk yang
 * sudah ada di menus.json — tidak pernah nama dari klien —
 * jadi tidak ada celah path traversal.
 */

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_BACKUP_BYTES = 200 * 1024 * 1024;


async function handleMenuImage(req, res, user, id){

    if(!menu.find(id)){
        return json(res, 404, { error: "Produk tidak ditemukan." });
    }

    if(!String(req.headers["content-type"] || "").startsWith("image/jpeg")){
        return json(res, 400, { error: "Format harus JPEG." });
    }

    const body = await readBody(req, MAX_IMAGE_BYTES);

    /* Cek magic bytes JPEG (FF D8 FF), jangan percaya header saja. */
    if(body.length < 3 || body[0] !== 0xFF || body[1] !== 0xD8 || body[2] !== 0xFF){
        return json(res, 400, { error: "Isi file bukan JPEG yang valid." });
    }

    await fs.promises.writeFile(path.join(PRODUCT_DIR, id + ".jpg"), body);

    /* ?v= supaya browser tidak menampilkan foto lama dari cache. */
    const result = menu.update(id, {
        gambar: `/uploads/products/${id}.jpg?v=${Date.now()}`
    });

    json(res, 200, result.menu);

}


/* =====================================================
   PROXY APPS SCRIPT
   ===================================================== */

let reportCache = null;


async function handleSubmit(req, res, user){

    const body = await readBody(req);

    let tx;

    try{
        tx = JSON.parse(body.toString("utf8"));
    }catch(error){
        return json(res, 400, { error: "Transaksi tidak valid." });
    }

    /*
     * Penjualan utang: catat utangnya DULU. Kalau gagal, browser
     * menerima error dan transaksi tetap di antreannya untuk
     * dikirim ulang; kiriman ulang tidak membuat utang dobel.
     */
    if(tx && tx.pembayaran === "Utang"){

        const result = debts.createFromTransaction(tx, user.username);

        if(!result.ok){
            return json(res, 400, { error: result.error });
        }

        if(!result.duplicate){
            console.log(`[utang] nota ${result.debt.nota} atas nama ${result.debt.pelanggan}: Rp${result.debt.total} oleh ${user.username}`);
        }

    }

    /* Salinan di server supaya nota yang sudah lunas bisa diubah / dibatalkan. */
    if(tx){
        sales.record(tx, user.username);
    }

    /* Apps Script membalas 302 ke googleusercontent, fetch mengikutinya. */
    const upstream = await fetch(SUBMIT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body,
        redirect: "follow"
    });

    if(upstream.ok){
        /* Ada transaksi baru: laporan berikutnya harus ambil ulang. */
        reportCache = null;
    }else{
        console.error("[submit] gagal:", upstream.status);
    }

    json(res, upstream.ok ? 200 : 502, { ok: upstream.ok });

}


/* =====================================================
   SETORAN KASIR
   Tablet mengirim catatan setoran (buka / tutup); superadmin
   melihat daftarnya di Laporan.
   ===================================================== */

async function handleShiftSave(req, res, user, id){

    const payload = await readJson(req);
    const result = shifts.upsert({ ...payload, id }, user.username);

    if(!result.ok){
        return json(res, 400, { error: result.error });
    }

    if(result.shift.closedAt && payload.closedAt){
        console.log(`[setoran] ditutup: ${result.shift.kasir}, modal Rp${result.shift.modal}, ${result.shift.totals.count} transaksi`);
    }

    json(res, 200, result.shift);

}


function handleShiftList(req, res){

    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    const from = req.query.get("from");
    const to = req.query.get("to");

    json(res, 200, {
        shifts: shifts.list(DATE.test(from || "") ? from : null, DATE.test(to || "") ? to : null)
    });

}


/* =====================================================
   UTANG
   Kasir & superadmin: lihat dan catat pembayaran.
   Hanya superadmin: membatalkan utang.
   ===================================================== */

function handleDebtsList(req, res){

    const all = debts.list();
    /* Tanggal toko (WIB), bukan UTC server — server hosting biasanya UTC. */
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
    const open = all.filter(d => d.status === "belum");

    json(res, 200, {
        debts: all,
        summary: {
            openCount: open.length,
            openTotal: open.reduce((sum, d) => sum + d.sisa, 0),
            customers: new Set(open.map(d => d.pelanggan.toLowerCase())).size,
            overdue: open.filter(d => d.jatuhTempo && d.jatuhTempo < today).length
        }
    });

}


function handleDebtGet(req, res, user, id){

    const debt = debts.find(id);

    if(!debt){
        return json(res, 404, { error: "Utang tidak ditemukan." });
    }

    json(res, 200, debt);

}


async function handleDebtPayment(req, res, user, id){

    const result = debts.addPayment(id, await readJson(req), user.username);

    if(!result.ok){
        return json(res, 400, { error: result.error });
    }

    if(!result.duplicate){
        const last = result.debt.payments[result.debt.payments.length - 1];
        console.log(`[utang] bayar nota ${result.debt.nota} (${result.debt.pelanggan}): Rp${last.jumlah} ${last.metode} oleh ${user.username}, sisa Rp${result.debt.sisa}`);
    }

    json(res, 200, result.debt);

}


async function handleDebtVoid(req, res, user, id){

    const payload = await readJson(req);
    const result = debts.voidDebt(id, payload.alasan, user.username);

    if(!result.ok){
        return json(res, 400, { error: result.error });
    }

    console.log(`[utang] dibatalkan oleh ${user.username}: nota ${result.debt.nota} (${result.debt.pelanggan}), alasan: ${result.debt.void.alasan}`);

    json(res, 200, result.debt);

}


/* =====================================================
   KOREKSI NOTA
   Nota yang sudah lunas bisa diubah / dibatalkan. Kasir wajib
   password koreksi dari superadmin (dicek di sini, bukan di
   browser); superadmin tidak diminta password.
   ===================================================== */

function handleSalesList(req, res, user){

    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    const from = req.query.get("from");
    const to = req.query.get("to");

    json(res, 200, {
        sales: sales.list({
            user,
            setoran: req.query.get("setoran"),
            from: DATE.test(from || "") ? from : null,
            to: DATE.test(to || "") ? to : null
        }),
        passwordSet: sales.hasPassword()
    });

}


async function handleSaleCancel(req, res, user, id){

    const result = await sales.cancel(id, user, await readJson(req));

    if(!result.ok){
        return json(res, result.status || 400, { error: result.error });
    }

    reportCache = null;
    console.log(`[koreksi] nota ${result.sale.nota} DIBATALKAN oleh ${user.username}: ${result.sale.cancelReason}`);

    json(res, 200, result.sale);

}


async function handleSaleEdit(req, res, user, id){

    const result = await sales.edit(id, user, await readJson(req));

    if(!result.ok){
        return json(res, result.status || 400, { error: result.error });
    }

    reportCache = null;
    console.log(`[koreksi] nota ${result.sale.nota} diubah oleh ${user.username}: ${result.sale.history[result.sale.history.length - 1].alasan}`);

    json(res, 200, result.sale);

}


function handleKoreksiStatus(req, res){
    json(res, 200, { passwordSet: sales.hasPassword() });
}


async function handleKoreksiPassword(req, res, user){

    const payload = await readJson(req);
    const result = payload.password ? sales.setPassword(payload.password) : sales.clearPassword();

    if(!result.ok){
        return json(res, 400, { error: result.error });
    }

    console.log(`[koreksi] password koreksi ${payload.password ? "diatur" : "dihapus"} oleh ${user.username}`);

    json(res, 200, { passwordSet: sales.hasPassword() });

}


async function handleReport(req, res){

    const fresh =
        reportCache &&
        Date.now() - reportCache.at < REPORT_CACHE_MS &&
        req.query.get("refresh") !== "1";

    if(!fresh){

        const upstream = await fetch(REPORT_URL, { redirect: "follow" });

        if(!upstream.ok){
            return json(res, 502, { error: "Gagal mengambil data dari Google Sheets." });
        }

        reportCache = { at: Date.now(), text: await upstream.text() };

    }

    res.writeHead(200, {
        ...BASE_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });

    res.end(sales.applyToReport(reportCache.text));

}


/* =====================================================
   FILE STATIS
   ===================================================== */

async function serveStatic(req, res, pathname){

    const isUpload = pathname.startsWith("/uploads/");
    const root     = isUpload ? UPLOADS_DIR : PUBLIC_DIR;
    const rel      = isUpload ? pathname.slice("/uploads".length) : pathname;
    const file     = path.join(root, rel === "/" ? "/index.html" : rel);

    const notFound = () => {
        res.writeHead(404, { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
    };

    /* Cegah keluar dari folder yang dilayani. */
    if(!file.startsWith(root + path.sep) || path.basename(file).startsWith(".")){
        return notFound();
    }

    let stat;

    try{
        stat = await fs.promises.stat(file);
    }catch(error){
        return notFound();
    }

    if(!stat.isFile()){
        return notFound();
    }

    const ext  = path.extname(file).toLowerCase();
    const etag = `"${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}"`;

    /*
     * HTML/CSS/JS: selalu cek ulang (ETag -> 304 murah),
     * supaya deploy baru langsung terpakai.
     * Gambar jarang berubah; upload sudah diberi ?v=.
     */
    const cacheControl =
        ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".webp"
            ? "public, max-age=86400"
            : "no-cache";

    const headers = {
        ...BASE_HEADERS,
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": cacheControl,
        "ETag": etag
    };

    if(req.headers["if-none-match"] === etag){
        res.writeHead(304, headers);
        return res.end();
    }

    res.writeHead(200, { ...headers, "Content-Length": stat.size });

    if(req.method === "HEAD"){
        return res.end();
    }

    fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);

}


/* =====================================================
   ROUTER
   -----------------------------------------------------
   [method, pola, handler, akses]
   akses: "public" | "user" | "superadmin"
   Grup dari pola (mis. :id) dioper sebagai argumen
   setelah (req, res, user).
   ===================================================== */

const ROUTES = [
    ["POST",   /^\/api\/login$/,                         handleLogin,              "public"],
    ["POST",   /^\/api\/logout$/,                        handleLogout,             "public"],
    ["GET",    /^\/api\/me$/,                            handleMe,                 "user"],
    ["POST",   /^\/api\/me\/password$/,                  handleChangePassword,     "superadmin"],
    ["POST",   /^\/api\/submit$/,                        handleSubmit,             "user"],
    ["GET",    /^\/api\/menu$/,                          handleMenuList,           "user"],
    ["PUT",    /^\/api\/settings$/,                     handleSettingsSave,       "superadmin"],
    ["GET",    /^\/api\/backup$/,                       handleBackupDownload,     "superadmin"],
    ["POST",   /^\/api\/backup\/restore$/,              handleBackupRestore,      "superadmin"],
    ["PUT",    /^\/api\/categories$/,                   handleCategoriesSave,     "superadmin"],
    ["POST",   /^\/api\/menu$/,                          handleMenuCreate,         "superadmin"],
    ["PUT",    /^\/api\/menu\/([\w-]{6,80})$/,           handleMenuUpdate,         "superadmin"],
    ["DELETE", /^\/api\/menu\/([\w-]{6,80})$/,           handleMenuDelete,         "superadmin"],
    ["POST",   /^\/api\/menu\/([\w-]{6,80})\/image$/,    handleMenuImage,          "superadmin"],
    ["PUT",    /^\/api\/shifts\/([\w.-]{6,80})$/,       handleShiftSave,          "user"],
    ["GET",    /^\/api\/shifts$/,                       handleShiftList,          "superadmin"],
    ["GET",    /^\/api\/debts$/,                        handleDebtsList,          "user"],
    ["GET",    /^\/api\/debts\/([\w.-]{6,80})$/,        handleDebtGet,            "user"],
    ["POST",   /^\/api\/debts\/([\w.-]{6,80})\/payments$/, handleDebtPayment,     "user"],
    ["POST",   /^\/api\/debts\/([\w.-]{6,80})\/void$/,   handleDebtVoid,           "superadmin"],
    ["GET",    /^\/api\/sales$/,                        handleSalesList,          "user"],
    ["POST",   /^\/api\/sales\/([\w.-]{6,80})\/cancel$/, handleSaleCancel,        "user"],
    ["POST",   /^\/api\/sales\/([\w.-]{6,80})\/edit$/,   handleSaleEdit,          "user"],
    ["GET",    /^\/api\/koreksi$/,                      handleKoreksiStatus,      "superadmin"],
    ["PUT",    /^\/api\/koreksi$/,                      handleKoreksiPassword,    "superadmin"],
    ["GET",    /^\/api\/report$/,                        handleReport,             "superadmin"],
    ["GET",    /^\/api\/users$/,                         handleUsersList,          "superadmin"],
    ["POST",   /^\/api\/users$/,                         handleUsersCreate,        "superadmin"],
    ["DELETE", /^\/api\/users\/([^/]+)$/,                handleUsersDelete,        "superadmin"],
    ["POST",   /^\/api\/users\/([^/]+)\/reset-password$/, handleUsersResetPassword, "superadmin"]
];


function isPublicFile(pathname){

    /*
     * Halaman login butuh CSS/ikon sebelum masuk. Foto
     * produk & aset tidak sensitif; halaman yang
     * menampilkannya tetap wajib login.
     */
    return (
        pathname === "/login.html" ||
        pathname.startsWith("/assets/") ||
        pathname.startsWith("/images/") ||
        pathname.startsWith("/uploads/")
    );

}


async function route(req, res){

    const url = new URL(req.url, "http://localhost");

    let pathname;

    try{
        pathname = decodeURIComponent(url.pathname);
    }catch(error){
        return json(res, 400, { error: "URL tidak valid." });
    }


    /* --- API --- */

    if(pathname.startsWith("/api/")){

        const candidates = ROUTES.filter(r => r[1].test(pathname));

        if(candidates.length === 0){
            return json(res, 404, { error: "Not found" });
        }

        const match = candidates.find(r => r[0] === req.method);

        if(!match){
            return json(res, 405, { error: "Method not allowed" });
        }

        const [, pattern, handler, access] = match;
        const params = pathname.match(pattern).slice(1);

        let user = null;

        if(access !== "public"){

            user = currentUser(req);

            if(!user){
                return json(res, 401, { error: "Sesi habis. Masuk ulang.", login: "/login.html" });
            }

            if(access === "superadmin" && user.role !== "superadmin"){
                return json(res, 403, { error: "Akses ditolak." });
            }

            /* Ada aktivitas: perpanjang sesi. */
            issueSession(res, user);

        }

        req.query = url.searchParams;

        return handler(req, res, user, ...params);

    }


    /* --- file --- */

    if(req.method !== "GET" && req.method !== "HEAD"){
        res.writeHead(405, BASE_HEADERS);
        return res.end();
    }

    if(isPublicFile(pathname)){
        return serveStatic(req, res, pathname);
    }

    const user = currentUser(req);

    if(user && (pathname === "/" || pathname.endsWith(".html"))){
        issueSession(res, user);
    }

    if(!user){

        res.writeHead(302, {
            ...BASE_HEADERS,
            "Location": "/login.html?next=" + encodeURIComponent(pathname + url.search),
            "Cache-Control": "no-store"
        });

        return res.end();

    }

    /* Laporan sekarang satu halaman dengan kasir. */
    if(pathname === "/report.html"){
        res.writeHead(302, { ...BASE_HEADERS, "Location": "/#laporan" });
        return res.end();
    }

    serveStatic(req, res, pathname);

}


const server = http.createServer(async (req, res) => {

    try{

        await route(req, res);

    }catch(error){

        const status = error.status || 500;

        if(status === 500){
            console.error("Error:", error);
        }

        if(!res.headersSent){
            json(res, status, { error: status === 500 ? "Server error" : error.message });
        }else{
            res.end();
        }

    }

});


server.on("error", error => {

    if(error.code === "EADDRINUSE"){
        console.error(
            `\nPort ${PORT} sudah dipakai — kemungkinan server ini masih jalan di terminal lain.\n` +
            `  Hentikan yang lama (Ctrl+C), atau: kill $(lsof -t -i :${PORT})\n` +
            `  Atau ganti PORT di .env.\n`
        );
        process.exit(1);
    }

    throw error;

});


server.listen(PORT, () => {

    console.log(
        `Broodle jalan di http://localhost:${PORT}\n` +
        `  sesi superadmin: ${ADMIN_SESSION_MINUTES} menit tidak aktif | kasir: sampai keluar` +
        (SECURE_COOKIE ? " | cookie Secure aktif" : "") +
        (TRUST_PROXY ? " | trust proxy" : "")
    );

});

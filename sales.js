/*
 * Catatan penjualan di server (data/sales.json) + koreksi nota.
 *
 * Penjualan tetap dikirim ke Google Sheets seperti biasa; file ini
 * menyimpan salinannya supaya nota yang SUDAH LUNAS bisa diubah atau
 * dibatalkan. Sheet tidak diubah — Laporan menimpa barisnya dengan
 * koreksi di sini (applyToReport).
 *
 * Kasir hanya boleh mengoreksi dengan password koreksi buatan
 * superadmin (disimpan sebagai hash scrypt, sama seperti password
 * akun). Superadmin tidak diminta password.
 *
 * Penjualan utang tidak ada di sini: utang dibatalkan lewat tab Utang.
 */

const fs   = require("node:fs");
const path = require("node:path");

const auth = require("./auth.js");


const SALES_FILE = path.join(auth.DATA_DIR, "sales.json");

const ID_PATTERN   = /^[\w.-]{6,80}$/;
const METHODS      = ["Cash", "QRIS", "Transfer BCA", "Debit"];
const MAX_QTY      = 999;
const MAX_AMOUNT   = 1_000_000_000;
const MAX_REASON   = 200;
const MIN_KOREKSI_PASSWORD = 6;

/* Salah password berulang: kunci sementara per akun. */
const MAX_FAILS = 5;
const LOCK_MS   = 5 * 60 * 1000;
const fails = new Map();


let cache = null;
let cacheMtime = 0;

const fileMtime = () => {
    try{ return fs.statSync(SALES_FILE).mtimeMs; }catch(e){ return 0; }
};


function load(){

    if(cache && fileMtime() === cacheMtime){
        return cache;
    }

    try{

        const parsed = JSON.parse(fs.readFileSync(SALES_FILE, "utf8"));

        cache = {
            sales: Array.isArray(parsed.sales) ? parsed.sales : [],
            koreksiHash: typeof parsed.koreksiHash === "string" ? parsed.koreksiHash : null
        };

    }catch(error){

        if(error.code !== "ENOENT"){
            /* File rusak: jangan ditimpa diam-diam, ini catatan uang. */
            throw new Error("sales.json tidak bisa dibaca: " + error.message);
        }

        cache = { sales: [], koreksiHash: null };

    }

    cacheMtime = fileMtime();

    return cache;

}


function persist(){

    const tmp = SALES_FILE + ".tmp";

    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, SALES_FILE);

    cacheMtime = fileMtime();

}


const day = iso => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });

const clean = value => String(value ?? "").trim();


/* =====================================================
   PENCATATAN
   ===================================================== */

/* Salin penjualan yang baru dikirim; kiriman ulang (antrean offline) diabaikan. */
function record(tx, username){

    const id = clean(tx?.transactionId);

    if(!ID_PATTERN.test(id) || tx.pembayaran === "Utang" || !Array.isArray(tx.items)){
        return;
    }

    const data = load();

    if(data.sales.some(s => s.id === id)){
        return;
    }

    const items = tx.items
        .map(i => ({
            nama: clean(i.nama).slice(0, 120),
            qty: Number(i.qty),
            harga: Number(i.harga),
            subtotal: Number(i.subtotal)
        }))
        .filter(i => i.nama && Number.isInteger(i.qty) && i.qty > 0 && Number.isFinite(i.harga) && Number.isFinite(i.subtotal));

    const total = Number(tx.total);

    if(items.length === 0 || !Number.isFinite(total)){
        return;
    }

    data.sales.push({
        id,
        nota: clean(tx.nota).slice(0, 20),
        tanggal: clean(tx.tanggal).slice(0, 20),
        jam: clean(tx.jam).slice(0, 10),
        kasir: auth.findUser(tx.kasir)?.username || username,
        setoran: ID_PATTERN.test(clean(tx.setoran)) ? clean(tx.setoran) : null,
        createdAt: new Date().toISOString(),
        status: "aktif",
        pembayaran: clean(tx.pembayaran).slice(0, 80),
        pembayaranBagi: Array.isArray(tx.pembayaranBagi) ? tx.pembayaranBagi : null,
        cashReceived: Number(tx.cashReceived) || 0,
        change: Number(tx.change) || 0,
        total,
        items,
        /* Grab: harga Grab asli untuk nota, tidak bisa diubah. */
        ...(tx.grabItems ? { grabItems: tx.grabItems, grabTotal: tx.grabTotal, grabPotongan: tx.grabPotongan } : {}),
        history: []
    });

    persist();

}


/* Bentuk yang dikirim ke browser. */
function view(sale){

    return {
        ...sale,
        /* Hanya sebagian jenis yang bisa diubah; semua yang bukan utang bisa dibatalkan. */
        editable: sale.status === "aktif" && !sale.pembayaranBagi && sale.pembayaran !== "Grab" && METHODS.includes(sale.pembayaran)
    };

}


/*
 * kasir: hanya penjualan miliknya di setoran tertentu.
 * superadmin: rentang tanggal (WIB), semua kasir.
 */
function list({ user, setoran, from, to }){

    const sales = load().sales.filter(s => {

        if(user.role !== "superadmin"){
            return s.kasir === user.username && !!setoran && s.setoran === setoran;
        }

        const d = day(s.createdAt);
        return (!from || d >= from) && (!to || d <= to);

    });

    return sales
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 300)
        .map(view);

}


/* =====================================================
   PASSWORD KOREKSI
   ===================================================== */

const hasPassword = () => !!load().koreksiHash;


function setPassword(password){

    const text = String(password ?? "");

    if(text.length < MIN_KOREKSI_PASSWORD){
        return { ok: false, error: `Password koreksi minimal ${MIN_KOREKSI_PASSWORD} karakter.` };
    }

    if(text.length > 128){
        return { ok: false, error: "Password koreksi terlalu panjang." };
    }

    const data = load();

    data.koreksiHash = auth.hashPassword(text);
    persist();
    fails.clear();

    return { ok: true };

}


function clearPassword(){

    const data = load();

    data.koreksiHash = null;
    persist();

    return { ok: true };

}


/* Superadmin langsung lolos; kasir wajib password koreksi. */
async function authorize(user, password){

    if(user.role === "superadmin"){
        return { ok: true };
    }

    const hash = load().koreksiHash;

    if(!hash){
        return { ok: false, status: 403, error: "Password koreksi belum diatur. Minta superadmin mengaturnya di Pengaturan." };
    }

    const state = fails.get(user.username);

    if(state && state.until > Date.now()){
        const minutes = Math.ceil((state.until - Date.now()) / 60000);
        return { ok: false, status: 429, error: `Terlalu banyak salah password. Coba lagi ${minutes} menit lagi.` };
    }

    if(!password || !(await auth.verifyPassword(String(password), hash))){

        const count = (state && state.until <= Date.now() ? 0 : state?.count || 0) + 1;

        fails.set(user.username, { count, until: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });

        return { ok: false, status: 403, error: "Password koreksi salah." };

    }

    fails.delete(user.username);

    return { ok: true };

}


/* =====================================================
   KOREKSI
   ===================================================== */

function snapshot(sale){

    return {
        at: new Date().toISOString(),
        pembayaran: sale.pembayaran,
        total: sale.total,
        cashReceived: sale.cashReceived,
        change: sale.change,
        items: sale.items
    };

}


function findFor(id, user){

    const sale = load().sales.find(s => s.id === id);

    if(!sale || (user.role !== "superadmin" && sale.kasir !== user.username)){
        return { error: "Nota tidak ditemukan." };
    }

    if(sale.status !== "aktif"){
        return { error: "Nota ini sudah dibatalkan." };
    }

    return { sale };

}


async function cancel(id, user, { password, alasan }){

    const { sale, error } = findFor(id, user);

    if(error){
        return { ok: false, status: 404, error };
    }

    const reason = clean(alasan).slice(0, MAX_REASON);

    if(!reason){
        return { ok: false, status: 400, error: "Isi alasan pembatalan." };
    }

    const authorized = await authorize(user, password);

    if(!authorized.ok){
        return authorized;
    }

    /* Cek ulang setelah menunggu scrypt: dua permintaan bersamaan tidak boleh lolos dua kali. */
    if(sale.status !== "aktif"){
        return { ok: false, status: 400, error: "Nota ini sudah dibatalkan." };
    }

    sale.history.push({ ...snapshot(sale), aksi: "batal", oleh: user.username, alasan: reason });
    sale.status = "batal";
    sale.cancelledAt = new Date().toISOString();
    sale.cancelledBy = user.username;
    sale.cancelReason = reason;

    persist();

    return { ok: true, sale: view(sale) };

}


/*
 * Ubah jumlah tiap item (0 = hapus item) dan/atau metode bayar.
 * Harga tidak bisa diubah; salah produk / harga = batalkan lalu
 * catat ulang.
 */
async function edit(id, user, { password, alasan, qty, pembayaran, cashReceived }){

    const { sale, error } = findFor(id, user);

    if(error){
        return { ok: false, status: 404, error };
    }

    if(!view(sale).editable){
        return { ok: false, status: 400, error: "Nota Grab atau bayar 2 metode tidak bisa diubah. Batalkan lalu catat ulang." };
    }

    const reason = clean(alasan).slice(0, MAX_REASON);

    if(!reason){
        return { ok: false, status: 400, error: "Isi alasan perubahan." };
    }

    if(!Array.isArray(qty) || qty.length !== sale.items.length){
        return { ok: false, status: 400, error: "Data item tidak cocok dengan nota." };
    }

    const items = [];

    for(let i = 0; i < qty.length; i++){

        const n = Number(qty[i]);

        if(!Number.isInteger(n) || n < 0 || n > MAX_QTY){
            return { ok: false, status: 400, error: "Jumlah item tidak valid." };
        }

        if(n > 0){
            const old = sale.items[i];
            items.push({ nama: old.nama, qty: n, harga: old.harga, subtotal: old.harga * n });
        }

    }

    if(items.length === 0){
        return { ok: false, status: 400, error: "Nota harus punya minimal satu item. Untuk menghapus semuanya, batalkan nota." };
    }

    const metode = clean(pembayaran) || sale.pembayaran;

    if(!METHODS.includes(metode)){
        return { ok: false, status: 400, error: "Metode pembayaran tidak valid." };
    }

    const total = items.reduce((sum, i) => sum + i.subtotal, 0);

    if(total > MAX_AMOUNT){
        return { ok: false, status: 400, error: "Total terlalu besar." };
    }

    let received = 0;
    let change = 0;

    if(metode === "Cash"){

        received = Number(cashReceived);

        if(!Number.isInteger(received) || received < total || received > MAX_AMOUNT){
            return { ok: false, status: 400, error: "Uang diterima kurang dari total." };
        }

        change = received - total;

    }

    const authorized = await authorize(user, password);

    if(!authorized.ok){
        return authorized;
    }

    if(sale.status !== "aktif"){
        return { ok: false, status: 400, error: "Nota ini sudah dibatalkan." };
    }

    sale.history.push({ ...snapshot(sale), aksi: "ubah", oleh: user.username, alasan: reason });

    sale.items = items;
    sale.total = total;
    sale.pembayaran = metode;
    sale.cashReceived = received;
    sale.change = change;
    sale.editedAt = new Date().toISOString();

    persist();

    return { ok: true, sale: view(sale) };

}


/* =====================================================
   LAPORAN
   Sheet tidak diubah; baris nota yang dibatalkan dibuang, nota
   yang diubah diganti isinya. Nota tanpa koreksi lewat apa adanya.
   ===================================================== */

function applyToReport(text){

    const corrected = new Map(load().sales.filter(s => s.status === "batal" || s.history.length).map(s => [s.id, s]));

    if(corrected.size === 0){
        return text;
    }

    let parsed;

    try{
        parsed = JSON.parse(text);
    }catch(error){
        return text;
    }

    const rows = Array.isArray(parsed) ? parsed : parsed?.data;

    if(!Array.isArray(rows)){
        return text;
    }

    const out = [];
    const emitted = new Set();

    for(const row of rows){

        const sale = corrected.get(row?.transactionId);

        if(!sale){
            out.push(row);
            continue;
        }

        if(sale.status === "batal" || emitted.has(sale.id)){
            continue;
        }

        emitted.add(sale.id);

        /* Pakai tanggal / jam / nota dari baris asli; hanya isi dan metode yang berubah. */
        for(const item of sale.items){
            out.push({ ...row, pembayaran: sale.pembayaran, nama: item.nama, qty: item.qty, harga: item.harga, subtotal: item.subtotal });
        }

    }

    return JSON.stringify(Array.isArray(parsed) ? out : { ...parsed, data: out });

}


module.exports = {
    MIN_KOREKSI_PASSWORD,
    record,
    list,
    hasPassword,
    setPassword,
    clearPassword,
    cancel,
    edit,
    applyToReport
};

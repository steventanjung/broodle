/*
 * Penyimpanan utang pelanggan (data/debts.json).
 *
 * Penjualan tetap tercatat di Google Sheets (pembayaran "Utang");
 * file ini menyimpan sisi yang berubah-ubah: siapa yang berutang,
 * sisa berapa, dan riwayat pembayarannya.
 *
 * Satu utang = satu transaksi; id-nya memakai transactionId,
 * jadi antrean offline yang mengirim ulang tidak membuat utang
 * dobel.
 */

const fs     = require("node:fs");
const path   = require("node:path");

const { DATA_DIR } = require("./auth.js");


const DEBT_FILE = path.join(DATA_DIR, "debts.json");

const ID_PATTERN   = /^[\w.-]{6,80}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const METHODS      = ["Cash", "QRIS", "Transfer BCA", "Debit"];
const MAX_AMOUNT   = 1_000_000_000;


/* =====================================================
   FILE (cache di memori, dibaca ulang kalau file berubah)
   ===================================================== */

let cache = null;
let cacheMtime = 0;

function fileMtime(){

    try{
        return fs.statSync(DEBT_FILE).mtimeMs;
    }catch(error){
        return 0;
    }

}


function load(){

    if(cache && fileMtime() === cacheMtime){
        return cache;
    }

    try{

        const parsed = JSON.parse(fs.readFileSync(DEBT_FILE, "utf8"));

        cache = { debts: Array.isArray(parsed.debts) ? parsed.debts : [] };

    }catch(error){

        if(error.code !== "ENOENT"){
            /* File rusak: jangan ditimpa diam-diam, ini catatan uang. */
            throw new Error("debts.json tidak bisa dibaca: " + error.message);
        }

        cache = { debts: [] };

    }

    cacheMtime = fileMtime();

    return cache;

}


/* Tulis ke file sementara lalu rename: file lama tetap utuh kalau server mati di tengah jalan. */
function persist(){

    cache.updatedAt = Date.now();

    const tmp = DEBT_FILE + ".tmp";

    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, DEBT_FILE);

    cacheMtime = fileMtime();

}


/* =====================================================
   NILAI TURUNAN
   ===================================================== */

function withTotals(debt){

    const dibayar = debt.payments.reduce((sum, p) => sum + p.jumlah, 0);
    const sisa = Math.max(debt.total - dibayar, 0);

    return {
        ...debt,
        dibayar,
        sisa,
        status: debt.void ? "dibatalkan" : sisa === 0 ? "lunas" : "belum"
    };

}


const text = (value, max) => String(value ?? "").trim().slice(0, max);


/* =====================================================
   OPERASI
   Semua mengembalikan { ok, error?, debt? }.
   ===================================================== */

/*
 * Dipanggil dari /api/submit untuk transaksi ber-pembayaran
 * "Utang". Total dihitung ulang dari item — jangan percaya
 * angka total dari browser untuk catatan utang.
 */

function createFromTransaction(tx, username){

    if(!tx || !ID_PATTERN.test(String(tx.transactionId || ""))){
        return { ok: false, error: "Transaksi tidak valid." };
    }

    const data = load();

    const existing = data.debts.find(d => d.id === tx.transactionId);

    /* Kiriman ulang dari antrean offline: sudah tercatat. */
    if(existing){
        return { ok: true, debt: withTotals(existing), duplicate: true };
    }

    const pelanggan = text(tx.pelanggan, 60);

    if(!pelanggan){
        return { ok: false, error: "Nama pelanggan wajib diisi untuk utang." };
    }

    if(!Array.isArray(tx.items) || tx.items.length === 0 || tx.items.length > 200){
        return { ok: false, error: "Isi pesanan tidak valid." };
    }

    const items = [];

    for(const item of tx.items){

        const qty = Number(item?.qty);
        const harga = Number(item?.harga);
        const nama = text(item?.nama, 120);

        if(!nama || !Number.isInteger(qty) || qty < 1 || qty > 10000 ||
           !Number.isInteger(harga) || harga < 0 || harga > 100_000_000){
            return { ok: false, error: "Item pesanan tidak valid." };
        }

        items.push({ nama, qty, harga, subtotal: qty * harga });

    }

    const total = items.reduce((sum, i) => sum + i.subtotal, 0);

    if(total <= 0){
        return { ok: false, error: "Total utang harus lebih dari 0." };
    }

    const jatuhTempo = String(tx.jatuhTempo || "");

    const debt = {
        id: tx.transactionId,
        nota: text(tx.nota, 20),
        tanggal: text(tx.tanggal, 20),
        jam: text(tx.jam, 10),
        createdAt: new Date().toISOString(),
        createdBy: username,
        pelanggan,
        telepon: text(tx.telepon, 20).replace(/[^\d+\- ]/g, ""),
        catatan: text(tx.catatan, 200),
        jatuhTempo: DATE_PATTERN.test(jatuhTempo) ? jatuhTempo : null,
        items,
        total,
        payments: [],
        void: null
    };

    data.debts.push(debt);

    persist();

    return { ok: true, debt: withTotals(debt) };

}


function list(){

    return load().debts.map(withTotals);

}


function find(id){

    const debt = load().debts.find(d => d.id === id);

    return debt ? withTotals(debt) : null;

}


/*
 * paymentId dibuat browser sekali per form; tap ganda atau
 * kiriman ulang dengan id yang sama tidak dicatat dua kali.
 */

function addPayment(id, input, username){

    const data = load();
    const debt = data.debts.find(d => d.id === id);

    if(!debt){
        return { ok: false, error: "Utang tidak ditemukan." };
    }

    const paymentId = String(input?.paymentId || "");

    if(!ID_PATTERN.test(paymentId)){
        return { ok: false, error: "Permintaan tidak valid." };
    }

    if(debt.payments.some(p => p.id === paymentId)){
        return { ok: true, debt: withTotals(debt), duplicate: true };
    }

    if(debt.void){
        return { ok: false, error: "Utang ini sudah dibatalkan." };
    }

    const { sisa } = withTotals(debt);

    if(sisa === 0){
        return { ok: false, error: "Utang ini sudah lunas." };
    }

    const jumlah = Number(input?.jumlah);

    if(!Number.isInteger(jumlah) || jumlah <= 0 || jumlah > MAX_AMOUNT){
        return { ok: false, error: "Jumlah pembayaran harus angka lebih dari 0." };
    }

    if(jumlah > sisa){
        return { ok: false, error: `Jumlah melebihi sisa utang (sisa Rp${sisa.toLocaleString("id-ID")}).` };
    }

    /* "Transfer" dari halaman versi lama = Transfer BCA. */
    const asked = input?.metode === "Transfer" ? "Transfer BCA" : input?.metode;
    const metode = METHODS.includes(asked) ? asked : null;

    if(!metode){
        return { ok: false, error: "Pilih metode pembayaran: Cash, QRIS, Transfer BCA, atau Debit." };
    }

    debt.payments.push({
        id: paymentId,
        at: new Date().toISOString(),
        jumlah,
        metode,
        oleh: username
    });

    persist();

    return { ok: true, debt: withTotals(debt) };

}


/* Hanya superadmin (dicek di server.js). Tidak dihapus: tetap ada sebagai jejak. */
function voidDebt(id, alasan, username){

    const data = load();
    const debt = data.debts.find(d => d.id === id);

    if(!debt){
        return { ok: false, error: "Utang tidak ditemukan." };
    }

    if(debt.void){
        return { ok: true, debt: withTotals(debt) };
    }

    const reason = text(alasan, 200);

    if(!reason){
        return { ok: false, error: "Tulis alasan pembatalan." };
    }

    debt.void = { at: new Date().toISOString(), oleh: username, alasan: reason };

    persist();

    return { ok: true, debt: withTotals(debt) };

}


module.exports = {
    createFromTransaction,
    list,
    find,
    addPayment,
    voidDebt
};

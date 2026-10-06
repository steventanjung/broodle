/*
 * Setoran kasir (data/shifts.json).
 *
 * Satu setoran = satu sesi kasir: dibuka saat login (uang modal),
 * ditutup saat logout (total Tunai / QRIS / Transfer yang harus
 * dicocokkan kasir). Totalnya dihitung di tablet — termasuk
 * penjualan yang belum terkirim saat offline — lalu dikirim ke
 * sini. Id dibuat tablet, jadi kiriman ulang tidak membuat dobel.
 */

const fs   = require("node:fs");
const path = require("node:path");

const auth = require("./auth.js");


const SHIFT_FILE = path.join(auth.DATA_DIR, "shifts.json");

const ID_PATTERN = /^[\w.-]{6,80}$/;
const TOTAL_KEYS = ["cash", "qris", "transfer", "debit", "grab", "utang", "cashPay", "qrisPay", "transferPay", "debitPay", "count"];
const MAX_AMOUNT = 10_000_000_000;


let cache = null;
let cacheMtime = 0;

const fileMtime = () => {
    try{ return fs.statSync(SHIFT_FILE).mtimeMs; }catch(e){ return 0; }
};


function load(){

    if(cache && fileMtime() === cacheMtime){
        return cache;
    }

    try{

        const parsed = JSON.parse(fs.readFileSync(SHIFT_FILE, "utf8"));
        cache = { shifts: Array.isArray(parsed.shifts) ? parsed.shifts : [] };

    }catch(error){

        if(error.code !== "ENOENT"){
            throw new Error("shifts.json tidak bisa dibaca: " + error.message);
        }

        cache = { shifts: [] };

    }

    cacheMtime = fileMtime();

    return cache;

}


function persist(){

    const tmp = SHIFT_FILE + ".tmp";

    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, SHIFT_FILE);

    cacheMtime = fileMtime();

}


const isDate = value => typeof value === "string" && !isNaN(Date.parse(value));


/*
 * Simpan / perbarui satu setoran. Setoran yang sudah ditutup
 * tidak bisa diubah lagi (kiriman ulang diabaikan).
 */

function upsert(input, sessionUser){

    const id = String(input?.id || "");

    if(!ID_PATTERN.test(id)){
        return { ok: false, error: "Setoran tidak valid." };
    }

    const data = load();
    const existing = data.shifts.find(s => s.id === id);

    if(existing?.closedAt){
        return { ok: true, shift: existing };
    }

    const modal = Number(input.modal);

    if(!Number.isInteger(modal) || modal < 0 || modal > MAX_AMOUNT){
        return { ok: false, error: "Uang modal tidak valid." };
    }

    if(!isDate(input.openedAt)){
        return { ok: false, error: "Waktu buka tidak valid." };
    }

    const totals = {};

    for(const key of TOTAL_KEYS){

        const n = Number(input.totals?.[key] ?? 0);

        if(!Number.isInteger(n) || n < 0 || n > MAX_AMOUNT){
            return { ok: false, error: "Total setoran tidak valid." };
        }

        totals[key] = n;

    }

    /* Nama kasir dari tablet (setoran bisa dikirim belakangan oleh login berikutnya), harus akun yang ada. */
    const kasir = existing?.kasir ||
        (auth.findUser(input.kasir) ? auth.findUser(input.kasir).username : sessionUser);

    const shift = {
        id,
        kasir,
        openedAt: input.openedAt,
        modal,
        totals,
        closedAt: isDate(input.closedAt) ? input.closedAt : null,
        closedBy: isDate(input.closedAt) ? sessionUser : null,
        updatedAt: new Date().toISOString()
    };

    if(existing){
        Object.assign(existing, shift);
    }else{
        data.shifts.push(shift);
    }

    persist();

    return { ok: true, shift };

}


/* Setoran yang dibuka di rentang tanggal toko (WIB), terbaru dulu. */
function list(from, to){

    const day = iso => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });

    return load().shifts
        .filter(s => { const d = day(s.openedAt); return (!from || d >= from) && (!to || d <= to); })
        .sort((a, b) => b.openedAt.localeCompare(a.openedAt));

}


module.exports = { upsert, list };

/*
 * Cadangan data (tab Pengaturan, superadmin).
 *
 * Satu file JSON berisi semua isi DATA_DIR (akun, menu, utang,
 * setoran, pengaturan) plus foto produk. Penjualan tidak ikut:
 * sudah ada di Google Sheets.
 *
 * Sebelum dipulihkan, data yang sedang dipakai disimpan dulu ke
 * DATA_DIR/backups/ (3 terakhir) supaya salah pulihkan bisa dibatalkan.
 */

const fs   = require("node:fs");
const path = require("node:path");

const { DATA_DIR, ROLES } = require("./auth.js");


const FORMAT  = "broodle-backup";
const VERSION = 1;

const FILES = ["users.json", "menus.json", "debts.json", "shifts.json", "settings.json"];

const PHOTO_NAME = /^[\w-]{1,80}\.jpg$/;
const SAFETY_DIR = path.join(DATA_DIR, "backups");
const KEEP_SAFETY = 3;

const isObject = v => !!v && typeof v === "object" && !Array.isArray(v);


function readData(){

    const data = {};

    for(const name of FILES){
        try{
            data[name] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8"));
        }catch(error){
            /* Belum pernah dibuat (mis. belum ada utang): tidak ikut. */
        }
    }

    return data;

}


function create(productDir, { photos = true } = {}){

    const backup = { format: FORMAT, version: VERSION, createdAt: new Date().toISOString(), data: readData(), photos: {} };

    if(photos){
        for(const name of safeList(productDir)){
            backup.photos[name] = fs.readFileSync(path.join(productDir, name)).toString("base64");
        }
    }

    return backup;

}


const safeList = dir => {
    try{ return fs.readdirSync(dir).filter(n => PHOTO_NAME.test(n)); }catch(e){ return []; }
};


/* Ringkasan untuk ditampilkan sebelum memulihkan. */
function summarize(data){

    return {
        akun:    data["users.json"]?.users?.length ?? 0,
        produk:  data["menus.json"]?.menus?.length ?? 0,
        utang:   data["debts.json"]?.debts?.length ?? 0,
        setoran: data["shifts.json"]?.shifts?.length ?? 0
    };

}


function validate(backup){

    if(!isObject(backup) || backup.format !== FORMAT){
        return "File ini bukan cadangan Broodle.";
    }

    if(backup.version > VERSION){
        return "Cadangan ini dibuat versi aplikasi yang lebih baru. Perbarui aplikasi dulu.";
    }

    if(!isObject(backup.data)){
        return "Isi cadangan rusak.";
    }

    for(const [name, value] of Object.entries(backup.data)){
        if(!FILES.includes(name) || !isObject(value)){
            return "Isi cadangan rusak.";
        }
    }

    /* Tanpa akun superadmin, tidak ada yang bisa masuk ke tab ini lagi. */
    const users = backup.data["users.json"]?.users;

    if(!Array.isArray(users) || !users.some(u => isObject(u) && u.role === "superadmin" && u.username && ROLES.includes(u.role))){
        return "Cadangan tidak berisi akun superadmin, tidak bisa dipulihkan.";
    }

    for(const [name, b64] of Object.entries(backup.photos || {})){
        if(!PHOTO_NAME.test(name) || typeof b64 !== "string"){
            return "Foto di cadangan rusak.";
        }
    }

    return null;

}


const writeAtomic = (file, text) => {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
};


function saveSafetyCopy(productDir){

    fs.mkdirSync(SAFETY_DIR, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(SAFETY_DIR, `sebelum-pulihkan-${stamp}.json`);

    writeAtomic(file, JSON.stringify(create(productDir)));

    fs.readdirSync(SAFETY_DIR)
        .filter(n => n.startsWith("sebelum-pulihkan-"))
        .sort()
        .slice(0, -KEEP_SAFETY)
        .forEach(n => fs.rmSync(path.join(SAFETY_DIR, n), { force: true }));

    return path.relative(DATA_DIR, file);

}


/*
 * Pulihkan: file data diganti isi cadangan. File yang tidak ada
 * di cadangan dibiarkan. Foto ditulis ulang; foto lain tidak dihapus.
 */
function restore(backup, productDir){

    const error = validate(backup);

    if(error){
        return { ok: false, error };
    }

    const safety = saveSafetyCopy(productDir);

    for(const [name, value] of Object.entries(backup.data)){
        writeAtomic(path.join(DATA_DIR, name), JSON.stringify(value, null, 2) + "\n");
    }

    fs.mkdirSync(productDir, { recursive: true });

    let photos = 0;

    for(const [name, b64] of Object.entries(backup.photos || {})){

        const buf = Buffer.from(b64, "base64");

        /* Hanya JPEG asli (FF D8 FF). */
        if(buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF){
            fs.writeFileSync(path.join(productDir, name), buf);
            photos += 1;
        }

    }

    return { ok: true, summary: { ...summarize(backup.data), foto: photos }, safety };

}


module.exports = { create, restore, summarize, validate };

/*
 * Penyimpanan menu di server (data/menus.json).
 *
 * Dulu menu disimpan di localStorage tiap browser,
 * jadi perubahan dari Kelola Menu tidak pernah sampai
 * ke tablet kasir lain. Sekarang server jadi satu-satunya
 * sumber data; browser kasir cuma menyimpan salinan
 * untuk dipakai saat offline.
 */

const crypto = require("node:crypto");
const fs     = require("node:fs");
const path   = require("node:path");

const { DATA_DIR } = require("./auth.js");


const MENU_FILE = path.join(DATA_DIR, "menus.json");


/*
 * Isi awal saat menus.json belum ada. Foto 1-11
 * di public/images mengikuti urutan ini.
 */

const DEFAULT_MENUS = [
    ["Cheesecake A",           40000, "Cheesecake", true ],
    ["Cheesecake B",           55000, "Cheesecake", true ],
    ["Dubai Chewy Cookie",     50000, "Dubai",      true ],
    ["Strawberry Dubai Choco", 95000, "Dubai",      true ],
    ["London Choco Cake",      55000, "Choco",      false],
    ["Mooncake Pudding",       40000, "Snack",      true ],
    ["Milk Cheese Bread",      25000, "Snack",      false],
    ["Bakwan Goreng",          40000, "Snack",      true ],
    ["Scoopable Kunafa",       55000, "Dubai",      true ],
    ["Scoopable Nutella",      40000, "Choco",      true ],
    ["Risol",                  30000, "Snack",      false],
    ["Bagia Ori / Mocha",      35000, "Bagia",      false],
    ["Bagia Kacang",           45000, "Bagia",      false],
    ["Lain-lain",              15000, "Snack",      true ]
].map(([nama, harga, kategori, unggulan], i) => ({
    id: crypto.randomUUID(),
    nama,
    harga,
    kategori,
    unggulan,
    hargaKustom: false,
    gambar: i < 11 ? `/images/${i + 1}.jpg` : null
}));


let cache = null;


function load(){

    if(cache){
        return cache;
    }

    try{

        const parsed =
            JSON.parse(fs.readFileSync(MENU_FILE, "utf8"));

        if(Array.isArray(parsed.menus)){
            cache = parsed;
            return cache;
        }

    }catch(error){

        if(error.code !== "ENOENT"){
            console.error("menus.json tidak bisa dibaca:", error.message);
        }

    }

    cache = { menus: DEFAULT_MENUS, updatedAt: Date.now() };

    persist();

    return cache;

}


/*
 * Tulis ke file sementara lalu rename: kalau server
 * mati di tengah penulisan, menus.json lama tetap utuh.
 */

function persist(){

    cache.updatedAt = Date.now();

    const tmp = MENU_FILE + ".tmp";

    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n");

    fs.renameSync(tmp, MENU_FILE);

}


/* =====================================================
   VALIDASI
   -----------------------------------------------------
   Jangan percaya isi dari browser: semua field dicek
   dan dinormalisasi di sini sebelum disimpan.
   ===================================================== */

const IMAGE_PATTERN =
    /^\/(images\/\d+\.jpg|uploads\/products\/[a-zA-Z0-9_-]+\.jpg(\?v=\d+)?)$/;


function sanitize(input, existing){

    const base = existing || {};
    const src  = input || {};

    const nama =
        String(src.nama ?? base.nama ?? "").trim().slice(0, 60);

    const kategori =
        String(src.kategori ?? base.kategori ?? "").trim().slice(0, 30) ||
        "Lainnya";

    const harga =
        Number(src.harga ?? base.harga ?? 0);

    if(!nama){
        return { error: "Nama produk wajib diisi." };
    }

    if(!Number.isInteger(harga) || harga < 0 || harga > 100_000_000){
        return { error: "Harga harus angka bulat 0 atau lebih." };
    }

    const hargaKustom = Boolean(src.hargaKustom ?? base.hargaKustom);

    if(!hargaKustom && harga === 0){
        return { error: "Isi harga, atau aktifkan harga custom." };
    }

    const gambar = src.gambar !== undefined ? src.gambar : base.gambar;

    return {
        value: {
            id: base.id || crypto.randomUUID(),
            nama,
            harga,
            kategori,
            unggulan: Boolean(src.unggulan ?? base.unggulan),
            hargaKustom,
            gambar:
                typeof gambar === "string" && IMAGE_PATTERN.test(gambar)
                    ? gambar
                    : null
        }
    };

}


/* =====================================================
   OPERASI
   Semua mengembalikan { ok, error?, menu? }.
   ===================================================== */

function list(){

    return load();

}


function find(id){

    return load().menus.find(m => m.id === id) || null;

}


function create(input){

    const result = sanitize(input, null);

    if(result.error){
        return { ok: false, error: result.error };
    }

    load().menus.push(result.value);

    persist();

    return { ok: true, menu: result.value };

}


function update(id, input){

    const data  = load();
    const index = data.menus.findIndex(m => m.id === id);

    if(index < 0){
        return { ok: false, error: "Produk tidak ditemukan." };
    }

    const result = sanitize(input, data.menus[index]);

    if(result.error){
        return { ok: false, error: result.error };
    }

    data.menus[index] = result.value;

    persist();

    return { ok: true, menu: result.value };

}


function remove(id){

    const data   = load();
    const before = data.menus.length;

    data.menus = data.menus.filter(m => m.id !== id);

    if(data.menus.length === before){
        return { ok: false, error: "Produk tidak ditemukan." };
    }

    persist();

    return { ok: true };

}


module.exports = {
    list,
    find,
    create,
    update,
    remove
};

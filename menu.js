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
let cacheMtime = 0;


/*
 * Cache di memori, tapi dibaca ulang kalau menus.json
 * berubah di disk (mis. seeder dijalankan saat server
 * hidup) — kalau tidak, edit admin berikutnya akan
 * menimpa data seeder.
 */

function fileMtime(){

    try{
        return fs.statSync(MENU_FILE).mtimeMs;
    }catch(error){
        return 0;
    }

}


function load(){

    if(cache && fileMtime() === cacheMtime){
        return cache;
    }

    try{

        const parsed =
            JSON.parse(fs.readFileSync(MENU_FILE, "utf8"));

        if(Array.isArray(parsed.menus)){

            /* Produk lama (sebelum ada varian) dapat nilai awal. */
            parsed.menus.forEach(m => {
                m.adaVarian = Boolean(m.adaVarian);
                m.varian = Array.isArray(m.varian) ? m.varian : [];
            });

            cache = parsed;
            ensureCategories(cache);
            cacheMtime = fileMtime();
            return cache;

        }

    }catch(error){

        if(error.code !== "ENOENT"){
            console.error("menus.json tidak bisa dibaca:", error.message);
        }

    }

    cache = { menus: DEFAULT_MENUS, updatedAt: Date.now() };

    ensureCategories(cache);

    persist();

    return cache;

}


/*
 * Kategori berdiri sendiri (boleh kosong tanpa produk), urutannya =
 * urutan tombol di kasir. Data lama (kategori hanya ada di produk,
 * atau "categoryOrder" versi sebelumnya) diubah otomatis di sini.
 */

function ensureCategories(data){

    const list = Array.isArray(data.categories) ? data.categories
        : Array.isArray(data.categoryOrder) ? data.categoryOrder
        : [];

    data.categories = [...new Set(list)];

    data.menus.forEach(m => addCategory(data, m.kategori));

    delete data.categoryOrder;

}


/* Tambah kategori kalau belum ada (tidak peka huruf besar/kecil); kembalikan ejaan yang tersimpan. */
function addCategory(data, name){

    const found = data.categories.find(c => c.toLowerCase() === String(name).toLowerCase());

    if(found){
        return found;
    }

    data.categories.push(name);

    return name;

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

    cacheMtime = fileMtime();

}


/* =====================================================
   VALIDASI
   -----------------------------------------------------
   Jangan percaya isi dari browser: semua field dicek
   dan dinormalisasi di sini sebelum disimpan.
   ===================================================== */

const IMAGE_PATTERN =
    /^\/(images\/\d+\.jpg|uploads\/products\/[a-zA-Z0-9_-]+\.jpg(\?v=\d+)?)$/;


/* Harga Grab opsional: kosong / 0 = belum diisi (null). */
function grabPrice(value, label){

    if(value === undefined || value === null || value === "" || Number(value) === 0){
        return { value: null };
    }

    const n = Number(value);

    if(!Number.isInteger(n) || n < 0 || n > 100_000_000){
        return { error: `Harga Grab ${label} harus angka bulat.` };
    }

    return { value: n };

}


const MAX_VARIANTS = 30;

const VARIANT_ID_PATTERN = /^[\w-]{4,40}$/;


/*
 * Varian: tiap varian punya nama & harga sendiri
 * (mis. Cheesecake -> Blueberry 45.000, Strawberry 48.000).
 * Id varian dipertahankan kalau valid, supaya penjualan
 * lama dan edit berikutnya tetap menunjuk varian yang sama.
 */

function sanitizeVariants(list){

    if(!Array.isArray(list)){
        return { value: [] };
    }

    if(list.length > MAX_VARIANTS){
        return { error: `Maksimal ${MAX_VARIANTS} varian per produk.` };
    }

    const seen = new Set();
    const out = [];

    for(const item of list){

        const nama = String(item?.nama ?? "").trim().slice(0, 40);
        const harga = Number(item?.harga);

        if(!nama){
            return { error: "Nama varian wajib diisi." };
        }

        if(!Number.isInteger(harga) || harga <= 0 || harga > 100_000_000){
            return { error: `Harga varian "${nama}" harus angka bulat lebih dari 0.` };
        }

        const grab = grabPrice(item?.hargaGrab, `varian "${nama}"`);

        if(grab.error){
            return { error: grab.error };
        }

        const key = nama.toLowerCase();

        if(seen.has(key)){
            return { error: `Nama varian "${nama}" dobel.` };
        }

        seen.add(key);

        out.push({
            id: VARIANT_ID_PATTERN.test(String(item.id || "")) ? item.id : crypto.randomUUID(),
            nama,
            harga,
            hargaGrab: grab.value
        });

    }

    return { value: out };

}


function sanitize(input, existing){

    const base = existing || {};
    const src  = input || {};

    const nama =
        String(src.nama ?? base.nama ?? "").trim().slice(0, 60);

    const kategori =
        String(src.kategori ?? base.kategori ?? "").trim().slice(0, 30) ||
        "Lainnya";

    if(!nama){
        return { error: "Nama produk wajib diisi." };
    }

    /*
     * Daftar varian tetap disimpan walau saklar dimatikan,
     * jadi menyalakan lagi tidak perlu mengetik ulang.
     */

    const variants = sanitizeVariants(src.varian ?? base.varian ?? []);

    if(variants.error){
        return { error: variants.error };
    }

    const adaVarian = Boolean(src.adaVarian ?? base.adaVarian);

    if(adaVarian && variants.value.length === 0){
        return { error: "Tambahkan minimal 1 varian, atau matikan varian." };
    }

    /* Varian dan harga custom tidak dipakai bersamaan. */
    const hargaKustom =
        !adaVarian && Boolean(src.hargaKustom ?? base.hargaKustom);

    /* Produk bervarian: "harga" = varian termurah, dipakai untuk tampilan "mulai dari". */
    const harga =
        adaVarian
            ? Math.min(...variants.value.map(v => v.harga))
            : Number(src.harga ?? base.harga ?? 0);

    if(!Number.isInteger(harga) || harga < 0 || harga > 100_000_000){
        return { error: "Harga harus angka bulat 0 atau lebih." };
    }

    if(!adaVarian && !hargaKustom && harga === 0){
        return { error: "Isi harga, atau aktifkan harga custom atau varian." };
    }

    const grab = grabPrice(src.hargaGrab !== undefined ? src.hargaGrab : base.hargaGrab, "produk");

    if(grab.error){
        return { error: grab.error };
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
            hargaGrab: adaVarian ? null : grab.value,
            adaVarian,
            varian: variants.value,
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

    const data = load();

    result.value.kategori = addCategory(data, result.value.kategori);

    data.menus.push(result.value);

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

    result.value.kategori = addCategory(data, result.value.kategori);

    data.menus[index] = result.value;

    persist();

    return { ok: true, menu: result.value };

}


/*
 * Pindahkan produk dengan id-id ini ke paling depan sesuai
 * urutan yang diberikan; produk lain tetap di belakang dengan
 * urutan semula (sort stabil). Dipakai seeder supaya urutan
 * menu selalu sama di tiap server.
 */

/*
 * Kelola kategori sekaligus (dari dialog Kategori):
 *   { from: "Snack", to: "Cemilan" }  ganti nama, semua produk ikut
 *   { from: "Choco", to: "Dubai" }    sama dengan kategori lain = digabung
 *   { from: null, to: "Minuman" }     kategori baru (boleh tanpa produk)
 *   kategori lama yang tidak dikirim  = dihapus, hanya kalau kosong
 * Urutan daftar = urutan tombol kategori di kasir.
 */

function saveCategories(input){

    if(!Array.isArray(input) || input.length > 100){
        return { ok: false, error: "Daftar kategori tidak valid." };
    }

    const data = load();
    const renames = new Map();
    const order = [];

    for(const item of input){

        const from = item?.from == null ? null : String(item.from);
        const to = String(item?.to ?? "").trim().slice(0, 30);

        if(from !== null && !data.categories.includes(from)){
            return { ok: false, error: `Kategori "${from}" tidak ditemukan. Muat ulang halaman.` };
        }

        if(!to){
            return { ok: false, error: "Nama kategori tidak boleh kosong." };
        }

        if(from !== null){
            renames.set(from, to);
        }

        if(!order.some(o => o.toLowerCase() === to.toLowerCase())){
            order.push(to);
        }

    }

    const removed = data.categories.filter(c => !renames.has(c));
    const stillUsed = removed.find(c => data.menus.some(m => m.kategori === c));

    if(stillUsed){
        const count = data.menus.filter(m => m.kategori === stillUsed).length;
        return { ok: false, error: `Kategori "${stillUsed}" masih dipakai ${count} produk. Pindahkan atau gabungkan dulu.` };
    }

    if(order.length === 0){
        return { ok: false, error: "Minimal harus ada satu kategori." };
    }

    /* Penggabungan tidak peka huruf besar/kecil: pakai ejaan yang tampil pertama. */
    const canonical = name => order.find(o => o.toLowerCase() === name.toLowerCase()) || name;

    data.menus.forEach(m => {
        if(renames.has(m.kategori)){
            m.kategori = canonical(renames.get(m.kategori));
        }
    });

    data.categories = order;

    persist();

    return { ok: true, data };

}


function reorder(ids){

    const data = load();
    const rank = new Map(ids.map((id, i) => [id, i]));

    data.menus.sort((a, b) =>
        (rank.has(a.id) ? rank.get(a.id) : Infinity) -
        (rank.has(b.id) ? rank.get(b.id) : Infinity) || 0);

    persist();

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
    reorder,
    saveCategories,
    remove
};

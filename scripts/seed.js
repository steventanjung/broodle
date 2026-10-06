#!/usr/bin/env node

/*
 * Jalankan seeder produk (scripts/seeds/*.js).
 *
 *   npm run seed                    semua produk
 *   npm run seed -- cheesecake      satu seeder saja (nama file tanpa angka)
 *   npm run seed -- --remove-old    + hapus produk lama yang
 *                                   digantikan varian (Cheesecake A/B,
 *                                   Scoopable Kunafa/Nutella)
 *
 * Seeder tersedia: cheesecake, scoopable, produk-lain.
 *
 * Aman dijalankan berulang kali: produk dicocokkan lewat
 * nama (tanpa peduli huruf besar/kecil). Kalau sudah ada,
 * datanya diperbarui dan foto yang sudah diupload dipertahankan;
 * kalau belum, produk dibuat. Produk yang tidak ada di seeder
 * tidak disentuh. Produk hasil seeder ditaruh paling depan di
 * menu sesuai urutan file (angka di depan nama file).
 *
 * Boleh dijalankan saat server hidup (server membaca ulang
 * menus.json kalau berubah).
 */

const fs   = require("node:fs");
const path = require("node:path");

/* Pakai DATA_DIR yang sama dengan server. */
const envFile = path.join(__dirname, "..", ".env");
if(fs.existsSync(envFile)){
    process.loadEnvFile(envFile);
}

const menu = require("../menu.js");


/* Produk lama yang digantikan seeder (dihapus hanya dengan --remove-old). */
const REPLACED = {
    cheesecake: ["Cheesecake A", "Cheesecake B"],
    scoopable:  ["Scoopable Kunafa", "Scoopable Nutella"]
};


const args = process.argv.slice(2);
const removeOld = args.includes("--remove-old");
const wanted = args.filter(a => !a.startsWith("--"));

const seedDir = path.join(__dirname, "seeds");

/* "01-cheesecake.js" -> { name: "cheesecake", file } ; urut menurut file. */
const seeders = fs.readdirSync(seedDir)
    .filter(f => f.endsWith(".js"))
    .sort()
    .map(file => ({ file, name: file.replace(/\.js$/, "").replace(/^\d+-/, "") }));

const selected = seeders.filter(s => wanted.length === 0 || wanted.includes(s.name));

if(selected.length === 0){
    console.error("Seeder tidak ditemukan. Tersedia: " + seeders.map(s => s.name).join(", "));
    process.exit(1);
}


const findByName = nama =>
    menu.list().menus.find(m => m.nama.toLowerCase() === nama.toLowerCase());

const rupiah = n => "Rp" + n.toLocaleString("id-ID");


let failed = false;
let created = 0;
let updated = 0;

const order = [];

for(const { file, name } of selected){

    const exported = require(path.join(seedDir, file));
    const products = Array.isArray(exported) ? exported : [exported];

    for(const seed of products){

        const existing = findByName(seed.nama);

        const data = { ...seed };

        /* Sudah ada: jangan timpa foto & harga Grab yang diisi admin. */
        if(existing){

            data.gambar = existing.gambar || seed.gambar;

            if(seed.hargaGrab === undefined){
                data.hargaGrab = existing.hargaGrab;
            }

            if(Array.isArray(seed.varian)){
                data.varian = seed.varian.map(v => {
                    const old = existing.varian?.find(o => o.id === v.id || o.nama.toLowerCase() === v.nama.toLowerCase());
                    return v.hargaGrab === undefined && old?.hargaGrab ? { ...v, hargaGrab: old.hargaGrab } : v;
                });
            }

        }

        const result = existing
            ? menu.update(existing.id, data)
            : menu.create(data);

        if(!result.ok){
            console.error(`[${name}] ${seed.nama}: gagal, ${result.error}`);
            failed = true;
            continue;
        }

        order.push(result.menu.id);

        existing ? updated++ : created++;

        const m = result.menu;

        const detail =
            m.adaVarian
                ? `${m.varian.length} varian (${[...new Set(m.varian.map(v => v.harga))].sort((a, b) => a - b).map(rupiah).join(", ")})`
                : m.hargaKustom
                    ? `harga custom (saran ${rupiah(m.harga)})`
                    : rupiah(m.harga);

        console.log(`[${name}] ${existing ? "diperbarui" : "dibuat    "} ${m.nama}: ${detail}`);

    }

    if(removeOld){

        for(const old of REPLACED[name] || []){

            const target = findByName(old);

            if(target && menu.remove(target.id).ok){
                console.log(`[${name}] produk lama dihapus: ${old}`);
            }

        }

    }

}

menu.reorder(order);

console.log(`\nSelesai: ${created} dibuat, ${updated} diperbarui, ${menu.list().menus.length} produk di menu.`);

process.exit(failed ? 1 : 0);

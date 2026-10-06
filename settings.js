/*
 * Pengaturan toko (data/settings.json), diubah superadmin di tab
 * Pengaturan. Setiap pengaturan didefinisikan sekali di SCHEMA —
 * menambah pengaturan baru cukup menambah satu entri di sini dan
 * satu di SETTINGS (public/assets/admin.js).
 */

const fs   = require("node:fs");
const path = require("node:path");

const { DATA_DIR } = require("./auth.js");


const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const SCHEMA = {
    /* Grab mengambil sekian persen dari harga Grab; sisanya yang tercatat sebagai penjualan. */
    grabCommission: { type: "number", default: 20, min: 0, max: 99, decimals: 1, label: "Potongan Grab" }
};

const DEFAULTS = Object.fromEntries(Object.entries(SCHEMA).map(([key, def]) => [key, def.default]));


function get(){

    try{

        const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));

        /* Hanya kunci yang dikenal; sisanya diabaikan. */
        return Object.fromEntries(Object.keys(SCHEMA).map(key => [key, key in saved ? saved[key] : DEFAULTS[key]]));

    }catch(error){

        return { ...DEFAULTS };

    }

}


/* Simpan sebagian atau semua pengaturan; kunci yang tidak dikirim tetap. */
function update(input){

    const next = get();

    for(const [key, value] of Object.entries(input || {})){

        const def = SCHEMA[key];

        if(!def){
            return { ok: false, error: `Pengaturan "${key}" tidak dikenal.` };
        }

        if(def.type === "number"){

            const n = Number(value);

            if(!Number.isFinite(n) || n < def.min || n > def.max){
                return { ok: false, error: `${def.label} harus angka ${def.min} sampai ${def.max}.` };
            }

            const factor = 10 ** (def.decimals || 0);
            next[key] = Math.round(n * factor) / factor;

        }

    }

    const tmp = SETTINGS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    fs.renameSync(tmp, SETTINGS_FILE);

    return { ok: true, settings: next };

}


module.exports = { get, update };

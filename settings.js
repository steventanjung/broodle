/*
 * Pengaturan toko (data/settings.json), diubah superadmin di tab
 * Pengaturan. Sekarang: potongan Grab (%).
 */

const fs   = require("node:fs");
const path = require("node:path");

const { DATA_DIR } = require("./auth.js");


const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const DEFAULTS = {
    /* Grab mengambil sekian persen dari harga Grab; sisanya yang tercatat sebagai penjualan. */
    grabCommission: 20
};


function get(){

    try{
        return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
    }catch(error){
        return { ...DEFAULTS };
    }

}


function update(input){

    const current = get();
    const pct = Number(input?.grabCommission);

    if(!Number.isFinite(pct) || pct < 0 || pct >= 100){
        return { ok: false, error: "Potongan Grab harus angka 0 sampai 99." };
    }

    /* Satu angka di belakang koma cukup (mis. 20 atau 22,5). */
    const next = { ...current, grabCommission: Math.round(pct * 10) / 10 };

    const tmp = SETTINGS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    fs.renameSync(tmp, SETTINGS_FILE);

    return { ok: true, settings: next };

}


module.exports = { get, update };

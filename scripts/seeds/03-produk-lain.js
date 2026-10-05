/*
 * Seeder: semua produk lain (tanpa varian).
 *
 * Foto 3-8 dan 11 ada di public/images. Produk tanpa foto
 * (Bagia, Lain-lain, Snack Box) mendapat foto lewat tab Menu —
 * foto hasil upload tersimpan di server, bukan di git, jadi
 * tidak bisa ikut di-seed.
 *
 * File ini mengekspor array; seeder lain mengekspor satu produk.
 */

const produk = (nama, harga, kategori, unggulan, gambar, extra = {}) => ({
    nama, harga, kategori, unggulan,
    adaVarian: false,
    hargaKustom: false,
    gambar: gambar || undefined,
    ...extra
});

module.exports = [
    produk("Dubai Chewy Cookie",     50000, "Dubai", true,  "/images/3.jpg"),
    produk("Strawberry Dubai Choco", 95000, "Dubai", true,  "/images/4.jpg"),
    produk("London Choco Cake",      55000, "Choco", false, "/images/5.jpg"),
    produk("Mooncake Pudding",       40000, "Snack", true,  "/images/6.jpg"),
    produk("Milk Cheese Bread",      25000, "Snack", false, "/images/7.jpg"),
    produk("Bakwan Goreng",          40000, "Snack", true,  "/images/8.jpg"),
    produk("Risol",                  30000, "Snack", false, "/images/11.jpg"),
    produk("Bagia Ori / Mocha",      35000, "Bagia", false),
    produk("Bagia Kacang",           45000, "Bagia", false),
    produk("Lain-lain",              15000, "Snack", true),

    /* Harga custom: harga di sini hanya saran awal, kasir mengisi harga tiap jual. */
    produk("Snack Box",              25000, "Snack", false, null, { hargaKustom: true })
];

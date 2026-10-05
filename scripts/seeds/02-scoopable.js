/*
 * Seeder: produk Scoopable dengan 4 varian.
 * Lihat cheesecake.js untuk cara kerja id tetap.
 */

const slug = text => "scoopable-" + text.toLowerCase().replace(/[^a-z0-9]+/g, "-");

const varian = [
    ["Nutella", 40000],
    ["Biscoff", 40000],
    ["Smores",  40000],
    ["Kunafa",  55000]
].map(([nama, harga]) => ({ id: slug(nama), nama, harga }));

module.exports = {
    nama: "Scoopable",
    kategori: "Scoopable",
    unggulan: true,
    adaVarian: true,
    hargaKustom: false,
    gambar: "/images/10.jpg",
    varian
};

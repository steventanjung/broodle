/*
 * Seeder: produk Cheesecake dengan 10 varian.
 *
 * Id varian dibuat tetap (slug), jadi menjalankan seeder
 * berulang kali tidak mengganti id dan tidak menggandakan
 * produk — hanya memperbarui nama & harga.
 */

const slug = text => "cheesecake-" + text.toLowerCase().replace(/[^a-z0-9]+/g, "-");

const varian = [
    ["Ubee Burnt",      40000],
    ["Matcha Burnt",    40000],
    ["Burnt Brownies",  40000],
    ["Iceberg",         40000],
    ["Ovomaltine",      40000],
    ["Blueberry",       40000],
    ["Strawberry",      40000],
    ["Nutella",         40000],
    ["Dubai Burnt",     55000],
    ["London Burnt",    55000]
].map(([nama, harga]) => ({ id: slug(nama), nama, harga }));

module.exports = {
    nama: "Cheesecake",
    kategori: "Cheesecake",
    unggulan: true,
    adaVarian: true,
    hargaKustom: false,
    gambar: "/images/1.jpg",
    varian
};

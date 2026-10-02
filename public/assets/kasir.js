/* =====================================================
   KASIR
   ===================================================== */

(() => {

    const { $, $$, isTouchDevice, icon, escapeHtml, rupiah, parseNumber, numberFmt, api, toast } = App;

    const PRINTER_URL = "http://localhost:9100/print";


    /* =================================================
       STATE
       ================================================= */

    /*
     * Keranjang: key -> baris.
     *
     * Baris menyimpan SALINAN nama & harga saat dipilih,
     * bukan index ke array menu. Jadi kalau admin mengubah
     * atau menghapus menu saat keranjang terisi, pesanan
     * yang sedang berjalan tidak ikut bergeser.
     *
     * key = id produk, atau "id:harga" untuk harga custom
     * (satu produk bisa punya beberapa harga dalam satu
     * pesanan, mis. isi box beda-beda).
     */
    const cart = new Map();

    /* null = belum dipilih kasir: otomatis Best Seller kalau ada. */
    let category = null;
    let query = "";
    let payment = "cash";

    let processing = false;

    /*
     * Transaksi yang SUDAH tercatat tapi gagal dicetak.
     * Cetak ulang memakai objek yang sama, supaya tidak
     * ada baris kedua di Google Sheets.
     */
    let awaitingReprint = null;

    let nota = parseInt(localStorage.getItem("nota"), 10) || 1;


    /* =================================================
       ANTREAN TRANSAKSI OFFLINE
       Kunci localStorage sama dengan versi lama, supaya
       transaksi yang masih tertunda tidak hilang.
       ================================================= */

    let pending = [];

    try{
        const saved = JSON.parse(localStorage.getItem("pendingTransactions"));
        pending = Array.isArray(saved) ? saved : [];
    }catch(e){}

    const savePending = () =>
        localStorage.setItem("pendingTransactions", JSON.stringify(pending));

    let syncing = false;
    let sessionExpiredNotified = false;


    async function syncPending(){

        renderStatus();

        if(syncing || !navigator.onLine || pending.length === 0){
            return;
        }

        syncing = true;

        try{

            /* Ambil yang pertama, hapus HANYA setelah berhasil terkirim. */
            while(navigator.onLine && pending.length > 0){

                const response = await fetch("/api/submit", {
                    method: "POST",
                    headers: { "Content-Type": "text/plain;charset=utf-8" },
                    body: JSON.stringify(pending[0])
                });

                if(response.status === 401){

                    if(!sessionExpiredNotified){
                        sessionExpiredNotified = true;
                        toast(`Sesi habis. ${pending.length} transaksi tersimpan dan terkirim setelah login lagi.`, "error");
                    }

                    break;

                }

                if(!response.ok){
                    throw new Error("Upload ke Google Sheets gagal (" + response.status + ")");
                }

                pending.shift();
                savePending();
                renderStatus();

            }

        }catch(error){

            console.error("Sync gagal:", error);

        }finally{

            syncing = false;
            renderStatus();

        }

    }

    window.addEventListener("online", syncPending);
    window.addEventListener("offline", renderStatus);


    function renderStatus(){

        const net = $("#netStatus");

        net.className = "status " + (navigator.onLine ? "status-ok" : "status-off");
        net.innerHTML = icon(navigator.onLine ? "wifi" : "wifi-off", "i-sm") +
            `<span class="hide-sm">${navigator.onLine ? "Online" : "Offline"}</span>`;

        const btn = $("#pendingStatus");

        btn.hidden = pending.length === 0;
        btn.innerHTML = icon("upload", "i-sm") +
            `<span>${pending.length}<span class="hide-sm"> belum terkirim</span></span>`;
        btn.title = "Coba kirim ulang ke Google Sheets";

    }


    /* =================================================
       KATALOG
       ================================================= */

    function visibleMenus(active){

        const q = query.trim().toLowerCase();

        return App.menus.filter(m => {

            if(q){
                return m.nama.toLowerCase().includes(q);
            }

            if(active === "__unggulan"){
                return m.unggulan;
            }

            return active === "__semua" || m.kategori === active;

        });

    }


    function renderCategories(){

        const hasFeatured = App.menus.some(m => m.unggulan);
        const cats = App.categories();

        const valid =
            category === "__semua" ||
            (category === "__unggulan" && hasFeatured) ||
            cats.includes(category);

        const active = valid ? category : (hasFeatured ? "__unggulan" : "__semua");

        const chips = [
            hasFeatured && ["__unggulan", icon("star", "i-sm i-fill") + "Best Seller"],
            ...cats.map(c => [c, escapeHtml(c)]),
            ["__semua", "Semua"]
        ].filter(Boolean);

        $("#categoryChips").innerHTML = chips.map(([value, label]) =>
            `<button type="button" class="chip" data-category="${escapeHtml(value)}"
                aria-pressed="${!query && value === active}">${label}</button>`
        ).join("");

        return active;

    }


    function productImage(m){

        return m.gambar
            ? `<img src="${escapeHtml(m.gambar)}" alt="" loading="lazy" decoding="async" data-fallback="cookie">`
            : icon("cookie");

    }


    function renderCatalog(){

        const active = renderCategories();

        const list = visibleMenus(active);

        if(list.length === 0){

            $("#productGrid").innerHTML =
                `<div class="empty" style="grid-column:1/-1">${icon(query ? "search" : "inbox")}
                    ${query ? `Tidak ada produk "${escapeHtml(query)}"` : "Belum ada produk di kategori ini"}</div>`;

            return;

        }

        $("#productGrid").innerHTML = list.map(m => `
            <button type="button" class="product" data-id="${escapeHtml(m.id)}">
                <div class="product-img">${productImage(m)}</div>
                ${m.unggulan ? `<span class="product-star" title="Best seller">${icon("star", "i-sm i-fill")}</span>` : ""}
                <span class="product-qty num" hidden></span>
                <span class="product-minus" role="button" aria-label="Kurangi" hidden>${icon("minus", "i-sm")}</span>
                <div class="product-info">
                    <span class="product-name">${escapeHtml(m.nama)}</span>
                    <span class="product-price num">
                        ${m.hargaKustom ? icon("tag", "i-sm") + "Harga custom" : rupiah(m.harga)}
                    </span>
                </div>
            </button>
        `).join("");

        renderCardBadges();

    }


    /* Cuma angka di kartu yang diperbarui; grid tidak dirender ulang. */
    function renderCardBadges(){

        const qtyById = new Map();

        cart.forEach(line =>
            qtyById.set(line.menuId, (qtyById.get(line.menuId) || 0) + line.qty));

        $$("#productGrid .product").forEach(card => {

            const qty = qtyById.get(card.dataset.id) || 0;
            const menu = findMenu(card.dataset.id);

            card.classList.toggle("in-cart", qty > 0);

            const badge = $(".product-qty", card);
            badge.hidden = qty === 0;
            badge.textContent = qty;

            /* Kurangi langsung dari kartu hanya untuk harga tetap. */
            $(".product-minus", card).hidden = qty === 0 || !!menu?.hargaKustom;

        });

    }


    const findMenu = id => App.menus.find(m => m.id === id);


    /* =================================================
       KERANJANG
       ================================================= */

    /*
     * Pesanan dikunci saat sedang diproses, atau saat
     * transaksi sudah tercatat tapi belum dicetak —
     * yang di Google Sheets tidak akan ikut berubah.
     */
    function cartLocked(){

        if(processing){
            return true;
        }

        if(awaitingReprint){
            toast(`Nota ${awaitingReprint.nota} sudah tercatat. Cetak ulang atau lanjut tanpa nota dulu.`, "error");
            return true;
        }

        return false;

    }


    function addLine(menu, harga, qty, custom){

        const key = custom ? `${menu.id}:${harga}` : menu.id;
        const line = cart.get(key);

        if(line){
            line.qty += qty;
        }else{
            cart.set(key, { key, menuId: menu.id, nama: menu.nama, harga, qty, custom });
        }

        cartChanged();

    }


    function setQty(key, qty){

        if(cartLocked()){
            return cartChanged();
        }

        const line = cart.get(key);

        if(!line){
            return;
        }

        if(!(qty > 0)){
            cart.delete(key);
        }else{
            line.qty = qty;
        }

        cartChanged();

    }


    function onProductTap(id){

        if(cartLocked()){
            return;
        }

        const menu = findMenu(id);

        if(!menu){
            return;
        }

        if(menu.hargaKustom){
            return openCustomPrice(menu);
        }

        addLine(menu, menu.harga, 1, false);

    }


    const getTotal = () => {
        let total = 0;
        cart.forEach(l => total += l.harga * l.qty);
        return total;
    };

    const getCount = () => {
        let count = 0;
        cart.forEach(l => count += l.qty);
        return count;
    };


    function cartChanged(){

        renderLines();
        renderCardBadges();
        renderPayment();

    }


    function renderLines(){

        const count = getCount();

        $("#orderCount").textContent = count + " item";

        if(cart.size === 0){

            $("#orderLines").innerHTML =
                `<div class="empty">${icon("cart")}Ketuk produk untuk menambah pesanan</div>`;

            return;

        }

        $("#orderLines").innerHTML = [...cart.values()].map(line => `
            <div class="line" data-key="${escapeHtml(line.key)}">
                <span class="line-name">${escapeHtml(line.nama)}</span>
                <span class="line-sub num">${rupiah(line.harga * line.qty)}</span>
                <span class="line-meta num">
                    ${rupiah(line.harga)}
                    ${line.custom ? `<span class="badge badge-accent">${icon("tag", "i-sm")}custom</span>` : ""}
                </span>
                <div class="stepper">
                    <button type="button" data-step="-1" aria-label="Kurangi">${icon(line.qty === 1 ? "trash" : "minus", "i-sm")}</button>
                    <input type="number" class="num" min="0" inputmode="numeric" value="${line.qty}" aria-label="Jumlah">
                    <button type="button" data-step="1" aria-label="Tambah">${icon("plus", "i-sm")}</button>
                </div>
            </div>
        `).join("");

    }


    /* =================================================
       HARGA CUSTOM
       ================================================= */

    let customMenu = null;

    function openCustomPrice(menu){

        customMenu = menu;

        const dlg = $("#customDialog");

        $("h2", dlg).textContent = menu.nama;
        $("#customPrice").value = menu.harga > 0 ? numberFmt.format(menu.harga) : "";
        $("#customQty").value = 1;

        dlg.showModal();
        $("#customPrice").select();

    }


    function submitCustomPrice(event){

        event.preventDefault();

        const harga = parseNumber($("#customPrice").value);
        const qty = parseInt($("#customQty").value, 10);

        if(harga <= 0){
            return toast("Isi harga lebih dari 0.", "error");
        }

        if(!(qty > 0)){
            return toast("Jumlah minimal 1.", "error");
        }

        $("#customDialog").close();

        addLine(customMenu, harga, qty, true);

    }


    /* =================================================
       PEMBAYARAN
       ================================================= */

    const cashReceived = () => parseNumber($("#cashInput").value);


    /* Uang pas + pecahan yang paling mungkin diterima. */
    function quickAmounts(total){

        if(total <= 0){
            return [];
        }

        const amounts = new Set([total]);

        [10000, 50000, 100000].forEach(step =>
            amounts.add(Math.ceil(total / step) * step));

        amounts.add(Math.ceil(total / 100000) * 100000 + 100000);

        return [...amounts].sort((a, b) => a - b).slice(0, 4);

    }


    function renderPayment(){

        const total = getTotal();
        const empty = cart.size === 0;

        $("#grandTotal").textContent = rupiah(total);
        $("#cartBarTotal").textContent = rupiah(total);
        $("#cartBarCount").textContent = getCount() + " item";

        $$("#paymentToggle button").forEach(b =>
            b.setAttribute("aria-pressed", b.dataset.payment === payment));

        $("#cashSection").hidden = payment !== "cash";
        $("#qrisSection").hidden = payment !== "qris";

        $("#quickCash").innerHTML = quickAmounts(total).map((amount, i) =>
            `<button type="button" class="num" data-amount="${amount}">${i === 0 ? "Uang pas" : numberFmt.format(amount / 1000) + "rb"}</button>`
        ).join("");

        const received = cashReceived();
        const change = received - total;
        const row = $("#changeRow");

        row.classList.toggle("short", received > 0 && change < 0);
        row.classList.toggle("enough", received > 0 && change >= 0 && !empty);

        $("#changeLabel").textContent = received > 0 && change < 0 ? "Kurang" : "Kembalian";
        $("#changeValue").textContent = rupiah(received > 0 ? Math.abs(change) : 0);

        const button = $("#payButton");

        if(awaitingReprint){
            button.innerHTML = icon("printer") + `Cetak ulang nota ${awaitingReprint.nota}`;
            button.disabled = processing;
        }else{
            button.innerHTML = icon("receipt") + (empty ? "Bayar" : `Bayar ${rupiah(total)}`);
            button.disabled = processing || empty || (payment === "cash" && received < total);
        }

        $("#reprintNotice").hidden = !awaitingReprint;
        $("#skipPrint").hidden = !awaitingReprint;

    }


    /* =================================================
       TRANSAKSI
       Bentuk objek sama persis dengan versi lama —
       Apps Script membaca field-field ini.
       ================================================= */

    function buildTransaction(){

        const total = getTotal();
        const cash = payment === "cash" ? cashReceived() : 0;
        const now = new Date();

        return {
            transactionId: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
            tanggal: now.toLocaleDateString("id-ID"),
            jam: now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false }),
            nota: String(nota).padStart(3, "0"),
            pembayaran: payment === "cash" ? "Cash" : "QRIS",
            cashReceived: cash,
            change: payment === "cash" ? cash - total : 0,
            total,
            items: [...cart.values()].map(l => ({
                nama: l.nama,
                qty: l.qty,
                harga: l.harga,
                subtotal: l.harga * l.qty
            }))
        };

    }


    async function pay(){

        if(processing){
            return;
        }

        if(awaitingReprint){
            return printAndFinish(awaitingReprint);
        }

        const total = getTotal();

        if(total <= 0){
            return toast("Belum ada produk dipilih.", "error");
        }

        if(payment === "cash" && cashReceived() < total){
            $("#cashInput").focus();
            return toast("Uang diterima kurang dari total.", "error");
        }

        const transaction = buildTransaction();

        /* 1. Simpan ke antrean lokal DULU, baru kirim di belakang. */
        if(!pending.some(t => t.transactionId === transaction.transactionId)){
            pending.push(transaction);
            savePending();
        }

        syncPending();

        /*
         * Nomor nota langsung maju: transaksi ini sudah
         * tercatat, apa pun hasil cetaknya.
         */
        nota++;
        localStorage.setItem("nota", nota);

        /* 2. Cetak. */
        await printAndFinish(transaction);

    }


    async function printAndFinish(transaction){

        processing = true;

        const button = $("#payButton");
        button.disabled = true;
        button.innerHTML = icon("printer") + "Mencetak nota...";

        const result = await printReceipt(transaction);

        processing = false;

        if(!result.ok){

            awaitingReprint = transaction;
            $("#reprintMessage").textContent = result.message;
            renderPayment();
            return;

        }

        finish(transaction);

    }


    function finish(transaction){

        awaitingReprint = null;
        cart.clear();
        payment = "cash";
        $("#cashInput").value = "";

        cartChanged();
        closeOrderSheet();

        toast(`Transaksi nota ${transaction.nota} selesai`);

    }


    async function skipPrint(){

        if(!awaitingReprint){
            return;
        }

        const ok = await App.confirmDialog({
            title: "Lanjut tanpa nota?",
            message: `Transaksi nota ${awaitingReprint.nota} sudah tercatat. Pesanan akan ditutup tanpa mencetak nota.`,
            confirmText: "Lanjut tanpa nota"
        });

        if(ok){
            finish(awaitingReprint);
        }

    }


    /* =================================================
       CETAK (Cleanter -> printer Bluetooth RPP02N)
       ================================================= */

    function receiptContent(t){

        const text = (value, extra) => ({ type: "text", text: value, ...extra });
        const divider = { type: "divider" };

        const content = [
            text(App.STORE.name.toUpperCase(), { align: "center", bold: true, size: "large" }),
            text(App.STORE.tagline, { align: "center" }),
            divider,
            text("No Nota : " + t.nota, { align: "center", bold: true }),
            text(t.tanggal + " • " + t.jam, { align: "center" }),
            divider
        ];

        t.items.forEach(item => {
            content.push(text(item.nama, { bold: true }));
            content.push({ type: "row", left: item.qty + " x " + rupiah(item.harga), right: rupiah(item.subtotal) });
        });

        content.push(
            divider,
            { type: "row", left: "TOTAL", right: rupiah(t.total), bold: true },
            divider,
            text("Pembayaran : " + t.pembayaran)
        );

        if(t.pembayaran === "Cash"){
            content.push(
                text("Diterima : " + rupiah(t.cashReceived)),
                text("Kembalian : " + rupiah(t.change))
            );
        }

        content.push(
            { type: "feed", lines: 1 },
            text("Terima Kasih", { align: "center" }),
            { type: "feed", lines: 3 }
        );

        return content;

    }


    async function printReceipt(transaction){

        try{

            const response = await fetch(PRINTER_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ cut: true, content: receiptContent(transaction) }),
                signal: AbortSignal.timeout(5000)
            });

            if(!response.ok){
                throw new Error("Cleanter error " + response.status);
            }

            const result = await response.json();

            if(result.status === "printed"){
                return { ok: true };
            }

            return { ok: false, message: "Printer menolak: " + (result.message || result.status || "tidak diketahui") + "." };

        }catch(error){

            console.error(error);

            return {
                ok: false,
                message: "Printer tidak terhubung. Pastikan RPP02N sudah paired lewat Bluetooth, Cleanter berjalan, dan RPP02N dipilih di Cleanter."
            };

        }

    }


    /* =================================================
       LEMBAR PESANAN (HP)
       ================================================= */

    function openOrderSheet(){
        $("#order").classList.add("open");
    }

    function closeOrderSheet(){
        $("#order").classList.remove("open");
    }


    /* =================================================
       EVENT
       ================================================= */

    function bind(){

        $("#productGrid").addEventListener("click", e => {

            const card = e.target.closest(".product");

            if(!card){
                return;
            }

            if(e.target.closest(".product-minus")){
                const line = cart.get(card.dataset.id);
                if(line){
                    setQty(line.key, line.qty - 1);
                }
                return;
            }

            onProductTap(card.dataset.id);

        });

        $("#categoryChips").addEventListener("click", e => {

            const chip = e.target.closest(".chip");

            if(chip){
                category = chip.dataset.category;
                query = "";
                $("#productSearch").value = "";
                renderCatalog();
            }

        });

        $("#productSearch").addEventListener("input", e => {
            query = e.target.value;
            renderCatalog();
        });

        $("#orderLines").addEventListener("click", e => {

            const step = e.target.closest("[data-step]");

            if(step){
                const line = cart.get(step.closest(".line").dataset.key);
                setQty(line.key, line.qty + Number(step.dataset.step));
            }

        });

        $("#orderLines").addEventListener("change", e => {

            if(e.target.matches(".stepper input")){
                setQty(e.target.closest(".line").dataset.key, parseInt(e.target.value, 10));
            }

        });

        $("#clearCart").addEventListener("click", async () => {

            if(cart.size === 0 || cartLocked()){
                return;
            }

            const ok = await App.confirmDialog({
                title: "Kosongkan pesanan?",
                message: "Semua produk di pesanan ini akan dihapus.",
                confirmText: "Kosongkan",
                danger: true
            });

            if(ok){
                cart.clear();
                cartChanged();
            }

        });

        $("#paymentToggle").addEventListener("click", e => {

            const btn = e.target.closest("[data-payment]");

            if(btn && !cartLocked()){
                payment = btn.dataset.payment;
                renderPayment();
                /* Tablet: keyboard layar akan menutupi tombol uang cepat, jadi tidak otomatis. */
                if(payment === "cash" && !isTouchDevice()){
                    $("#cashInput").focus();
                }
            }

        });

        $("#cashInput").addEventListener("input", e => {
            const n = parseNumber(e.target.value);
            e.target.value = n ? numberFmt.format(n) : "";
            renderPayment();
        });

        $("#cashInput").addEventListener("keydown", e => {
            if(e.key === "Enter"){
                e.preventDefault();
                pay();
            }
        });

        $("#quickCash").addEventListener("click", e => {

            const btn = e.target.closest("[data-amount]");

            if(btn){
                $("#cashInput").value = numberFmt.format(Number(btn.dataset.amount));
                renderPayment();
            }

        });

        $("#payButton").addEventListener("click", pay);
        $("#skipPrint").addEventListener("click", skipPrint);
        $("#pendingStatus").addEventListener("click", syncPending);

        $("#cartBar").addEventListener("click", openOrderSheet);
        $("#closeOrder").addEventListener("click", closeOrderSheet);

        $("#customForm").addEventListener("submit", submitCustomPrice);

        $("#customPrice").addEventListener("input", e => {
            const n = parseNumber(e.target.value);
            e.target.value = n ? numberFmt.format(n) : "";
        });

    }


    /* =================================================
       MULAI
       ================================================= */

    App.registerView("kasir", {});

    App.on("menus", renderCatalog);

    App.on("logout-request", async () => {

        if(pending.length > 0){

            const ok = await App.confirmDialog({
                title: "Masih ada transaksi tertunda",
                message: `${pending.length} transaksi belum terkirim ke Google Sheets. Data tetap tersimpan di perangkat ini dan terkirim setelah login lagi.`,
                confirmText: "Tetap keluar"
            });

            if(!ok){
                return;
            }

        }

        App.logout();

    });

    App.on("ready", () => {

        bind();
        renderCatalog();
        cartChanged();
        syncPending();

    });

})();

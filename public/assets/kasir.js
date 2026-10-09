/* =====================================================
   KASIR
   ===================================================== */

(() => {

    const { $, $$, isTouchDevice, icon, escapeHtml, rupiah, parseNumber, numberFmt, api, toast } = App;



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

    /*
     * Bagi 2 metode: satu nota dibayar penuh dengan dua metode
     * (mis. Rp30.000 QRIS + Rp20.000 Cash). Bukan utang, bukan Grab.
     * Kasir mengisi salah satu jumlah; yang lain = sisa dari total.
     */
    let split = false;
    let splitPair = ["qris", "cash"];
    let splitAnchor = 0;
    let splitValue = 0;

    let processing = false;

    /*
     * Transaksi yang SUDAH tercatat tapi gagal dicetak.
     * Cetak ulang memakai objek yang sama, supaya tidak
     * ada baris kedua di Google Sheets.
     */
    let awaitingReprint = null;

    /*
     * Nomor nota: DDMMYY + urutan 3 digit, mulai dari 001 tiap hari (WITA).
     * Contoh 9 Oktober 2026, nota pertama: 091026001.
     */
    let notaSeq = parseInt(localStorage.getItem("nota"), 10) || 1;
    let notaDay = localStorage.getItem("notaDay") || "";

    function nextNota(now){
        const [y, m, d] = App.shopTime(now).iso.split("-");
        const day = d + m + y.slice(2);
        return day + String(day === notaDay ? notaSeq : 1).padStart(3, "0");
    }


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

                const sent = pending.shift();
                savePending();
                renderStatus();

                if(sent.pembayaran === "Utang"){
                    App.emit("debts-changed");
                }

            }

        }catch(error){

            console.error("Sync gagal:", error);

        }finally{

            syncing = false;
            renderStatus();

        }

    }

    /*
     * Pesanan hanya ada di memori halaman. Reload / tutup tab yang
     * tidak sengaja akan menghapusnya, jadi minta konfirmasi.
     */
    window.addEventListener("beforeunload", e => {
        if(!App.leaving && (cart.size > 0 || awaitingReprint)){
            e.preventDefault();
            e.returnValue = "";
        }
    });

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
        btn.title = "Coba kirim ulang sekarang";

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

        catalogGrab = isGrab();

        /* Belum ada salinan menu sama sekali (login pertama di perangkat ini). */
        if(App.menus.length === 0 && App.menuStatus !== "ready"){

            $("#productGrid").innerHTML = App.menuStatus === "error"
                ? `<div class="empty" style="grid-column:1/-1">${icon("wifi-off")}
                        Menu belum bisa dimuat. Periksa koneksi internet.
                        <button type="button" class="btn btn-sm" data-retry-menu>${icon("refresh", "i-sm")}Coba lagi</button></div>`
                : `<div class="loading-row" style="grid-column:1/-1"><span class="spinner" aria-hidden="true"></span>Memuat menu…</div>` +
                  Array.from({ length: 8 }, () => `<div class="skeleton" style="height:210px"></div>`).join("");

            return;

        }

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
                    <span class="product-price num">${priceLabel(m)}</span>
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
            $(".product-minus", card).hidden = qty === 0 || !!menu?.hargaKustom || usesVariants(menu);

        });

    }


    const findMenu = id => App.menus.find(m => m.id === id);

    let catalogGrab = false;

    /* Produk bervarian: ketuk membuka pilihan varian, harga ada di tiap varian. */
    const usesVariants = m => !!m && !!m.adaVarian && Array.isArray(m.varian) && m.varian.length > 0;

    const cheapest = m => Math.min(...m.varian.map(v => v.harga));

    /*
     * GRAB: tiap produk / varian punya harga Grab sendiri (diisi superadmin).
     * Saat metode Grab dipilih, harga di layar & nota = harga Grab;
     * yang tercatat sebagai penjualan = harga Grab dikurangi potongan Grab.
     */
    const isGrab = () => payment === "grab";
    const grabRate = () => 1 - (Number(App.settings.grabCommission) || 0) / 100;
    const grabNet = price => Math.round(price * grabRate());

    const linePrice = line => isGrab() ? (line.hargaGrab || 0) : line.harga;
    const missingGrab = () => [...cart.values()].filter(l => !l.hargaGrab);

    const cheapestGrab = m => {
        const prices = m.varian.map(v => v.hargaGrab).filter(Boolean);
        return prices.length ? Math.min(...prices) : null;
    };

    function priceLabel(m){

        if(isGrab()){
            const grab = usesVariants(m) ? cheapestGrab(m) : m.hargaGrab;
            return grab
                ? (usesVariants(m) ? icon("layers", "i-sm") + "Mulai " : "") + rupiah(grab)
                : `<span class="no-grab">Belum ada harga Grab</span>`;
        }

        return usesVariants(m)
            ? icon("layers", "i-sm") + "Mulai " + rupiah(cheapest(m))
            : m.hargaKustom ? icon("tag", "i-sm") + "Harga custom" : rupiah(m.harga);

    }


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


    function addLine(menu, harga, qty, custom, variant){

        /*
         * Varian disalin ke baris (nama & harga saat dipilih),
         * jadi pesanan berjalan tidak berubah kalau admin
         * mengedit atau menghapus varian di tengah transaksi.
         */
        const key =
            variant ? `${menu.id}:v:${variant.id}`
            : custom ? `${menu.id}:${harga}`
            : menu.id;

        const line = cart.get(key);

        if(line){
            line.qty += qty;
        }else{
            cart.set(key, {
                key, menuId: menu.id, nama: menu.nama, harga, qty, custom,
                varian: variant ? variant.nama : null,
                hargaGrab: (variant ? variant.hargaGrab : menu.hargaGrab) || null
            });
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

        if(usesVariants(menu)){
            return openVariants(menu);
        }

        if(menu.hargaKustom){
            return openCustomPrice(menu);
        }

        addLine(menu, menu.harga, 1, false);

    }


    const getTotal = () => {
        let total = 0;
        cart.forEach(l => total += linePrice(l) * l.qty);
        return total;
    };

    const getCount = () => {
        let count = 0;
        cart.forEach(l => count += l.qty);
        return count;
    };


    function cartChanged(){

        renderVariantRows();
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
                <span class="line-name">${escapeHtml(line.nama)}${line.varian ? ` <span class="badge">${escapeHtml(line.varian)}</span>` : ""}</span>
                <span class="line-sub num">${isGrab() && !line.hargaGrab ? "–" : rupiah(linePrice(line) * line.qty)}</span>
                <span class="line-meta num">
                    ${isGrab() && !line.hargaGrab ? `<span class="no-grab">Belum ada harga Grab</span>` : rupiah(linePrice(line))}
                    ${isGrab() && line.hargaGrab ? `<span class="badge">Grab</span>` : ""}
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
       VARIAN
       Satu dialog untuk memilih beberapa varian sekaligus:
       tiap varian punya tombol +/- sendiri, dialog tetap
       terbuka sampai kasir menekan Selesai.
       ================================================= */

    let variantMenu = null;

    const variantKey = (menu, variant) => `${menu.id}:v:${variant.id}`;


    function openVariants(menu){

        variantMenu = menu;

        $("#variantDialog h2").textContent = menu.nama;

        $("#variantDialog").showModal();

        renderVariantRows();

    }


    function renderVariantRows(){

        const dlg = $("#variantDialog");

        if(!variantMenu || !dlg.open){
            return;
        }

        let picked = 0;

        $("#variantRows").innerHTML = variantMenu.varian.map(v => {

            const qty = cart.get(variantKey(variantMenu, v))?.qty || 0;

            picked += qty;

            return `
                <div class="variant-row ${qty ? "picked" : ""}" data-vid="${escapeHtml(v.id)}">
                    <div class="variant-info">
                        <span class="variant-name">${escapeHtml(v.nama)}</span>
                        <span class="variant-price num">${isGrab() ? (v.hargaGrab ? rupiah(v.hargaGrab) + " · Grab" : "Belum ada harga Grab") : rupiah(v.harga)}</span>
                    </div>
                    <div class="stepper">
                        <button type="button" data-vstep="-1" aria-label="Kurangi ${escapeHtml(v.nama)}" ${qty ? "" : "disabled"}>${icon(qty === 1 ? "trash" : "minus", "i-sm")}</button>
                        <span class="variant-qty num">${qty}</span>
                        <button type="button" data-vstep="1" aria-label="Tambah ${escapeHtml(v.nama)}">${icon("plus", "i-sm")}</button>
                    </div>
                </div>`;

        }).join("");

        $("#variantSummary").textContent = picked ? picked + " dipilih" : "";

    }


    function stepVariant(variantId, delta){

        if(!variantMenu || cartLocked()){
            return;
        }

        const variant = variantMenu.varian.find(v => v.id === variantId);

        if(!variant){
            return;
        }

        if(delta > 0){
            return addLine(variantMenu, variant.harga, 1, false, variant);
        }

        const line = cart.get(variantKey(variantMenu, variant));

        if(line){
            setQty(line.key, line.qty - 1);
        }

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

    const METHOD_NAME = { cash: "Cash", qris: "QRIS", transfer: "Transfer BCA", debit: "Debit", grab: "Grab", utang: "Utang" };
    const METHOD_ICON = { cash: "cash", qris: "qr", transfer: "bank", debit: "card" };
    const SPLIT_METHODS = ["cash", "qris", "transfer", "debit"];

    /* Jumlah per metode saat dibagi: [metode pertama, metode kedua]. */
    function splitAmounts(){
        const other = getTotal() - splitValue;
        return splitAnchor === 0 ? [splitValue, other] : [other, splitValue];
    }

    const splitValid = () => {
        const [a, b] = splitAmounts();
        return a > 0 && b > 0;
    };

    const usesMethod = m => split ? splitPair.includes(m) : payment === m;

    /* Yang harus dibayar tunai: seluruh total, atau bagian Cash saat dibagi. */
    const cashDue = () => split ? splitAmounts()[splitPair.indexOf("cash")] : getTotal();

    function clearSplitAmounts(){
        splitAnchor = 0;
        splitValue = 0;
        $("#split0").value = "";
        $("#split1").value = "";
    }

    function setSplit(on){

        split = on;
        clearSplitAmounts();

        if(on){
            /* Metode yang sedang dipilih jadi yang pertama; yang kedua Cash (atau QRIS). */
            const first = SPLIT_METHODS.includes(payment) ? payment : "cash";
            splitPair = [first, first === "cash" ? "qris" : "cash"];
        }else{
            payment = splitPair[0];
        }

        $("#cashInput").value = "";

        renderPayment();

        if(on && !isTouchDevice()){
            $("#split0").focus();
        }

    }

    /* Metode yang sama dipilih di dua baris: baris lainnya bertukar. */
    function setSplitMethod(i, m){
        const other = 1 - i;
        if(splitPair[other] === m){
            splitPair[other] = splitPair[i];
        }
        splitPair[i] = m;
        if(!splitPair.includes("cash")){
            $("#cashInput").value = "";
        }
        renderPayment();
    }


    function renderSplit(){

        $("#splitSection").hidden = !split;

        if(!split){
            return;
        }

        const total = getTotal();
        const amounts = splitAmounts();

        splitPair.forEach((m, i) => {
            const select = $("#splitMethod" + i);
            if(!select.options.length){
                select.innerHTML = SPLIT_METHODS.map(k => `<option value="${k}">${METHOD_NAME[k]}</option>`).join("");
            }
            select.value = m;
            /* Kolom yang sedang diketik tidak ditimpa; kolom lainnya ikut sisa. */
            if(i !== splitAnchor){
                $("#split" + i).value = amounts[i] > 0 ? numberFmt.format(amounts[i]) : "";
            }
        });

        const status = $("#splitStatus");

        status.className = "split-status";

        if(splitValue > total){
            status.classList.add("bad");
            status.textContent = `Melebihi total ${rupiah(total)}`;
        }else if(!splitValid()){
            status.textContent = "";
        }else{
            status.textContent = "";
        }

    }


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

        /* Pesanan dikosongkan: tidak ada lagi yang dibagi. */
        if(split && empty){
            split = false;
            payment = splitPair[0];
            clearSplitAmounts();
        }

        $$("#paymentToggle button").forEach(b =>
            b.setAttribute("aria-pressed", usesMethod(b.dataset.payment)));
        $("#paymentSelect").value = payment;

        /* Saat dibagi, kartu bagi menggantikan pilihan metode. Grab & Utang tidak bisa dibagi. */
        $("#paymentToggle").hidden = split;
        $("#splitOpen").hidden = split || !!awaitingReprint || !SPLIT_METHODS.includes(payment);
        $("#splitOpen").disabled = empty || processing;
        renderSplit();

        $("#cashSection").hidden = !usesMethod("cash");
        $("#cashLabel").textContent = split ? "Uang tunai diterima" : "Uang diterima";
        $("#qrisSection").hidden = !usesMethod("qris");
        $("#transferSection").hidden = !usesMethod("transfer");
        $("#debitSection").hidden = !usesMethod("debit");
        $("#grabSection").hidden = !isGrab();

        if(isGrab()){

            const missing = missingGrab();

            $("#grabSection").className = "notice " + (missing.length ? "notice-warn" : "notice-info");
            $("#grabText").innerHTML = missing.length
                ? `Harga Grab belum diisi untuk: <b>${missing.map(l => escapeHtml(l.nama + (l.varian ? " (" + l.varian + ")" : ""))).join(", ")}</b>.`
                : `Nota memakai harga Grab. Tercatat sebagai penjualan <b class="num">${rupiah([...cart.values()].reduce((sum, l) => sum + grabNet(l.hargaGrab) * l.qty, 0))}</b> (harga Grab − ${App.settings.grabCommission}%).`;

        }

        /* Ganti ke/dari Grab: harga di kartu produk & baris pesanan ikut berganti. */
        if(catalogGrab !== isGrab()){
            renderCatalog();
            renderVariantRows();
            renderLines();
        }
        $("#utangSection").hidden = payment !== "utang";

        const due = usesMethod("cash") ? cashDue() : total;

        $("#quickCash").innerHTML = quickAmounts(due).map((amount, i) =>
            `<button type="button" class="num" data-amount="${amount}">${i === 0 ? "Uang pas" : numberFmt.format(amount / 1000) + "rb"}</button>`
        ).join("");

        const received = cashReceived();
        const change = received - due;
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
            button.innerHTML = payment === "utang"
                ? icon("book") + (empty ? "Catat utang" : `Catat utang <span class="pay-amt">${rupiah(total)}</span>`)
                : icon("receipt") + (empty ? "Bayar" : `Bayar <span class="pay-amt">${rupiah(total)}</span>`);
            button.disabled = processing || empty
                || (split && !splitValid())
                || (usesMethod("cash") && received < due)
                || (isGrab() && missingGrab().length > 0);
        }

        $("#reprintNotice").hidden = !awaitingReprint;

        $("#clearCart").disabled = empty || processing;
        $("#previewReceipt").disabled = empty;
        $("#skipPrint").hidden = !awaitingReprint;

    }


    /* =================================================
       TRANSAKSI
       Bentuk objek sama persis dengan versi lama —
       Apps Script membaca field-field ini.
       ================================================= */

    function buildTransaction(utang){

        const total = getTotal();
        const cash = usesMethod("cash") ? cashReceived() : 0;
        const now = new Date();

        const parts = split
            ? splitPair.map((m, i) => ({ metode: METHOD_NAME[m], jumlah: splitAmounts()[i] }))
            : null;

        return {
            transactionId: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
            /* WITA, bukan jam tablet: tablet dengan zona waktu salah tidak menggeser jam nota. */
            tanggal: App.shopTime(now).tanggal,
            jam: App.shopTime(now).jam,
            nota: nextNota(now),
            /* Dibagi: "Cash 25000 + QRIS 25000" — terbaca di sheet dan dipecah lagi oleh laporan. */
            pembayaran: parts ? parts.map(p => `${p.metode} ${p.jumlah}`).join(" + ") : METHOD_NAME[payment],
            ...(parts ? { pembayaranBagi: parts } : {}),
            cashReceived: cash,
            change: usesMethod("cash") ? cash - cashDue() : 0,
            /* Grab: total yang tercatat = jumlah harga bersih (harga Grab − potongan). */
            total: isGrab() ? [...cart.values()].reduce((sum, l) => sum + grabNet(l.hargaGrab) * l.qty, 0) : total,
            /* Grab: yang tercatat = harga Grab − potongan, per item. */
            items: [...cart.values()].map(l => {
                const harga = isGrab() ? grabNet(l.hargaGrab) : l.harga;
                return {
                    nama: l.varian ? `${l.nama} (${l.varian})` : l.nama,
                    qty: l.qty,
                    harga,
                    subtotal: harga * l.qty
                };
            }),
            /* Grab: harga Grab asli untuk dicetak di nota. */
            ...(isGrab() ? {
                grabPotongan: Number(App.settings.grabCommission) || 0,
                grabTotal: total,
                grabItems: [...cart.values()].map(l => ({
                    nama: l.varian ? `${l.nama} (${l.varian})` : l.nama,
                    qty: l.qty,
                    harga: l.hargaGrab,
                    subtotal: l.hargaGrab * l.qty
                }))
            } : {}),
            kasir: App.session?.username,
            setoran: App.shiftId || null,
            /* Hanya untuk utang: dicatat server sebagai utang pelanggan. */
            ...(utang || {})
        };

    }


    async function pay(utang){

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

        if(split && !splitValid()){
            return toast("Jumlah kedua metode harus pas dengan total.", "error");
        }

        if(usesMethod("cash") && cashReceived() < cashDue()){
            $("#cashInput").focus();
            return toast(split ? "Uang tunai diterima kurang dari bagian Cash." : "Uang diterima kurang dari total.", "error");
        }

        if(isGrab() && missingGrab().length){
            return toast("Harga Grab belum diisi untuk sebagian produk.", "error");
        }

        /* Utang: minta data pelanggan dulu; dialog memanggil pay() lagi dengan datanya. */
        if(payment === "utang" && !utang){
            return openUtangDialog(total);
        }

        const transaction = buildTransaction(payment === "utang" ? utang : null);

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
        notaDay = transaction.nota.slice(0, 6);
        notaSeq = Number(transaction.nota.slice(6)) + 1;
        localStorage.setItem("nota", notaSeq);
        localStorage.setItem("notaDay", notaDay);

        /* Masuk ke total setoran kasir. */
        App.emit("sale-recorded", transaction);

        /* 2. Cetak. */
        await printAndFinish(transaction);

    }


    async function printAndFinish(transaction){

        processing = true;

        const button = $("#payButton");
        button.disabled = true;
        button.innerHTML = icon("printer") + "Mencetak nota...";

        const result = await Printer.send(Printer.saleReceipt(transaction));

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
        split = false;
        clearSplitAmounts();
        $("#cashInput").value = "";

        cartChanged();
        closeOrderSheet();

        /* Kembalian ditampilkan lebih lama: kasir butuh angkanya setelah nota keluar. */
        if(transaction.pembayaran === "Utang"){
            toast(`Utang nota ${transaction.nota} atas nama ${transaction.pelanggan} dicatat`, "ok", 5000);
        }else if(transaction.change > 0){
            toast(`Nota ${transaction.nota} selesai. Kembalian ${rupiah(transaction.change)}`, "ok", 7000);
        }else{
            toast(`Nota ${transaction.nota} selesai`);
        }

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
       UTANG: DATA PELANGGAN
       ================================================= */

    /* Nama & no. HP pelanggan yang pernah berutang, untuk saran isian. */
    let knownDebtors = new Map();

    async function loadDebtorSuggestions(){

        try{

            const { debts } = await api("/api/debts");

            knownDebtors = new Map();

            debts.forEach(d => knownDebtors.set(d.pelanggan.toLowerCase(), { nama: d.pelanggan, telepon: d.telepon }));

            $("#debtorNames").innerHTML = [...knownDebtors.values()]
                .map(d => `<option value="${escapeHtml(d.nama)}">`).join("");

        }catch(error){
            /* Offline: tanpa saran, tetap bisa diketik manual. */
        }

    }


    function openUtangDialog(total){

        const form = $("#utangForm");

        form.reset();
        $("#utangTotal").textContent = rupiah(total);

        /* Jatuh tempo tidak boleh di masa lalu. */
        const now = new Date();
        form.jatuhTempo.min = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

        $("#utangDialog").showModal();
        form.pelanggan.focus();

        loadDebtorSuggestions();

    }


    function submitUtang(event){

        event.preventDefault();

        const form = event.target;
        const pelanggan = form.pelanggan.value.trim();

        if(!pelanggan){
            form.pelanggan.focus();
            return toast("Isi nama pelanggan.", "error");
        }

        $("#utangDialog").close();

        pay({
            pelanggan,
            telepon: form.telepon.value.trim(),
            jatuhTempo: form.jatuhTempo.value || null,
            catatan: form.catatan.value.trim()
        });

    }


    /* =================================================
       PRATINJAU NOTA
       Nota dibangun dengan kode cetak yang sama, jadi yang
       tampil = yang akan keluar dari printer.
       ================================================= */

    function previewReceipt(){

        if(cart.size === 0){
            return;
        }

        const t = buildTransaction(payment === "utang" ? { pelanggan: "(nama pelanggan)" } : null);

        $("#receiptSlip").innerHTML = Printer.toHtml(Printer.saleReceipt(t));

        const missing = isGrab() ? missingGrab() : [];

        $("#receiptNote").textContent =
            missing.length
                ? `Harga Grab belum diisi untuk: ${missing.map(l => l.nama + (l.varian ? " (" + l.varian + ")" : "")).join(", ")}. Nota belum bisa dicetak.`
            : split && !splitValid()
                ? "Jumlah kedua metode belum pas dengan total."
            : usesMethod("cash") && t.change < 0
                ? "Uang diterima belum diisi. Nomor nota dan jam mengikuti saat Bayar."
                : "Nomor nota dan jam mengikuti saat Bayar ditekan.";

        $("#receiptDialog").showModal();

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

        /* Pilihan metode berbentuk dropdown (tablet): sama dengan menekan tombol metode. */
        $("#paymentSelect").addEventListener("change", e => {

            if(cartLocked()){
                e.target.value = payment;
                return;
            }

            payment = e.target.value;
            renderPayment();

        });

        $("#splitOpen").addEventListener("click", () => {
            if(!cartLocked()){
                setSplit(true);
            }
        });

        $("#splitCancel").addEventListener("click", () => {
            if(!cartLocked()){
                setSplit(false);
            }
        });

        [0, 1].forEach(i => {

            $("#splitMethod" + i).addEventListener("change", e => {
                if(cartLocked()){
                    e.target.value = splitPair[i];
                    return;
                }
                setSplitMethod(i, e.target.value);
            });

            $("#split" + i).addEventListener("input", e => {
                const n = parseNumber(e.target.value);
                e.target.value = n ? numberFmt.format(n) : "";
                splitAnchor = i;
                splitValue = n;
                renderPayment();
            });

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

        $("#payButton").addEventListener("click", () => pay());
        $("#previewReceipt").addEventListener("click", previewReceipt);

        $("#utangForm").addEventListener("submit", submitUtang);

        /* Pelanggan lama dipilih dari saran: isi no. HP-nya otomatis kalau masih kosong. */
        $("#utangForm").pelanggan.addEventListener("change", e => {
            const known = knownDebtors.get(e.target.value.trim().toLowerCase());
            const phone = $("#utangForm").telepon;
            if(known?.telepon && !phone.value){
                phone.value = known.telepon;
            }
        });
        $("#skipPrint").addEventListener("click", skipPrint);
        $("#pendingStatus").addEventListener("click", syncPending);

        $("#cartBar").addEventListener("click", openOrderSheet);
        $("#closeOrder").addEventListener("click", closeOrderSheet);

        $("#variantRows").addEventListener("click", e => {

            const btn = e.target.closest("[data-vstep]");

            if(btn && !btn.disabled){
                stepVariant(btn.closest(".variant-row").dataset.vid, Number(btn.dataset.vstep));
            }

        });

        $("#variantDialog").addEventListener("close", () => { variantMenu = null; });

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

        /* Akun kasir keluar lewat Tutup kasir (setoran.js). */
        if(App.session?.role === "kasir"){
            return;
        }

        if(pending.length > 0){

            const ok = await App.confirmDialog({
                title: "Masih ada transaksi tertunda",
                message: `${pending.length} transaksi belum terkirim. Data tetap tersimpan di perangkat ini dan terkirim otomatis setelah login lagi.`,
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

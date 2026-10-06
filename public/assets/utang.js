/* =====================================================
   UTANG
   Daftar utang pelanggan, pembayaran (lunas / cicilan),
   cetak ulang nota & bukti bayar. Kasir dan superadmin
   sama-sama bisa mencatat pembayaran; hanya superadmin
   yang bisa membatalkan utang (dijaga juga di server).
   ===================================================== */

(() => {

    const { $, $$, icon, escapeHtml, rupiah, parseNumber, numberFmt, api, toast, busy } = App;

    let data = null;
    let status = "belum";
    let query = "";
    let lastLoad = 0;

    let current = null;
    let payMethod = "Cash";
    let paymentId = null;

    const pad = n => String(n).padStart(2, "0");

    const today = () => {
        const d = new Date();
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };

    const isOverdue = d => d.status === "belum" && d.jatuhTempo && d.jatuhTempo < today();

    const newPaymentId = () =>
        crypto.randomUUID ? crypto.randomUUID() : "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);


    /* =================================================
       DATA
       ================================================= */

    async function load(){

        lastLoad = Date.now();

        const btn = $("#utangRefresh");
        btn.disabled = true;
        btn.classList.add("is-loading");

        if(!data){
            $("#utangRows").innerHTML = `<div class="loading-row" style="padding:24px"><span class="spinner" aria-hidden="true"></span>Memuat utang…</div>`;
        }

        try{

            data = await api("/api/debts");

            $("#utangUpdated").textContent = "Diperbarui " + (d => `${pad(d.getHours())}:${pad(d.getMinutes())}`)(new Date());

            render();

            /* Dialog terbuka: tampilkan angka terbaru. */
            if(current && $("#debtDialog").open){
                current = data.debts.find(d => d.id === current.id) || current;
                renderDebt();
            }

        }catch(error){

            if(!data){
                $("#utangRows").innerHTML = `<div class="empty">${icon("wifi-off")}${escapeHtml(error.message)}
                    <button type="button" class="btn btn-sm" data-retry-utang>${icon("refresh", "i-sm")}Coba lagi</button></div>`;
            }else{
                /* Tetap gambar ulang: utang baru yang masih di antrean offline ikut tampil. */
                render();
                toast(error.message, "error");
            }

        }finally{

            btn.disabled = false;
            btn.classList.remove("is-loading");

        }

    }


    /*
     * Penjualan utang yang dibuat saat offline masih di antrean
     * perangkat ini; tampilkan supaya kasir tahu utangnya tidak
     * hilang, tapi belum bisa dibayar sampai sampai di server.
     */
    function pendingCredit(){

        try{

            const queued = JSON.parse(localStorage.getItem("pendingTransactions")) || [];
            const known = new Set((data?.debts || []).map(d => d.id));

            return queued.filter(t => t.pembayaran === "Utang" && !known.has(t.transactionId));

        }catch(e){

            return [];

        }

    }


    function replaceDebt(debt){

        const i = data.debts.findIndex(d => d.id === debt.id);

        if(i >= 0){
            data.debts[i] = debt;
        }

        /* Ringkasan dihitung ulang di klien supaya langsung sesuai. */
        const open = data.debts.filter(d => d.status === "belum");

        data.summary = {
            openCount: open.length,
            openTotal: open.reduce((sum, d) => sum + d.sisa, 0),
            customers: new Set(open.map(d => d.pelanggan.toLowerCase())).size,
            overdue: open.filter(isOverdue).length
        };

    }


    /* =================================================
       DAFTAR
       ================================================= */

    function render(){

        const summary = data.summary;

        $("#utangTotalOpen").textContent = rupiah(summary.openTotal);
        $("#utangCustomers").textContent = numberFmt.format(summary.customers);
        $("#utangOverdue").textContent = numberFmt.format(data.debts.filter(isOverdue).length);

        const badge = $("#utangBadge");
        badge.hidden = summary.openCount === 0;
        badge.textContent = summary.openCount;

        $$("#utangFilter .chip").forEach(c => c.setAttribute("aria-pressed", c.dataset.status === status));

        const q = query.trim().toLowerCase();

        const matches = d =>
            !q || d.pelanggan.toLowerCase().includes(q) || String(d.nota).includes(q);

        let list = data.debts.filter(d => (status === "semua" || d.status === status) && matches(d));

        /* Belum lunas: lewat tempo dulu, lalu yang paling lama. Lainnya: terbaru dulu. */
        list.sort(status === "belum"
            ? (a, b) => (isOverdue(b) - isOverdue(a)) || a.createdAt.localeCompare(b.createdAt)
            : (a, b) => b.createdAt.localeCompare(a.createdAt));

        const queued = (status === "belum" || status === "semua")
            ? pendingCredit().filter(t => !q || String(t.pelanggan || "").toLowerCase().includes(q) || String(t.nota).includes(q))
            : [];

        if(list.length === 0 && queued.length === 0){

            const message = q ? `Tidak ada utang yang cocok dengan "${escapeHtml(query)}".`
                : status === "belum" ? "Tidak ada utang yang belum lunas."
                : status === "lunas" ? "Belum ada utang yang lunas."
                : status === "dibatalkan" ? "Tidak ada utang yang dibatalkan."
                : "Belum ada utang.";

            $("#utangRows").innerHTML = `<div class="empty">${icon(q ? "search" : "book")}${message}</div>`;
            return;

        }

        $("#utangRows").innerHTML =
            queued.map(t => `
                <div class="row debt-row is-pending">
                    <div class="avatar">${escapeHtml((t.pelanggan || "?")[0])}</div>
                    <div class="row-main">
                        <span class="row-title">${escapeHtml(t.pelanggan || "-")} <span class="badge badge-warn">${icon("upload", "i-sm")}Menunggu terkirim</span></span>
                        <span class="row-sub">Nota ${escapeHtml(t.nota)} · ${escapeHtml(t.tanggal)} · terkirim otomatis saat online</span>
                    </div>
                    <div class="debt-amount"><strong class="num">${rupiah(t.total)}</strong></div>
                </div>`).join("") +
            list.map(d => {

                const badges = [
                    d.status === "lunas" && `<span class="badge badge-ok">${icon("check", "i-sm")}Lunas</span>`,
                    d.status === "dibatalkan" && `<span class="badge">Dibatalkan</span>`,
                    isOverdue(d) && `<span class="badge badge-danger">${icon("alert", "i-sm")}Lewat jatuh tempo</span>`,
                    d.status === "belum" && !isOverdue(d) && d.jatuhTempo && `<span class="badge">${icon("calendar", "i-sm")}Tempo ${escapeHtml(Printer.isoDate(d.jatuhTempo))}</span>`,
                    d.status === "belum" && d.dibayar > 0 && `<span class="badge badge-warn">Dicicil</span>`
                ].filter(Boolean).join(" ");

                const itemCount = d.items.reduce((sum, i) => sum + i.qty, 0);

                return `
                    <button type="button" class="row debt-row" data-id="${escapeHtml(d.id)}">
                        <div class="avatar">${escapeHtml(d.pelanggan[0])}</div>
                        <div class="row-main">
                            <span class="row-title">${escapeHtml(d.pelanggan)} ${badges}</span>
                            <span class="row-sub">Nota ${escapeHtml(d.nota)} · ${escapeHtml(d.tanggal)} · ${itemCount} item</span>
                        </div>
                        <div class="debt-amount">
                            <strong class="num">${rupiah(d.status === "belum" ? d.sisa : d.total)}</strong>
                            ${d.status === "belum" && d.dibayar > 0 ? `<span class="small muted num">dari ${rupiah(d.total)}</span>` : ""}
                        </div>
                    </button>`;

            }).join("");

    }


    /* =================================================
       DETAIL & PEMBAYARAN
       ================================================= */

    function openDebt(id){

        current = data.debts.find(d => d.id === id);

        if(!current){
            return;
        }

        payMethod = "Cash";
        paymentId = newPaymentId();

        renderDebt(true);

        $("#debtDialog").showModal();

    }


    function renderDebt(resetAmount){

        const d = current;
        const overdue = isOverdue(d);

        $("#debtTitle").textContent = d.pelanggan;
        $("#debtMeta").textContent = `Nota ${d.nota} · ${d.tanggal} ${d.jam} · oleh ${d.createdBy}`;

        /* Kontak & jatuh tempo: satu baris teks biasa, bukan deretan label. */
        const contact = [
            d.telepon && `<a href="tel:${escapeHtml(d.telepon.replace(/[^\d+]/g, ""))}">${escapeHtml(d.telepon)}</a>`,
            d.jatuhTempo && `<span class="${overdue ? "debt-late" : ""}">${overdue ? "Lewat jatuh tempo" : "Jatuh tempo"} ${escapeHtml(Printer.isoDate(d.jatuhTempo))}</span>`,
            d.catatan && `<span>${escapeHtml(d.catatan)}</span>`
        ].filter(Boolean).join(`<span class="muted"> · </span>`);

        const itemCount = d.items.reduce((sum, i) => sum + i.qty, 0);

        /* Angka utama: berapa yang masih harus dibayar. */
        const hero =
            d.status === "lunas"
                ? `<div class="debt-hero is-done"><span>${icon("check", "i-sm")}Lunas</span><strong class="num">${rupiah(d.total)}</strong></div>`
            : d.status === "dibatalkan"
                ? `<div class="debt-hero is-void"><span>${icon("ban", "i-sm")}Dibatalkan oleh ${escapeHtml(d.void.oleh)} · ${escapeHtml(d.void.alasan)}</span><strong class="num">${rupiah(d.total)}</strong></div>`
            : `<div class="debt-hero"><span>Sisa utang</span><strong class="num">${rupiah(d.sisa)}</strong>
                    ${d.dibayar > 0 ? `<small class="muted num">dari ${rupiah(d.total)} · sudah dibayar ${rupiah(d.dibayar)}</small>` : ""}</div>`;

        $("#debtBody").innerHTML = `
            ${contact ? `<p class="debt-contact">${contact}</p>` : ""}

            ${hero}

            <details class="debt-more">
                <summary><span>${itemCount} item</span><span class="num">${rupiah(d.total)}</span>${icon("chevron-down", "i-sm")}</summary>
                <ul class="debt-list">
                    ${d.items.map(i => `
                        <li><span>${escapeHtml(i.nama)} <span class="muted num">${i.qty} × ${rupiah(i.harga)}</span></span>
                            <span class="num">${rupiah(i.subtotal)}</span></li>`).join("")}
                </ul>
            </details>

            ${d.payments.length ? `
            <details class="debt-more">
                <summary><span>Riwayat pembayaran · ${d.payments.length}</span><span class="num">${rupiah(d.dibayar)}</span>${icon("chevron-down", "i-sm")}</summary>
                <ul class="debt-list">
                    ${d.payments.map(p => `
                        <li>
                            <span>${escapeHtml(Printer.stamp(p.at))} <span class="muted">· ${escapeHtml(p.metode)} · ${escapeHtml(p.oleh)}</span></span>
                            <span class="debt-pay-row">
                                <span class="num">${rupiah(p.jumlah)}</span>
                                <button type="button" class="btn btn-ghost btn-icon btn-sm" data-print-payment="${escapeHtml(p.id)}" aria-label="Cetak bukti pembayaran" title="Cetak bukti">${icon("printer", "i-sm")}</button>
                            </span>
                        </li>`).join("")}
                </ul>
            </details>` : ""}`;

        const canPay = d.status === "belum";

        $("#debtPayForm").hidden = !canPay;
        $("#debtVoid").hidden = !App.isSuperadmin();

        if(canPay){

            if(resetAmount){
                $("#dJumlah").value = numberFmt.format(d.sisa);
            }

            renderPayButton();

        }

    }


    function renderPayButton(){

        const amount = parseNumber($("#dJumlah").value);
        const btn = $("#debtPaySubmit");

        $$("#debtMethod button").forEach(b => b.setAttribute("aria-pressed", b.dataset.metode === payMethod));

        btn.disabled = amount <= 0 || amount > current.sisa;
        btn.innerHTML = icon("check") + (
            amount > current.sisa ? `Melebihi sisa ${rupiah(current.sisa)}`
            : amount >= current.sisa ? `Lunasi ${rupiah(amount)}`
            : `Terima ${rupiah(amount || 0)}`
        );

    }


    async function submitPayment(event){

        event.preventDefault();

        const jumlah = parseNumber($("#dJumlah").value);

        if(jumlah <= 0 || jumlah > current.sisa){
            return toast("Jumlah harus lebih dari 0 dan tidak melebihi sisa.", "error");
        }

        await busy($("#debtPaySubmit"), "Menyimpan…", async () => {

            try{

                const debt = await api(`/api/debts/${encodeURIComponent(current.id)}/payments`, {
                    method: "POST",
                    body: { paymentId, jumlah, metode: payMethod }
                });

                const payment = debt.payments.find(p => p.id === paymentId);

                /* Uang pelunasan yang diterima kasir masuk ke setorannya. */
                App.emit("debt-paid", payment);

                current = debt;
                paymentId = newPaymentId();

                replaceDebt(debt);
                render();
                renderDebt(true);

                toast(debt.status === "lunas"
                    ? `${debt.pelanggan} lunas. Pembayaran ${rupiah(jumlah)} dicatat`
                    : `Pembayaran ${rupiah(jumlah)} dicatat. Sisa ${rupiah(debt.sisa)}`, "ok", 5000);

                /* Pembayaran sudah tersimpan; cetak bukti sesudahnya. */
                const printed = await Printer.send(Printer.paymentReceipt(debt, payment));

                if(!printed.ok){
                    toast("Pembayaran tersimpan, bukti belum tercetak. Cetak dari riwayat pembayaran. " + printed.message, "error", 8000);
                }

            }catch(error){

                toast(error.message, "error");

            }

        });

    }


    async function print(content, label){

        const result = await Printer.send(content);

        toast(result.ok ? label + " dicetak" : result.message, result.ok ? "ok" : "error", result.ok ? undefined : 7000);

    }


    async function voidCurrent(event){

        event.preventDefault();

        const alasan = event.target.alasan.value.trim();

        if(!alasan){
            return toast("Tulis alasan pembatalan.", "error");
        }

        await busy($("#voidSubmit"), "Membatalkan…", async () => {

            try{

                const debt = await api(`/api/debts/${encodeURIComponent(current.id)}/void`, {
                    method: "POST",
                    body: { alasan }
                });

                current = debt;

                replaceDebt(debt);
                render();
                renderDebt(false);

                $("#voidDialog").close();
                toast(`Utang ${debt.pelanggan} (nota ${debt.nota}) dibatalkan`);

            }catch(error){

                toast(error.message, "error");

            }

        });

    }


    /* =================================================
       EVENT
       ================================================= */

    function bind(){

        $("#utangRefresh").addEventListener("click", load);

        $("#utangRows").addEventListener("click", e => {

            if(e.target.closest("[data-retry-utang]")){
                return load();
            }

            const row = e.target.closest(".debt-row[data-id]");

            if(row){
                openDebt(row.dataset.id);
            }

        });

        $("#utangSearch").addEventListener("input", e => {
            query = e.target.value;
            if(data){ render(); }
        });

        $("#utangFilter").addEventListener("click", e => {
            const chip = e.target.closest("[data-status]");
            if(chip){
                status = chip.dataset.status;
                if(data){ render(); }
            }
        });

        $("#dJumlah").addEventListener("input", e => {
            const n = parseNumber(e.target.value);
            e.target.value = n ? numberFmt.format(n) : "";
            renderPayButton();
        });

        $("#debtMethod").addEventListener("click", e => {
            const btn = e.target.closest("[data-metode]");
            if(btn){
                payMethod = btn.dataset.metode;
                renderPayButton();
            }
        });

        $("#debtPayForm").addEventListener("submit", submitPayment);

        $("#debtBody").addEventListener("click", e => {
            const btn = e.target.closest("[data-print-payment]");
            if(btn){
                const payment = current.payments.find(p => p.id === btn.dataset.printPayment);
                print(Printer.paymentReceipt(current, payment), "Bukti pembayaran");
            }
        });

        $("#debtReprint").addEventListener("click", () => print(Printer.debtInvoice(current), "Nota"));

        $("#debtVoid").addEventListener("click", () => {
            $("#voidForm").reset();
            $("#voidTitle").textContent = `Batalkan utang ${current.pelanggan}?`;
            $("#voidDialog").showModal();
        });

        $("#voidForm").addEventListener("submit", voidCurrent);

        $("#debtDialog").addEventListener("close", () => { current = null; });

        /* Utang baru terkirim dari kasir, atau kembali ke tab: perbarui (juga untuk angka di tab). */
        App.on("debts-changed", load);

        document.addEventListener("visibilitychange", () => {
            if(document.visibilityState === "visible" && Date.now() - lastLoad > 30000){
                load();
            }
        });

    }


    App.registerView("utang", { onShow: load });

    App.on("ready", () => {

        bind();

        /* Angka di tab Utang langsung terisi walau tab belum dibuka. */
        load();

    });

})();

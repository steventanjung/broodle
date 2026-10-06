/* =====================================================
   SETORAN KASIR (hanya akun kasir)
   -----------------------------------------------------
   Login  -> isi uang modal (biasanya Rp300.000), setoran dimulai.
   Jualan -> total Tunai / QRIS / Transfer dihitung di tablet.
   Keluar -> tampil total yang harus dicocokkan kasir dengan uang
             di laci & mutasi QRIS / rekening, lalu setoran ditutup.
   Setoran yang tertinggal terbuka (keluar tanpa logout) harus
   ditutup dulu di login berikutnya.
   ===================================================== */

(() => {

    const { $, icon, rupiah, numberFmt, parseNumber, api, toast, busy } = App;

    const SHIFT_KEY = "shift";
    const QUEUE_KEY = "shiftQueue";
    const DEFAULT_MODAL = 300000;

    const read = (key, fallback) => {
        try{ return JSON.parse(localStorage.getItem(key)) ?? fallback; }catch(e){ return fallback; }
    };

    let shift = read(SHIFT_KEY, null);

    const isKasir = () => App.session?.role === "kasir";
    const isOpen = () => !!shift && !shift.closedAt;

    const emptyTotals = () => ({ cash: 0, qris: 0, transfer: 0, debit: 0, grab: 0, utang: 0, cashPay: 0, qrisPay: 0, transferPay: 0, debitPay: 0, count: 0 });

    /* Uang yang seharusnya ada, per tempat. */
    const drawer   = s => s.modal + s.totals.cash + s.totals.cashPay;
    const qris     = s => s.totals.qris + s.totals.qrisPay;
    const transfer = s => s.totals.transfer + s.totals.transferPay;
    const debit    = s => (s.totals.debit || 0) + (s.totals.debitPay || 0);

    const pad = n => String(n).padStart(2, "0");
    const clock = iso => { const d = new Date(iso); return `${pad(d.getHours())}.${pad(d.getMinutes())}`; };
    const dayTime = iso => { const d = new Date(iso); return `${d.getDate()}/${d.getMonth() + 1} ${clock(iso)}`; };

    const newId = () => crypto.randomUUID ? crypto.randomUUID() : "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

    /* Penjualan di antrean offline (dipakai untuk peringatan saat keluar). */
    const unsent = () => read("pendingTransactions", []).length;

    /* Setoran dipakai kasir.js untuk menandai tiap transaksi. */
    Object.defineProperty(App, "shiftId", { get: () => isOpen() ? shift.id : null });


    /* =================================================
       SIMPAN & KIRIM
       Catatan terbaru per setoran diantrekan, lalu dikirim
       ke server; gagal (offline) = coba lagi nanti.
       ================================================= */

    function save(){

        localStorage.setItem(SHIFT_KEY, JSON.stringify(shift));

        const queue = read(QUEUE_KEY, {});
        queue[shift.id] = shift;
        localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));

        flush();

    }


    let flushing = null;

    function flush(){

        flushing ||= (async () => {

            try{

                const queue = read(QUEUE_KEY, {});

                for(const record of Object.values(queue)){

                    await api(`/api/shifts/${encodeURIComponent(record.id)}`, { method: "PUT", body: record, keepOn401: true });

                    /* Hapus dari antrean hanya kalau isinya belum berubah selama dikirim. */
                    const latest = read(QUEUE_KEY, {});
                    if(JSON.stringify(latest[record.id]) === JSON.stringify(record)){
                        delete latest[record.id];
                        localStorage.setItem(QUEUE_KEY, JSON.stringify(latest));
                    }

                }

            }catch(error){
                /* Offline / sesi habis: tetap di antrean. */
            }finally{
                flushing = null;
            }

        })();

        return flushing;

    }


    /* =================================================
       BUKA SETORAN
       ================================================= */

    function openDialog(){

        /* Mode uji (SETORAN_ASK_MODAL=false di server): langsung mulai dengan modal bawaan. */
        if(App.session?.askModal === false){
            beginShift(DEFAULT_MODAL);
            return;
        }

        const form = $("#shiftOpenForm");

        form.reset();
        form.modal.value = numberFmt.format(DEFAULT_MODAL);

        $("#shiftOpenDialog").showModal();

    }


    function startShift(event){

        event.preventDefault();

        beginShift(parseNumber(event.target.modal.value));

        $("#shiftOpenDialog").close();

        toast(`Setoran dimulai dengan modal ${rupiah(shift.modal)}`);

    }


    function beginShift(modal){

        shift = {
            id: newId(),
            kasir: App.session.username,
            openedAt: new Date().toISOString(),
            modal,
            totals: emptyTotals(),
            closedAt: null
        };

        save();
        renderTotalan();

    }


    /* =================================================
       TUTUP SETORAN
       mode "logout"  : tombol Keluar / Tutup kasir
       mode "leftover": setoran lama belum ditutup saat login
       ================================================= */

    let closeMode = "logout";

    /*
     * Angka utama = total diterima semua metode. Tunai ikut di daftar
     * seperti metode lain; modal & "uang di laci" (tunai + modal, yang
     * dicocokkan dengan laci) di bagian bawah, lebih kecil.
     */
    function summaryHtml(s){

        const cash = s.totals.cash + s.totals.cashPay;
        const received = cash + qris(s) + transfer(s) + debit(s);

        return `
            <div class="shift-sum">
                <div class="shift-main">
                    <span>Total diterima</span>
                    <strong class="num">${rupiah(received)}</strong>
                </div>
                <div class="shift-row"><span>${icon("cash", "i-sm")}Tunai</span><strong class="num">${rupiah(cash)}</strong></div>
                <div class="shift-row"><span>${icon("qr", "i-sm")}QRIS</span><strong class="num">${rupiah(qris(s))}</strong></div>
                <div class="shift-row"><span>${icon("bank", "i-sm")}Transfer BCA</span><strong class="num">${rupiah(transfer(s))}</strong></div>
                <div class="shift-row"><span>${icon("card", "i-sm")}Debit</span><strong class="num">${rupiah(debit(s))}</strong></div>
                ${s.totals.grab ? `<div class="shift-row"><span>${icon("bike", "i-sm")}Grab <span class="muted small">dicairkan Grab, di luar total</span></span><strong class="num">${rupiah(s.totals.grab)}</strong></div>` : ""}
                <div class="shift-foot">
                    <div><span>Modal awal</span><span class="num">${rupiah(s.modal)}</span></div>
                    <div><span>Uang di laci seharusnya <span class="muted">(tunai + modal)</span></span><b class="num">${rupiah(drawer(s))}</b></div>
                </div>
            </div>`;

    }


    function openClose(mode){

        closeMode = mode;

        const leftover = mode === "leftover";
        const waiting = unsent();

        $("#shiftCloseTitle").textContent = leftover ? "Setoran sebelumnya belum ditutup" : "Tutup kasir";

        $("#shiftCloseBody").innerHTML = `
            <p class="dialog-msg">${leftover
                ? `Setoran ${shift.kasir === App.session.username ? "Anda" : `<b>${App.escapeHtml(shift.kasir)}</b>`} sejak ${dayTime(shift.openedAt)} belum ditutup. Cocokkan totalnya, lalu tutup sebelum mulai setoran baru.`
                : "Cocokkan dengan uang di laci, mutasi QRIS / BCA, dan struk EDC sebelum keluar."}</p>
            ${summaryHtml(shift)}
            ${waiting && !leftover ? `<div class="notice notice-warn">${icon("upload")}<span>${waiting} penjualan belum terkirim. Pastikan internet tersambung sebelum keluar.</span></div>` : ""}`;

        $("#shiftCloseSubmit").textContent = leftover ? "Tutup setoran ini" : "Tutup kasir & keluar";
        $("#shiftCloseCancel").hidden = leftover;

        $("#shiftCloseDialog").showModal();

    }


    async function closeShift(event){

        event.preventDefault();

        await busy($("#shiftCloseSubmit"), "Menutup…", async () => {

            shift.closedAt = new Date().toISOString();
            save();

            /* Coba kirim sekarang, tapi jangan sampai kasir tertahan kalau internet lambat. */
            await Promise.race([flush(), new Promise(r => setTimeout(r, 4000))]);

        });

        $("#shiftCloseDialog").close();

        if(closeMode === "leftover"){
            toast("Setoran sebelumnya ditutup");
            openDialog();
            return;
        }

        App.logout();

    }


    /* =================================================
       TOTAL BERJALAN
       ================================================= */

    const SALE_KEY = { Cash: "cash", QRIS: "qris", "Transfer BCA": "transfer", Transfer: "transfer", Debit: "debit", Grab: "grab", Utang: "utang" };
    const PAY_KEY = { Cash: "cashPay", QRIS: "qrisPay", "Transfer BCA": "transferPay", Transfer: "transferPay", Debit: "debitPay" };

    App.on("sale-recorded", tx => {

        /* Dibagi 2 metode: tiap bagian masuk ke metodenya sendiri. */
        const parts = Array.isArray(tx.pembayaranBagi)
            ? tx.pembayaranBagi
            : [{ metode: tx.pembayaran, jumlah: tx.total }];

        if(!isKasir() || !isOpen() || !parts.every(p => SALE_KEY[p.metode])){
            return;
        }

        parts.forEach(p => {
            shift.totals[SALE_KEY[p.metode]] = (shift.totals[SALE_KEY[p.metode]] || 0) + p.jumlah;
        });
        shift.totals.count += 1;

        save();
        renderTotalan();

    });

    App.on("debt-paid", payment => {

        if(!isKasir() || !isOpen() || !PAY_KEY[payment?.metode]){
            return;
        }

        shift.totals[PAY_KEY[payment.metode]] = (shift.totals[PAY_KEY[payment.metode]] || 0) + payment.jumlah;

        save();
        renderTotalan();

    });


    function renderTotalan(){

        if(!isOpen()){
            $("#totalanBody").innerHTML = `<div class="empty">${icon("cash")}Belum ada setoran yang dibuka.</div>`;
            return;
        }

        const t = shift.totals;

        $("#totalanMeta").textContent =
            `Dibuka ${clock(shift.openedAt)} · ${t.count} transaksi` + (t.utang ? ` · utang diberikan ${rupiah(t.utang)}` : "");

        $("#totalanBody").innerHTML = summaryHtml(shift);

    }


    /* =================================================
       MULAI
       ================================================= */

    App.registerView("totalan", { onShow: renderTotalan });

    App.on("logout-request", () => {
        if(isKasir() && isOpen()){
            openClose("logout");
        }else if(isKasir()){
            App.logout();
        }
    });

    /* Menutup tab / browser saat setoran masih terbuka: peringatan bawaan browser. */
    window.addEventListener("beforeunload", e => {
        if(isKasir() && isOpen() && !App.leaving){
            e.preventDefault();
            e.returnValue = "";
        }
    });

    App.on("ready", () => {

        /* Setoran tertunda dari kasir lain di tablet ini ikut terkirim walau yang login superadmin. */
        flush();

        $(".tab[data-view=totalan]").hidden = !isKasir();

        if(!isKasir()){
            return;
        }

        $("#shiftOpenForm").addEventListener("submit", startShift);
        $("#shiftCloseForm").addEventListener("submit", closeShift);
        $("#totalanClose").addEventListener("click", () => openClose("logout"));

        $("#shiftOpenForm").modal.addEventListener("input", e => {
            const n = parseNumber(e.target.value);
            e.target.value = n ? numberFmt.format(n) : "";
        });

        /* Dialog buka/tutup setoran wajib: Esc tidak menutupnya. */
        $("#shiftOpenDialog").addEventListener("cancel", e => e.preventDefault());
        $("#shiftCloseDialog").addEventListener("cancel", e => { if(closeMode === "leftover"){ e.preventDefault(); } });

        const fresh = localStorage.getItem("freshLogin") === "1";
        localStorage.removeItem("freshLogin");

        if(isOpen() && fresh){
            openClose("leftover");
        }else if(!isOpen()){
            openDialog();
        }

        renderTotalan();

    });

})();

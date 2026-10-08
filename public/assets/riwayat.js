/* =====================================================
   RIWAYAT NOTA
   Nota yang sudah lunas: lihat, ubah (jumlah item / metode bayar)
   dan batalkan. Kasir hanya melihat nota setorannya sendiri dan
   wajib password koreksi dari superadmin; superadmin melihat semua
   tanggal tanpa password. Semua dijaga juga di server.
   ===================================================== */

(() => {

    const { $, $$, icon, escapeHtml, rupiah, numberFmt, parseNumber, api, toast, busy } = App;

    const METHODS = ["Cash", "QRIS", "Transfer BCA", "Debit"];

    let data = null;
    let query = "";
    let status = "semua";
    let current = null;

    /* Mode dialog: "view" | "edit" | "cancel". Draft = isian formulir ubah. */
    let mode = "view";
    let draft = null;

    /* Langkah persetujuan kasir: mode form asal & alasan yang sudah diisi. */
    let returnMode = "edit";
    let reason = "";

    const isKasir = () => App.session?.role === "kasir";

    /* "2× Roti, 1× Kopi +3 lainnya" */
    function preview(sale){
        const shown = sale.items.slice(0, 2).map(i => `${i.qty}× ${i.nama}`).join(", ");
        return sale.items.length > 2 ? `${shown} +${sale.items.length - 2} lainnya` : shown;
    }

    const itemCount = sale => sale.items.reduce((sum, i) => sum + i.qty, 0);


    /* =================================================
       DATA
       ================================================= */

    function url(){

        if(isKasir()){
            return "/api/sales?setoran=" + encodeURIComponent(App.shiftId || "");
        }

        const from = $("#riwayatFrom").value;
        const to = $("#riwayatTo").value;

        return `/api/sales?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

    }


    async function load(){

        const btn = $("#riwayatRefresh");
        btn.disabled = true;
        btn.classList.add("is-loading");

        if(!data){
            $("#riwayatRows").innerHTML = `<div class="loading-row" style="padding:24px"><span class="spinner" aria-hidden="true"></span>Memuat nota…</div>`;
        }

        try{

            data = await api(url());
            render();

        }catch(error){

            if(!data){
                $("#riwayatRows").innerHTML = `<div class="empty">${icon("wifi-off")}${escapeHtml(error.message)}</div>`;
            }else{
                toast(error.message, "error");
            }

        }finally{

            btn.disabled = false;
            btn.classList.remove("is-loading");

        }

    }


    function render(){

        const q = query.trim().toLowerCase();

        /* Ringkasan mengikuti rentang tanggal, bukan pencarian/filter. */
        const live = data.sales.filter(s => s.status === "aktif");

        $("#riwayatCount").textContent = numberFmt.format(live.length);
        $("#riwayatSum").textContent = rupiah(live.reduce((sum, s) => sum + s.total, 0));
        $("#riwayatVoid").textContent = numberFmt.format(data.sales.length - live.length);

        const matchStatus = s => status === "semua" ? true
            : status === "diubah" ? s.status === "aktif" && s.history.length > 0
            : s.status === (status === "aktif" ? "aktif" : "batal");

        const list = data.sales.filter(s => matchStatus(s) && (
            !q || String(s.nota).includes(q) || s.items.some(i => i.nama.toLowerCase().includes(q)) || s.pembayaran.toLowerCase().includes(q)));

        if(list.length === 0){

            const message = q ? `Tidak ada nota yang cocok dengan "${escapeHtml(query)}".`
                : status !== "semua" ? "Tidak ada nota dengan status ini."
                : isKasir() ? "Belum ada nota di setoran ini."
                : "Tidak ada nota pada tanggal ini.";

            $("#riwayatRows").innerHTML = `<div class="empty">${icon(q ? "search" : "receipt")}<span>${message}</span></div>`;
            return;

        }

        $("#riwayatRows").innerHTML = list.map(s => {

            const badges = [
                s.status === "batal" && `<span class="badge badge-danger">${icon("ban", "i-sm")}Dibatalkan</span>`,
                s.status === "aktif" && s.history.length > 0 && `<span class="badge badge-warn">${icon("pencil", "i-sm")}Diubah</span>`,
                `<span class="badge ${s.status === "batal" ? "" : "badge-accent"}">${escapeHtml(s.pembayaran)}</span>`
            ].filter(Boolean).join(" ");

            return `
                <button type="button" class="row debt-row ${s.status === "batal" ? "is-void" : ""}" data-id="${escapeHtml(s.id)}">
                    <div class="avatar">${icon("receipt")}</div>
                    <div class="row-main">
                        <span class="row-title">Nota ${escapeHtml(s.nota)} ${badges}</span>
                        <span class="row-sub rw-items">${escapeHtml(preview(s))}</span>
                        <span class="row-sub">${escapeHtml(s.tanggal)} ${escapeHtml(s.jam)} · ${itemCount(s)} item${isKasir() ? "" : " · " + escapeHtml(s.kasir)}</span>
                    </div>
                    <div class="debt-amount"><strong class="num"${s.status === "batal" ? ` style="text-decoration:line-through"` : ""}>${rupiah(s.total)}</strong></div>
                </button>`;

        }).join("");

    }


    /* =================================================
       DIALOG
       ================================================= */

    function open(id){

        current = data.sales.find(s => s.id === id);

        if(!current){
            return;
        }

        mode = "view";
        renderDialog();
        $("#saleDialog").showModal();

    }


    const itemsHtml = sale => `
        <ul class="debt-list">
            ${sale.items.map(i => `
                <li><span>${escapeHtml(i.nama)} <span class="muted num">${i.qty} × ${rupiah(i.harga)}</span></span>
                    <span class="num">${rupiah(i.subtotal)}</span></li>`).join("")}
        </ul>`;


    /* Kasir butuh password koreksi, tapi diminta lewat dialog persetujuan saat kirim. */
    function authFields(){

        if(!isKasir() || data.passwordSet){
            return "";
        }

        return `<div class="notice notice-info">${icon("lock")}<span>Password koreksi belum diatur. Minta superadmin mengaturnya di Pengaturan.</span></div>`;

    }


    const reasonField = label => `
        <div class="field">
            <label class="label" for="saleReason">${label}</label>
            <input id="saleReason" name="alasan" class="input" maxlength="200" required placeholder="mis. salah input jumlah, pelanggan batal">
        </div>`;


    function renderDialog(){

        const s = current;

        $("#saleTitle").textContent = "Nota " + s.nota;
        $("#saleMeta").textContent = `${s.tanggal} ${s.jam} · ${s.kasir}`;
        $("#saleReprint").hidden = s.status !== "aktif";

        const locked = isKasir() && !data.passwordSet;

        if(mode === "view"){

            const last = s.history[s.history.length - 1];

            $("#saleBody").innerHTML = `
                ${s.status === "batal"
                    ? `<div class="debt-hero is-void"><span>${icon("ban", "i-sm")}Dibatalkan oleh ${escapeHtml(s.cancelledBy)} · ${escapeHtml(s.cancelReason)}</span><strong class="num">${rupiah(s.total)}</strong></div>`
                    : `<div class="debt-hero is-done"><span>${icon("check", "i-sm")}Lunas · ${escapeHtml(s.pembayaran)}</span><strong class="num">${rupiah(s.total)}</strong></div>`}
                ${itemsHtml(s)}
                ${s.status === "aktif" && s.history.length ? `<p class="small muted">Terakhir diubah oleh ${escapeHtml(s.history[s.history.length - 1].oleh)}: ${escapeHtml(last.alasan)}</p>` : ""}
                ${s.history.length ? `
                <details class="debt-more">
                    <summary><span>Riwayat perubahan · ${s.history.length}</span>${icon("chevron-down", "i-sm")}</summary>
                    <ul class="debt-list">
                        ${s.history.map(h => `
                            <li><span>${escapeHtml(Printer.stamp(h.at))} <span class="muted">· ${h.aksi === "batal" ? "dibatalkan" : "diubah"} oleh ${escapeHtml(h.oleh)} · ${escapeHtml(h.alasan)}</span></span>
                                <span class="num">${rupiah(h.total)}</span></li>`).join("")}
                    </ul>
                </details>` : ""}`;

            $("#saleFoot").innerHTML = s.status !== "aktif" ? `<button type="button" class="btn" data-close>Tutup</button>` : `
                <button type="button" class="btn btn-solid-danger" data-sale="cancel" ${locked ? "disabled" : ""}>${icon("ban", "i-sm")}Batalkan nota</button>
                ${s.editable
                    ? `<button type="button" class="btn btn-primary" data-sale="edit" ${locked ? "disabled" : ""}>${icon("pencil", "i-sm")}Ubah nota</button>`
                    : `<span class="small muted" style="align-self:center">Nota ${escapeHtml(s.pembayaran)}/bagi 2 metode: batalkan lalu catat ulang untuk mengubah.</span>`}`;

            if(locked){
                $("#saleBody").insertAdjacentHTML("beforeend", authFields());
            }

            return;

        }

        if(mode === "cancel"){

            $("#saleBody").innerHTML = `
                <p class="dialog-msg">Nota <b>${escapeHtml(s.nota)}</b> (${rupiah(s.total)}) tidak dihitung lagi di Totalan dan Laporan. Baris di Google Sheets tidak dihapus.</p>
                ${reasonField("Alasan pembatalan")}
                ${authFields()}`;

            if(reason){ $("#saleReason").value = reason; }

            $("#saleFoot").innerHTML = `
                <button type="button" class="btn" data-sale="back">Kembali</button>
                <button id="saleSubmit" type="submit" class="btn btn-solid-danger">Ya, batalkan</button>`;

            return;

        }

        if(mode === "approve"){

            const newTotal = returnMode === "cancel" ? s.total
                : draft.qty.reduce((sum, n, i) => sum + n * s.items[i].harga, 0);

            $("#saleBody").innerHTML = `
                <div class="notice notice-info">${icon("lock")}<span>Minta superadmin memasukkan password koreksi untuk menyetujui.</span></div>
                <ul class="debt-list">
                    <li><span>${returnMode === "cancel" ? "Batalkan nota" : "Ubah nota"}</span><span class="num">${rupiah(newTotal)}</span></li>
                    <li><span>Alasan</span><span>${escapeHtml(reason)}</span></li>
                </ul>
                <div class="field">
                    <label class="label" for="saleSecret">Password koreksi</label>
                    <input id="saleSecret" name="secret" class="input" type="password" data-no-reveal autocomplete="off" required>
                </div>`;

            $("#saleFoot").innerHTML = `
                <button type="button" class="btn" data-sale="back">Kembali</button>
                <button id="saleSubmit" type="submit" class="btn ${returnMode === "cancel" ? "btn-solid-danger" : "btn-primary"}">Setujui &amp; simpan</button>`;

            $("#saleSecret").focus();

            return;

        }

        /* edit */
        const total = draft.qty.reduce((sum, n, i) => sum + n * s.items[i].harga, 0);
        const cashShort = draft.metode === "Cash" && draft.cash < total;

        $("#saleBody").innerHTML = `
            ${s.items.map((i, n) => `
                <div class="line" data-i="${n}">
                    <span class="line-name">${escapeHtml(i.nama)} <span class="muted num">${rupiah(i.harga)}</span></span>
                    <div class="stepper">
                        <button type="button" data-step="-1" aria-label="Kurangi">${icon(draft.qty[n] <= 1 ? "trash" : "minus", "i-sm")}</button>
                        <input type="number" class="num" min="0" max="999" inputmode="numeric" value="${draft.qty[n]}" aria-label="Jumlah">
                        <button type="button" data-step="1" aria-label="Tambah">${icon("plus", "i-sm")}</button>
                    </div>
                </div>`).join("")}
            <div class="debt-totals"><div class="debt-sisa"><span>Total baru</span><strong class="num" id="saleNewTotal">${rupiah(total)}</strong></div></div>

            <span class="label">Dibayar dengan</span>
            <div id="saleMethod" class="segmented" role="group" aria-label="Metode pembayaran">
                ${METHODS.map(m => `<button type="button" data-metode="${m}" aria-pressed="${m === draft.metode}">${m}</button>`).join("")}
            </div>

            ${draft.metode === "Cash" ? `
            <div class="field">
                <label class="label" for="saleCash">Uang diterima</label>
                <input id="saleCash" class="input num" inputmode="numeric" value="${draft.cash ? numberFmt.format(draft.cash) : ""}" autocomplete="off">
                <span id="saleChange" class="small ${cashShort ? "debt-late" : "muted"}">${cashShort ? "Uang diterima kurang dari total." : "Kembalian " + rupiah(draft.cash - total)}</span>
            </div>` : ""}

            ${reasonField("Alasan perubahan")}
            ${authFields()}`;

        $("#saleFoot").innerHTML = `
            <button type="button" class="btn" data-sale="back">Kembali</button>
            <button id="saleSubmit" type="submit" class="btn btn-primary" ${cashShort ? "disabled" : ""}>Simpan perubahan</button>`;

        /* Isian alasan / password tidak hilang saat total dihitung ulang. */
        if(draft.alasan){ $("#saleReason").value = draft.alasan; }

    }


    /* Hitung ulang total & tombol tanpa menggambar ulang formulir (supaya fokus ketikan tetap). */
    function refreshEdit(){

        const total = draft.qty.reduce((sum, n, i) => sum + n * current.items[i].harga, 0);

        $("#saleNewTotal").textContent = rupiah(total);

        const short = draft.metode === "Cash" && draft.cash < total;

        if(draft.metode === "Cash"){
            $("#saleChange").textContent = short ? "Uang diterima kurang dari total." : "Kembalian " + rupiah(draft.cash - total);
            $("#saleChange").className = "small " + (short ? "debt-late" : "muted");
        }

        $("#saleSubmit").disabled = short || total <= 0;

    }


    function startEdit(){

        draft = {
            qty: current.items.map(i => i.qty),
            metode: current.pembayaran,
            cash: current.pembayaran === "Cash" ? current.cashReceived : 0,
            alasan: ""
        };

        mode = "edit";
        renderDialog();

    }


    function setQty(i, value){

        draft.qty[i] = Math.max(0, Math.min(999, Number.isFinite(value) ? value : 0));

        /* Hapus item = 0; ikon & kolom jumlah ikut diperbarui. */
        const input = $(`#saleBody .line[data-i="${i}"] input`);
        input.value = draft.qty[i];
        $(`#saleBody .line[data-i="${i}"] [data-step="-1"]`).innerHTML = icon(draft.qty[i] <= 1 ? "trash" : "minus", "i-sm");

        refreshEdit();

    }


    /* =================================================
       KIRIM
       ================================================= */

    async function submit(event){

        event.preventDefault();

        if(mode === "view"){
            return;
        }

        const form = event.target;
        const approving = mode === "approve";
        const alasan = approving ? reason : form.alasan.value.trim();

        if(!alasan){
            return toast("Isi alasannya.", "error");
        }

        const before = current;
        const cancelling = (approving ? returnMode : mode) === "cancel";

        let body = { alasan, password: "" };

        if(!cancelling){

            const total = draft.qty.reduce((sum, n, i) => sum + n * current.items[i].harga, 0);

            if(total <= 0){
                return toast("Nota harus punya minimal satu item. Untuk menghapus semuanya, batalkan nota.", "error");
            }

            body = { ...body, qty: draft.qty, pembayaran: draft.metode, cashReceived: draft.metode === "Cash" ? draft.cash : 0 };

        }

        /* Kasir: setelah isian lengkap, dialog yang sama pindah ke langkah persetujuan superadmin. */
        if(isKasir() && !approving){

            reason = alasan;
            returnMode = mode;

            if(!cancelling){
                draft.alasan = alasan;
            }

            mode = "approve";
            renderDialog();

            return;

        }

        if(approving){

            if(!form.secret.value){
                form.secret.focus();
                return toast("Isi password koreksi.", "error");
            }

            body.password = form.secret.value;

        }

        await busy($("#saleSubmit"), "Menyimpan…", async () => {

            try{

                const sale = await api(`/api/sales/${encodeURIComponent(current.id)}/${cancelling ? "cancel" : "edit"}`, {
                    method: "POST",
                    body
                });

                const i = data.sales.findIndex(s => s.id === sale.id);

                if(i >= 0){
                    data.sales[i] = sale;
                }

                current = sale;
                mode = "view";
                reason = "";

                render();
                renderDialog();

                App.emit("sale-corrected", { before, after: cancelling ? null : sale });

                toast(cancelling ? `Nota ${sale.nota} dibatalkan` : `Nota ${sale.nota} diubah`);

                if(!cancelling){
                    offerReprint(sale);
                }

            }catch(error){

                toast(error.message, "error");

                if(form.secret){
                    form.secret.value = "";
                    form.secret.focus();
                }

            }

        });

    }


    async function offerReprint(sale){

        const ok = await App.confirmDialog({
            title: "Cetak nota yang sudah diubah?",
            message: `Nota ${sale.nota} sekarang ${rupiah(sale.total)}. Cetak ulang supaya nota pelanggan sama dengan catatan.`,
            confirmText: "Cetak"
        });

        if(ok){
            reprint();
        }

    }


    async function reprint(){

        const result = await Printer.send(Printer.saleReceipt({ ...current, reprint: true }));

        toast(result.ok ? "Nota dicetak" : result.message, result.ok ? "ok" : "error");

    }


    /* =================================================
       EVENT
       ================================================= */

    function bind(){

        const today = new Date().toLocaleDateString("sv-SE");

        $("#riwayatFrom").value = today;
        $("#riwayatTo").value = today;
        $("#riwayatRange").hidden = isKasir();

        $("#riwayatTo").min = $("#riwayatFrom").value;

        $("#riwayatRefresh").addEventListener("click", load);

        $("#riwayatRange").addEventListener("change", e => {

            const from = $("#riwayatFrom");
            const to = $("#riwayatTo");

            /* Tanggal akhir tidak boleh sebelum tanggal mulai. */
            to.min = from.value;

            if(from.value && to.value && to.value < from.value){
                to.value = from.value;
            }

            if(!from.value || !to.value){
                return;
            }

            load();

        });

        $("#riwayatFilter").addEventListener("click", e => {
            const chip = e.target.closest("[data-status]");
            if(!chip){ return; }
            status = chip.dataset.status;
            $$("#riwayatFilter .chip").forEach(c => c.setAttribute("aria-pressed", String(c === chip)));
            if(data){ render(); }
        });

        $("#riwayatSearch").addEventListener("input", e => {
            query = e.target.value;
            if(data){ render(); }
        });

        $("#riwayatRows").addEventListener("click", e => {
            const row = e.target.closest("[data-id]");
            if(row){ open(row.dataset.id); }
        });

        $("#saleReprint").addEventListener("click", reprint);
        $("#saleForm").addEventListener("submit", submit);

        $("#saleFoot").addEventListener("click", e => {

            const btn = e.target.closest("[data-sale]");

            if(!btn){
                return;
            }

            if(btn.dataset.sale === "edit"){
                startEdit();
            }else if(btn.dataset.sale === "cancel"){
                mode = "cancel";
                reason = "";
                renderDialog();
            }else{
                mode = mode === "approve" ? returnMode : "view";
                renderDialog();
            }

        });

        $("#saleBody").addEventListener("click", e => {

            const step = e.target.closest("[data-step]");

            if(step && mode === "edit"){
                const i = Number(step.closest(".line").dataset.i);
                setQty(i, draft.qty[i] + Number(step.dataset.step));
                return;
            }

            const method = e.target.closest("[data-metode]");

            if(method && mode === "edit"){
                draft.alasan = $("#saleReason").value;
                draft.metode = method.dataset.metode;
                if(draft.metode === "Cash" && !draft.cash){
                    draft.cash = draft.qty.reduce((sum, n, i) => sum + n * current.items[i].harga, 0);
                }
                renderDialog();
            }

        });

        $("#saleBody").addEventListener("change", e => {

            if(mode === "edit" && e.target.matches(".stepper input")){
                setQty(Number(e.target.closest(".line").dataset.i), parseInt(e.target.value, 10));
            }

        });

        $("#saleBody").addEventListener("input", e => {

            if(mode === "edit" && e.target.id === "saleCash"){
                const n = parseNumber(e.target.value);
                e.target.value = n ? numberFmt.format(n) : "";
                draft.cash = n;
                refreshEdit();
            }

        });

        $("#saleDialog").addEventListener("close", () => { current = null; draft = null; mode = "view"; reason = ""; });

        /* Nota baru dari kasir: daftar ikut diperbarui saat tab dibuka lagi. */
        App.on("sale-recorded", () => { data = null; });

    }


    App.registerView("riwayat", { onShow: load });

    App.on("ready", bind);

})();

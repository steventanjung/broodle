/* =====================================================
   LAPORAN (superadmin)
   ===================================================== */

(() => {

    const { $, $$, icon, escapeHtml, rupiah, numberFmt, api } = App;


    /*
     * Data mentah disimpan di memori: ganti rentang
     * tanggal cukup memfilter ulang, tidak perlu
     * mengambil seluruh sheet lagi. Tombol "Muat ulang"
     * memaksa ambil data terbaru.
     */
    let rows = null;

    /* Data utang dari server (untuk Uang masuk & Piutang berjalan). null = tidak bisa dimuat. */
    let debtData = null;

    /* Setoran kasir (semua), difilter sesuai rentang tanggal saat ditampilkan. */
    let shiftData = [];
    let preset = "30";


    /* =================================================
       TANGGAL & JAM
       ================================================= */

    const pad = n => String(n).padStart(2, "0");

    const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

    const fromISO = s => new Date(s + "T00:00:00");

    const fmtShort = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short" });
    const fmtLong  = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "long", year: "numeric" });


    /* Sheet: "17/9/2026" -> "2026-09-17" */
    function normalizeDate(value){

        const str = String(value ?? "").trim();
        const parts = str.split("/");

        if(parts.length === 3){
            return `${parts[2]}-${pad(parts[1])}-${pad(parts[0])}`;
        }

        /*
         * Sel tanggal di Google Sheets dikirim sebagai waktu UTC dari tengah
         * malam di zona waktu sheet (mis. "2026-06-09T16:00:00.000Z" untuk
         * GMT+8). +12 jam lalu ambil tanggal UTC = tanggal sel itu, apa pun
         * zona waktunya (GMT-12 s/d +12).
         */
        if(/^\d{4}-\d{2}-\d{2}T/.test(str)){
            return new Date(Date.parse(str) + 12 * 3600 * 1000).toISOString().slice(0, 10);
        }

        return str;

    }


    /*
     * transactionId = "<waktu Date.now() saat Bayar>-<acak>". Itu waktu
     * jual yang pasti benar, tidak terpengaruh pengaturan lokal / zona
     * waktu Google Sheets (yang bisa membaca 6/10 sebagai 10 Juni).
     */
    function saleMoment(row){

        const ms = Number(String(row.transactionId || "").split("-")[0]);

        return ms > 1.5e12 && ms < 4e12 ? new Date(ms) : null;

    }


    /*
     * Kolom "Jam" tersimpan sebagai angka HH.MM
     * (12.33 -> 12:33, 9.5 -> 09:50), atau string ISO /
     * "HH:MM" kalau Sheets mengubah tipe selnya.
     */
    function formatTime(value){

        if(value === null || value === undefined || value === ""){
            return "-";
        }

        const str = String(value);

        const iso = str.match(/T(\d{2}):(\d{2})/);
        if(iso){
            return `${iso[1]}:${iso[2]}`;
        }

        if(str.includes(":")){
            const [h, m] = str.split(":");
            return `${pad(h)}:${pad(m || "0")}`;
        }

        if(!isNaN(Number(str))){
            /* Split string, bukan aritmatika float (12.33 - 12 = 0.3299...). */
            const [h, m = "0"] = str.split(".");
            return `${pad(h)}:${(m + "00").slice(0, 2)}`;
        }

        return str;

    }


    /* =================================================
       DATA
       ================================================= */

    async function fetchRows(refresh){

        const payload = await api("/api/report" + (refresh ? "?refresh=1" : ""));

        /* doGet: { status, data } atau langsung array. */
        if(payload?.status === "error"){
            throw new Error(payload.message || "Gagal mengambil data.");
        }

        const data = Array.isArray(payload) ? payload : payload?.data;

        if(!Array.isArray(data)){
            throw new Error("Format data dari Google Sheets tidak valid.");
        }

        return data;

    }


    /*
     * Satu baris sheet = satu item. Dikelompokkan jadi
     * transaksi lewat transactionId; baris lama tanpa
     * transactionId jatuh ke tanggal+nota.
     */
    function groupTransactions(data, from, to){

        const groups = new Map();

        data.forEach(row => {

            const moment = saleMoment(row);
            const shop = moment && App.shopTime(moment);
            const date = shop ? shop.iso : normalizeDate(row.tanggal);

            if(date < from || date > to){
                return;
            }

            const key = row.transactionId ? "tx:" + row.transactionId : `legacy:${date}|${row.nota}`;

            let t = groups.get(key);

            if(!t){
                t = {
                    date,
                    time: shop ? shop.hhmm : formatTime(row.jam),
                    payment: String(row.pembayaran || "").trim().toUpperCase(),
                    nota: row.nota,
                    total: 0,
                    items: []
                };
                groups.set(key, t);
            }

            /* Subtotal diambil dari sheet (harga saat transaksi), bukan dihitung ulang. */
            const subtotal = Number(row.subtotal) || 0;

            t.total += subtotal;
            t.items.push({
                product: row.nama || "(Tanpa nama)",
                qty: Number(row.qty) || 0,
                price: Number(row.harga) || 0,
                subtotal
            });

        });

        /* Terbaru di atas — yang paling sering dicari admin. */
        return [...groups.values()].sort((a, b) =>
            a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.time.localeCompare(a.time));

    }


    /* "CASH 25000 + QRIS 25000" -> [{payment:"CASH", amount:25000}, ...]; bukan bagi -> null. */
    const SPLIT_PATTERN = /^(.+?) (\d+) \+ (.+?) (\d+)$/;

    function splitParts(payment){
        const m = SPLIT_PATTERN.exec(payment);
        return m ? [{ payment: m[1], amount: Number(m[2]) }, { payment: m[3], amount: Number(m[4]) }] : null;
    }


    function aggregate(transactions, from, to){

        let total = 0, cash = 0, qris = 0, transfer = 0, debit = 0, grab = 0, utang = 0, items = 0;

        const byDay = new Map();
        const byHour = new Map();
        const byProduct = new Map();

        transactions.forEach(t => {

            total += t.total;

            /* Dibagi 2 metode: tiap bagian dihitung ke metodenya. */
            (splitParts(t.payment) || [{ payment: t.payment, amount: t.total }]).forEach(({ payment, amount }) => {
                if(payment === "CASH") cash += amount;
                if(payment === "QRIS") qris += amount;
                if(payment === "TRANSFER" || payment === "TRANSFER BCA") transfer += amount;
                if(payment === "DEBIT") debit += amount;
                if(payment === "GRAB") grab += amount;
                if(payment === "UTANG") utang += amount;
            });

            byDay.set(t.date, (byDay.get(t.date) || 0) + t.total);

            const hour = parseInt(t.time, 10);
            if(!isNaN(hour)){
                byHour.set(hour, (byHour.get(hour) || 0) + t.total);
            }

            t.items.forEach(item => {
                items += item.qty;
                const p = byProduct.get(item.product) || { qty: 0, subtotal: 0 };
                p.qty += item.qty;
                p.subtotal += item.subtotal;
                byProduct.set(item.product, p);
            });

        });

        /*
         * Satu hari -> tren per jam. Lebih dari satu hari ->
         * per tanggal, termasuk hari tanpa penjualan supaya
         * garisnya tidak melompati hari kosong.
         */
        let trend;

        if(from === to){

            const hours = [...byHour.keys()];
            const start = Math.min(8, ...hours);
            const end = Math.max(21, ...hours);

            trend = [];
            for(let h = start; h <= end; h++){
                trend.push({ label: pad(h) + ":00", tip: `${pad(h)}:00 – ${pad(h)}:59`, value: byHour.get(h) || 0 });
            }

        }else{

            trend = [];
            for(let d = fromISO(from); d <= fromISO(to); d = addDays(d, 1)){
                const key = toISO(d);
                trend.push({ label: fmtShort.format(d), tip: fmtLong.format(d), value: byDay.get(key) || 0 });
            }

        }

        const products = [...byProduct.entries()]
            .map(([product, v]) => ({ product, ...v }))
            .sort((a, b) => b.subtotal - a.subtotal);

        return {
            total, cash, qris, transfer, debit, grab, utang, items, trend, products,
            count: transactions.length,
            average: transactions.length ? total / transactions.length : 0
        };

    }


    /* Lebih dari 8 produk: sisanya dilipat jadi "Lainnya". */
    function foldTop(products, limit){

        if(products.length <= limit){
            return products;
        }

        const rest = products.slice(limit);

        return [
            ...products.slice(0, limit),
            {
                product: `Lainnya (${rest.length})`,
                qty: rest.reduce((a, p) => a + p.qty, 0),
                subtotal: rest.reduce((a, p) => a + p.subtotal, 0),
                other: true
            }
        ];

    }


    function niceCeiling(value){

        if(value <= 0){
            return 0;
        }

        const mag = Math.pow(10, Math.floor(Math.log10(value)));
        const n = value / mag;

        return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;

    }

    /* 1.500.000 -> "1,5jt", 250.000 -> "250rb" untuk label sumbu. */
    function compactRupiah(n){

        if(n >= 1e6) return numberFmt.format(+(n / 1e6).toFixed(1)) + "jt";
        if(n >= 1e3) return numberFmt.format(Math.round(n / 1e3)) + "rb";
        return String(n);

    }


    /* =================================================
       TOOLTIP (isi selalu lewat textContent)
       ================================================= */

    let tooltip = null;

    const isTouch = ev => ev.pointerType === "touch" || ev.pointerType === "pen";

    function showTip(ev, title, value){

        if(!tooltip){
            tooltip = document.createElement("div");
            tooltip.className = "tooltip";
            tooltip.innerHTML = "<div></div><b></b>";
            document.body.appendChild(tooltip);
        }

        tooltip.firstChild.textContent = title;
        tooltip.lastChild.textContent = value;
        tooltip.style.display = "block";

        const w = tooltip.offsetWidth;
        const h = tooltip.offsetHeight;

        if(isTouch(ev)){

            /* Di atas jari, supaya tidak tertutup. */
            tooltip.style.left = Math.min(Math.max(ev.clientX - w / 2, 8), innerWidth - w - 8) + "px";
            tooltip.style.top = Math.max(ev.clientY - h - 28, 8) + "px";

            return;

        }

        tooltip.style.left = (ev.clientX + w + 24 > innerWidth ? ev.clientX - w - 12 : ev.clientX + 14) + "px";
        tooltip.style.top = (ev.clientY + 14) + "px";

    }

    const hideTip = () => tooltip && (tooltip.style.display = "none");


    /* =================================================
       GRAFIK
       ================================================= */

    /* Penjualan harian: skala tetap minimal 0–20jt supaya antar-periode bisa dibandingkan. */
    const DAILY_MIN_TOP = 20e6;
    const DAILY_STEP = 2e6;

    function renderTrend(points, fixedScale){

        const el = $("#trendChart");

        const W = 760, H = 230, L = 52, R = 12, T = 16, B = 28;
        const pw = W - L - R, ph = H - T - B;

        const dataMax = Math.max(0, ...points.map(p => p.value));

        /* Skala tetap: gridline tiap 2jt (sampai 30jt). Di atas itu langkahnya melebar supaya garis tidak terlalu rapat. */
        const dailyStep = dataMax <= 30e6 ? DAILY_STEP : niceCeiling(dataMax / 10);
        const max = fixedScale
            ? Math.max(DAILY_MIN_TOP, Math.ceil(dataMax / dailyStep) * dailyStep)
            : niceCeiling(dataMax);
        const n = points.length;
        const step = n > 1 ? pw / (n - 1) : 0;

        const x = i => n > 1 ? L + i * step : L + pw / 2;
        const y = v => T + ph - (max ? (v / max) * ph : 0);

        const ticks = !max ? [0]
            : fixedScale ? Array.from({ length: Math.round(max / dailyStep) + 1 }, (_, k) => k * dailyStep)
            : [0, max / 2, max];

        const grid = ticks.map(t =>
            `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid-line)"/>
             <text x="${L - 8}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${compactRupiah(t)}</text>`
        ).join("");

        const every = Math.max(1, Math.ceil(n / 7));

        const labels = points.map((p, i) =>
            i % every === 0 || i === n - 1
                ? `<text x="${x(i)}" y="${H - 8}" text-anchor="${n > 1 && i === 0 ? "start" : n > 1 && i === n - 1 ? "end" : "middle"}" font-size="11" fill="var(--muted)">${escapeHtml(p.label)}</text>`
                : ""
        ).join("");

        const line = points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");
        const area = `${x(0)},${y(0)} ${line} ${x(n - 1)},${y(0)}`;

        /* Puncak diberi label langsung; sisanya lewat tooltip. */
        const peak = points.reduce((best, p, i) => p.value > points[best].value ? i : best, 0);

        const hits = points.map((p, i) => {
            const w = n > 1 ? step : pw;
            return `<rect data-i="${i}" x="${x(i) - w / 2}" y="${T}" width="${w}" height="${ph}" fill="transparent"/>`;
        }).join("");

        el.innerHTML = `
            <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img"
                aria-label="Grafik penjualan">
                ${grid}
                <polygon points="${area}" fill="var(--series-trend-wash)"/>
                <polyline points="${line}" fill="none" stroke="var(--series-trend)" stroke-width="2"
                    stroke-linejoin="round" stroke-linecap="round"/>
                ${points[peak].value > 0 ? `
                    <circle cx="${x(peak)}" cy="${y(points[peak].value)}" r="4" fill="var(--series-trend)" stroke="#fff" stroke-width="2"/>
                    <text x="${x(peak)}" y="${Math.max(y(points[peak].value) - 10, 12)}"
                        text-anchor="${peak > n * 0.8 ? "end" : peak < n * 0.2 ? "start" : "middle"}"
                        font-size="12" font-weight="700" fill="var(--text)">${rupiah(points[peak].value)}</text>` : ""}
                ${labels}
                <line class="crosshair" y1="${T}" y2="${T + ph}" stroke="var(--muted)" style="display:none"/>
                <circle class="hover-dot" r="4" fill="var(--series-trend)" stroke="#fff" stroke-width="2" style="display:none"/>
                ${hits}
            </svg>`;

        const cross = $(".crosshair", el);
        const dot = $(".hover-dot", el);

        /*
         * Mouse: tooltip mengikuti kursor. Sentuh: ketuk atau geser
         * jari di grafik, tooltip tetap tampil sampai ketuk di luar.
         * Di layar sentuh target event terkunci di elemen pertama yang
         * disentuh, jadi elemen di bawah jari dicari lewat koordinat.
         */
        const clear = () => {
            cross.style.display = "none";
            dot.style.display = "none";
            hideTip();
        };

        const hover = ev => {

            const rect = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("rect[data-i]");

            if(!rect || !el.contains(rect)){
                return;
            }

            const i = Number(rect.dataset.i);
            const p = points[i];

            cross.setAttribute("x1", x(i));
            cross.setAttribute("x2", x(i));
            cross.style.display = "";
            dot.setAttribute("cx", x(i));
            dot.setAttribute("cy", y(p.value));
            dot.style.display = "";

            showTip(ev, p.tip, rupiah(p.value));

        };

        el.onpointerdown = hover;
        el.onpointermove = hover;
        el.onpointercancel = clear;
        el.onpointerleave = ev => isTouch(ev) || clear();

    }


    function renderProducts(products){

        const el = $("#productChart");

        if(!products.length){
            el.innerHTML = `<div class="empty">Tidak ada data.</div>`;
            return;
        }

        const max = Math.max(...products.map(p => p.subtotal));

        el.innerHTML = products.map((p, i) => `
            <div class="bar-row" data-i="${i}">
                <span class="bar-label" title="${escapeHtml(p.product)}">${escapeHtml(p.product)}</span>
                <div class="bar-track"><div class="bar-fill ${p.other ? "other" : ""}" style="width:${max ? (p.subtotal / max) * 100 : 0}%"></div></div>
                <span class="bar-value num">${p.qty}×</span>
            </div>
        `).join("");

        const hover = ev => {

            const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".bar-row");

            if(!row || !el.contains(row)){
                return hideTip();
            }

            const p = products[row.dataset.i];

            showTip(ev, p.product, `${p.qty} terjual · ${rupiah(p.subtotal)}`);

        };

        el.onpointerdown = hover;
        el.onpointermove = hover;
        el.onpointercancel = hideTip;
        el.onpointerleave = ev => isTouch(ev) || hideTip();

    }


    function renderPayments(cash, qris, transfer, debit, grab, utang){

        const el = $("#paymentChart");
        const total = cash + qris + transfer + debit + grab + utang;

        if(total <= 0){
            el.innerHTML = `<div class="empty">Tidak ada data.</div>`;
            return;
        }

        const pct = v => Math.round((v / total) * 100);

        /* Transfer & Utang hanya tampil kalau ada; urutan & warna tetap per metode. */
        const parts = [
            ["Cash", cash, "var(--series-cash)"],
            ["QRIS", qris, "var(--series-qris)"],
            ...(transfer > 0 ? [["Transfer BCA", transfer, "var(--series-transfer)"]] : []),
            ...(debit > 0 ? [["Debit", debit, "var(--series-debit)"]] : []),
            ...(grab > 0 ? [["Grab", grab, "var(--series-grab)"]] : []),
            ...(utang > 0 ? [["Utang", utang, "var(--series-utang)"]] : [])
        ];

        el.innerHTML = `
            <div class="split">
                ${parts.filter(p => p[1] > 0).map(([, v, c]) => `<div style="width:${(v / total) * 100}%;background:${c}"></div>`).join("")}
            </div>
            <div class="legend">
                ${parts.map(([name, v, c]) => `
                    <div class="legend-item"><span class="swatch" style="background:${c}"></span>${name}
                        <span class="muted">${pct(v)}%</span><b class="num">${rupiah(v)}</b></div>`).join("")}
            </div>`;

    }


    function renderKpis(agg, from, to){

        $("#kpiTotal").textContent = rupiah(agg.total);
        $("#kpiCount").textContent = numberFmt.format(agg.count);
        $("#kpiAverage").textContent = rupiah(agg.average);
        $("#kpiItems").textContent = numberFmt.format(agg.items);

        if(!debtData){
            $("#kpiInflow").textContent = rupiah(agg.cash + agg.qris + agg.transfer + agg.debit);
            $("#kpiReceivable").textContent = "–";
            return;
        }

        /* Pembayaran utang yang diterima di rentang ini (tanggal lokal perangkat). */
        const repaid = debtData.debts
            .flatMap(d => d.payments)
            .filter(p => { const day = App.shopTime(p.at).iso; return day >= from && day <= to; })
            .reduce((sum, p) => sum + p.jumlah, 0);

        $("#kpiInflow").textContent = rupiah(agg.cash + agg.qris + agg.transfer + agg.debit + repaid);
        $("#kpiReceivable").textContent = rupiah(debtData.summary.openTotal);

    }


    /* --- tabel transaksi: urutkan + halaman --- */

    const PAGE_SIZES = [10, 25, 50, 100];

    let allTx = [];
    let sortedTx = [];
    let sortKey = "waktu";
    let sortDir = "desc";
    let page = 1;
    let pageSize = PAGE_SIZES.includes(Number(localStorage.getItem("txPageSize")))
        ? Number(localStorage.getItem("txPageSize"))
        : 25;

    const productNames = t => t.items.map(i => i.product).join(", ");

    const SORTERS = {
        nota:   t => Number(t.nota) || 0,
        waktu:  t => t.date + " " + t.time,
        produk: t => productNames(t).toLowerCase(),
        bayar:  t => t.payment,
        total:  t => t.total
    };

    /* Arah awal saat kolom baru diklik: angka & waktu turun dulu, teks A–Z. */
    const DEFAULT_DIR = { nota: "desc", waktu: "desc", total: "desc", produk: "asc", bayar: "asc" };


    function sortTransactions(){

        const get = SORTERS[sortKey];
        const dir = sortDir === "asc" ? 1 : -1;

        sortedTx = allTx.slice().sort((a, b) => {

            const x = get(a), y = get(b);

            const diff = typeof x === "number" ? x - y : x.localeCompare(y, "id");

            /* Nilai sama: yang terbaru di atas. */
            return diff * dir || SORTERS.waktu(b).localeCompare(SORTERS.waktu(a));

        });

    }


    function renderTable(transactions){

        allTx = transactions;
        page = 1;

        $("#txPageSize").value = pageSize;

        sortTransactions();
        renderPage();

    }


    const PAY_LABEL = { CASH: "Cash", QRIS: "QRIS", TRANSFER: "Transfer BCA", "TRANSFER BCA": "Transfer BCA", DEBIT: "Debit" };
    const PAY_ICON = { CASH: "cash", QRIS: "qr", TRANSFER: "bank", "TRANSFER BCA": "bank", DEBIT: "card" };

    function paymentBadge(payment){

        const parts = splitParts(payment);

        if(parts){
            const label = parts.map(p => `${PAY_LABEL[p.payment] || p.payment} ${rupiah(p.amount)}`).join(" + ");
            return `<span class="badge badge-split" title="${App.escapeHtml(label)}">${parts.map(p => icon(PAY_ICON[p.payment] || "cash", "i-sm")).join("")}<span class="pay-text">${parts.map(p => PAY_LABEL[p.payment] || p.payment).join(" + ")}</span></span>`;
        }

        if(payment === "QRIS"){
            return `<span class="badge badge-accent">${icon("qr", "i-sm")}<span class="pay-text">QRIS</span></span>`;
        }

        if(payment === "TRANSFER" || payment === "TRANSFER BCA"){
            return `<span class="badge badge-accent">${icon("bank", "i-sm")}<span class="pay-text">Transfer BCA</span></span>`;
        }

        if(payment === "GRAB"){
            return `<span class="badge badge-ok">${icon("bike", "i-sm")}<span class="pay-text">Grab</span></span>`;
        }

        if(payment === "DEBIT"){
            return `<span class="badge badge-accent">${icon("card", "i-sm")}<span class="pay-text">Debit</span></span>`;
        }

        if(payment === "UTANG"){
            return `<span class="badge badge-warn">${icon("book", "i-sm")}<span class="pay-text">Utang</span></span>`;
        }

        return `<span class="badge">${icon("cash", "i-sm")}<span class="pay-text">Cash</span></span>`;

    }


    function renderShifts(from, to){

        const list = shiftData.filter(sh => { const d = App.shopTime(sh.openedAt).iso; return d >= from && d <= to; });
        const time = iso => { const t = App.shopTime(iso); return `${t.tanggal.split("/").slice(0, 2).join("/")} ${t.jam}`; };

        $("#shiftCount").textContent = list.length ? list.length + " setoran" : "";

        $("#shiftBody").innerHTML = list.length ? list.map(sh => {

            const t = sh.totals;

            return `
                <tr>
                    <td><b>${escapeHtml(sh.kasir)}</b></td>
                    <td class="num">${time(sh.openedAt)} – ${sh.closedAt ? time(sh.closedAt).split(" ")[1] : `<span class="badge badge-warn">Belum ditutup</span>`}</td>
                    <td class="r num hide-sm">${rupiah(sh.modal)}</td>
                    <td class="r num"><b>${rupiah(t.cash + t.cashPay)}</b></td>
                    <td class="r num">${rupiah(t.qris + t.qrisPay)}</td>
                    <td class="r num">${rupiah(t.transfer + t.transferPay)}</td>
                    <td class="r num">${rupiah((t.debit || 0) + (t.debitPay || 0))}</td>
                    <td class="r num">${rupiah(t.grab || 0)}</td>
                </tr>`;

        }).join("") : `<tr><td colspan="8" class="muted">Tidak ada setoran pada rentang ini.</td></tr>`;

    }


    function renderPage(){

        const total = sortedTx.length;
        const pages = Math.max(1, Math.ceil(total / pageSize));

        page = Math.min(Math.max(page, 1), pages);

        const start = (page - 1) * pageSize;
        const slice = sortedTx.slice(start, start + pageSize);

        const multiDay = new Set(allTx.map(t => t.date)).size > 1;

        $("#txCount").textContent = total + " transaksi";

        $$("#txHead th[data-sort]").forEach(th =>
            th.setAttribute("aria-sort",
                th.dataset.sort === sortKey ? (sortDir === "asc" ? "ascending" : "descending") : "none"));

        $("#txBody").innerHTML = slice.map((t, k) => {

            const extra = t.items.length - 1;

            return `
            <tr class="tx-row" data-i="${start + k}" aria-expanded="false" tabindex="0">
                <td><b>${escapeHtml(String(t.nota).padStart(3, "0"))}</b></td>
                <td class="num">${multiDay ? fmtShort.format(fromISO(t.date)) + ", " : ""}${escapeHtml(t.time)}</td>
                <td class="tx-products" title="${escapeHtml(productNames(t))}">${escapeHtml(t.items[0]?.product || "-")}${extra > 0 ? ` <span class="muted">+${extra}</span>` : ""}</td>
                <td>${paymentBadge(t.payment)}</td>
                <td class="r num"><b>${rupiah(t.total)}</b></td>
                <td class="r tx-chev" style="width:36px">${icon("chevron-down", "i-sm")}</td>
            </tr>`;

        }).join("");

        renderPager(total, pages, start, slice.length);

    }


    /* 1 … 4 [5] 6 … 20 */
    function pageList(current, pages){

        const set = new Set([1, pages, current - 1, current, current + 1]);

        const nums = [...set].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);

        const out = [];

        nums.forEach((n, i) => {
            if(i > 0 && n - nums[i - 1] > 1){
                out.push("gap");
            }
            out.push(n);
        });

        return out;

    }


    function renderPager(total, pages, start, shown){

        const pager = $("#txPager");

        pager.hidden = total === 0;

        if(total === 0){
            return;
        }

        const btn = (label, target, extra = "") =>
            `<button type="button" class="btn btn-sm ${extra}" data-page="${target}"
                ${target < 1 || target > pages ? "disabled" : ""}>${label}</button>`;

        pager.innerHTML = `
            <span class="small muted">Menampilkan ${start + 1}–${start + shown} dari ${total}</span>
            <div class="pager-controls" ${pages === 1 ? "hidden" : ""}>
                ${btn(icon("chevron-down", "i-sm pager-prev"), page - 1, "btn-icon")}
                ${pageList(page, pages).map(n => n === "gap"
                    ? `<span class="muted">…</span>`
                    : `<button type="button" class="btn btn-sm ${n === page ? "btn-primary" : ""}" data-page="${n}" ${n === page ? 'aria-current="page"' : ""}>${n}</button>`
                ).join("")}
                ${btn(icon("chevron-down", "i-sm pager-next"), page + 1, "btn-icon")}
            </div>`;

    }


    function toggleRow(tr){

        const open = tr.getAttribute("aria-expanded") === "true";

        tr.setAttribute("aria-expanded", !open);

        if(open){
            tr.nextElementSibling?.classList.contains("tx-items") && tr.nextElementSibling.remove();
            return;
        }

        const t = sortedTx[tr.dataset.i];
        const parts = splitParts(t.payment);

        tr.insertAdjacentHTML("afterend", `
            <tr class="tx-items"><td colspan="6"><ul>
                ${t.items.map(item => `
                    <li><span>${escapeHtml(item.product)} <span class="muted num">${item.qty} × ${rupiah(item.price)}</span></span>
                        <span class="num">${rupiah(item.subtotal)}</span></li>`).join("")}
                ${parts ? parts.map(p => `
                    <li class="muted"><span>Dibayar ${escapeHtml(PAY_LABEL[p.payment] || p.payment)}</span>
                        <span class="num">${rupiah(p.amount)}</span></li>`).join("") : ""}
            </ul></td></tr>`);

    }


    /* =================================================
       ALUR
       ================================================= */

    function setState(state, message){

        $("#reportLoading").hidden = state !== "loading";
        $("#reportEmpty").hidden = state !== "empty";
        $("#reportError").hidden = state !== "error";
        $("#reportContent").hidden = state !== "ready";

        if(state === "error"){
            $("#reportErrorText").textContent = message;
        }

    }


    function applyPreset(name){

        preset = name;

        /* "Hari ini" = tanggal toko (WITA), bukan tanggal perangkat. */
        const today = fromISO(App.shopTime().iso);
        const from = {
            today: today,
            "7": addDays(today, -6),
            "30": addDays(today, -29),
            month: new Date(today.getFullYear(), today.getMonth(), 1)
        }[name];

        $("#dateFrom").value = toISO(from);
        $("#dateTo").value = toISO(today);

        render();

    }


    async function load(refresh){

        const btn = $("#reportRefresh");
        const label = $("span", btn);

        setState("loading");

        /* Tombol menunjukkan sedang bekerja & tidak bisa ditekan dua kali. */
        btn.disabled = true;
        btn.classList.add("is-loading");
        btn.setAttribute("aria-busy", "true");
        label.textContent = "Memuat…";

        try{
            let shiftResult;

            [rows, debtData, shiftResult] = await Promise.all([
                fetchRows(refresh),
                api("/api/debts").catch(() => null),
                api("/api/shifts").catch(() => null)
            ]);

            shiftData = shiftResult?.shifts || [];
            $("#reportUpdated").textContent = "Diperbarui " + (d => `${pad(d.getHours())}:${pad(d.getMinutes())}`)(new Date());
            render();
        }catch(error){
            setState("error", error.message);
        }finally{
            btn.disabled = false;
            btn.classList.remove("is-loading");
            btn.removeAttribute("aria-busy");
            label.textContent = "Muat ulang";
        }

    }


    function render(){

        $$("#presetChips .chip").forEach(c => c.setAttribute("aria-pressed", c.dataset.preset === preset));

        if(!rows){
            return;
        }

        let from = $("#dateFrom").value;
        let to = $("#dateTo").value;

        if(!from || !to){
            return;
        }

        if(from > to){
            [from, to] = [to, from];
            $("#dateFrom").value = from;
            $("#dateTo").value = to;
        }

        $("#reportRange").textContent = from === to
            ? fmtLong.format(fromISO(from))
            : `${fmtLong.format(fromISO(from))} – ${fmtLong.format(fromISO(to))}`;

        hideTip();

        const transactions = groupTransactions(rows, from, to);

        if(transactions.length === 0){
            return setState("empty");
        }

        const agg = aggregate(transactions, from, to);

        setState("ready");

        $("#trendTitle").textContent = from === to ? "Penjualan per jam" : "Penjualan harian";

        renderKpis(agg, from, to);
        renderShifts(from, to);
        renderTrend(agg.trend, from !== to);
        renderProducts(foldTop(agg.products, 8));
        renderPayments(agg.cash, agg.qris, agg.transfer, agg.debit, agg.grab, agg.utang);
        renderTable(transactions);

    }


    function bind(){

        $("#presetChips").addEventListener("click", e => {
            const chip = e.target.closest("[data-preset]");
            if(chip){
                applyPreset(chip.dataset.preset);
            }
        });

        ["#dateFrom", "#dateTo"].forEach(sel =>
            $(sel).addEventListener("change", () => { preset = null; render(); }));

        /* Ketuk di luar grafik: tooltip & garis bantu hilang. */
        document.addEventListener("pointerdown", e => {

            if(!e.target.closest("#trendChart, #productChart")){
                hideTip();
                $$(".crosshair, .hover-dot").forEach(n => n.style.display = "none");
            }

            if(!e.target.closest(".info-btn")){
                $$(".info-btn[aria-expanded=true]").forEach(b => b.setAttribute("aria-expanded", "false"));
            }

        });

        /* Ikon info: ketuk untuk buka/tutup (di layar sentuh tidak ada hover). */
        document.addEventListener("click", e => {

            const btn = e.target.closest(".info-btn");

            $$(".info-btn[aria-expanded=true]").forEach(b => b !== btn && b.setAttribute("aria-expanded", "false"));

            if(btn){
                btn.setAttribute("aria-expanded", btn.getAttribute("aria-expanded") !== "true");
            }

        });

        document.addEventListener("keydown", e => {
            if(e.key === "Escape"){
                $$(".info-btn[aria-expanded=true]").forEach(b => b.setAttribute("aria-expanded", "false"));
            }
        });

        $("#reportRefresh").addEventListener("click", () => load(true));
        $("#reportRetry").addEventListener("click", () => load(true));

        $("#txHead").addEventListener("click", e => {

            const th = e.target.closest("th[data-sort]");

            if(!th){
                return;
            }

            if(sortKey === th.dataset.sort){
                sortDir = sortDir === "asc" ? "desc" : "asc";
            }else{
                sortKey = th.dataset.sort;
                sortDir = DEFAULT_DIR[sortKey];
            }

            page = 1;
            sortTransactions();
            renderPage();

        });

        $("#txPageSize").addEventListener("change", e => {
            pageSize = Number(e.target.value);
            localStorage.setItem("txPageSize", pageSize);
            page = 1;
            renderPage();
        });

        $("#txPager").addEventListener("click", e => {

            const btn = e.target.closest("[data-page]");

            if(!btn || btn.disabled){
                return;
            }

            page = Number(btn.dataset.page);
            renderPage();

            /* Pager ada di bawah tabel panjang: kembali ke awal tabel. */
            $("#txPanel").scrollIntoView({ block: "start", behavior: "smooth" });

        });

        $("#txBody").addEventListener("click", e => {
            const tr = e.target.closest(".tx-row");
            if(tr){
                toggleRow(tr);
            }
        });

        $("#txBody").addEventListener("keydown", e => {
            const tr = e.target.closest(".tx-row");
            if(tr && (e.key === "Enter" || e.key === " ")){
                e.preventDefault();
                toggleRow(tr);
            }
        });

    }


    App.registerView("laporan", {
        adminOnly: true,
        onShow(first){
            if(first && !rows){
                applyPreset(preset || "30");
                load(false);
            }
        }
    });

    App.on("ready", () => {
        if(App.isSuperadmin()){
            bind();
        }
    });

})();

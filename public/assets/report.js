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

        return parts.length === 3
            ? `${parts[2]}-${pad(parts[1])}-${pad(parts[0])}`
            : str;

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

            const date = normalizeDate(row.tanggal);

            if(date < from || date > to){
                return;
            }

            const key = row.transactionId ? "tx:" + row.transactionId : `legacy:${date}|${row.nota}`;

            let t = groups.get(key);

            if(!t){
                t = {
                    date,
                    time: formatTime(row.jam),
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


    function aggregate(transactions, from, to){

        let total = 0, cash = 0, qris = 0, items = 0;

        const byDay = new Map();
        const byHour = new Map();
        const byProduct = new Map();

        transactions.forEach(t => {

            total += t.total;

            if(t.payment === "CASH") cash += t.total;
            if(t.payment === "QRIS") qris += t.total;

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
            total, cash, qris, items, trend, products,
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


    function renderPayments(cash, qris){

        const el = $("#paymentChart");
        const total = cash + qris;

        if(total <= 0){
            el.innerHTML = `<div class="empty">Tidak ada data.</div>`;
            return;
        }

        const pct = v => Math.round((v / total) * 100);

        el.innerHTML = `
            <div class="split">
                ${cash ? `<div style="width:${(cash / total) * 100}%;background:var(--series-cash)"></div>` : ""}
                ${qris ? `<div style="width:${(qris / total) * 100}%;background:var(--series-qris)"></div>` : ""}
            </div>
            <div class="legend">
                <div class="legend-item"><span class="swatch" style="background:var(--series-cash)"></span>Cash
                    <span class="muted">${pct(cash)}%</span><b class="num">${rupiah(cash)}</b></div>
                <div class="legend-item"><span class="swatch" style="background:var(--series-qris)"></span>QRIS
                    <span class="muted">${pct(qris)}%</span><b class="num">${rupiah(qris)}</b></div>
            </div>`;

    }


    /* =================================================
       RINGKASAN & TABEL
       ================================================= */

    function renderKpis(agg){

        $("#kpiTotal").textContent = rupiah(agg.total);
        $("#kpiCount").textContent = numberFmt.format(agg.count);
        $("#kpiAverage").textContent = rupiah(agg.average);
        $("#kpiItems").textContent = numberFmt.format(agg.items);

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
                <td><span class="badge ${t.payment === "QRIS" ? "badge-accent" : ""}">${t.payment === "QRIS" ? icon("qr", "i-sm") + '<span class="pay-text">QRIS</span>' : icon("cash", "i-sm") + '<span class="pay-text">Cash</span>'}</span></td>
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

        tr.insertAdjacentHTML("afterend", `
            <tr class="tx-items"><td colspan="6"><ul>
                ${t.items.map(item => `
                    <li><span>${escapeHtml(item.product)} <span class="muted num">${item.qty} × ${rupiah(item.price)}</span></span>
                        <span class="num">${rupiah(item.subtotal)}</span></li>`).join("")}
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

        const today = new Date();
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
            rows = await fetchRows(refresh);
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

        renderKpis(agg);
        renderTrend(agg.trend, from !== to);
        renderProducts(foldTop(agg.products, 8));
        renderPayments(agg.cash, agg.qris);
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

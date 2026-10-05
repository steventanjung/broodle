/* =====================================================
   INTI APLIKASI
   -----------------------------------------------------
   Dipakai bersama kasir.js, admin.js, report.js:
   helper format, panggilan API, sesi, router tab,
   dialog, toast, dan data menu bersama.
   ===================================================== */

const App = (() => {

    const STORE = {
        name: "Kukikoe",
        tagline: "Mooncake Festival"
    };


    /* --- helper DOM & format --- */

    /* Layar sentuh: jangan buka keyboard layar otomatis kalau tidak perlu. */
    const isTouchDevice = () => matchMedia("(pointer:coarse)").matches;

    const $  = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    const ICONS = "/assets/icons.svg";

    function icon(name, cls = ""){
        return `<svg class="i ${cls}" aria-hidden="true"><use href="${ICONS}#${name}"/></svg>`;
    }

    const ESC = { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" };

    function escapeHtml(text){
        return String(text ?? "").replace(/[&<>"']/g, c => ESC[c]);
    }

    const numberFmt = new Intl.NumberFormat("id-ID");

    function rupiah(n){
        return "Rp" + numberFmt.format(Math.round(Number(n) || 0));
    }

    /* "50.000" / "Rp 50.000" -> 50000 */
    function parseNumber(text){
        return parseInt(String(text ?? "").replace(/\D/g, ""), 10) || 0;
    }


    /* --- API --- */

    /*
     * fetch + JSON + pesan error yang bisa langsung
     * ditampilkan. Sesi habis -> ke halaman login,
     * kecuali pemanggil minta tangani sendiri (sync
     * transaksi offline tidak boleh dilempar keluar).
     */

    async function api(path, { method = "GET", body, headers, keepOn401 = false } = {}){

        const isJson = body !== undefined && !(body instanceof Blob);

        let response;

        try{

            response = await fetch(path, {
                method,
                headers: isJson ? { "Content-Type": "application/json", ...headers } : headers,
                body: isJson ? JSON.stringify(body) : body
            });

        }catch(error){

            /* Browser melempar "Failed to fetch" (Inggris, teknis) saat offline / server mati. */
            throw Object.assign(
                new Error("Tidak bisa terhubung ke server. Periksa koneksi internet lalu coba lagi."),
                { network: true }
            );

        }

        if(response.status === 401 && !keepOn401){
            goToLogin();
        }

        const data = await response.json().catch(() => ({}));

        if(!response.ok){
            throw Object.assign(
                new Error(data.error || "Permintaan gagal (" + response.status + ")."),
                { status: response.status }
            );
        }

        return data;

    }


    /* --- sesi --- */

    let session = null;

    function goToLogin(){
        location.replace("/login.html?next=" + encodeURIComponent(location.pathname + location.hash));
    }

    async function loadSession(){

        try{

            session = await api("/api/me");

        }catch(error){

            /*
             * Offline: halaman sudah termuat, kasir tetap
             * bisa jualan, transaksi masuk antrean lokal.
             * Pakai identitas terakhir yang diketahui.
             */

            try{ session = JSON.parse(localStorage.getItem("session")); }catch(e){}

        }

        if(session){
            localStorage.setItem("session", JSON.stringify(session));
        }

        return session;

    }

    const isSuperadmin = () => session?.role === "superadmin";

    async function logout(){

        try{ await fetch("/api/logout", { method: "POST" }); }catch(e){}

        localStorage.removeItem("session");

        location.replace("/login.html");

    }


    /* --- event sederhana antar modul --- */

    const listeners = {};

    const on   = (name, fn) => (listeners[name] ||= []).push(fn);
    const emit = (name, data) => (listeners[name] || []).forEach(fn => fn(data));


    /* --- data menu (dipakai kasir & kelola menu) --- */

    let menus = [];

    try{ menus = JSON.parse(localStorage.getItem("menuCache")) || []; }catch(e){}

    /* "loading" hanya kalau belum ada salinan lokal sama sekali. */
    let menuStatus = menus.length ? "ready" : "loading";
    let lastMenuFetch = 0;

    function setMenus(list){
        menus = list;
        localStorage.setItem("menuCache", JSON.stringify(list));
        emit("menus", list);
    }

    async function refreshMenus(){

        lastMenuFetch = Date.now();

        const hadNothing = menuStatus !== "ready";

        if(hadNothing){
            menuStatus = "loading";
            emit("menus", menus);
        }

        try{

            const data = await api("/api/menu");

            menuStatus = "ready";

            /* Tidak ada yang berubah: jangan render ulang (kartu tidak berkedip). */
            if(hadNothing || JSON.stringify(data.menus) !== JSON.stringify(menus)){
                setMenus(data.menus);
            }

        }catch(error){

            /* Offline: tetap pakai salinan terakhir. Tanpa salinan: tampilkan galat + tombol coba lagi. */
            if(menus.length === 0){
                menuStatus = "error";
                emit("menus", menus);
            }

        }

    }

    /*
     * Kasir membuka aplikasi seharian: harga yang diubah admin
     * harus sampai tanpa reload manual. Muat ulang menu saat tab
     * kembali aktif, saat internet kembali, dan berkala.
     */
    function keepMenusFresh(){

        const stale = ms => Date.now() - lastMenuFetch > ms;

        document.addEventListener("visibilitychange", () => {
            if(document.visibilityState === "visible" && stale(20000)){
                refreshMenus();
            }
        });

        window.addEventListener("online", () => refreshMenus());

        setInterval(() => {
            if(document.visibilityState === "visible" && navigator.onLine && stale(110000)){
                refreshMenus();
            }
        }, 120000);

        document.addEventListener("click", e => {
            if(e.target.closest("[data-retry-menu]")){
                refreshMenus();
            }
        });

    }

    /* Kategori unik sesuai urutan kemunculan di menu. */
    function categories(){
        return [...new Set(menus.map(m => m.kategori || "Lainnya"))];
    }


    /* --- router tab --- */

    const views = {};
    let currentView = null;

    function registerView(name, { adminOnly = false, onShow } = {}){
        views[name] = { adminOnly, onShow };
    }

    function showView(name){

        if(!views[name] || (views[name].adminOnly && !isSuperadmin())){
            name = "kasir";
        }

        $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
        $$(".tab").forEach(t => t.dataset.view === name
            ? t.setAttribute("aria-current", "page")
            : t.removeAttribute("aria-current"));

        const first = currentView !== name;
        currentView = name;

        if(first){
            const label = $(`.tab[data-view="${name}"]`)?.textContent.trim();
            document.title = (label ? label + " — " : "") + STORE.name;
            window.scrollTo(0, 0);
        }

        views[name].onShow?.(first);

    }

    window.addEventListener("hashchange", () => showView(location.hash.slice(1)));


    /* --- toast --- */

    function toast(message, type = "ok", ms){

        let host = $(".toasts");

        if(!host){
            host = document.createElement("div");
            host.className = "toasts";
            host.setAttribute("role", "status");
            document.body.appendChild(host);
        }

        const el = document.createElement("div");
        el.className = "toast toast-" + type;
        el.innerHTML = icon(type === "error" ? "alert" : "check") + "<span></span>";
        el.querySelector("span").textContent = message;

        host.appendChild(el);

        setTimeout(() => el.remove(), ms || (type === "error" ? 5000 : 2600));

    }


    /* --- dialog --- */

    /*
     * Konfirmasi yang tidak memblokir halaman seperti
     * confirm() bawaan. Mengembalikan Promise<boolean>.
     */

    function confirmDialog({ title, message, confirmText = "Ya", danger = false }){

        const dlg = $("#confirmDialog");

        $("h2", dlg).textContent = title;
        $(".dialog-msg", dlg).textContent = message || "";

        const ok = $("[data-confirm]", dlg);
        ok.textContent = confirmText;
        ok.className = "btn " + (danger ? "btn-solid-danger" : "btn-primary");

        dlg.returnValue = "";
        dlg.showModal();
        ok.focus();

        return new Promise(resolve => {
            dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true });
        });

    }

    /* Tombol [data-close] di dalam dialog mana pun menutupnya. */
    document.addEventListener("click", e => {

        const closer = e.target.closest("[data-close]");

        if(closer){
            closer.closest("dialog")?.close(closer.dataset.close || "");
        }

    });

    /* Foto produk gagal dimuat -> ganti ikon placeholder. */
    document.addEventListener("error", e => {
        const img = e.target;
        if(img.tagName === "IMG" && img.dataset.fallback){
            img.outerHTML = icon(img.dataset.fallback);
        }
    }, true);

    /* Klik backdrop menutup dialog. */
    document.addEventListener("pointerdown", e => {
        /* Dialog berisi isian (data-lock): tidak tertutup karena tersentuh di luar, supaya ketikan tidak hilang. */
        if(e.target.tagName === "DIALOG" && !e.target.hasAttribute("data-lock")){
            e.target.close();
        }
    });


    /* --- tombol sibuk --- */

    async function busy(button, label, task){

        const html = button.innerHTML;

        button.disabled = true;
        button.textContent = label;

        try{
            return await task();
        }finally{
            button.disabled = false;
            button.innerHTML = html;
        }

    }


    /* --- mulai --- */

    async function start(){

        await loadSession();

        if(!session){
            goToLogin();
            return;
        }

        const admin = isSuperadmin();

        $("#whoName").textContent = session.username;
        $("#whoRole").textContent = admin ? "Superadmin" : "Kasir";

        $$(".tab[data-admin]").forEach(t => t.hidden = !admin);
        document.body.classList.toggle("has-tabs", admin);
        $(".tabs").hidden = !admin;

        $("#logoutButton").addEventListener("click", () => emit("logout-request"));

        emit("ready", session);

        showView(location.hash.slice(1) || "kasir");

        keepMenusFresh();

        refreshMenus();

    }


    return {
        STORE,
        $, $$, isTouchDevice, icon, escapeHtml, rupiah, parseNumber, numberFmt,
        api, isSuperadmin, logout, get session(){ return session; },
        on, emit,
        get menus(){ return menus; }, get menuStatus(){ return menuStatus; },
        setMenus, refreshMenus, categories,
        registerView, showView,
        toast, confirmDialog, busy,
        start
    };

})();

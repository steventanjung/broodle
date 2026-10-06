/* =====================================================
   ADMIN: KELOLA MENU & KELOLA AKUN (superadmin)
   Tombol & tab disembunyikan untuk kasir hanya demi
   kerapian — penjaga aksesnya tetap server.js.
   ===================================================== */

(() => {

    const { $, $$, isTouchDevice, icon, escapeHtml, rupiah, parseNumber, numberFmt, api, toast, busy } = App;


    /* =================================================
       KELOLA MENU
       ================================================= */

    let menuQuery = "";
    let menuCategory = "";


    function renderMenuAdmin(){

        const menus = App.menus;
        const cats = App.categories();

        /* Daftar belum sampai: jangan tampilkan "belum ada produk" yang menyesatkan. */
        if(menus.length === 0 && App.menuStatus !== "ready"){

            $("#menuSummary").textContent = App.menuStatus === "error" ? "Menu belum bisa dimuat" : "Memuat menu…";

            $("#menuRows").innerHTML = App.menuStatus === "error"
                ? `<div class="empty">${icon("wifi-off")}Menu belum bisa dimuat. Periksa koneksi internet.
                        <button type="button" class="btn btn-sm" data-retry-menu>${icon("refresh", "i-sm")}Coba lagi</button></div>`
                : `<div class="panel-body"><div class="skeleton"></div></div>`;

            return;

        }

        $("#menuSummary").textContent =
            `${menus.length} produk · ${cats.length} kategori · tampil di semua perangkat kasir`;

        /* Filter kategori: pertahankan pilihan kalau masih ada. */
        if(menuCategory && !cats.includes(menuCategory)){
            menuCategory = "";
        }

        $("#menuCategoryFilter").innerHTML =
            `<option value="">Semua kategori</option>` +
            cats.map(c => `<option ${c === menuCategory ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");

        const q = menuQuery.trim().toLowerCase();

        const list = menus.filter(m =>
            (!menuCategory || m.kategori === menuCategory) &&
            (!q || m.nama.toLowerCase().includes(q)));

        if(list.length === 0){

            $("#menuRows").innerHTML = `<div class="empty">${icon(menus.length ? "search" : "package")}
                ${menus.length ? "Tidak ada produk yang cocok." : "Belum ada produk. Tambah produk pertama."}</div>`;

            return;

        }

        /* Kelompokkan per kategori, urutan sesuai pengaturan Kategori. */
        const groups = new Map(cats.map(c => [c, []]));

        list.forEach(m => {
            const key = m.kategori || "Lainnya";
            if(!groups.has(key)){
                groups.set(key, []);
            }
            groups.get(key).push(m);
        });

        let html = "";

        groups.forEach((items, cat) => {

            if(items.length === 0){
                return;
            }

            html += `<div class="group-label">${escapeHtml(cat)} <span class="muted">· ${items.length}</span></div>`;

            html += items.map(m => `
                <div class="row" data-id="${escapeHtml(m.id)}">
                    <div class="thumb">${m.gambar
                        ? `<img src="${escapeHtml(m.gambar)}" alt="" loading="lazy" data-fallback="cookie">`
                        : icon("cookie")}</div>
                    <div class="row-main">
                        <span class="row-title">${escapeHtml(m.nama)}</span>
                        ${m.hargaKustom ? `<span class="row-sub">${icon("tag", "i-sm")} Harga custom, diisi kasir tiap jual</span>` : ""}
                        ${hasVariants(m) ? `<span class="row-sub">${icon("layers", "i-sm")} ${m.varian.length} varian: ${escapeHtml(m.varian.slice(0, 3).map(v => v.nama).join(", "))}${m.varian.length > 3 ? ", …" : ""}</span>` : ""}
                    </div>
                    <span class="row-price num">${hasVariants(m)
                        ? `<span class="muted small">mulai</span> ${rupiah(m.harga)}`
                        : m.hargaKustom
                        ? (m.harga ? `<span class="muted small">saran</span> ${rupiah(m.harga)}` : `<span class="muted">—</span>`)
                        : rupiah(m.harga)}</span>
                    <div class="row-end">
                        <button type="button" class="btn btn-ghost btn-icon star-toggle" data-action="star"
                            aria-pressed="${m.unggulan}" aria-label="Best Seller" title="${m.unggulan ? "Hapus dari Best Seller" : "Jadikan Best Seller"}">
                            ${icon("star")}
                        </button>
                        <button type="button" class="btn btn-ghost btn-icon" data-action="edit" aria-label="Ubah" title="Ubah">${icon("pencil")}</button>
                    </div>
                </div>
            `).join("");

        });

        $("#menuRows").innerHTML = html;

    }


    function replaceMenu(updated){

        const list = App.menus.slice();
        const index = list.findIndex(m => m.id === updated.id);

        if(index < 0){
            list.push(updated);
        }else{
            list[index] = updated;
        }

        App.setMenus(list);

    }


    async function toggleStar(id, button){

        const menu = App.menus.find(m => m.id === id);

        button.disabled = true;

        try{
            const updated = await api("/api/menu/" + id, { method: "PUT", body: { unggulan: !menu.unggulan } });
            replaceMenu(updated);
            toast(updated.unggulan ? `${updated.nama} jadi Best Seller` : `${updated.nama} bukan Best Seller lagi`);
        }catch(error){
            toast(error.message, "error");
            button.disabled = false;
        }

    }


    /* --- dialog produk --- */

    let editingId = null;
    let pickedPhoto = null;
    let removePhoto = false;

    /* Salinan kerja daftar varian di dialog; baru dikirim ke server saat Simpan. */
    let variantDraft = [];

    const hasVariants = m => m.adaVarian && Array.isArray(m.varian) && m.varian.length > 0;

    function renderVariantEditor(focusLast){

        $("#variantList").innerHTML = variantDraft.map((v, i) => `
            <div class="variant-edit" data-i="${i}">
                <input class="input" data-f="nama" maxlength="40" placeholder="Nama varian, mis. Blueberry" value="${escapeHtml(v.nama)}" aria-label="Nama varian">
                <div class="input-group">
                    <span class="prefix">Rp</span>
                    <input class="input num" data-f="harga" inputmode="numeric" placeholder="0" value="${v.harga ? numberFmt.format(v.harga) : ""}" aria-label="Harga varian">
                </div>
                <button type="button" class="btn btn-ghost btn-icon btn-danger" data-vdel aria-label="Hapus varian">${icon("trash")}</button>
            </div>
        `).join("");

        if(focusLast && !isTouchDevice()){
            const inputs = $$("#variantList [data-f=nama]");
            inputs[inputs.length - 1]?.focus();
        }

    }

    function setPhotoPreview(src){

        $("#photoPreview").innerHTML = src ? `<img src="${escapeHtml(src)}" alt="">` : icon("image", "i-lg");
        $("#photoRemove").hidden = !src;

    }


    function openProductDialog(id){

        const menu = id ? App.menus.find(m => m.id === id) : null;

        editingId = menu ? menu.id : null;
        pickedPhoto = null;
        removePhoto = false;

        const form = $("#productForm");
        form.reset();

        $("#productDialog h2").textContent = menu ? "Ubah produk" : "Tambah produk";
        $("#productDelete").hidden = !menu;

        form.nama.value = menu?.nama || "";
        form.harga.value = menu?.harga ? numberFmt.format(menu.harga) : "";
        fillCategorySelect(menu?.kategori || menuCategory);
        form.unggulan.checked = !!menu?.unggulan;
        form.hargaKustom.checked = !!menu?.hargaKustom;
        form.adaVarian.checked = !!menu?.adaVarian;

        variantDraft = (menu?.varian || []).map(v => ({ id: v.id, nama: v.nama, harga: v.harga }));
        renderVariantEditor(false);

        setPhotoPreview(menu?.gambar || null);
        syncPriceHint();

        $("#productDialog").showModal();
        /* Ubah produk di tablet: jangan langsung memunculkan keyboard layar. */
        if(!menu || !isTouchDevice()){
            form.nama.focus();
        }

    }


    /* Pilihan kategori di form produk: hanya kategori yang sudah dibuat di dialog Kategori. */
    function fillCategorySelect(selected){

        const select = $("#productForm").kategori;
        const all = App.categories({ all: true });

        select.innerHTML = all.length
            ? all.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")
            : `<option value="" disabled selected>Belum ada kategori, buat dulu lewat "Atur kategori"</option>`;

        if(selected && all.includes(selected)){
            select.value = selected;
        }

    }


    function syncPriceHint(){

        const form = $("#productForm");
        const custom = form.hargaKustom.checked;
        const variants = form.adaVarian.checked;

        $("#priceLabel").textContent = custom ? "Harga saran (opsional)" : "Harga";
        $("#priceHint").hidden = !custom;

        /* Produk bervarian: harga ada di tiap varian, kolom harga biasa disembunyikan. */
        $("#priceField").hidden = variants;
        $("#variantEditor").hidden = !variants;

    }


    async function saveProduct(event){

        event.preventDefault();

        const form = event.target;

        /* Harga wajib kecuali produk bervarian / harga custom: arahkan kursor ke kolomnya. */
        if(!form.adaVarian.checked && !form.hargaKustom.checked && parseNumber(form.harga.value) <= 0){
            form.harga.focus();
            return toast("Isi harga produk, atau aktifkan varian / harga custom.", "error");
        }

        const body = {
            nama: form.nama.value.trim(),
            harga: parseNumber(form.harga.value),
            kategori: form.kategori.value.trim(),
            unggulan: form.unggulan.checked,
            hargaKustom: form.hargaKustom.checked,
            adaVarian: form.adaVarian.checked,
            varian: variantDraft
                .filter(v => v.nama.trim() || v.harga)
                .map(v => ({ id: v.id, nama: v.nama.trim(), harga: v.harga }))
        };

        if(removePhoto){
            body.gambar = null;
        }

        await busy($("#productSave"), "Menyimpan...", async () => {

            try{

                let menu = editingId
                    ? await api("/api/menu/" + editingId, { method: "PUT", body })
                    : await api("/api/menu", { method: "POST", body });

                replaceMenu(menu);

                /*
                 * Server lama (belum di-restart setelah update) menerima
                 * simpanan tapi membuang field varian tanpa kabar.
                 */
                if(body.adaVarian && !menu.adaVarian){
                    $("#productDialog").close();
                    toast("Varian tidak tersimpan: server masih versi lama. Hentikan server (Ctrl+C) lalu jalankan npm start lagi.", "error");
                    return;
                }

                if(pickedPhoto){

                    try{
                        const blob = await compressImage(pickedPhoto, 800, 0.72);
                        menu = await api(`/api/menu/${menu.id}/image`, {
                            method: "POST", body: blob, headers: { "Content-Type": "image/jpeg" }
                        });
                        replaceMenu(menu);
                    }catch(error){
                        toast("Produk tersimpan, tapi foto gagal diupload: " + error.message, "error");
                        $("#productDialog").close();
                        return;
                    }

                }

                $("#productDialog").close();
                toast(editingId ? "Perubahan disimpan" : `${menu.nama} ditambahkan`);

            }catch(error){

                toast(error.message, "error");

            }

        });

    }


    async function deleteProduct(){

        const menu = App.menus.find(m => m.id === editingId);

        if(!menu){
            return;
        }

        $("#productDialog").close();

        const ok = await App.confirmDialog({
            title: `Hapus ${menu.nama}?`,
            message: "Produk hilang dari semua perangkat kasir. Riwayat penjualan di laporan tidak terpengaruh.",
            confirmText: "Hapus produk",
            danger: true
        });

        if(!ok){
            return;
        }

        try{
            await api("/api/menu/" + menu.id, { method: "DELETE" });
            App.setMenus(App.menus.filter(m => m.id !== menu.id));
            toast(`${menu.nama} dihapus`);
        }catch(error){
            toast(error.message, "error");
        }

    }


    /*
     * Kompres foto di browser sebelum upload: foto HP
     * 4-8 MB jadi JPEG maks 800px, biasanya < 200 KB.
     */
    function compressImage(file, maxDimension, quality){

        return new Promise((resolve, reject) => {

            const img = new Image();
            const url = URL.createObjectURL(file);

            img.onload = () => {

                URL.revokeObjectURL(url);

                const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
                const canvas = document.createElement("canvas");

                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);

                canvas.toBlob(
                    blob => blob ? resolve(blob) : reject(new Error("Gagal mengompres gambar.")),
                    "image/jpeg",
                    quality
                );

            };

            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error("File bukan gambar yang valid."));
            };

            img.src = url;

        });

    }


    function bindMenu(){

        $("#addProduct").addEventListener("click", () => openProductDialog(null));

        $("#menuSearch").addEventListener("input", e => {
            menuQuery = e.target.value;
            renderMenuAdmin();
        });

        $("#menuCategoryFilter").addEventListener("change", e => {
            menuCategory = e.target.value;
            renderMenuAdmin();
        });

        $("#menuRows").addEventListener("click", e => {

            const row = e.target.closest(".row");

            if(!row){
                return;
            }

            const star = e.target.closest("[data-action=star]");

            if(star){
                return toggleStar(row.dataset.id, star);
            }

            openProductDialog(row.dataset.id);

        });

        const form = $("#productForm");

        form.addEventListener("submit", saveProduct);
        /* Varian dan harga custom saling meniadakan. */
        form.hargaKustom.addEventListener("change", () => {
            if(form.hargaKustom.checked){
                form.adaVarian.checked = false;
            }
            syncPriceHint();
        });

        form.adaVarian.addEventListener("change", () => {

            if(form.adaVarian.checked){

                form.hargaKustom.checked = false;

                /* Daftar kosong: langsung sediakan satu baris. */
                if(variantDraft.length === 0){
                    variantDraft.push({ nama: "", harga: 0 });
                    renderVariantEditor(true);
                }

            }

            syncPriceHint();

        });

        $("#addVariant").addEventListener("click", () => {
            variantDraft.push({ nama: "", harga: 0 });
            renderVariantEditor(true);
        });

        $("#variantList").addEventListener("input", e => {

            const field = e.target.dataset.f;
            const row = e.target.closest(".variant-edit");

            if(!field || !row){
                return;
            }

            const v = variantDraft[Number(row.dataset.i)];

            if(field === "harga"){
                v.harga = parseNumber(e.target.value);
                e.target.value = v.harga ? numberFmt.format(v.harga) : "";
            }else{
                v.nama = e.target.value;
            }

        });

        $("#variantList").addEventListener("click", e => {

            const del = e.target.closest("[data-vdel]");

            if(del){
                variantDraft.splice(Number(del.closest(".variant-edit").dataset.i), 1);
                renderVariantEditor(false);
            }

        });

        form.harga.addEventListener("input", e => {
            const n = parseNumber(e.target.value);
            e.target.value = n ? numberFmt.format(n) : "";
        });

        $("#photoPick").addEventListener("click", () => $("#photoInput").click());

        $("#photoInput").addEventListener("change", e => {

            const file = e.target.files[0];

            if(file){
                pickedPhoto = file;
                removePhoto = false;
                setPhotoPreview(URL.createObjectURL(file));
            }

            e.target.value = "";

        });

        $("#photoRemove").addEventListener("click", () => {
            pickedPhoto = null;
            removePhoto = true;
            setPhotoPreview(null);
        });

        $("#productDelete").addEventListener("click", deleteProduct);

    }


    /* =================================================
       KELOLA KATEGORI
       Ganti nama (semua produk ikut), gabung (nama sama
       dengan kategori lain), dan atur urutan tombol kasir.
       ================================================= */

    let categoryDraft = [];

    function openCategories(){

        categoryDraft = App.categories({ all: true }).map(name => ({
            from: name,
            to: name,
            count: App.menus.filter(m => (m.kategori || "Lainnya") === name).length
        }));

        renderCategories();

        $("#categoryDialog").showModal();

    }


    function renderCategories(){

        $("#categoryList").innerHTML = categoryDraft.map((c, i) => {

            /* Nama sama dengan baris di atasnya = akan digabung ke sana. */
            const target = categoryDraft.findIndex(o => o.to.trim().toLowerCase() === c.to.trim().toLowerCase());
            const mergeNote = target !== i && c.to.trim()
                ? `<span class="hint">Digabung ke "${escapeHtml(categoryDraft[target].to.trim())}"</span>` : "";

            return `
                <li class="cat-row" data-i="${i}">
                    <button type="button" class="cat-grip" aria-label="Geser untuk mengurutkan ${escapeHtml(c.to || "kategori baru")} (atau tekan panah atas/bawah)" title="Geser untuk mengurutkan">${icon("grip")}</button>
                    <div class="cat-main">
                        <input class="input" data-f="to" maxlength="30" value="${escapeHtml(c.to)}" placeholder="Nama kategori baru" aria-label="Nama kategori ${escapeHtml(c.from || "baru")}">
                        <span class="small muted">${c.from === null ? "Kategori baru" : `${c.count} produk`}${c.from !== null && c.to.trim() !== c.from ? ` · dulu "${escapeHtml(c.from)}"` : ""}</span>
                        ${mergeNote}
                    </div>
                    <button type="button" class="btn btn-ghost btn-icon btn-sm btn-danger" data-delete aria-label="Hapus kategori"
                        ${c.count > 0 ? `disabled title="Masih dipakai ${c.count} produk"` : `title="Hapus kategori"`}>${icon("trash", "i-sm")}</button>
                </li>`;

        }).join("");

    }


    async function saveCategories(event){

        event.preventDefault();

        /* Baris baru yang dibiarkan kosong: abaikan saja. */
        categoryDraft = categoryDraft.filter(c => c.from !== null || c.to.trim());

        if(categoryDraft.some(c => !c.to.trim())){
            renderCategories();
            return toast("Nama kategori tidak boleh kosong.", "error");
        }

        await busy($("#categorySave"), "Menyimpan…", async () => {

            try{

                const data = await api("/api/categories", {
                    method: "PUT",
                    body: { categories: categoryDraft.map(c => ({ from: c.from, to: c.to.trim() })) }
                });

                App.setMenus(data.menus, data.categories);

                $("#categoryDialog").close();
                toast("Kategori disimpan");

                /* Dibuka dari form produk: perbarui pilihannya, pertahankan yang sudah dipilih. */
                if($("#productDialog").open){
                    const select = $("#productForm").kategori;
                    const newest = categoryDraft.find(c => c.from === null)?.to.trim();
                    fillCategorySelect(newest || select.value);
                }

            }catch(error){

                toast(error.message, "error");

            }

        });

    }


    /*
     * Urutkan dengan geser (sentuh & mouse) lewat pointer events —
     * drag-and-drop bawaan browser tidak jalan di layar sentuh.
     * Baris mengikuti jari; saat melewati titik tengah baris lain,
     * posisinya ditukar di DOM. Saat dilepas, draf disusun ulang
     * sesuai urutan baru. Keyboard: panah atas/bawah di pegangan.
     */
    function moveCategory(from, to){

        if(to < 0 || to >= categoryDraft.length || to === from){
            return;
        }

        const [item] = categoryDraft.splice(from, 1);
        categoryDraft.splice(to, 0, item);

        renderCategories();

    }


    function bindCategoryDrag(){

        const list = $("#categoryList");
        let drag = null;

        /* offsetTop = posisi tata letak (tidak terpengaruh transform), sama acuannya untuk semua baris. */
        const follow = () => {
            drag.row.style.transform = `translateY(${drag.moved - (drag.row.offsetTop - drag.startTop)}px)`;
        };

        list.addEventListener("pointerdown", e => {

            const grip = e.target.closest(".cat-grip");

            if(!grip || (e.pointerType === "mouse" && e.button !== 0)){
                return;
            }

            e.preventDefault();
            grip.setPointerCapture(e.pointerId);

            const row = grip.closest(".cat-row");

            drag = { row, startY: e.clientY, startTop: row.offsetTop, moved: 0 };

            row.classList.add("dragging");
            list.classList.add("is-sorting");

        });

        list.addEventListener("pointermove", e => {

            if(!drag){
                return;
            }

            const { row } = drag;

            drag.moved = e.clientY - drag.startY;

            /* Titik tengah baris yang digeser (posisi tampil) dibanding titik tengah tetangga. */
            const mid = drag.startTop + drag.moved + row.offsetHeight / 2;
            const next = row.nextElementSibling;
            const prev = row.previousElementSibling;

            if(next && mid > next.offsetTop + next.offsetHeight / 2){
                list.insertBefore(next, row);
            }else if(prev && mid < prev.offsetTop + prev.offsetHeight / 2){
                list.insertBefore(row, prev);
            }

            follow();

            /* Dekat tepi dialog: gulir otomatis supaya daftar panjang tetap bisa diurutkan. */
            const dialog = $("#categoryDialog");
            const box = dialog.getBoundingClientRect();
            const step = e.clientY < box.top + 60 ? -10 : e.clientY > box.bottom - 60 ? 10 : 0;

            if(step){
                dialog.scrollTop += step;
                drag.startY -= step;
            }

        });

        const drop = () => {

            if(!drag){
                return;
            }

            const order = [...list.children].map(li => Number(li.dataset.i));
            const moved = Number(drag.row.dataset.i);

            categoryDraft = order.map(i => categoryDraft[i]);
            drag = null;
            list.classList.remove("is-sorting");

            renderCategories();

            /* Fokus kembali ke pegangan baris yang tadi digeser. */
            $(`#categoryList .cat-row[data-i="${order.indexOf(moved)}"] .cat-grip`)?.focus({ preventScroll: true });

        };

        list.addEventListener("pointerup", drop);
        list.addEventListener("pointercancel", drop);

        list.addEventListener("keydown", e => {

            const grip = e.target.closest(".cat-grip");

            if(!grip || (e.key !== "ArrowUp" && e.key !== "ArrowDown")){
                return;
            }

            e.preventDefault();

            const from = Number(grip.closest(".cat-row").dataset.i);
            const to = from + (e.key === "ArrowUp" ? -1 : 1);

            moveCategory(from, to);

            $(`#categoryList .cat-row[data-i="${Math.max(0, Math.min(to, categoryDraft.length - 1))}"] .cat-grip`)?.focus();

        });

    }


    function bindCategories(){

        $("#manageCategories").addEventListener("click", openCategories);
        $("#productManageCategories").addEventListener("click", openCategories);

        $("#addCategory").addEventListener("click", () => {
            categoryDraft.push({ from: null, to: "", count: 0 });
            renderCategories();
            const inputs = $$("#categoryList [data-f=to]");
            inputs[inputs.length - 1].focus();
        });
        $("#categoryForm").addEventListener("submit", saveCategories);

        /* Ketik: simpan ke draf tanpa render ulang (fokus & kursor tetap); catatan gabung diperbarui saat keluar kolom. */
        $("#categoryList").addEventListener("input", e => {
            const row = e.target.closest(".cat-row");
            if(row){
                categoryDraft[Number(row.dataset.i)].to = e.target.value;
            }
        });

        $("#categoryList").addEventListener("change", renderCategories);

        bindCategoryDrag();

        $("#categoryList").addEventListener("click", e => {

            const del = e.target.closest("[data-delete]");

            if(del && !del.disabled){
                categoryDraft.splice(Number(del.closest(".cat-row").dataset.i), 1);
                return renderCategories();
            }

        });

    }


    /* =================================================
       KELOLA AKUN
       Akun superadmin baru hanya lewat CLI di server,
       supaya satu sesi browser yang disalahgunakan
       tidak bisa mencetak superadmin sendiri.
       ================================================= */

    const dateFmt = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric" });


    async function loadAccounts(){

        $("#accountRows").innerHTML = `<div class="panel-body"><div class="skeleton"></div></div>`;

        try{

            const { users } = await api("/api/users");

            renderAccounts(users);

        }catch(error){

            $("#accountRows").innerHTML = `<div class="empty">${icon("alert")}${escapeHtml(error.message)}</div>`;

        }

    }


    function renderAccounts(users){

        const me = App.session.username.toLowerCase();

        /* Superadmin dulu, lalu kasir; masing-masing urut nama. */
        users.sort((a, b) =>
            (a.role === b.role ? 0 : a.role === "superadmin" ? -1 : 1) ||
            a.username.localeCompare(b.username));

        $("#accountSummary").textContent =
            `${users.filter(u => u.role === "kasir").length} kasir · ${users.filter(u => u.role === "superadmin").length} superadmin`;

        $("#accountRows").innerHTML = users.map(u => {

            const self = u.username.toLowerCase() === me;
            const name = escapeHtml(u.username);

            return `
                <div class="row" data-username="${name}">
                    <div class="avatar">${escapeHtml(u.username[0])}</div>
                    <div class="row-main">
                        <span class="row-title">${name}${self ? ` <span class="badge">Anda</span>` : ""}</span>
                        <span class="row-sub">
                            ${u.role === "superadmin" ? `${icon("shield", "i-sm")} Superadmin` : "Kasir"}
                            ${u.createdAt ? ` · dibuat ${dateFmt.format(new Date(u.createdAt))}` : ""}
                        </span>
                    </div>
                    <div class="row-end">
                        <button type="button" class="btn btn-sm" data-action="password">${icon("key", "i-sm")}<span class="hide-sm">Ganti password</span></button>
                        ${self ? "" : `<button type="button" class="btn btn-sm btn-danger btn-icon" data-action="delete" aria-label="Hapus akun" title="Hapus akun">${icon("trash", "i-sm")}</button>`}
                    </div>
                </div>
            `;

        }).join("");

    }


    async function createAccount(event){

        event.preventDefault();

        const form = event.target;
        const username = form.username.value.trim();

        await busy($("#accountSave"), "Membuat...", async () => {

            try{
                await api("/api/users", { method: "POST", body: { username, password: form.password.value } });
                $("#accountDialog").close();
                toast(`Akun kasir ${username} dibuat`);
                loadAccounts();
            }catch(error){
                toast(error.message, "error");
            }

        });

    }


    let passwordTarget = null;

    async function resetPassword(event){

        event.preventDefault();

        const form = event.target;

        if(form.password.value !== form.confirm.value){
            return toast("Konfirmasi password tidak sama.", "error");
        }

        await busy($("#passwordSave"), "Menyimpan...", async () => {

            try{
                await api(`/api/users/${encodeURIComponent(passwordTarget)}/reset-password`, {
                    method: "POST", body: { password: form.password.value }
                });
                $("#passwordDialog").close();
                toast(`Password ${passwordTarget} diganti`);
            }catch(error){
                toast(error.message, "error");
            }

        });

    }


    async function deleteAccount(username){

        const ok = await App.confirmDialog({
            title: `Hapus akun ${username}?`,
            message: "Akun ini tidak bisa login lagi. Tindakan ini tidak bisa dibatalkan.",
            confirmText: "Hapus akun",
            danger: true
        });

        if(!ok){
            return;
        }

        try{
            await api("/api/users/" + encodeURIComponent(username), { method: "DELETE" });
            toast(`Akun ${username} dihapus`);
            loadAccounts();
        }catch(error){
            toast(error.message, "error");
        }

    }


    function bindAccounts(){

        $("#addAccount").addEventListener("click", () => {
            $("#accountForm").reset();
            $("#accountDialog").showModal();
        });

        $("#accountForm").addEventListener("submit", createAccount);
        $("#passwordForm").addEventListener("submit", resetPassword);

        $("#accountRows").addEventListener("click", e => {

            const btn = e.target.closest("[data-action]");

            if(!btn){
                return;
            }

            const username = btn.closest(".row").dataset.username;

            if(btn.dataset.action === "delete"){
                return deleteAccount(username);
            }

            passwordTarget = username;
            $("#passwordForm").reset();
            $("#passwordDialog h2").textContent = "Ganti password " + username;
            $("#passwordDialog").showModal();

        });

    }


    /* =================================================
       PROFIL (ganti password sendiri)
       ================================================= */

    function bindProfile(){

        const dlg = $("#profileDialog");
        const form = $("#profileForm");

        $("#profileButton").hidden = false;

        $("#profileButton").addEventListener("click", () => {
            form.reset();
            $("#profileName").textContent = App.session.username;
            $("#profileAvatar").textContent = App.session.username[0];
            dlg.showModal();
            form.currentPassword.focus();
        });

        form.addEventListener("submit", async event => {

            event.preventDefault();

            if(form.newPassword.value !== form.confirm.value){
                return toast("Konfirmasi password baru tidak sama.", "error");
            }

            await busy($("#profileSave"), "Menyimpan...", async () => {

                try{
                    await api("/api/me/password", {
                        method: "POST",
                        body: {
                            currentPassword: form.currentPassword.value,
                            newPassword: form.newPassword.value
                        }
                    });
                    dlg.close();
                    toast("Password berhasil diganti");
                }catch(error){
                    toast(error.message, "error");
                    form.currentPassword.select();
                }

            });

        });

    }


    /* =================================================
       MULAI
       ================================================= */

    App.registerView("menu", { adminOnly: true, onShow: renderMenuAdmin });
    App.registerView("akun", { adminOnly: true, onShow: loadAccounts });

    App.on("ready", () => {

        if(!App.isSuperadmin()){
            return;
        }

        bindMenu();
        bindCategories();
        bindAccounts();
        bindProfile();

        App.on("menus", () => {
            if($("#view-menu").classList.contains("active")){
                renderMenuAdmin();
            }
        });

    });

})();

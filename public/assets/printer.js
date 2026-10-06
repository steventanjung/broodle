/* =====================================================
   PRINTER (Cleanter -> printer Bluetooth RPP02N)
   -----------------------------------------------------
   Dipakai kasir (nota penjualan) dan tab Utang (cetak ulang
   nota utang, bukti pembayaran utang). Isi nota dikirim
   sebagai perintah terstruktur; Cleanter yang mengatur
   tata letak kertas 58mm.
   ===================================================== */

const Printer = (() => {

    const PRINTER_URL = "http://localhost:9100/print";

    const { rupiah } = App;

    const text = (value, extra) => ({ type: "text", text: String(value), ...extra });
    const row = (left, right, extra) => ({ type: "row", left, right, ...extra });
    const divider = { type: "divider" };
    const feed = lines => ({ type: "feed", lines });

    const pad = n => String(n).padStart(2, "0");

    /* "2026-10-12" -> "12/10/2026" (sama dengan format tanggal nota) */
    const isoDate = iso => {
        const [y, m, d] = String(iso).split("-");
        return `${Number(d)}/${Number(m)}/${y}`;
    };

    /* ISO waktu -> "5/10/2026 • 14.05" (waktu lokal perangkat) */
    const stamp = iso => {
        const d = new Date(iso);
        return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()} • ${pad(d.getHours())}.${pad(d.getMinutes())}`;
    };

    function header(){
        return [
            text(App.STORE.name.toUpperCase(), { align: "center", bold: true, size: "large" }),
            text(App.STORE.tagline, { align: "center" }),
            divider
        ];
    }

    function footer(extra = []){
        return [
            feed(1),
            ...extra,
            text("Terima Kasih", { align: "center" }),
            feed(3)
        ];
    }

    function itemLines(items){
        return items.flatMap(item => [
            text(item.nama, { bold: true }),
            row(item.qty + " x " + rupiah(item.harga), rupiah(item.subtotal))
        ]);
    }


    /*
     * Nota penjualan. Untuk pembayaran "Utang", bagian bawahnya
     * berisi nama pelanggan & sisa utang, bukan uang diterima.
     * t.dibayar / t.sisa / t.reprint diisi saat cetak ulang dari
     * tab Utang.
     */
    function saleReceipt(t){

        const content = [
            ...header(),
            ...(t.reprint ? [text("CETAK ULANG", { align: "center" })] : []),
            text("No Nota : " + t.nota, { align: "center", bold: true }),
            text(t.tanggal + " • " + t.jam, { align: "center" }),
            divider,
            ...itemLines(t.items),
            divider,
            row("TOTAL", rupiah(t.total), { bold: true }),
            divider
        ];

        if(t.pembayaran === "Utang"){

            const dibayar = t.dibayar || 0;
            const sisa = t.sisa ?? t.total;

            content.push(
                text(sisa === 0 ? "UTANG - LUNAS" : "UTANG - BELUM LUNAS", { align: "center", bold: true }),
                text("Atas nama : " + t.pelanggan)
            );

            if(t.jatuhTempo){
                content.push(text("Jatuh tempo : " + isoDate(t.jatuhTempo)));
            }

            if(dibayar > 0){
                content.push(row("Sudah dibayar", rupiah(dibayar)));
            }

            content.push(row("Sisa utang", rupiah(sisa), { bold: true }));

            return content.concat(footer(
                sisa > 0 ? [text("Simpan nota ini untuk pelunasan", { align: "center" })] : []
            ));

        }

        content.push(text("Pembayaran : " + t.pembayaran));

        /* Di pratinjau, uang diterima bisa belum diisi: baris ini dilewati. */
        if(t.pembayaran === "Cash" && t.cashReceived >= t.total){
            content.push(
                text("Diterima : " + rupiah(t.cashReceived)),
                text("Kembalian : " + rupiah(t.change))
            );
        }

        return content.concat(footer());

    }


    /* Cetak ulang nota utang dari catatan server (status pembayaran terbaru). */
    function debtInvoice(debt){

        return saleReceipt({
            ...debt,
            pembayaran: "Utang",
            reprint: true
        });

    }


    /* Bukti satu pembayaran utang; angka "sudah dibayar" dihitung sampai pembayaran ini. */
    function paymentReceipt(debt, payment){

        const upTo = debt.payments.slice(0, debt.payments.findIndex(p => p.id === payment.id) + 1);
        const paid = upTo.reduce((sum, p) => sum + p.jumlah, 0);
        const sisa = Math.max(debt.total - paid, 0);

        return [
            ...header(),
            text("BUKTI PEMBAYARAN UTANG", { align: "center", bold: true }),
            divider,
            text("Nota asal : " + debt.nota),
            text("Tanggal utang : " + debt.tanggal),
            text("Atas nama : " + debt.pelanggan),
            text("Dibayar : " + stamp(payment.at)),
            divider,
            row("Total utang", rupiah(debt.total)),
            row("Bayar (" + payment.metode + ")", rupiah(payment.jumlah), { bold: true }),
            row("Sudah dibayar", rupiah(paid)),
            divider,
            sisa === 0
                ? text("LUNAS", { align: "center", bold: true, size: "large" })
                : row("Sisa utang", rupiah(sisa), { bold: true }),
            ...footer()
        ];

    }


    /* Tampilan nota di layar (pratinjau), dari perintah cetak yang sama persis. */
    function toHtml(content){

        const esc = App.escapeHtml;

        return content.map(c => {

            if(c.type === "divider"){
                return `<div class="slip-div"></div>`;
            }

            if(c.type === "feed"){
                return `<div class="slip-feed"></div>`;
            }

            if(c.type === "row"){
                return `<div class="slip-row${c.bold ? " b" : ""}"><span>${esc(c.left)}</span><span>${esc(c.right)}</span></div>`;
            }

            const cls = [c.align === "center" && "c", c.bold && "b", c.size === "large" && "l"].filter(Boolean).join(" ");

            return `<div class="slip-line ${cls}">${esc(c.text)}</div>`;

        }).join("");

    }


    /* Mengembalikan { ok } atau { ok:false, message } — tidak pernah throw. */
    async function send(content){

        try{

            const response = await fetch(PRINTER_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ cut: true, content }),
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


    return { send, saleReceipt, debtInvoice, paymentReceipt, toHtml, isoDate, stamp };

})();

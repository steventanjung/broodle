/*
 * Tombol "tampilkan password" di semua kolom password.
 * Di tablet, salah ketik di keyboard layar sering terjadi dan
 * titik-titik password tidak membantu. Dipakai login.html dan
 * index.html.
 */

(() => {

    const ICON = name =>
        `<svg class="i" aria-hidden="true"><use href="/assets/icons.svg#${name}"/></svg>`;

    function enhance(input){

        let host = input.parentElement;

        /* .input-group sudah relative; selain itu bungkus dulu. */
        if(!host.classList.contains("input-group")){

            host = document.createElement("div");
            host.className = "pw-wrap";

            input.replaceWith(host);
            host.appendChild(input);

        }

        input.dataset.pw = "1";

        const btn = document.createElement("button");

        btn.type = "button";
        btn.className = "pw-toggle";
        btn.innerHTML = ICON("eye");
        btn.setAttribute("aria-label", "Tampilkan password");
        btn.setAttribute("aria-pressed", "false");

        btn.addEventListener("click", () => {

            const show = input.type === "password";

            input.type = show ? "text" : "password";
            btn.innerHTML = ICON(show ? "eye-off" : "eye");
            btn.setAttribute("aria-label", show ? "Sembunyikan password" : "Tampilkan password");
            btn.setAttribute("aria-pressed", String(show));

            input.focus();

        });

        host.appendChild(btn);

    }

    function init(){
        document.querySelectorAll("input[type=password]:not([data-no-reveal])").forEach(enhance);
    }

    /* Dialog ditutup: kembalikan ke tersembunyi, jangan tertinggal terbuka untuk pengguna berikutnya. */
    document.addEventListener("close", e => {

        e.target.querySelectorAll?.(".pw-toggle").forEach(btn => {

            const input = btn.parentElement.querySelector("input");

            if(input && input.type === "text"){
                btn.click();
                input.blur();
            }

        });

    }, true);

    if(document.readyState === "loading"){
        document.addEventListener("DOMContentLoaded", init);
    }else{
        init();
    }

})();

/*
 * Autentikasi: hash password, session cookie,
 * dan penyimpanan user.
 *
 * Tanpa dependency eksternal — semua pakai
 * modul bawaan Node.
 */

const crypto = require("node:crypto");
const fs     = require("node:fs");
const path   = require("node:path");


/*
 * Semua data runtime (akun, menu) di satu folder,
 * supaya gampang di-backup / di-mount sebagai volume.
 */

const DATA_DIR =
    process.env.DATA_DIR ||
    path.join(__dirname, "data");

fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE =
    path.join(DATA_DIR, "users.json");


const ROLES = ["kasir", "superadmin"];


/* =====================================================
   PASSWORD
   ===================================================== */

/*
 * scrypt: lambat by design, jadi password
 * tidak bisa di-brute force cepat kalau
 * users.json sampai bocor.
 */

const SCRYPT = {
    N: 16384,
    r: 8,
    p: 1,
    keylen: 64
};


function hashPassword(password){

    const salt =
        crypto.randomBytes(16);

    const hash =
        crypto.scryptSync(
            password,
            salt,
            SCRYPT.keylen,
            {
                N: SCRYPT.N,
                r: SCRYPT.r,
                p: SCRYPT.p
            }
        );

    return [
        "scrypt",
        SCRYPT.N,
        SCRYPT.r,
        SCRYPT.p,
        salt.toString("base64"),
        hash.toString("base64")
    ].join("$");

}


/*
 * Async: scrypt butuh ~50ms CPU. Versi sync akan
 * membekukan seluruh server (termasuk kasir lain)
 * selama login berlangsung.
 */

const scryptAsync = (password, salt, keylen, options) =>
    new Promise((resolve, reject) =>
        crypto.scrypt(password, salt, keylen, options,
            (err, key) => err ? reject(err) : resolve(key)));


async function verifyPassword(password, stored){

    try{

        const [
            scheme,
            N,
            r,
            p,
            saltB64,
            hashB64
        ] = String(stored).split("$");

        if(scheme !== "scrypt"){
            return false;
        }

        const expected =
            Buffer.from(hashB64, "base64");

        const actual =
            await scryptAsync(
                String(password || ""),
                Buffer.from(saltB64, "base64"),
                expected.length,
                {
                    N: Number(N),
                    r: Number(r),
                    p: Number(p)
                }
            );

        /* Banding waktu-konstan. */
        return crypto.timingSafeEqual(
            expected,
            actual
        );

    }catch(error){

        return false;

    }

}


/* =====================================================
   USER STORE
   ===================================================== */

/*
 * Dibaca di SETIAP permintaan (cek akun masih ada), jadi disimpan di
 * memori dan hanya dibaca ulang kalau users.json berubah. Pemanggil
 * mendapat salinan, supaya mengubahnya tidak mengubah cache diam-diam.
 */
let usersCache = null;
let usersMtime = -1;

function loadUsers(){

    let mtime = 0;

    try{
        mtime = fs.statSync(USERS_FILE).mtimeMs;
    }catch(error){
        if(error.code !== "ENOENT"){
            console.error("users.json tidak bisa dibaca:", error.message);
        }
        return [];
    }

    if(!usersCache || mtime !== usersMtime){

        try{

            const parsed = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));

            usersCache = Array.isArray(parsed.users) ? parsed.users : [];
            usersMtime = mtime;

        }catch(error){

            console.error("users.json tidak bisa dibaca:", error.message);
            return [];

        }

    }

    return structuredClone(usersCache);

}


function saveUsers(users){

    fs.writeFileSync(
        USERS_FILE,
        JSON.stringify({ users }, null, 2) + "\n",
        { mode: 0o600 }
    );

}


function findUser(username){

    const wanted =
        String(username || "")
        .trim()
        .toLowerCase();

    return loadUsers().find(
        u => u.username.toLowerCase() === wanted
    ) || null;

}


/* =====================================================
   KELOLA AKUN
   -----------------------------------------------------
   Dipakai bersama oleh scripts/user.js (CLI) dan
   server.js (panel akun superadmin), supaya aturannya
   (panjang password, tidak boleh hapus superadmin
   terakhir, dst) hanya didefinisikan satu kali.
   ===================================================== */

const MIN_PASSWORD_LENGTH = 8;

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;


function validateUsername(username){

    const trimmed = String(username || "").trim();

    if(!USERNAME_PATTERN.test(trimmed)){

        return "Username 3-32 karakter, huruf/angka/" +
            "titik/strip/underscore saja.";

    }

    return null;

}


function validatePassword(password){

    if(
        typeof password !== "string" ||
        password.length < MIN_PASSWORD_LENGTH
    ){

        return `Password minimal ${MIN_PASSWORD_LENGTH} karakter.`;

    }

    return null;

}


/*
 * Tambah akun baru. Mengembalikan { ok, error } —
 * tidak pernah throw, supaya pemanggil (API HTTP atau
 * CLI) bisa menampilkan pesannya langsung ke user.
 */

function createUser(username, password, role){

    const trimmedUsername =
        String(username || "").trim();

    const usernameError =
        validateUsername(trimmedUsername);

    if(usernameError){
        return { ok:false, error:usernameError };
    }

    const passwordError =
        validatePassword(password);

    if(passwordError){
        return { ok:false, error:passwordError };
    }

    if(!ROLES.includes(role)){
        return {
            ok:false,
            error:
                "Role harus salah satu: " +
                ROLES.join(", ")
        };
    }

    if(findUser(trimmedUsername)){
        return {
            ok:false,
            error:
                `Akun "${trimmedUsername}" sudah ada.`
        };
    }

    const users = loadUsers();

    users.push({
        username: trimmedUsername,
        role: role,
        password: hashPassword(password),
        createdAt: new Date().toISOString()
    });

    saveUsers(users);

    return { ok:true };

}


/*
 * Tidak boleh menyisakan 0 superadmin — kalau itu
 * terjadi, tidak ada lagi yang bisa login ke halaman
 * Kelola Akun untuk memperbaikinya.
 */

function wouldRemoveLastSuperadmin(users, usernameToRemove){

    const wanted =
        String(usernameToRemove || "")
        .trim()
        .toLowerCase();

    const remainingSuperadmins =
        users.filter(
            u =>
                u.role === "superadmin" &&
                u.username.toLowerCase() !== wanted
        ).length;

    return remainingSuperadmins === 0;

}


function removeUser(username){

    const users = loadUsers();

    const target =
        findUser(username);

    if(!target){
        return {
            ok:false,
            error:`Akun "${username}" tidak ditemukan.`
        };
    }

    if(wouldRemoveLastSuperadmin(users, target.username)){
        return {
            ok:false,
            error:
                "Tidak boleh menghapus superadmin terakhir."
        };
    }

    const kept =
        users.filter(
            u => u.username !== target.username
        );

    saveUsers(kept);

    return { ok:true };

}


function resetPassword(username, newPassword){

    const target = findUser(username);

    if(!target){
        return {
            ok:false,
            error:`Akun "${username}" tidak ditemukan.`
        };
    }

    const passwordError =
        validatePassword(newPassword);

    if(passwordError){
        return { ok:false, error:passwordError };
    }

    const users = loadUsers();

    const entry =
        users.find(u => u.username === target.username);

    entry.password = hashPassword(newPassword);

    /* Semua sesi yang dibuat sebelum ini jadi tidak berlaku (perangkat lain ikut keluar). */
    entry.passwordChangedAt = Date.now();

    saveUsers(users);

    return { ok:true };

}


/*
 * Ganti password sendiri: wajib menyebut password saat
 * ini, supaya sesi yang tertinggal di perangkat orang
 * lain tidak cukup untuk mengambil alih akun.
 */

async function changePassword(username, currentPassword, newPassword){

    const target = findUser(username);

    if(
        !target ||
        !(await verifyPassword(currentPassword, target.password))
    ){
        return {
            ok:false,
            wrongCurrent:true,
            error:"Password saat ini salah."
        };
    }

    if(currentPassword === newPassword){
        return {
            ok:false,
            error:"Password baru harus berbeda dari yang lama."
        };
    }

    return resetPassword(target.username, newPassword);

}


/*
 * Selalu jalankan scrypt walau user tidak ada,
 * supaya waktu respons tidak membocorkan
 * username mana yang terdaftar.
 */

const DUMMY_HASH = hashPassword(
    crypto.randomBytes(32).toString("hex")
);


async function authenticate(username, password){

    const user =
        findUser(username);

    if(!user){

        await verifyPassword(password, DUMMY_HASH);

        return null;

    }

    if(!(await verifyPassword(password, user.password))){

        return null;

    }

    return {
        username: user.username,
        role: user.role
    };

}


/* =====================================================
   SESSION COOKIE
   ===================================================== */

/*
 * Cookie ditandatangani HMAC, isinya tidak rahasia
 * tapi tidak bisa dipalsukan tanpa SESSION_SECRET.
 *
 * Stateless: restart server tidak melogout kasir
 * di tengah shift, selama SESSION_SECRET di .env
 * tidak berubah.
 */

const COOKIE_NAME = "broodle_session";


function b64url(buf){

    return Buffer.from(buf)
        .toString("base64url");

}


function sign(payload, secret){

    return crypto
        .createHmac("sha256", secret)
        .update(payload)
        .digest("base64url");

}


function createSession(user, secret, maxAgeSeconds){

    const expiresAt =
        Date.now() + maxAgeSeconds * 1000;

    const payload =
        b64url(JSON.stringify({
            u: user.username,
            r: user.role,
            e: expiresAt,
            i: Date.now()
        }));

    return payload + "." + sign(payload, secret);

}


function readSession(token, secret){

    if(typeof token !== "string"){
        return null;
    }

    const dot =
        token.lastIndexOf(".");

    if(dot <= 0){
        return null;
    }

    const payload =
        token.slice(0, dot);

    const signature =
        token.slice(dot + 1);

    const expected =
        sign(payload, secret);

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    if(
        a.length !== b.length ||
        !crypto.timingSafeEqual(a, b)
    ){
        return null;
    }

    let data;

    try{

        data =
            JSON.parse(
                Buffer.from(payload, "base64url")
                .toString("utf8")
            );

    }catch(error){

        return null;

    }

    if(
        !data ||
        typeof data.e !== "number" ||
        Date.now() > data.e
    ){
        return null;
    }

    if(!ROLES.includes(data.r)){
        return null;
    }

    return {
        username: data.u,
        role: data.r,
        expiresAt: data.e,
        issuedAt: Number(data.i) || 0
    };

}


/*
 * Cookie yang sah belum cukup: akunnya harus masih ada, perannya sama,
 * dan sesi dibuat SETELAH password terakhir diganti. Akun dihapus atau
 * password diganti = semua perangkat akun itu keluar di permintaan berikutnya.
 */
function validateSession(session){

    if(!session){
        return null;
    }

    const user = findUser(session.username);

    if(!user || user.role !== session.role){
        return null;
    }

    if((user.passwordChangedAt || 0) > session.issuedAt){
        return null;
    }

    return { ...session, username: user.username };

}


function parseCookies(header){

    const out = {};

    String(header || "")
    .split(";")
    .forEach(part => {

        const eq = part.indexOf("=");

        if(eq < 0){
            return;
        }

        out[part.slice(0, eq).trim()] =
            decodeURIComponent(
                part.slice(eq + 1).trim()
            );

    });

    return out;

}


module.exports = {
    ROLES,
    COOKIE_NAME,
    DATA_DIR,
    USERS_FILE,
    MIN_PASSWORD_LENGTH,
    hashPassword,
    verifyPassword,
    loadUsers,
    saveUsers,
    findUser,
    authenticate,
    createSession,
    readSession,
    validateSession,
    parseCookies,
    validateUsername,
    validatePassword,
    createUser,
    removeUser,
    resetPassword,
    changePassword,
    wouldRemoveLastSuperadmin
};

#!/usr/bin/env node

/*
 * Kelola akun kasir / superadmin.
 *
 *   node scripts/user.js add <username> <role>
 *   node scripts/user.js passwd <username>
 *   node scripts/user.js list
 *   node scripts/user.js remove <username>
 *
 * Password diminta lewat prompt, tidak lewat
 * argumen — argumen tersimpan di shell history.
 * Jalankan di terminal biasa (Terminal / iTerm / terminal VS Code).
 */

const fs       = require("node:fs");
const path     = require("node:path");

/* Pakai DATA_DIR yang sama dengan server. */
const envFile = path.join(__dirname, "..", ".env");
if(fs.existsSync(envFile)){
    process.loadEnvFile(envFile);
}

const auth = require("../auth.js");


/*
 * Di terminal biasa: password diketik tanpa tampil (mode raw).
 * Kalau stdin bukan terminal (pipe / prompt tanpa TTY): baca
 * semua baris sekali di awal — dua readline terpisah saling
 * menghilangkan input, akibatnya password salah tersimpan.
 */

const pipedLines =
    process.stdin.isTTY
        ? null
        : fs.readFileSync(0, "utf8").split(/\r?\n/);


function readHidden(prompt){

    return new Promise(resolve => {

        const stdin = process.stdin;

        process.stdout.write(prompt);

        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");

        let typed = "";

        const onData = chunk => {

            for(const ch of chunk){

                if(ch === "\r" || ch === "\n"){

                    stdin.setRawMode(false);
                    stdin.pause();
                    stdin.off("data", onData);

                    process.stdout.write("\n");

                    resolve(typed);

                    return;

                }

                if(ch === "\u0003"){
                    process.stdout.write("\n");
                    process.exit(130);
                }

                if(ch === "\u007f" || ch === "\b"){
                    typed = typed.slice(0, -1);
                }else{
                    typed += ch;
                }

            }

        };

        stdin.on("data", onData);

    });

}


async function ask(question){

    if(pipedLines){

        process.stdout.write(question + "\n");

        return pipedLines.shift() ?? "";

    }

    return readHidden(question);

}


async function askPassword(){

    const first =
        await ask("Password baru: ");

    const passwordError =
        auth.validatePassword(first);

    if(passwordError){

        console.error(passwordError);

        process.exit(1);

    }

    const second =
        await ask("Ulangi password: ");

    if(first !== second){

        console.error(
            "Password tidak sama."
        );

        process.exit(1);

    }

    return first;

}


async function main(){

    const [command, username, role] =
        process.argv.slice(2);


    if(command === "list"){

        const users = auth.loadUsers();

        if(users.length === 0){

            console.log(
                "Belum ada akun. Buat dulu:\n" +
                "  node scripts/user.js add admin superadmin"
            );

            return;

        }

        console.log("\nAKUN TERDAFTAR\n");

        users.forEach(u => {

            console.log(
                "  " +
                u.username.padEnd(20) +
                u.role
            );

        });

        console.log("");

        return;

    }


    if(command === "add"){

        if(!username || !role){

            console.error(
                "Pemakaian: node scripts/user.js add <username> <kasir|superadmin>"
            );

            process.exit(1);

        }

        if(!auth.ROLES.includes(role)){

            console.error(
                "Role harus salah satu: " +
                auth.ROLES.join(", ")
            );

            process.exit(1);

        }

        if(auth.findUser(username)){

            console.error(
                `Akun "${username}" sudah ada. ` +
                `Pakai "passwd" untuk ganti password.`
            );

            process.exit(1);

        }

        const password =
            await askPassword();

        const result =
            auth.createUser(username, password, role);

        if(!result.ok){

            console.error(result.error);

            process.exit(1);

        }

        console.log(
            `\nAkun "${username}" (${role}) dibuat.`
        );

        return;

    }


    if(command === "passwd"){

        if(!username){

            console.error(
                "Pemakaian: node scripts/user.js passwd <username>"
            );

            process.exit(1);

        }

        if(!auth.findUser(username)){

            console.error(
                `Akun "${username}" tidak ditemukan.`
            );

            process.exit(1);

        }

        const password =
            await askPassword();

        const result =
            auth.resetPassword(username, password);

        if(!result.ok){

            console.error(result.error);

            process.exit(1);

        }

        console.log(
            `\nPassword "${username}" diganti.`
        );

        return;

    }


    if(command === "remove"){

        if(!username){

            console.error(
                "Pemakaian: node scripts/user.js remove <username>"
            );

            process.exit(1);

        }

        const result =
            auth.removeUser(username);

        if(!result.ok){

            console.error(result.error);

            process.exit(1);

        }

        console.log(
            `Akun "${username}" dihapus.`
        );

        return;

    }


    console.log(
        "\nKelola akun Broodle\n\n" +
        "  node scripts/user.js add <username> <kasir|superadmin>\n" +
        "  node scripts/user.js passwd <username>\n" +
        "  node scripts/user.js list\n" +
        "  node scripts/user.js remove <username>\n"
    );

}


main().catch(error => {

    console.error(error);

    process.exit(1);

});

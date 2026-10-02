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
 */

const fs       = require("node:fs");
const path     = require("node:path");
const readline = require("node:readline");

/* Pakai DATA_DIR yang sama dengan server. */
const envFile = path.join(__dirname, "..", ".env");
if(fs.existsSync(envFile)){
    process.loadEnvFile(envFile);
}

const auth = require("../auth.js");


function ask(question, hidden){

    return new Promise(resolve => {

        const rl =
            readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                terminal: true
            });

        if(hidden){

            /* Jangan tampilkan password di layar. */
            rl._writeToOutput = function(chunk){

                if(rl.stdoutMuted){

                    rl.output.write("");

                    return;

                }

                rl.output.write(chunk);

            };

        }

        rl.question(question, answer => {

            rl.stdoutMuted = false;

            if(hidden){
                rl.output.write("\n");
            }

            rl.close();

            resolve(answer);

        });

        if(hidden){
            rl.stdoutMuted = true;
        }

    });

}


async function askPassword(){

    const first =
        await ask("Password baru: ", true);

    const passwordError =
        auth.validatePassword(first);

    if(passwordError){

        console.error(passwordError);

        process.exit(1);

    }

    const second =
        await ask("Ulangi password: ", true);

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

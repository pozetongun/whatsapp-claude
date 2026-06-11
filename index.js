const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

const AUTH_DIR = path.join(__dirname, 'auth_info');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: require('pino')({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    // Request pairing code if not registered
    if (!sock.authState.creds.registered) {
        const phone = await ask('Entrez votre numéro WhatsApp (ex: 33612345678 sans +): ');
        const code = await sock.requestPairingCode(phone.trim());
        console.log(`\n🔑 Code de couplage: ${code}`);
        console.log('\nDans WhatsApp sur votre téléphone:');
        console.log('  Paramètres → Appareils connectés → Connecter un appareil');
        console.log('  → Lier avec un numéro de téléphone → Entrez le code ci-dessus\n');
        rl.close();
    } else {
        rl.close();
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut) {
                console.log('Déconnecté. Supprimez le dossier auth_info et relancez.');
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                process.exit(1);
            } else {
                console.log('Reconnexion...');
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('\n✅ WhatsApp connecté avec succès!\n');
            console.log('Commandes disponibles:');
            console.log('  node send.js <numéro> <message>   — envoyer un message');
            console.log('  node listen.js                     — écouter les messages entrants\n');
            process.exit(0);
        }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const from = msg.key.remoteJid;
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            if (text) console.log(`[MESSAGE] De ${from}: ${text}`);
        }
    });
}

connectToWhatsApp().catch(console.error);

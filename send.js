const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const path = require('path');

const AUTH_DIR = path.join(__dirname, 'auth_info');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendMessage(number, message, attempt = 1) {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: require('pino')({ level: 'silent' }),
        retryRequestDelayMs: 500,
    });

    sock.ev.on('creds.update', saveCreds);

    await new Promise((resolve, reject) => {
        sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
            if (connection === 'open') resolve();
            if (connection === 'close') reject(new Error('close'));
        });
    });

    await sleep(3000);

    const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

    try {
        await sock.sendMessage(jid, { text: message });
        console.log(`✅ Message envoyé à ${number}`);
        await sleep(500);
        process.exit(0);
    } catch (err) {
        await sock.end();
        if (attempt < 3) {
            console.log(`Tentative ${attempt} échouée, retry...`);
            await sleep(2000);
            return sendMessage(number, message, attempt + 1);
        }
        throw err;
    }
}

const [,, number, ...rest] = process.argv;
const message = rest.join(' ');

if (!number || !message) {
    console.log('Usage: node send.js <numéro> <message>');
    console.log('Exemple: node send.js 33612345678 "Bonjour depuis Claude Code!"');
    process.exit(1);
}

sendMessage(number, message).catch((err) => { console.error('Erreur:', err.message); process.exit(1); });

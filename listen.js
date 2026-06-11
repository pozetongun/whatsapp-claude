const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const path = require('path');

const AUTH_DIR = path.join(__dirname, 'auth_info');

async function listenMessages() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({ auth: state, printQRInTerminal: false, logger: require('pino')({ level: 'silent' }) });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection }) => {
        if (connection === 'open') console.log('✅ En écoute... (Ctrl+C pour arrêter)\n');
        if (connection === 'close') { console.log('Déconnecté.'); process.exit(1); }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const from = msg.key.remoteJid?.replace('@s.whatsapp.net', '').replace('@g.us', ' (groupe)');
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[media]';
            const time = new Date(msg.messageTimestamp * 1000).toLocaleTimeString('fr-FR');
            console.log(`[${time}] ${from}: ${text}`);
        }
    });
}

listenMessages().catch(console.error);

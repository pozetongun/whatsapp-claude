const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const net = require('net');
const fs = require('fs');
const path = require('path');

const AUTH_DIR = path.join(__dirname, 'auth_info');
const DATA_DIR = path.join(__dirname, 'data');
const MSG_DIR  = path.join(DATA_DIR, 'messages');
const SOCKET_PATH = '/tmp/wa-daemon.sock';
const MAX_MSG = 100;

fs.mkdirSync(MSG_DIR, { recursive: true });

let sock = null;
let connected = false;

function loadJSON(file, def) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function saveJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let contacts = loadJSON(path.join(DATA_DIR, 'contacts.json'), {});
let groups   = loadJSON(path.join(DATA_DIR, 'groups.json'), {});

function jidToFilename(jid) {
    return jid.replace(/[^a-zA-Z0-9@._-]/g, '_');
}

function saveMessage(jid, msg) {
    const file = path.join(MSG_DIR, `${jidToFilename(jid)}.json`);
    const msgs = loadJSON(file, []);
    msgs.push(msg);
    if (msgs.length > MAX_MSG) msgs.splice(0, msgs.length - MAX_MSG);
    saveJSON(file, msgs);
}

function getMessages(jid, limit) {
    const file = path.join(MSG_DIR, `${jidToFilename(jid)}.json`);
    const msgs = loadJSON(file, []);
    return msgs.slice(-limit);
}

async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: require('pino')({ level: 'silent' }),
        retryRequestDelayMs: 500,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            process.stdout.write('[daemon] Session WhatsApp requise — scannez ce QR code (WhatsApp → Appareils connectés → Connecter un appareil) :\n');
            require('qrcode-terminal').generate(qr, { small: true }, (code) => process.stdout.write(code + '\n'));
        }
        if (connection === 'open') {
            connected = true;
            process.stdout.write('[daemon] connecté\n');
            try {
                const all = await sock.groupFetchAllParticipating();
                for (const [jid, meta] of Object.entries(all)) {
                    groups[jid] = { jid, name: meta.subject, participants: meta.participants?.length ?? 0 };
                }
                saveJSON(path.join(DATA_DIR, 'groups.json'), groups);
            } catch {}
        }
        if (connection === 'close') {
            connected = false;
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (code === DisconnectReason.loggedOut) {
                process.stdout.write('[daemon] déconnecté définitivement\n');
                process.exit(1);
            } else {
                process.stdout.write('[daemon] reconnexion...\n');
                setTimeout(connect, 3000);
            }
        }
    });

    sock.ev.on('contacts.upsert', (list) => {
        for (const c of list) {
            if (!c.id) continue;
            contacts[c.id] = { jid: c.id, name: c.name || c.notify || c.id.split('@')[0] };
        }
        saveJSON(path.join(DATA_DIR, 'contacts.json'), contacts);
    });

    sock.ev.on('contacts.update', (list) => {
        for (const c of list) {
            if (!c.id) continue;
            contacts[c.id] = { jid: c.id, name: c.name || c.notify || contacts[c.id]?.name || c.id.split('@')[0] };
        }
        saveJSON(path.join(DATA_DIR, 'contacts.json'), contacts);
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            const jid = msg.key.remoteJid;
            if (!jid) continue;
            const text = msg.message?.conversation
                || msg.message?.extendedTextMessage?.text
                || msg.message?.imageMessage?.caption
                || '';
            saveMessage(jid, {
                id: msg.key.id,
                from: msg.key.fromMe ? 'me' : (msg.key.participant || jid),
                fromMe: !!msg.key.fromMe,
                text,
                timestamp: msg.messageTimestamp,
            });
        }
    });
}

async function handleCommand(cmd) {
    switch (cmd.action) {
        case 'status':
            return { ok: true, connected };

        case 'contacts': {
            let list = Object.values(contacts);
            if (cmd.query) {
                const q = cmd.query.toLowerCase();
                list = list.filter(c => c.name?.toLowerCase().includes(q) || c.jid.includes(q));
            }
            return { ok: true, count: list.length, data: list };
        }

        case 'groups': {
            let list = Object.values(groups);
            if (cmd.query) {
                const q = cmd.query.toLowerCase();
                list = list.filter(g => g.name?.toLowerCase().includes(q));
            }
            return { ok: true, count: list.length, data: list };
        }

        case 'history': {
            const limit = cmd.limit || 20;
            return { ok: true, data: getMessages(cmd.jid, limit) };
        }

        case 'send': {
            if (!connected || !sock) return { ok: false, error: 'Non connecté à WhatsApp' };
            const jid = cmd.jid.includes('@') ? cmd.jid : `${cmd.jid}@s.whatsapp.net`;
            await sock.sendMessage(jid, { text: cmd.text });
            return { ok: true };
        }

        default:
            return { ok: false, error: `Action inconnue: ${cmd.action}` };
    }
}

function startServer() {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);

    const server = net.createServer((client) => {
        let buf = '';
        client.on('data', async (chunk) => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const cmd = JSON.parse(line);
                    const res = await handleCommand(cmd);
                    client.write(JSON.stringify(res) + '\n');
                } catch (e) {
                    client.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
                }
            }
        });
        client.on('error', () => {});
    });

    server.listen(SOCKET_PATH, () => {
        process.stdout.write(`[daemon] socket prêt: ${SOCKET_PATH}\n`);
    });
}

startServer();
connect().catch(console.error);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

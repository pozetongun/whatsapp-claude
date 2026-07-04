const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser, normalizeMessageContent } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const net = require('net');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { generateReply, generateLegalReply } = require('./claude');

const AUTO_REPLY_SELF_CHAT = true;
const AUTO_REPLY_LEGAL_GROUP = true;
const LEGAL_GROUP_JID = '120363428295698973@g.us'; // "Veille CGT"
const AUTO_REPLY_COOLDOWN_MS = 8000;
const botSentIds = new Set();
const lastBotReplyAt = new Map();

function extractText(waMessage) {
    const content = normalizeMessageContent(waMessage);
    return content?.conversation
        || content?.extendedTextMessage?.text
        || content?.imageMessage?.caption
        || '';
}

const AUTH_DIR = path.join(__dirname, 'auth_info');
const DATA_DIR = path.join(__dirname, 'data');
const MSG_DIR  = path.join(DATA_DIR, 'messages');
const SOCKET_PATH = '/tmp/wa-daemon.sock';
const MAX_MSG = 100;

fs.mkdirSync(MSG_DIR, { recursive: true });

// Verrou : une seule instance du daemon à la fois. Deux sockets Baileys sur la même
// session WhatsApp corrompent le protocole Signal (messages vides, désync).
const PID_FILE = '/tmp/wa-daemon.pid';
if (fs.existsSync(PID_FILE)) {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    try {
        process.kill(existingPid, 0);
        process.stdout.write(`[daemon] déjà en cours d'exécution (PID ${existingPid}), arrêt.\n`);
        process.exit(1);
    } catch { /* processus mort, verrou obsolète */ }
}
fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch {} });

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

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            const jid = msg.key.remoteJid;
            if (!jid) continue;

            if (botSentIds.has(msg.key.id)) { botSentIds.delete(msg.key.id); continue; }

            const text = extractText(msg.message);

            const priorHistory = getMessages(jid, MAX_MSG);

            saveMessage(jid, {
                id: msg.key.id,
                from: msg.key.fromMe ? 'me' : (msg.key.participant || jid),
                fromMe: !!msg.key.fromMe,
                text,
                timestamp: msg.messageTimestamp,
            });

            // WhatsApp peut router le chat "Vous" via le JID numéro (@s.whatsapp.net)
            // ou via le LID (@lid, l'identifiant multi-appareils) — on vérifie les deux.
            const selfJids = [sock.user?.id, sock.user?.lid].filter(Boolean).map(jidNormalizedUser);
            const isSelfChat = selfJids.includes(jid);
            const isLegalGroup = jid === LEGAL_GROUP_JID && !!msg.key.fromMe;
            const cooledDown = (Date.now() - (lastBotReplyAt.get(jid) || 0)) > AUTO_REPLY_COOLDOWN_MS;

            if (text && cooledDown) {
                try {
                    let reply = null;
                    if (AUTO_REPLY_SELF_CHAT && isSelfChat) {
                        reply = await generateReply(priorHistory, text);
                    } else if (AUTO_REPLY_LEGAL_GROUP && isLegalGroup) {
                        reply = await generateLegalReply(priorHistory, text);
                    }
                    if (reply) {
                        const sent = await sock.sendMessage(jid, { text: reply });
                        if (sent?.key?.id) botSentIds.add(sent.key.id);
                        lastBotReplyAt.set(jid, Date.now());
                    }
                } catch (e) {
                    process.stdout.write(`[daemon] erreur Claude: ${e.message}\n`);
                }
            }
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

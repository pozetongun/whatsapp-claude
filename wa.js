require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const net    = require('net');
const https  = require('https');
const http   = require('http');
const { spawn } = require('child_process');
const path   = require('path');
const fs     = require('fs');

const SOCKET_PATH  = '/tmp/wa-daemon.sock';
const DAEMON_PATH  = path.join(__dirname, 'daemon.js');
const REMOTE_URL   = process.env.WA_REMOTE_URL;  // ex: https://xxx.ngrok.io
const API_KEY      = process.env.WA_API_KEY || process.env.API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Transport : local socket ou HTTP distant ───────────────────────────────────

function remoteRequest(method, endpoint, body, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const url = new URL(endpoint, REMOTE_URL);
        const lib = url.protocol === 'https:' ? https : http;
        const opts = {
            hostname: url.hostname,
            port:     url.port || (url.protocol === 'https:' ? 443 : 80),
            path:     url.pathname + url.search,
            method,
            headers:  { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            timeout,
        };
        const req = lib.request(opts, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function sendCommand(cmd, timeout = 10000) {
    if (REMOTE_URL) {
        const { action, ...params } = cmd;
        switch (action) {
            case 'status':   return remoteRequest('GET',  '/api/status', null, timeout);
            case 'groups':   return remoteRequest('GET',  `/api/groups?q=${encodeURIComponent(params.query||'')}`, null, timeout);
            case 'contacts': return remoteRequest('GET',  `/api/contacts?q=${encodeURIComponent(params.query||'')}`, null, timeout);
            case 'history':  return remoteRequest('GET',  `/api/history?jid=${encodeURIComponent(params.jid)}&limit=${params.limit||20}`, null, timeout);
            case 'send':     return remoteRequest('POST', '/api/send', { jid: params.jid, text: params.text }, timeout);
            default: throw new Error(`Action inconnue: ${action}`);
        }
    }
    return new Promise((resolve, reject) => {
        const client = net.connect(SOCKET_PATH, () => client.write(JSON.stringify(cmd) + '\n'));
        let buf = '';
        const t = setTimeout(() => { client.destroy(); reject(new Error('Timeout')); }, timeout);
        client.on('data', d => {
            buf += d.toString();
            for (const line of buf.split('\n')) {
                if (!line.trim()) continue;
                try { clearTimeout(t); resolve(JSON.parse(line)); client.destroy(); return; } catch {}
            }
        });
        client.on('error', e => { clearTimeout(t); reject(e); });
    });
}

async function ensureDaemon() {
    if (REMOTE_URL) return; // daemon géré à distance
    try { await sendCommand({ action: 'status' }, 1000); return; } catch {}
    const log = fs.openSync('/tmp/wa-daemon.log', 'a');
    spawn('node', [DAEMON_PATH], { detached: true, stdio: ['ignore', log, log] }).unref();
    for (let i = 0; i < 15; i++) {
        await sleep(600);
        try { await sendCommand({ action: 'status' }, 1000); return; } catch {}
    }
    throw new Error('Impossible de démarrer le daemon. Lancez: node /root/whatsapp-claude/daemon.js');
}

// ── CLI ────────────────────────────────────────────────────────────────────────

function out(data) { console.log(JSON.stringify(data, null, 2)); }

async function main() {
    const [,, action, ...args] = process.argv;

    if (!action || action === 'help') {
        const mode = REMOTE_URL ? `distant (${REMOTE_URL})` : 'local';
        console.log([
            `Usage: node wa.js <commande> [options]  [mode: ${mode}]`,
            '',
            '  status                 — état de la connexion WhatsApp',
            '  contacts [query]       — liste des contacts (filtrable)',
            '  groups   [query]       — liste des groupes (filtrable)',
            '  send <jid> <message>   — envoyer un message',
            '  history <jid> [n]      — n derniers messages (défaut: 20)',
            '',
            'Mode distant: définir WA_REMOTE_URL et WA_API_KEY dans l\'environnement',
        ].join('\n'));
        return;
    }

    if (action !== 'status') {
        try { await ensureDaemon(); }
        catch (e) { out({ ok: false, error: e.message }); process.exit(1); }
    }

    switch (action) {
        case 'status': {
            try { out(await sendCommand({ action: 'status' }, 2000)); }
            catch { out({ ok: false, connected: false, daemon: false }); }
            break;
        }
        case 'contacts':
            out(await sendCommand({ action: 'contacts', query: args[0] || '' }));
            break;
        case 'groups':
            out(await sendCommand({ action: 'groups', query: args[0] || '' }));
            break;
        case 'send': {
            const [jid, ...rest] = args;
            const text = rest.join(' ');
            if (!jid || !text) { out({ ok: false, error: 'Usage: send <jid> <message>' }); break; }
            out(await sendCommand({ action: 'send', jid, text }, 15000));
            break;
        }
        case 'history': {
            const [jid, limitStr] = args;
            if (!jid) { out({ ok: false, error: 'Usage: history <jid> [limit]' }); break; }
            out(await sendCommand({ action: 'history', jid, limit: parseInt(limitStr) || 20 }));
            break;
        }
        default:
            out({ ok: false, error: `Commande inconnue: ${action}` });
    }
}

main().catch(e => { out({ ok: false, error: e.message }); process.exit(1); });

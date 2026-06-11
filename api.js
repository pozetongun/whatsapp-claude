const http = require('http');
const net  = require('net');
const crypto = require('crypto');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const PORT        = process.env.PORT     || 3000;
const API_KEY     = process.env.API_KEY  || 'changeme';
const SOCKET_PATH = '/tmp/wa-daemon.sock';

// ── Daemon client ─────────────────────────────────────────────────────────────

function daemonCmd(cmd, timeout = 10000) {
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

// ── MCP tools ─────────────────────────────────────────────────────────────────

const TOOLS = [
    {
        name: 'wa_list_groups',
        description: 'Liste tous les groupes WhatsApp. Retourne nom, JID et nombre de membres.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Filtre optionnel par nom' } } },
    },
    {
        name: 'wa_list_contacts',
        description: 'Liste les contacts WhatsApp connus (se peuple au fil des échanges).',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Filtre par nom ou numéro' } } },
    },
    {
        name: 'wa_send_message',
        description: 'Envoie un message WhatsApp à un contact ou un groupe.',
        inputSchema: {
            type: 'object', required: ['jid', 'text'],
            properties: {
                jid:  { type: 'string', description: 'JID du destinataire : numéro (33612345678) ou groupe (xxx@g.us)' },
                text: { type: 'string', description: 'Texte du message' },
            },
        },
    },
    {
        name: 'wa_get_history',
        description: 'Récupère les derniers messages d\'une conversation (contact ou groupe).',
        inputSchema: {
            type: 'object', required: ['jid'],
            properties: {
                jid:   { type: 'string', description: 'JID de la conversation' },
                limit: { type: 'number', description: 'Nombre de messages à retourner (défaut: 20)' },
            },
        },
    },
    {
        name: 'wa_status',
        description: 'Vérifie si WhatsApp est connecté.',
        inputSchema: { type: 'object', properties: {} },
    },
];

async function runTool(name, args = {}) {
    switch (name) {
        case 'wa_status': {
            const r = await daemonCmd({ action: 'status' });
            return r.connected ? 'WhatsApp connecté.' : 'WhatsApp non connecté.';
        }
        case 'wa_list_groups': {
            const r = await daemonCmd({ action: 'groups', query: args.query || '' });
            if (!r.data?.length) return 'Aucun groupe trouvé.';
            return r.data.map(g => `• ${g.name || '(sans nom)'} — ${g.participants} membres — \`${g.jid}\``).join('\n');
        }
        case 'wa_list_contacts': {
            const r = await daemonCmd({ action: 'contacts', query: args.query || '' });
            if (!r.data?.length) return 'Aucun contact trouvé.';
            return r.data.map(c => `• ${c.name} — \`${c.jid}\``).join('\n');
        }
        case 'wa_send_message': {
            const r = await daemonCmd({ action: 'send', jid: args.jid, text: args.text }, 15000);
            return r.ok ? `Message envoyé à \`${args.jid}\`.` : `Erreur: ${r.error}`;
        }
        case 'wa_get_history': {
            const r = await daemonCmd({ action: 'history', jid: args.jid, limit: args.limit || 20 });
            if (!r.data?.length) return 'Aucun message.';
            return r.data.map(m => {
                const t = new Date(m.timestamp * 1000).toLocaleString('fr-FR');
                return `[${t}] ${m.fromMe ? 'Moi' : m.from}: ${m.text || '(media)'}`;
            }).join('\n');
        }
        default:
            throw new Error(`Outil inconnu: ${name}`);
    }
}

// ── MCP HTTP/SSE transport ────────────────────────────────────────────────────

const sessions = new Map(); // sessionId → res

function sseWrite(res, event, data) {
    res.write(`event: ${event}\ndata: ${data}\n\n`);
}

async function handleMCPMessage(raw, sseRes) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { method, id, params } = msg;
    let result, error;

    try {
        switch (method) {
            case 'initialize':
                result = {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'whatsapp-mcp', version: '1.0.0' },
                };
                break;
            case 'notifications/initialized':
                return;
            case 'ping':
                result = {};
                break;
            case 'tools/list':
                result = { tools: TOOLS };
                break;
            case 'tools/call': {
                const text = await runTool(params.name, params.arguments || {});
                result = { content: [{ type: 'text', text }] };
                break;
            }
            default:
                error = { code: -32601, message: `Method not found: ${method}` };
        }
    } catch (e) {
        error = { code: -32000, message: e.message };
    }

    const response = { jsonrpc: '2.0', id };
    if (error) response.error = error; else response.result = result;
    sseWrite(sseRes, 'message', JSON.stringify(response));
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function auth(req) {
    const header = req.headers['authorization'];
    if (header?.startsWith('Bearer ')) return header.slice(7) === API_KEY;
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('key') === API_KEY;
}

function json(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST' });
        res.end(); return;
    }

    if (!auth(req)) { json(res, 401, { error: 'Unauthorized' }); return; }

    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // ── MCP SSE endpoint
    if (req.method === 'GET' && path === '/sse') {
        const sid = crypto.randomBytes(8).toString('hex');
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });
        sessions.set(sid, res);
        sseWrite(res, 'endpoint', `/message?sessionId=${sid}`);
        req.on('close', () => sessions.delete(sid));
        return;
    }

    // ── MCP message endpoint
    if (req.method === 'POST' && path === '/message') {
        const sid = url.searchParams.get('sessionId');
        const sseRes = sessions.get(sid);
        if (!sseRes) { json(res, 404, { error: 'Session not found' }); return; }
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
            res.writeHead(202); res.end();
            handleMCPMessage(body, sseRes);
        });
        return;
    }

    // ── REST API (pour wa.js distant et tests)
    if (path === '/api/status')   { json(res, 200, await daemonCmd({ action: 'status' })); return; }
    if (path === '/api/groups')   { json(res, 200, await daemonCmd({ action: 'groups',   query: url.searchParams.get('q') || '' })); return; }
    if (path === '/api/contacts') { json(res, 200, await daemonCmd({ action: 'contacts', query: url.searchParams.get('q') || '' })); return; }
    if (path === '/api/history')  { json(res, 200, await daemonCmd({ action: 'history',  jid: url.searchParams.get('jid'), limit: parseInt(url.searchParams.get('limit')) || 20 })); return; }

    if (req.method === 'POST' && path === '/api/send') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', async () => {
            try {
                const { jid, text } = JSON.parse(body);
                json(res, 200, await daemonCmd({ action: 'send', jid, text }, 15000));
            } catch (e) { json(res, 400, { error: e.message }); }
        });
        return;
    }

    json(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
    console.log(`[WA API] http://localhost:${PORT}`);
    console.log(`[WA API] MCP SSE → GET  /sse`);
    console.log(`[WA API] REST     → GET  /api/groups|contacts|history|status`);
    console.log(`[WA API] REST     → POST /api/send`);
});

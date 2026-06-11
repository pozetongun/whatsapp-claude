#!/usr/bin/env bash
# Lance le daemon WhatsApp, le serveur MCP/API, et ngrok
set -e
cd "$(dirname "$0")"

# Charge les variables d'env
source .env 2>/dev/null || true

echo "=== WhatsApp MCP Server ==="

# 1. Daemon
if ! node wa.js status 2>/dev/null | grep -q '"connected":true'; then
    echo "[1/3] Démarrage du daemon WhatsApp..."
    nohup node daemon.js >> /tmp/wa-daemon.log 2>&1 &
    for i in $(seq 1 15); do
        sleep 1
        node wa.js status 2>/dev/null | grep -q '"connected":true' && break
        echo "  attente connexion WhatsApp... ($i/15)"
    done
else
    echo "[1/3] Daemon déjà actif."
fi

# 2. API / MCP server
if lsof -ti:${PORT:-3000} >/dev/null 2>&1; then
    echo "[2/3] Serveur API déjà sur le port ${PORT:-3000}."
else
    echo "[2/3] Démarrage du serveur MCP (port ${PORT:-3000})..."
    nohup node api.js >> /tmp/wa-api.log 2>&1 &
    sleep 2
fi

# 3. ngrok
echo "[3/3] Démarrage de ngrok..."
NGROK_BIN="${NGROK_BIN:-ngrok}"

# Tue un éventuel ngrok déjà lancé sur ce port
pkill -f "ngrok http ${PORT:-3000}" 2>/dev/null || true
sleep 1

nohup $NGROK_BIN http ${PORT:-3000} >> /tmp/wa-ngrok.log 2>&1 &
sleep 3

# Récupère l'URL publique via l'API locale de ngrok
PUBLIC_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const t=JSON.parse(d).tunnels;const u=t.find(x=>x.proto==='https');console.log(u?u.public_url:'');}catch{console.log('')}})" 2>/dev/null)

if [ -z "$PUBLIC_URL" ]; then
    echo ""
    echo "⚠️  ngrok URL non détectée (vérifiez votre token: ngrok config add-authtoken <TOKEN>)"
    echo "    Logs: /tmp/wa-ngrok.log"
else
    echo ""
    echo "✅ Tout est lancé!"
    echo ""
    echo "  URL publique : $PUBLIC_URL"
    echo "  Clé API      : ${API_KEY}"
    echo ""
    echo "─── Pour claude.ai (MCP) ───────────────────────────────────────"
    echo "  URL du serveur MCP : ${PUBLIC_URL}/sse"
    echo "  Header auth        : Authorization: Bearer ${API_KEY}"
    echo ""
    echo "─── Pour Claude Code distant ────────────────────────────────────"
    echo "  export WA_REMOTE_URL=${PUBLIC_URL}"
    echo "  export WA_API_KEY=${API_KEY}"
    echo ""
fi

#!/usr/bin/env bash
# Garde le daemon WhatsApp et le serveur API en vie en permanence.
# Un seul superviseur actif à la fois (verrou via flock).
cd "$(dirname "$0")"

PIDFILE=/tmp/wa-supervisor.pid
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
    exit 0
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

BOX_SYNC_DIR=/home/userland/box-mcp-server
i=0
while true; do
    pgrep -f "node daemon.js" >/dev/null || nohup node daemon.js >> /tmp/wa-daemon.log 2>&1 &
    pgrep -f "node api.js"    >/dev/null || nohup node api.js    >> /tmp/wa-api.log    2>&1 &

    # Synchronise les nouveaux accords Box toutes les ~10 min, seulement si un token valide existe
    if [ $((i % 20)) -eq 0 ] && [ -d "$BOX_SYNC_DIR" ]; then
        (cd "$BOX_SYNC_DIR" && node sync-new-accords.js) >/dev/null 2>&1 &
    fi
    i=$((i + 1))

    sleep 30
done

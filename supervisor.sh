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

while true; do
    pgrep -f "node daemon.js" >/dev/null || nohup node daemon.js >> /tmp/wa-daemon.log 2>&1 &
    pgrep -f "node api.js"    >/dev/null || nohup node api.js    >> /tmp/wa-api.log    2>&1 &
    sleep 30
done

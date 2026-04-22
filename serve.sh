#!/usr/bin/env bash
# Serve the static app from this directory (e.g. local dev or LAN preview).
# Usage: ./serve.sh [port]
set -euo pipefail
PORT="${1:-8080}"

lan_ip=""
if command -v hostname >/dev/null 2>&1; then
  lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi

echo "Listening on all interfaces, port ${PORT}"
echo "  This computer: http://127.0.0.1:${PORT}/"
if [[ -n "${lan_ip}" ]]; then
  echo "  Phone / other devices: http://${lan_ip}:${PORT}/"
else
  echo "  On your phone, use this machine's LAN IP (e.g. 192.168.x.x) instead of 127.0.0.1"
fi
echo "Tip: if the phone cannot connect, check the firewall allows TCP ${PORT}."
exec python3 -m http.server "${PORT}" --bind 0.0.0.0

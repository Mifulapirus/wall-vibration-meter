#!/usr/bin/env bash
# Apply the latest wallvibe nginx config (adds /api/ + /firmware over HTTP for
# device OTA) and restart the app to load new server code. Safe: validates
# nginx before reloading, rolls back the conf on failure. Only touches the
# wallvibe site + service.
#
# Run:  sudo bash /srv/apps/wallvibe/server/deploy/update.sh
set -euo pipefail

SRC=/srv/apps/wallvibe/server/deploy/wallvibe.thehomelab.dev.conf
DST=/etc/nginx/sites-available/wallvibe.thehomelab.dev.conf
BAK="${DST}.bak.$(date +%s)"

echo ">> Restarting wallvibe service (loads new app.py + runs DB migration)"
systemctl restart wallvibe
sleep 2
curl -fsS http://127.0.0.1:5006/health >/dev/null && echo "   service healthy"

echo ">> Updating nginx conf"
cp -a "$DST" "$BAK"
install -m 644 "$SRC" "$DST"
if nginx -t; then
    systemctl reload nginx
    echo "   nginx reloaded (backup: ${BAK})"
else
    echo "!! nginx -t failed — restoring backup, not reloading"
    cp -a "$BAK" "$DST"
    exit 1
fi

echo ">> Checks"
echo -n "   HTTP /api/firmware/latest (expect 200, not 301): "
curl -s -o /dev/null -w "%{http_code}\n" http://wallvibe.thehomelab.dev/api/firmware/latest
echo ">> Done."

#!/usr/bin/env bash
# Allow the ESP32-C3 to push over plain HTTP on port 80 (path /api/ingest),
# while browsers are still redirected to HTTPS. Avoids the TLS memory cost on
# the device. Safe: backs up the current conf, validates with `nginx -t`, and
# rolls back automatically if validation fails.
#
# Run:  sudo bash /srv/apps/wallvibe/server/deploy/enable-http-ingest.sh
set -euo pipefail

SRC=/srv/apps/wallvibe/server/deploy/wallvibe.thehomelab.dev.conf
DST=/etc/nginx/sites-available/wallvibe.thehomelab.dev.conf
BAK="${DST}.bak.$(date +%s)"

echo ">> Backing up current conf -> ${BAK}"
cp -a "$DST" "$BAK"

echo ">> Installing HTTP-ingest conf"
install -m 644 "$SRC" "$DST"

echo ">> Validating nginx config"
if nginx -t; then
    systemctl reload nginx
    echo ">> Reloaded. Backup kept at ${BAK}"
else
    echo "!! nginx -t FAILED — restoring backup and NOT reloading."
    cp -a "$BAK" "$DST"
    exit 1
fi

echo ">> Quick checks"
echo -n "   HTTP  /api/ingest (expect 200/4xx, NOT 301): "
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://wallvibe.thehomelab.dev/api/ingest \
     -H 'Content-Type: application/json' -d '{"device_id":"nginxtest","vel_rms_mm_s":0}'
echo -n "   HTTP  /            (expect 301): "
curl -s -o /dev/null -w "%{http_code}\n" http://wallvibe.thehomelab.dev/
echo ">> Done."

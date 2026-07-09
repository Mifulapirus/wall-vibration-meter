#!/usr/bin/env bash
# Privileged install steps for the Wall Vibration Meter history server.
# Everything non-root (app files, venv, deps) is already deployed to
# /srv/apps/wallvibe. This script only ADDS wallvibe-specific units/config —
# it never edits other projects' files. Safe to re-run (idempotent).
#
# Run:  sudo bash /srv/apps/wallvibe/deploy/install-root.sh
set -euo pipefail

APP=/srv/apps/wallvibe
DOMAIN=wallvibe.thehomelab.dev

echo ">> Pre-flight collision checks"
if ss -ltn | grep -q '127.0.0.1:5006 '; then
    echo "!! Port 5006 already in use — aborting."; exit 1
fi
if [ -e /etc/systemd/system/wallvibe.service ]; then
    echo "   (wallvibe.service already exists — will be overwritten with the repo version)"
fi
for f in /etc/nginx/sites-enabled/*; do
    if grep -qs "server_name .*${DOMAIN}" "$f" && [ "$(basename "$f")" != "${DOMAIN}.conf" ]; then
        echo "!! ${DOMAIN} already served by $f — aborting to avoid a clash."; exit 1
    fi
done
echo "   OK: 5006 free, no foreign nginx block for ${DOMAIN}"

echo ">> Installing systemd unit"
install -m 644 "${APP}/deploy/wallvibe.service" /etc/systemd/system/wallvibe.service
systemctl daemon-reload
systemctl enable --now wallvibe.service
sleep 2
systemctl --no-pager --full status wallvibe.service | head -6

echo ">> Local health check (127.0.0.1:5006)"
curl -fsS http://127.0.0.1:5006/health && echo

echo ">> Installing nginx site"
install -m 644 "${APP}/deploy/wallvibe.thehomelab.dev.conf" /etc/nginx/sites-available/${DOMAIN}.conf
ln -sfn /etc/nginx/sites-available/${DOMAIN}.conf /etc/nginx/sites-enabled/${DOMAIN}.conf
nginx -t
systemctl reload nginx

echo ">> Obtaining TLS certificate via certbot (nginx plugin)"
certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos --redirect \
        -m legna.fernandez1945@gmail.com || {
    echo "!! certbot failed. The service is up on HTTP; fix DNS/cert and re-run:"
    echo "   sudo certbot --nginx -d ${DOMAIN}"
}

echo ">> Final public check"
curl -fsS https://${DOMAIN}/health && echo
echo ">> Done. Dashboard: https://${DOMAIN}/"

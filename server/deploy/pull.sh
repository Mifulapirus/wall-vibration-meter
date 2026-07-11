#!/usr/bin/env bash
# Routine wallvibe deploy: pull latest code from git and hot-reload gunicorn.
# No sudo needed — the checkout, venv, and gunicorn master all run as `angel`.
# The SIGHUP re-imports app.py and re-runs init_db() with zero downtime.
#
# Only nginx/systemd changes need the sudo path (update.sh / install-root.sh).
#
# Run:  bash /srv/apps/wallvibe/server/deploy/pull.sh
set -euo pipefail

ROOT=/srv/apps/wallvibe          # git checkout root (sparse: server/ only)
APP="$ROOT/server"               # holds app.py + requirements.txt
VENV="$ROOT/.venv"               # untracked, lives at the checkout root

echo ">> git pull"
git -C "$ROOT" pull --ff-only

echo ">> pip install (in case requirements changed)"
"$VENV/bin/pip" install -q -r "$APP/requirements.txt"

echo ">> Hot-reloading gunicorn (SIGHUP to master)"
kill -HUP "$(systemctl show -p MainPID --value wallvibe)"
sleep 2

printf ">> health -> "
curl -fsS http://127.0.0.1:5006/health && echo
echo ">> Done."

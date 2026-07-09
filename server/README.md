# Wall Vibration Meter — History Server

Receives readings pushed by the ESP32-C3 meter, stores them in SQLite, and
serves a history dashboard (velocity & frequency over time + a spectrogram).

Stack: **Flask + SQLAlchemy + SQLite**, served by gunicorn, packaged with
Docker. It exposes a **plain HTTP port** so your existing Nginx can reverse-proxy
`wallvibe.thehomelab.dev` to it (consistent with your other services).

Because the meter has no real-time clock, **the server timestamps every reading
on receipt.**

## Run on capek-web (Docker)

```bash
cd server
cp .env.example .env          # optional: set INGEST_TOKEN, retention, etc.
docker compose up -d --build
```

The app now listens on `http://capek-web:5006`. Data persists in `./data`
(SQLite DB), mounted into the container.

### Put it behind Nginx

A reference server block is in [`nginx/wallvibe.thehomelab.dev.conf`](nginx/wallvibe.thehomelab.dev.conf).
Copy it into your Nginx config (adjust cert paths / upstream to match your
setup), point it at `127.0.0.1:5006`, reload Nginx, and the dashboard is at
<https://wallvibe.thehomelab.dev/>.

## Point the device at it

In the firmware's [`include/MeterConfig.h`](../include/MeterConfig.h):

```c
#define HISTORY_INGEST_URL  "https://wallvibe.thehomelab.dev/api/ingest"
#define HISTORY_TOKEN       ""      // must equal server INGEST_TOKEN
```

Then `pio run -t upload`. The device POSTs a reading (+ spectrum) every
`HISTORY_PUSH_INTERVAL_MS` (default 10 s).

> **Memory note:** the ESP32-C3 does HTTPS with a relaxed (`setInsecure`)
> handshake, created per-push so TLS buffers are freed immediately. If you see
> `history push failed` with low heap in the serial log, point `HISTORY_INGEST_URL`
> at the container's plain-HTTP port instead — `http://capek-web:5006/api/ingest`
> — which skips TLS entirely.

## API

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/ingest` | Device pushes a reading. Body = the same JSON as the device's `/api/vibration`, plus `device_id`. Optional `X-Device-Token` header. |
| GET | `/api/devices` | List devices seen, with last-seen + latest reading. |
| GET | `/api/latest?device=` | Most recent reading. |
| GET | `/api/readings?device=&hours=24&limit=3000` | Summary time series (decimated server-side for long ranges). |
| GET | `/api/spectra?device=&hours=6&limit=500` | Spectrogram columns (decoded float arrays). |
| GET | `/health` | Health check (used by the Docker healthcheck). |
| GET | `/` | Dashboard. |

## Configuration (env / `.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `5006` | HTTP listen port. |
| `DB_PATH` | `/data/wallvibe.db` | SQLite file (mounted volume). |
| `INGEST_TOKEN` | *(empty)* | If set, device must send it in `X-Device-Token`. |
| `SPECTRUM_MIN_INTERVAL_S` | `30` | Store at most one spectrum per device per this many seconds. |
| `RETENTION_DAYS` | `0` | Delete data older than N days (0 = keep forever). |

## Local development

```bash
python -m venv .venv && . .venv/Scripts/activate   # (Windows: .venv\Scripts\activate)
pip install -r requirements.txt
DB_PATH=./data/dev.db PORT=5006 python app.py       # dev server on :5006
```

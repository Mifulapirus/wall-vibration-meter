"""
Wall Vibration Meter - history server.

Receives readings pushed by the ESP32-C3 meter, stores them in SQLite, and
serves a dashboard with historical charts and a spectrogram.

The device has no real-time clock, so every reading is timestamped on the
server at the moment of receipt.

Stack matches the Activity Dice app: Flask + SQLAlchemy + SQLite.
"""
import csv
import io
import os
import struct
import threading
import time
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from dateutil import parser as dtparser
from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import func

# --- Configuration (env-overridable) ---------------------------------------
DB_PATH               = os.environ.get("DB_PATH", "/data/wallvibe.db")
INGEST_TOKEN          = os.environ.get("INGEST_TOKEN", "")          # "" = open (homelab)
SPECTRUM_MIN_INTERVAL = float(os.environ.get("SPECTRUM_MIN_INTERVAL_S", "30"))
RETENTION_DAYS        = int(os.environ.get("RETENTION_DAYS", "0"))   # 0 = keep forever
PORT                  = int(os.environ.get("PORT", "5006"))
# Discard obvious handling/mounting transients at ingest (0 disables a check).
# A bump saturates the accelerometer and blows up the low-frequency velocity
# integral, so real wall vibration never approaches these.
# Real AC-induced wall velocity is sub-2 mm/s (the compressor is high-frequency
# and velocity ~ accel/freq), so anything above ~10 mm/s is a low-frequency
# bump/handling event, not wall vibration.
INGEST_MAX_VEL_MM_S   = float(os.environ.get("INGEST_MAX_VEL_MM_S", "10"))
INGEST_MAX_PEAK_G     = float(os.environ.get("INGEST_MAX_PEAK_G", "1.5"))

app = Flask(__name__)
CORS(app)
# Use an absolute path: Flask-SQLAlchemy resolves *relative* sqlite paths
# against app.instance_path, not the working directory.
DB_ABS = os.path.abspath(DB_PATH)
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///" + DB_ABS.replace(os.sep, "/")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
# Wait up to 15 s if another worker holds the write lock (SQLite + gunicorn).
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {"connect_args": {"timeout": 15}}
db = SQLAlchemy(app)


def utcnow():
    return datetime.now(timezone.utc)


# --- Models ----------------------------------------------------------------
class Reading(db.Model):
    __tablename__ = "readings"
    id            = db.Column(db.Integer, primary_key=True)
    device_id     = db.Column(db.String(32), index=True, nullable=False)
    ts            = db.Column(db.DateTime, index=True, default=utcnow, nullable=False)
    uptime_ms     = db.Column(db.BigInteger)
    vel_rms_mm_s  = db.Column(db.Float)
    dom_freq_hz   = db.Column(db.Float)
    accel_rms_g   = db.Column(db.Float)
    accel_rms_ms2 = db.Column(db.Float)
    peak_g        = db.Column(db.Float)
    zone          = db.Column(db.Integer)
    fs            = db.Column(db.Float)
    n             = db.Column(db.Integer)
    bin_hz        = db.Column(db.Float)
    n_bins        = db.Column(db.Integer)
    band_rms_g    = db.Column(db.Float)     # legacy single band (fw<=3)
    band_lo_hz    = db.Column(db.Float)
    band_hi_hz    = db.Column(db.Float)
    band1_rms_g   = db.Column(db.Float)     # band 1 (low, ~25-40 Hz) - 4-pole/fan units
    band1_lo_hz   = db.Column(db.Float)
    band1_hi_hz   = db.Column(db.Float)
    band2_rms_g   = db.Column(db.Float)     # band 2 (compressor, ~50-65 Hz) - 2-pole units
    band2_lo_hz   = db.Column(db.Float)
    band2_hi_hz   = db.Column(db.Float)
    fw_version    = db.Column(db.Integer)   # firmware version that produced this

    def as_dict(self):
        return {
            "id": self.id,
            "device_id": self.device_id,
            "ts": self.ts.replace(tzinfo=timezone.utc).isoformat(),
            "vel_rms_mm_s": self.vel_rms_mm_s,
            "dom_freq_hz": self.dom_freq_hz,
            "accel_rms_g": self.accel_rms_g,
            "accel_rms_ms2": self.accel_rms_ms2,
            "peak_g": self.peak_g,
            "band_rms_g": self.band_rms_g,
            "band_lo_hz": self.band_lo_hz,
            "band_hi_hz": self.band_hi_hz,
            "band1_rms_g": self.band1_rms_g,
            "band1_lo_hz": self.band1_lo_hz,
            "band1_hi_hz": self.band1_hi_hz,
            "band2_rms_g": self.band2_rms_g,
            "band2_lo_hz": self.band2_lo_hz,
            "band2_hi_hz": self.band2_hi_hz,
            "fw_version": self.fw_version,
            "zone": self.zone,
            "bin_hz": self.bin_hz,
            "n_bins": self.n_bins,
        }


class Spectrum(db.Model):
    __tablename__ = "spectra"
    id        = db.Column(db.Integer, primary_key=True)
    device_id = db.Column(db.String(32), index=True, nullable=False)
    ts        = db.Column(db.DateTime, index=True, default=utcnow, nullable=False)
    bin_hz    = db.Column(db.Float)
    n_bins    = db.Column(db.Integer)
    data      = db.Column(db.LargeBinary)   # packed little-endian float32, n_bins values (m/s^2)

    def values(self):
        n = len(self.data) // 4
        return list(struct.unpack("<%df" % n, self.data))


class Noise(db.Model):
    __tablename__ = "noise"
    id      = db.Column(db.Integer, primary_key=True)
    source  = db.Column(db.String(48), index=True, nullable=False)  # e.g. "bedroom"
    ts      = db.Column(db.DateTime, index=True, nullable=False)     # stored UTC
    spl_db  = db.Column(db.Float)                                    # primary level (LAeq if available)
    lamax   = db.Column(db.Float)                                    # optional per-row max
    lamin   = db.Column(db.Float)                                    # optional per-row min

    def as_dict(self):
        return {
            "source": self.source,
            "ts": self.ts.replace(tzinfo=timezone.utc).isoformat(),
            "spl_db": self.spl_db,
            "lamax": self.lamax,
            "lamin": self.lamin,
        }


# --- Helpers ---------------------------------------------------------------
def token_ok():
    if not INGEST_TOKEN:
        return True
    return request.headers.get("X-Device-Token", "") == INGEST_TOKEN


def parse_range_hours():
    try:
        return max(0.0, float(request.args.get("hours", "24")))
    except ValueError:
        return 24.0


# --- Device ingest ---------------------------------------------------------
@app.post("/api/ingest")
def ingest():
    if not token_ok():
        return jsonify(ok=False, error="unauthorized"), 401

    j = request.get_json(silent=True)
    if not j:
        return jsonify(ok=False, error="bad json"), 400

    device_id = str(j.get("device_id") or request.remote_addr or "unknown")[:32]
    now = utcnow()

    # Reject mounting/handling transients before storing anything (incl. spectrum).
    vel = j.get("vel_rms_mm_s")
    peak = j.get("peak_g")
    if (INGEST_MAX_VEL_MM_S > 0 and vel is not None and vel > INGEST_MAX_VEL_MM_S) or \
       (INGEST_MAX_PEAK_G > 0 and peak is not None and peak > INGEST_MAX_PEAK_G):
        app.logger.info("discarded outlier from %s: vel=%s peak=%s", device_id, vel, peak)
        return jsonify(ok=True, discarded=True, vel=vel, peak=peak), 200

    r = Reading(
        device_id=device_id,
        ts=now,
        uptime_ms=j.get("uptime_ms"),
        vel_rms_mm_s=j.get("vel_rms_mm_s"),
        dom_freq_hz=j.get("dom_freq_hz"),
        accel_rms_g=j.get("accel_rms_g"),
        accel_rms_ms2=j.get("accel_rms_ms2"),
        peak_g=j.get("peak_g"),
        zone=j.get("zone"),
        fs=j.get("fs"),
        n=j.get("n"),
        bin_hz=j.get("bin_hz"),
        n_bins=j.get("n_bins"),
        band_rms_g=j.get("band_rms_g"),
        band_lo_hz=j.get("band_lo_hz"),
        band_hi_hz=j.get("band_hi_hz"),
        band1_rms_g=j.get("band1_rms_g"),
        band1_lo_hz=j.get("band1_lo_hz"),
        band1_hi_hz=j.get("band1_hi_hz"),
        band2_rms_g=j.get("band2_rms_g"),
        band2_lo_hz=j.get("band2_lo_hz"),
        band2_hi_hz=j.get("band2_hi_hz"),
        fw_version=j.get("fw_version"),
    )
    db.session.add(r)

    # Throttled spectrum storage for the spectrogram view.
    spec = j.get("spectrum")
    stored_spec = False
    if isinstance(spec, list) and spec:
        last = (
            db.session.query(func.max(Spectrum.ts))
            .filter(Spectrum.device_id == device_id)
            .scalar()
        )
        due = last is None or (now - last.replace(tzinfo=timezone.utc)).total_seconds() >= SPECTRUM_MIN_INTERVAL
        if due:
            blob = struct.pack("<%df" % len(spec), *[float(x) for x in spec])
            db.session.add(Spectrum(
                device_id=device_id, ts=now,
                bin_hz=j.get("bin_hz"), n_bins=len(spec), data=blob))
            stored_spec = True

    db.session.commit()
    return jsonify(ok=True, id=r.id, spectrum_stored=stored_spec)


# --- Query APIs ------------------------------------------------------------
@app.get("/api/devices")
def devices():
    rows = (
        db.session.query(
            Reading.device_id,
            func.max(Reading.ts).label("last_seen"),
            func.count(Reading.id).label("count"),
        )
        .group_by(Reading.device_id)
        .all()
    )
    out = []
    for dev, last_seen, count in rows:
        latest = (
            Reading.query.filter_by(device_id=dev)
            .order_by(Reading.ts.desc())
            .first()
        )
        out.append({
            "device_id": dev,
            "last_seen": last_seen.replace(tzinfo=timezone.utc).isoformat() if last_seen else None,
            "count": count,
            "latest": latest.as_dict() if latest else None,
        })
    return jsonify(out)


@app.get("/api/latest")
def latest():
    q = Reading.query
    dev = request.args.get("device")
    if dev:
        q = q.filter_by(device_id=dev)
    r = q.order_by(Reading.ts.desc()).first()
    return jsonify(r.as_dict() if r else {})


@app.get("/api/readings")
def readings():
    hours = parse_range_hours()
    limit = min(int(request.args.get("limit", "3000")), 20000)
    q = Reading.query
    dev = request.args.get("device")
    if dev:
        q = q.filter_by(device_id=dev)
    fr, to = request.args.get("from"), request.args.get("to")
    if fr:
        q = q.filter(Reading.ts >= dtparser.parse(fr).astimezone(timezone.utc).replace(tzinfo=None))
    if to:
        q = q.filter(Reading.ts <= dtparser.parse(to).astimezone(timezone.utc).replace(tzinfo=None))
    if not fr and not to and hours > 0:
        q = q.filter(Reading.ts >= utcnow().replace(tzinfo=None) - timedelta(hours=hours))
    q = q.order_by(Reading.ts.asc())

    rows = q.all()
    # Decimate server-side so long ranges stay light in the browser.
    if len(rows) > limit:
        step = len(rows) / limit
        rows = [rows[int(i * step)] for i in range(limit)]
    return jsonify([r.as_dict() for r in rows])


@app.get("/api/spectra")
def spectra():
    hours = parse_range_hours()
    limit = min(int(request.args.get("limit", "500")), 2000)
    q = Spectrum.query
    dev = request.args.get("device")
    if dev:
        q = q.filter_by(device_id=dev)
    if hours > 0:
        q = q.filter(Spectrum.ts >= utcnow().replace(tzinfo=None) - timedelta(hours=hours))
    q = q.order_by(Spectrum.ts.asc())

    rows = q.all()
    if len(rows) > limit:
        step = len(rows) / limit
        rows = [rows[int(i * step)] for i in range(limit)]
    return jsonify([{
        "ts": s.ts.replace(tzinfo=timezone.utc).isoformat(),
        "bin_hz": s.bin_hz,
        "n_bins": s.n_bins,
        "values": s.values(),
    } for s in rows])


# --- Noise (dB) import + query ---------------------------------------------
_SS_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _col_index(ref):
    """A1-style cell ref -> zero-based column index ('B3' -> 1)."""
    letters = "".join(ch for ch in ref if ch.isalpha())
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch.upper()) - 64)
    return n - 1


def _rows_from_xlsx(raw):
    """Read the first worksheet of an .xlsx into a list of string rows, using
    only the stdlib (no openpyxl). Sound-meter apps (e.g. the "噪音 datasheet"
    export) give a title line, a header line, then Date/DB-value/unit rows."""
    z = zipfile.ZipFile(io.BytesIO(raw))

    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        sst = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in sst.findall(_SS_NS + "si"):
            shared.append("".join(t.text or "" for t in si.iter(_SS_NS + "t")))

    # Resolve the first sheet's part (namelist order isn't guaranteed).
    sheet_name = "xl/worksheets/sheet1.xml"
    if sheet_name not in z.namelist():
        sheets = sorted(n for n in z.namelist()
                        if n.startswith("xl/worksheets/") and n.endswith(".xml"))
        if not sheets:
            return []
        sheet_name = sheets[0]

    sheet = ET.fromstring(z.read(sheet_name))
    rows = []
    for row in sheet.iter(_SS_NS + "row"):
        cells, width = {}, 0
        for c in row.findall(_SS_NS + "c"):
            ref = c.get("r")
            idx = _col_index(ref) if ref else len(cells)
            width = max(width, idx + 1)
            ctype = c.get("t")
            val = ""
            if ctype == "inlineStr":
                is_el = c.find(_SS_NS + "is")
                if is_el is not None:
                    val = "".join(t.text or "" for t in is_el.iter(_SS_NS + "t"))
            else:
                v = c.find(_SS_NS + "v")
                if v is not None and v.text is not None:
                    val = shared[int(v.text)] if ctype == "s" else v.text
            cells[idx] = val
        rows.append([cells.get(i, "") for i in range(width)])
    return rows


def _rows_from_upload(filename, raw):
    """Return (rows, error). rows is a list of string-cell lists; delimiter and
    file type (.xlsx vs CSV/TSV) are auto-detected."""
    name = (filename or "").lower()
    is_xlsx = name.endswith(".xlsx") or raw[:2] == b"PK"
    if is_xlsx:
        try:
            return _rows_from_xlsx(raw), None
        except Exception as e:  # noqa: BLE001
            return None, f"could not read xlsx: {e}"

    text = raw.decode("utf-8-sig", errors="replace")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return [], None
    # Pick the delimiter that most consistently splits the head into the same
    # number of columns. Counting raw occurrences is unreliable: European CSVs
    # use ';' to separate and ',' as the decimal point, so both counts match;
    # only ';' yields a stable column count. A leading title line (0 delimiters)
    # is ignored via the >1-column filter.
    head = lines[:15]

    def score(d):
        counts = [ln.count(d) + 1 for ln in head if ln.count(d) > 0]
        if not counts:
            return (0, 0)
        modal = max(set(counts), key=counts.count)
        if modal < 2:
            return (0, 0)
        return (counts.count(modal), modal)   # agreement, then column width

    delim = max((",", ";", "\t"), key=score)
    rows = [next(csv.reader([ln], delimiter=delim)) for ln in lines]
    return rows, None


# Column-name hints for auto-detecting a phone/meter CSV export.
_TS_HINTS  = ("time", "date", "timestamp", "datetime")
_AVG_HINTS = ("laeq", "leq", "avg", "average", "mean", "spl", "db", "dba",
              "decibel", "level", "sound", "value")
_MAX_HINTS = ("lamax", "lmax", "max", "peak")
_MIN_HINTS = ("lamin", "lmin", "min")


def _pick_col(headers, hints, override=None):
    """Return the index of the best-matching column, or None."""
    if override:
        for i, h in enumerate(headers):
            if h.strip().lower() == override.strip().lower():
                return i
        if override.isdigit() and int(override) < len(headers):
            return int(override)
    low = [h.strip().lower() for h in headers]
    for hint in hints:                       # prefer earlier (more specific) hints
        for i, h in enumerate(low):
            if hint == h:
                return i
    for hint in hints:
        for i, h in enumerate(low):
            if hint in h:
                return i
    return None


@app.post("/api/import/noise")
def import_noise():
    """Import a phone/meter log of dB readings (CSV, TSV, or .xlsx). Timestamps
    are interpreted in the given timezone (default UTC) and stored as UTC to
    align with vibration."""
    if "file" not in request.files:
        return jsonify(ok=False, error="no file"), 400
    f = request.files["file"]
    source = (request.form.get("source") or f.filename or "noise").strip()[:48]
    tzname = request.form.get("tz") or "UTC"
    try:
        tz = ZoneInfo(tzname)
    except Exception:  # noqa: BLE001
        tz = timezone.utc

    rows, err = _rows_from_upload(f.filename, f.read())
    if err:
        return jsonify(ok=False, error=err), 422
    if not rows:
        return jsonify(ok=False, error="empty file"), 400

    # Find the header row (some apps prepend a title / metadata lines).
    header_idx, headers = None, None
    for i, cells in enumerate(rows[:15]):
        low = [c.lower() for c in cells]
        if any(any(hh in c for hh in _TS_HINTS) for c in low) and \
           any(any(hh in c for hh in _AVG_HINTS) for c in low):
            header_idx, headers = i, cells
            break
    if headers is None:
        return jsonify(ok=False, error="could not find a header row with a time "
                       "column and a dB column",
                       first_rows=rows[:5]), 422

    ts_i  = _pick_col(headers, _TS_HINTS,  request.form.get("ts_col"))
    avg_i = _pick_col(headers, _AVG_HINTS, request.form.get("db_col"))
    max_i = _pick_col(headers, _MAX_HINTS)
    min_i = _pick_col(headers, _MIN_HINTS)
    if ts_i is None or avg_i is None:
        return jsonify(ok=False, error="could not map columns", headers=headers), 422
    if max_i == avg_i:
        max_i = None
    if min_i == avg_i:
        min_i = None

    def to_float(cells, idx):
        if idx is None or idx >= len(cells):
            return None
        try:
            return float(str(cells[idx]).strip().replace(",", "."))
        except (ValueError, AttributeError):
            return None

    added, skipped, first_ts, last_ts = 0, 0, None, None
    for cells in rows[header_idx + 1:]:
        if ts_i >= len(cells) or not str(cells[ts_i]).strip():
            skipped += 1
            continue
        try:
            dt = dtparser.parse(str(cells[ts_i]).strip())
        except (ValueError, OverflowError, TypeError):
            skipped += 1
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=tz)
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)

        spl = to_float(cells, avg_i)
        if spl is None:
            skipped += 1
            continue
        db.session.add(Noise(source=source, ts=dt, spl_db=spl,
                             lamax=to_float(cells, max_i),
                             lamin=to_float(cells, min_i)))
        added += 1
        first_ts = dt if first_ts is None else min(first_ts, dt)
        last_ts = dt if last_ts is None else max(last_ts, dt)
    db.session.commit()

    return jsonify(ok=True, source=source, imported=added, skipped=skipped,
                   columns={"time": headers[ts_i], "level": headers[avg_i],
                            "max": headers[max_i] if max_i is not None else None},
                   range=[first_ts.replace(tzinfo=timezone.utc).isoformat() if first_ts else None,
                          last_ts.replace(tzinfo=timezone.utc).isoformat() if last_ts else None])


@app.get("/api/noise/sources")
def noise_sources():
    rows = (db.session.query(Noise.source, func.count(Noise.id),
                             func.min(Noise.ts), func.max(Noise.ts))
            .group_by(Noise.source).all())
    return jsonify([{"source": s, "count": c,
                     "first": mn.replace(tzinfo=timezone.utc).isoformat() if mn else None,
                     "last": mx.replace(tzinfo=timezone.utc).isoformat() if mx else None}
                    for s, c, mn, mx in rows])


@app.get("/api/noise")
def noise_series():
    hours = parse_range_hours()
    limit = min(int(request.args.get("limit", "4000")), 20000)
    q = Noise.query
    src = request.args.get("source")
    if src:
        q = q.filter_by(source=src)
    fr, to = request.args.get("from"), request.args.get("to")
    if fr:
        q = q.filter(Noise.ts >= dtparser.parse(fr).astimezone(timezone.utc).replace(tzinfo=None))
    if to:
        q = q.filter(Noise.ts <= dtparser.parse(to).astimezone(timezone.utc).replace(tzinfo=None))
    if not fr and not to and hours > 0:
        q = q.filter(Noise.ts >= utcnow().replace(tzinfo=None) - timedelta(hours=hours))
    q = q.order_by(Noise.ts.asc())
    rows = q.all()
    if len(rows) > limit:
        step = len(rows) / limit
        rows = [rows[int(i * step)] for i in range(limit)]
    return jsonify([r.as_dict() for r in rows])


# --- Aggregation: multi-night heatmap --------------------------------------
@app.get("/api/heatmap")
def heatmap():
    """Peak level per (local night, time-bucket). metric = noise | vibration.
    `offset` is the viewer's UTC offset in minutes (from JS getTimezoneOffset,
    negated) so buckets fall on local wall-clock time."""
    metric = request.args.get("metric", "noise")
    days   = min(int(request.args.get("days", "7")), 120)
    bucket = max(1, min(int(request.args.get("bucket", "15")), 120))
    offset = int(request.args.get("offset", "0"))   # minutes east of UTC
    mod = f"{offset} minutes"

    since = utcnow().replace(tzinfo=None) - timedelta(days=days)
    if metric == "vibration":
        col, model, src_filter = Reading.vel_rms_mm_s, Reading, None
        src = request.args.get("device")
        if src:
            src_filter = Reading.device_id == src
    else:
        col, model, src_filter = Noise.spl_db, Noise, None
        src = request.args.get("source")
        if src:
            src_filter = Noise.source == src

    local_min = (func.cast(func.strftime("%H", model.ts, mod), db.Integer) * 60 +
                 func.cast(func.strftime("%M", model.ts, mod), db.Integer))
    day_expr = func.strftime("%Y-%m-%d", model.ts, mod)
    bucket_expr = (local_min / bucket)

    q = (db.session.query(day_expr.label("day"), bucket_expr.label("b"),
                          func.max(col).label("v"))
         .filter(model.ts >= since))
    if src_filter is not None:
        q = q.filter(src_filter)
    q = q.group_by("day", "b")

    grid = {}
    for day, b, v in q.all():
        grid.setdefault(day, {})[int(b)] = v
    cols = (24 * 60) // bucket
    days_sorted = sorted(grid.keys())
    return jsonify({
        "metric": metric, "bucket_min": bucket, "cols": cols, "offset_min": offset,
        "days": [{"date": d, "values": [grid[d].get(b) for b in range(cols)]}
                 for d in days_sorted],
    })


# --- Remote firmware (OTA) --------------------------------------------------
# Firmware binaries + a manifest.json live in FIRMWARE_DIR. Devices poll
# /api/firmware/latest and pull the .bin from /firmware/<file> over plain HTTP.
FIRMWARE_DIR = os.environ.get("FIRMWARE_DIR",
                              os.path.join(os.path.dirname(DB_ABS), "..", "firmware"))
FIRMWARE_DIR = os.path.abspath(FIRMWARE_DIR)


@app.get("/api/firmware/latest")
def firmware_latest():
    path = os.path.join(FIRMWARE_DIR, "manifest.json")
    if not os.path.exists(path):
        return jsonify(version=0, url=""), 200
    with open(path) as f:
        return app.response_class(f.read(), mimetype="application/json")


@app.get("/firmware/<path:name>")
def firmware_file(name):
    from flask import send_from_directory
    return send_from_directory(FIRMWARE_DIR, name)


@app.get("/health")
def health():
    return jsonify(ok=True, ts=utcnow().isoformat())


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/sleep")
def sleep_view():
    return render_template("sleep.html")


# --- Maintenance -----------------------------------------------------------
def prune_loop():
    while RETENTION_DAYS > 0:
        try:
            with app.app_context():
                cutoff = utcnow().replace(tzinfo=None) - timedelta(days=RETENTION_DAYS)
                Reading.query.filter(Reading.ts < cutoff).delete()
                Spectrum.query.filter(Spectrum.ts < cutoff).delete()
                db.session.commit()
        except Exception as e:  # noqa: BLE001
            app.logger.warning("prune failed: %s", e)
        time.sleep(6 * 3600)


def init_db():
    os.makedirs(os.path.dirname(DB_ABS) or ".", exist_ok=True)
    os.makedirs(FIRMWARE_DIR, exist_ok=True)
    with app.app_context():
        db.create_all()
        try:
            db.session.execute(db.text("PRAGMA journal_mode=WAL;"))
            db.session.commit()
        except Exception:  # noqa: BLE001
            pass
        # Lightweight migration: create_all() won't ALTER an existing table, so
        # add any newly-introduced columns to `readings`.
        try:
            have = {row[1] for row in db.session.execute(db.text("PRAGMA table_info(readings)"))}
            for col, typ in [("band_rms_g", "REAL"), ("band_lo_hz", "REAL"),
                             ("band_hi_hz", "REAL"), ("fw_version", "INTEGER"),
                             ("band1_rms_g", "REAL"), ("band1_lo_hz", "REAL"), ("band1_hi_hz", "REAL"),
                             ("band2_rms_g", "REAL"), ("band2_lo_hz", "REAL"), ("band2_hi_hz", "REAL")]:
                if col not in have:
                    db.session.execute(db.text(f"ALTER TABLE readings ADD COLUMN {col} {typ}"))
            db.session.commit()
        except Exception as e:  # noqa: BLE001
            app.logger.warning("column migration skipped: %s", e)


init_db()
if RETENTION_DAYS > 0:
    threading.Thread(target=prune_loop, daemon=True).start()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=True)

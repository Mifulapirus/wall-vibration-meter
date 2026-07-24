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
import json
import os
import struct
import threading
import time
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np
from dateutil import parser as dtparser
from flask import (Flask, request, jsonify, render_template, session,
                   redirect, url_for, render_template_string, abort)
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
# Re-read templates on change so dashboard (HTML) edits go live like static
# assets — no restart needed to keep index.html in sync with app.js.
app.config["TEMPLATES_AUTO_RELOAD"] = True
db = SQLAlchemy(app)

# --- Simple site-wide password gate ----------------------------------------
# Keeps the dashboard/reports out of casual public view. Devices and import
# scripts (machine-to-machine POSTs, OTA, health) stay open so the data
# pipeline is unaffected; every human-facing page needs the shared password.
SITE_PASSWORD = os.environ.get("SITE_PASSWORD", "bartonhell")
app.secret_key = os.environ.get(
    "WALLVIBE_SECRET_KEY", "wv-9f3a1c7e5b2d48a6b0e1f2c3d4e5f60718293a4b5c6d7e8f")
app.permanent_session_lifetime = timedelta(days=30)

# Endpoints reached without a browser session (device ingest, OTA, streamer,
# import scripts, health checks) are always open.
_OPEN_PREFIXES = (
    "/api/ingest", "/api/session/", "/api/rawcapture", "/api/firmware",
    "/firmware/", "/api/import/noise", "/api/noise/live", "/health", "/login",
)

_LOGIN_HTML = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wall Vibe — sign in</title><style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#0f1720; color:#e6edf3; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  form { background:#1b2733; padding:32px 28px; border-radius:14px; width:min(340px,92vw);
    box-shadow:0 10px 40px rgba(0,0,0,.4); }
  h1 { font-size:19px; margin:0 0 4px; }
  p { margin:0 0 20px; color:#8b98a5; font-size:13px; }
  label { display:block; font-size:12px; color:#8b98a5; margin-bottom:6px; letter-spacing:.03em; }
  input { width:100%; padding:11px 12px; border-radius:8px; border:1px solid #2a3846;
    background:#0f1720; color:#e6edf3; font-size:15px; }
  input:focus { outline:2px solid #4aa8ff; outline-offset:1px; border-color:#4aa8ff; }
  button { width:100%; margin-top:16px; padding:11px; border:0; border-radius:8px;
    background:#4aa8ff; color:#03121f; font-size:15px; font-weight:600; cursor:pointer; }
  button:hover { background:#69b8ff; }
  .err { color:#f85149; font-size:13px; margin-top:12px; min-height:1em; }
</style></head><body>
  <form method="post" action="{{ url_for('login', next=nxt) }}">
    <h1>Wall Vibration Meter</h1>
    <p>Enter the site password to continue.</p>
    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" autofocus autocomplete="current-password">
    <button type="submit">Enter</button>
    <div class="err">{{ err }}</div>
  </form>
</body></html>"""


@app.before_request
def _require_login():
    if session.get("authed") or request.endpoint == "static":
        return
    # Scripts/tools may authenticate with the shared password via header or
    # ?key= instead of a browser session (keeps CLI analysis + imports working).
    if (request.headers.get("X-Site-Password") == SITE_PASSWORD
            or request.args.get("key") == SITE_PASSWORD):
        return
    p = request.path
    if any(p == pre or p.startswith(pre) for pre in _OPEN_PREFIXES):
        return
    if request.method == "GET":
        return redirect(url_for("login", next=p))
    abort(401)


@app.route("/login", methods=["GET", "POST"])
def login():
    err = ""
    nxt = request.args.get("next") or "/"
    if not nxt.startswith("/"):       # never redirect off-site
        nxt = "/"
    if request.method == "POST":
        if request.form.get("password", "") == SITE_PASSWORD:
            session.permanent = True
            session["authed"] = True
            return redirect(nxt)
        err = "Incorrect password."
    return render_template_string(_LOGIN_HTML, err=err, nxt=nxt)


@app.get("/logout")
def logout():
    session.pop("authed", None)
    return redirect(url_for("login"))


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
    dom_amp_ms2   = db.Column(db.Float)     # amplitude of the dominant peak
    noise_floor_ms2 = db.Column(db.Float)   # median spectral noise floor
    snr           = db.Column(db.Float)     # dominant peak / noise floor
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
            "dom_amp_ms2": self.dom_amp_ms2,
            "noise_floor_ms2": self.noise_floor_ms2,
            "snr": self.snr,
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


class DeviceState(db.Model):
    """Per-device logging switch. When paused, ingest drops readings so
    mounting/handling transients aren't recorded. DB-backed so it's consistent
    across gunicorn workers."""
    __tablename__ = "device_state"
    device_id = db.Column(db.String(32), primary_key=True)
    paused    = db.Column(db.Boolean, default=False, nullable=False)
    updated   = db.Column(db.DateTime, default=utcnow)
    # Live snapshot — refreshed on EVERY ingest (even while paused) so the
    # mounting helper stays live while history logging is paused.
    live_ts           = db.Column(db.DateTime)
    live_accel_rms_g  = db.Column(db.Float)
    live_band1_rms_g  = db.Column(db.Float)
    live_band2_rms_g  = db.Column(db.Float)
    live_vel_rms_mm_s = db.Column(db.Float)
    live_dom_freq_hz  = db.Column(db.Float)
    live_dom_amp_ms2  = db.Column(db.Float)
    live_snr          = db.Column(db.Float)
    live_fw_version   = db.Column(db.Integer)


class RawCap(db.Model):
    """Result of a high-resolution analysis of a raw time-domain snippet, used
    to try to count individual compressors (their motor lines differ by load)."""
    __tablename__  = "raw_capture"
    id             = db.Column(db.Integer, primary_key=True)
    device_id      = db.Column(db.String(32), index=True, nullable=False)
    ts             = db.Column(db.DateTime, index=True, default=utcnow)
    axis           = db.Column(db.Integer)
    fs             = db.Column(db.Float)
    n              = db.Column(db.Integer)
    noise_floor_mg = db.Column(db.Float)
    n_units        = db.Column(db.Integer)   # estimated # of resolved lines
    peaks          = db.Column(db.Text)      # JSON: {low:[...], high:[...], res_hz}


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


def decimate(base_q, model, order_col, limit):
    """Sample ~limit rows in SQL (id-modulo) instead of materialising the whole
    range as ORM objects then slicing in Python — the big win for long windows."""
    total = base_q.with_entities(func.count(model.id)).order_by(None).scalar() or 0
    q = base_q
    if total > limit:
        stride = (total + limit - 1) // limit          # ceil -> ~limit rows back
        q = q.filter(model.id % stride == 0)
    return q.order_by(order_col.asc()).all()


def reading_chart(r):
    """Compact reading for the charts (8 fields vs ~18) to shrink the payload."""
    return {
        "ts": r.ts.replace(tzinfo=timezone.utc).isoformat(),
        "vel_rms_mm_s": r.vel_rms_mm_s,
        "dom_freq_hz": r.dom_freq_hz,
        "accel_rms_g": r.accel_rms_g,
        "band_rms_g": r.band_rms_g,
        "band1_rms_g": r.band1_rms_g,
        "band2_rms_g": r.band2_rms_g,
        "snr": r.snr,
        "dom_amp_ms2": r.dom_amp_ms2,   # amplitude of the dominant tone (physical strength)
        "zone": r.zone,
    }


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

    # Refresh the live snapshot on every push — even when paused or dropped — so
    # the mounting helper shows live coupling while history logging is paused.
    st = db.session.get(DeviceState, device_id)
    if not st:
        st = DeviceState(device_id=device_id)
        db.session.add(st)
    st.live_ts = now
    st.live_accel_rms_g = j.get("accel_rms_g")
    st.live_band1_rms_g = j.get("band1_rms_g")
    st.live_band2_rms_g = j.get("band2_rms_g")
    st.live_vel_rms_mm_s = j.get("vel_rms_mm_s")
    st.live_dom_freq_hz = j.get("dom_freq_hz")
    st.live_dom_amp_ms2 = j.get("dom_amp_ms2")
    st.live_snr = j.get("snr")
    st.live_fw_version = j.get("fw_version")

    # Session pause: drop everything for this device while the user has logging
    # paused (e.g. handling / mounting it on the wall).
    if st.paused:
        db.session.commit()
        return jsonify(ok=True, discarded=True, reason="paused"), 200

    # Reject mounting/handling transients before storing anything (incl. spectrum).
    vel = j.get("vel_rms_mm_s")
    peak = j.get("peak_g")
    if (INGEST_MAX_VEL_MM_S > 0 and vel is not None and vel > INGEST_MAX_VEL_MM_S) or \
       (INGEST_MAX_PEAK_G > 0 and peak is not None and peak > INGEST_MAX_PEAK_G):
        app.logger.info("discarded outlier from %s: vel=%s peak=%s", device_id, vel, peak)
        db.session.commit()   # keep the live snapshot even for dropped outliers
        return jsonify(ok=True, discarded=True, vel=vel, peak=peak), 200

    r = Reading(
        device_id=device_id,
        ts=now,
        uptime_ms=j.get("uptime_ms"),
        vel_rms_mm_s=j.get("vel_rms_mm_s"),
        dom_freq_hz=j.get("dom_freq_hz"),
        dom_amp_ms2=j.get("dom_amp_ms2"),
        noise_floor_ms2=j.get("noise_floor_ms2"),
        snr=j.get("snr"),
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
    return jsonify([reading_chart(r) for r in decimate(q, Reading, Reading.ts, limit)])


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
    rows = decimate(q, Spectrum, Spectrum.ts, limit)
    return jsonify([{
        "ts": s.ts.replace(tzinfo=timezone.utc).isoformat(),
        "bin_hz": s.bin_hz,
        "n_bins": s.n_bins,
        "values": s.values(),
    } for s in rows])


# Per-unit compressor tracking. The wall couples to three distinct, independently
# cycling motor lines: a 4-pole unit (~28 Hz), a 2-pole unit's fundamental
# (~58 Hz), and the 2-pole 2nd harmonic (~120 Hz — which the single "dominant
# frequency" usually wins, yet the 25-40/50-65 bands miss entirely). Each unit's
# strength = the peak bin (mg) in its band, read from the stored spectra so it
# works retroactively across all history.
UNIT_BANDS = [("u28", 26.0, 32.0), ("u58", 55.0, 62.0), ("u120", 115.0, 125.0)]


@app.get("/api/units")
def units():
    hours = parse_range_hours()
    limit = min(int(request.args.get("limit", "1500")), 8000)
    q = Spectrum.query
    dev = request.args.get("device")
    if dev:
        q = q.filter_by(device_id=dev)
    fr, to = request.args.get("from"), request.args.get("to")
    if fr:
        q = q.filter(Spectrum.ts >= dtparser.parse(fr).astimezone(timezone.utc).replace(tzinfo=None))
    if to:
        q = q.filter(Spectrum.ts <= dtparser.parse(to).astimezone(timezone.utc).replace(tzinfo=None))
    if not fr and not to and hours > 0:
        q = q.filter(Spectrum.ts >= utcnow().replace(tzinfo=None) - timedelta(hours=hours))
    G = 9.80665
    out = []
    for s in decimate(q, Spectrum, Spectrum.ts, limit):
        amp = s.values()               # m/s^2 per bin
        bh = s.bin_hz or 0.78125
        n = len(amp)
        rec = {"ts": s.ts.replace(tzinfo=timezone.utc).isoformat()}
        for name, lo, hi in UNIT_BANDS:
            k0 = max(1, int(lo / bh))
            k1 = min(n, int(hi / bh) + 1)
            seg = amp[k0:k1]
            rec[name] = round((max(seg) if seg else 0.0) / G * 1000.0, 2)   # mg
        out.append(rec)
    return jsonify(out)


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


def _rows_from_xls(raw):
    """Read the first worksheet of a legacy .xls (BIFF/OLE2) into a list of
    string rows, using xlrd. Some meters (e.g. the DSL unit) export this old
    binary format, where cells are typed (numbers as float, times/dates as their
    own text). We stringify every cell so the shared column-mapping logic works
    the same as for CSV/xlsx."""
    import xlrd  # local import: only needed for the rare legacy-.xls upload
    book = xlrd.open_workbook(file_contents=raw)

    def sheet_rows(sheet):
        rows = []
        for r in range(sheet.nrows):
            cells = []
            for c in range(sheet.ncols):
                v = sheet.cell_value(r, c)
                # int-valued floats -> "1" not "1.0"; everything else -> str
                if isinstance(v, float) and v.is_integer():
                    v = int(v)
                cells.append(str(v))
            rows.append(cells)
        return rows

    # Some meters (e.g. the ennoLogic eS528L) put a metadata "Summary" on the
    # first sheet and the actual time series on a later "Data" sheet. Pick the
    # sheet that looks like the data: most rows, with at least 2 columns.
    best = None
    for si in range(book.nsheets):
        s = book.sheet_by_index(si)
        if s.ncols >= 2 and (best is None or s.nrows > best.nrows):
            best = s
    return sheet_rows(best if best is not None else book.sheet_by_index(0))


def _rows_from_upload(filename, raw):
    """Return (rows, error). rows is a list of string-cell lists; delimiter and
    file type (.xlsx vs legacy .xls vs CSV/TSV) are auto-detected."""
    name = (filename or "").lower()
    is_xlsx = name.endswith(".xlsx") or raw[:2] == b"PK"
    # Legacy .xls is an OLE2 compound file: magic D0 CF 11 E0 A1 B1 1A E1.
    is_xls = name.endswith(".xls") or raw[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
    if is_xlsx:
        try:
            return _rows_from_xlsx(raw), None
        except Exception as e:  # noqa: BLE001
            return None, f"could not read xlsx: {e}"
    if is_xls:
        try:
            return _rows_from_xls(raw), None
        except Exception as e:  # noqa: BLE001
            return None, f"could not read xls: {e}"

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


def _parse_noise_series(rows, tz, ts_override=None, db_override=None):
    """Turn parsed spreadsheet/CSV rows into a list of noise records.

    Returns (records, colinfo, err). `records` is a list of dicts with keys
    ts (naive UTC datetime), spl, lamax, lamin. `colinfo` names the columns used.
    `err` is (message, extra_dict) on failure, else None. Shared by the noise
    import and the coordinated two-meter comparison so both handle the same
    formats (a title/units row above the header is tolerated)."""
    if not rows:
        return None, None, ("empty file", {})

    header_idx, headers = None, None
    for i, cells in enumerate(rows[:15]):
        low = [c.lower() for c in cells]
        if any(any(hh in c for hh in _TS_HINTS) for c in low) and \
           any(any(hh in c for hh in _AVG_HINTS) for c in low):
            header_idx, headers = i, cells
            break
    if headers is None:
        return None, None, ("could not find a header row with a time column and a "
                            "dB column", {"first_rows": rows[:5]})

    ts_i  = _pick_col(headers, _TS_HINTS,  ts_override)
    avg_i = _pick_col(headers, _AVG_HINTS, db_override)
    max_i = _pick_col(headers, _MAX_HINTS)
    min_i = _pick_col(headers, _MIN_HINTS)
    if ts_i is None or avg_i is None:
        return None, None, ("could not map columns", {"headers": headers})
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

    records, skipped = [], 0
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
        records.append({"ts": dt, "spl": spl,
                        "lamax": to_float(cells, max_i),
                        "lamin": to_float(cells, min_i)})

    colinfo = {"time": headers[ts_i], "level": headers[avg_i],
               "max": headers[max_i] if max_i is not None else None}
    return records, {"columns": colinfo, "skipped": skipped}, None


@app.post("/api/import/noise")
def import_noise():
    """Import a phone/meter log of dB readings (CSV, TSV, .xls, or .xlsx).
    Timestamps are interpreted in the given timezone (default UTC) and stored as
    UTC to align with vibration."""
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

    records, meta, perr = _parse_noise_series(rows, tz, request.form.get("ts_col"),
                                              request.form.get("db_col"))
    if perr:
        msg, extra = perr
        return jsonify(ok=False, error=msg, **extra), 422

    added, first_ts, last_ts = 0, None, None
    for rec in records:
        db.session.add(Noise(source=source, ts=rec["ts"], spl_db=rec["spl"],
                             lamax=rec["lamax"], lamin=rec["lamin"]))
        added += 1
        first_ts = rec["ts"] if first_ts is None else min(first_ts, rec["ts"])
        last_ts = rec["ts"] if last_ts is None else max(last_ts, rec["ts"])
    db.session.commit()

    return jsonify(ok=True, source=source, imported=added, skipped=meta["skipped"],
                   columns=meta["columns"],
                   range=[first_ts.replace(tzinfo=timezone.utc).isoformat() if first_ts else None,
                          last_ts.replace(tzinfo=timezone.utc).isoformat() if last_ts else None])


@app.post("/api/noise/live")
def noise_live():
    """Ingest live dB readings pushed by a local agent (meter_agent.py) whose USB
    meters are on a different machine than this server. Body:
    {"readings": [{"source","ts"?,"spl_db","lamax"?,"lamin"?}, ...]} (or a bare
    list). Missing ts is stamped on receipt. Rows land as ordinary Noise sources,
    so they flow straight into the dashboard/sleep/heatmap views."""
    if not token_ok():
        return jsonify(ok=False, error="unauthorized"), 401
    j = request.get_json(silent=True)
    items = j.get("readings") if isinstance(j, dict) else j
    if not isinstance(items, list):
        return jsonify(ok=False, error="expected a list of readings"), 400

    def maybe_float(v):
        try:
            return float(v) if v is not None else None
        except (ValueError, TypeError):
            return None

    added, counts = 0, {}
    for it in items:
        if not isinstance(it, dict):
            continue
        spl = maybe_float(it.get("spl_db"))
        if spl is None:
            continue
        source = str(it.get("source") or "noise")[:48]
        ts_raw = it.get("ts")
        if ts_raw:
            try:
                dt = dtparser.parse(str(ts_raw)).astimezone(timezone.utc).replace(tzinfo=None)
            except (ValueError, OverflowError, TypeError):
                dt = utcnow().replace(tzinfo=None)
        else:
            dt = utcnow().replace(tzinfo=None)
        db.session.add(Noise(source=source, ts=dt, spl_db=spl,
                             lamax=maybe_float(it.get("lamax")),
                             lamin=maybe_float(it.get("lamin"))))
        added += 1
        counts[source] = counts.get(source, 0) + 1
    db.session.commit()
    return jsonify(ok=True, imported=added, sources=counts)


@app.get("/api/noise/latest")
def noise_latest():
    """Newest dB reading for a source — for the dashboard's live sound-level tile.

    `prefix` matches a family of sources instead of one exact name: the live
    meter streams into a weighting-suffixed source (DSL-A / DSL-C) that changes
    when the meter's A/C button is flipped, so the tile asks for `prefix=DSL-`
    and gets whichever of them is actually streaming right now."""
    q = Noise.query
    pref = request.args.get("prefix")
    if pref:
        q = q.filter(Noise.source.like(pref.replace("%", "") + "%"))
    else:
        src = request.args.get("source", "DSL")
        if src:
            q = q.filter_by(source=src)
    r = q.order_by(Noise.ts.desc()).first()
    return jsonify(r.as_dict() if r else {})


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
    return jsonify([r.as_dict() for r in decimate(q, Noise, Noise.ts, limit)])


# --- Sound + vibration fusion (compressor on/off, WHO, low-frequency) ------
# Correlates the vibration compressor detector (dominant-tone SNR) with the
# sound-meter dB so conclusions use BOTH sensors: vibration says WHEN the AC
# runs; sound says how loud that is, whether it breaks WHO sleep limits, and —
# via the C-minus-A weighting gap — whether the noise is low-frequency-dominated.
def _epoch(dt):
    return dt.replace(tzinfo=timezone.utc).timestamp()


def _fusion_window():
    hours = parse_range_hours() or 12.0
    fr, to = request.args.get("from"), request.args.get("to")
    t_to = (dtparser.parse(to).astimezone(timezone.utc).replace(tzinfo=None)
            if to else utcnow().replace(tzinfo=None))
    t_from = (dtparser.parse(fr).astimezone(timezone.utc).replace(tzinfo=None)
              if fr else t_to - timedelta(hours=hours))
    return t_from, t_to


@app.get("/api/fusion")
def fusion():
    t_from, t_to = _fusion_window()
    dev = request.args.get("device")
    # DSL is the single connected meter now; callers that have a separate
    # A-weighted reference (e.g. the report's eS528L-night) pass asource explicitly.
    asrc = request.args.get("asource", "DSL")     # anchor source -> WHO comparison
    csrc = request.args.get("csource", "DSL")     # C-weighted -> low-frequency indicator
    snr_on = float(request.args.get("snr_on", "10"))
    handling_db = float(request.args.get("handling_db", "999"))   # drop samples above this (self-noise/handling)
    MAX_GAP, MERGE_GAP, MIN_RUN = 15.0, 90.0, 20.0

    # --- compressor on/off from vibration SNR ---
    rq = Reading.query.filter(Reading.ts >= t_from, Reading.ts <= t_to)
    if dev:
        rq = rq.filter_by(device_id=dev)
    rows = rq.order_by(Reading.ts.asc()).limit(200000).all()
    vt = np.array([_epoch(r.ts) for r in rows], dtype=float)
    on = np.array([(r.snr is not None and r.snr >= snr_on) for r in rows], dtype=bool)
    domf = np.array([(r.dom_freq_hz if r.dom_freq_hz is not None else np.nan) for r in rows], dtype=float)

    duty = None
    on_intervals, on_durs, off_durs, n_cycles = [], [], [], 0
    if len(vt) >= 2:
        dt = np.diff(vt)
        keep = dt <= MAX_GAP
        total = float(dt[keep].sum())
        on_time = float(dt[keep & on[:-1]].sum())
        duty = (on_time / total) if total else None
        # contiguous runs
        runs, cur, start = [], bool(on[0]), vt[0]
        for i in range(1, len(vt)):
            if bool(on[i]) != cur:
                runs.append((cur, start, vt[i - 1])); cur = bool(on[i]); start = vt[i]
        runs.append((cur, start, vt[-1]))
        on_runs = [(s, e) for st, s, e in runs if st]
        off_durs = [e - s for st, s, e in runs if not st]
        on_durs = [e - s for s, e in on_runs]
        n_cycles = len(on_runs)
        # merge on-runs separated by a short off gap; drop blips
        for s, e in on_runs:
            if on_intervals and s - on_intervals[-1][1] <= MERGE_GAP:
                on_intervals[-1][1] = e
            else:
                on_intervals.append([s, e])
        on_intervals = [iv for iv in on_intervals if iv[1] - iv[0] >= MIN_RUN]

    span_h = (vt[-1] - vt[0]) / 3600.0 if len(vt) >= 2 else 0.0
    dom_on = domf[on] if len(domf) else np.array([])
    dom_on = dom_on[~np.isnan(dom_on)]
    dom_freq_median = round(float(np.median(dom_on)), 1) if len(dom_on) else None

    def classify(times):
        """on/off state (1/0/-1) at each time from the nearest prior reading."""
        if not len(vt):
            return np.full(len(times), -1)
        idx = np.searchsorted(vt, times, side="right") - 1
        st = np.full(len(times), -1)
        ok = (idx >= 0)
        oki = np.where(ok)[0]
        for k in oki:
            i = idx[k]
            if times[k] - vt[i] <= MAX_GAP:
                st[k] = 1 if on[i] else 0
        return st

    def sound(src, cap=False):
        nq = (Noise.query.filter(Noise.source == src, Noise.ts >= t_from, Noise.ts <= t_to)
              .order_by(Noise.ts.asc()).limit(200000).all())
        if not nq:
            return None, None
        nt = np.array([_epoch(n.ts) for n in nq], dtype=float)
        nd = np.array([n.spl_db for n in nq], dtype=float)
        if cap and handling_db < 200:              # exclude handling/self-noise (A-weighted anchor only)
            keep = nd <= handling_db
            nt, nd = nt[keep], nd[keep]
            if not len(nd):
                return None, None
        st = classify(nt)
        onv, offv = nd[st == 1], nd[st == 0]
        leq = lambda a: (float(10 * np.log10(np.mean(10 ** (a / 10.0)))) if len(a) else None)
        med = lambda a: (float(np.median(a)) if len(a) else None)
        ev, inev = 0, False
        for v in nd:
            if not inev and v >= 45:
                ev += 1; inev = True
            elif inev and v < 40:
                inev = False
        s = dict(n=len(nd), leq=leq(nd), leq_on=leq(onv), leq_off=leq(offv),
                 median_on=med(onv), median_off=med(offv), lmax=float(nd.max()),
                 L10=float(np.percentile(nd, 90)), L50=float(np.percentile(nd, 50)),
                 L90=float(np.percentile(nd, 10)),
                 above30_pct=float((nd > 30).mean() * 100), above40_pct=float((nd > 40).mean() * 100),
                 above45_pct=float((nd > 45).mean() * 100), events_gt45=ev,
                 on_samples=int((st == 1).sum()), off_samples=int((st == 0).sum()))
        s["delta_leq"] = (s["leq_on"] - s["leq_off"]) if (s["leq_on"] is not None and s["leq_off"] is not None) else None
        s["contribution"] = (float(10 * np.log10(10 ** (s["leq_on"] / 10.0) - 10 ** (s["leq_off"] / 10.0)))
                             if (s["leq_on"] is not None and s["leq_off"] is not None and s["leq_on"] > s["leq_off"]) else None)
        return s, (nt, nd)

    a_stats, a_series = sound(asrc, cap=True)     # handling cut applies to the A-weighted anchor
    c_stats, c_series = sound(csrc, cap=False)

    lowfreq = None
    if a_series and c_series:
        amap = {round(t): d for t, d in zip(*a_series)}
        cmap = {round(t): d for t, d in zip(*c_series)}
        common = sorted(set(amap) & set(cmap))
        if common:
            gaps = np.array([cmap[s] - amap[s] for s in common])
            cst = classify(np.array(common, dtype=float))
            lowfreq = dict(n=len(gaps), ca_median=float(np.median(gaps)),
                           ca_on=(float(np.median(gaps[cst == 1])) if (cst == 1).any() else None),
                           ca_off=(float(np.median(gaps[cst == 0])) if (cst == 0).any() else None))

    # WHO verdict on the A-weighted source
    who = None
    if a_stats and a_stats["leq"] is not None:
        laeq = a_stats["leq"]
        reasons = []
        sev = "ok"
        if laeq > 40:
            sev = "poor"; reasons.append(f"LAeq {laeq:.0f} dBA exceeds WHO's 40 dBA night guideline")
        elif laeq > 30:
            sev = "marginal"; reasons.append(f"LAeq {laeq:.0f} dBA is above the 30 dBA bedroom guideline for undisturbed sleep")
        if a_stats["events_gt45"]:
            reasons.append(f"{a_stats['events_gt45']} noise events above the 45 dB LAmax awakening threshold")
        who = dict(laeq_a=laeq, severity=sev, reasons=reasons)

    return jsonify(
        window=dict(**{"from": t_from.replace(tzinfo=timezone.utc).isoformat(),
                       "to": t_to.replace(tzinfo=timezone.utc).isoformat()},
                    span_hours=round(span_h, 2), vib_readings=len(vt)),
        compressor=dict(
            duty_pct=(round(duty * 100, 1) if duty is not None else None),
            on_periods=n_cycles, cycles_per_hour=(round(n_cycles / span_h, 1) if span_h else None),
            mean_on_min=(round(sum(on_durs) / len(on_durs) / 60, 1) if on_durs else None),
            longest_on_min=(round(max(on_durs) / 60, 1) if on_durs else None),
            mean_off_min=(round(sum(off_durs) / len(off_durs) / 60, 1) if off_durs else None),
            snr_on=snr_on, dom_freq_median_on=dom_freq_median,
            on_intervals=[[datetime.fromtimestamp(s, timezone.utc).isoformat(),
                           datetime.fromtimestamp(e, timezone.utc).isoformat()] for s, e in on_intervals[:1000]],
        ),
        sound={asrc: a_stats, csrc: c_stats},
        weighting=dict(a_source=asrc, c_source=csrc),
        lowfreq=lowfreq,
        who=who,
    )


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
        # SNR (dominant peak vs noise floor), not velocity: velocity de-weights
        # the 58-120 Hz compressor tones by ~1/f, so it badly under-represents the
        # felt/heard AC. SNR tracks when a compressor is actually running.
        col, model, src_filter = Reading.snr, Reading, None
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


# --- Session (pause/resume logging) ----------------------------------------
@app.get("/api/session/<device>")
def session_get(device):
    st = db.session.get(DeviceState, device)
    return jsonify(device=device,
                   paused=bool(st.paused) if st else False,
                   updated=st.updated.replace(tzinfo=timezone.utc).isoformat() if st and st.updated else None)


@app.post("/api/session/<device>")
def session_set(device):
    j = request.get_json(silent=True) or {}
    paused = bool(j.get("paused", False))
    st = db.session.get(DeviceState, device)
    if not st:
        st = DeviceState(device_id=device)
        db.session.add(st)
    st.paused = paused
    st.updated = utcnow()
    db.session.commit()
    return jsonify(device=device, paused=paused)


@app.get("/api/live/<device>")
def live(device):
    """Latest reading, refreshed on every push even while paused — for the
    mounting helper (live coupling feedback without logging to history)."""
    st = db.session.get(DeviceState, device)
    if not st or st.live_ts is None:
        return jsonify(valid=False, paused=bool(st.paused) if st else False)
    return jsonify(
        valid=True,
        ts=st.live_ts.replace(tzinfo=timezone.utc).isoformat(),
        accel_rms_g=st.live_accel_rms_g,
        band1_rms_g=st.live_band1_rms_g,
        band2_rms_g=st.live_band2_rms_g,
        vel_rms_mm_s=st.live_vel_rms_mm_s,
        dom_freq_hz=st.live_dom_freq_hz,
        dom_amp_ms2=st.live_dom_amp_ms2,
        snr=st.live_snr,
        fw_version=st.live_fw_version,
        paused=bool(st.paused),
    )


@app.get("/mount")
def mount_view():
    return render_template("mount.html")


# --- High-resolution raw-snippet analysis (compressor counting experiment) ---
def _find_lines(freqs, amp, floor, fmin, fmax, min_sep=0.4, floor_mult=4.0, rel=0.08):
    """Distinct spectral lines in [fmin,fmax]. A line must clear both an absolute
    threshold (floor_mult*noise) and a relative one (rel * the band's strongest
    peak) — the latter rejects window sidelobes (Hann ~ -31 dB) and noise so they
    aren't miscounted as units. Greedily keep the strongest, dropping anything
    within min_sep Hz of a kept line (a single tone's lobe counts once)."""
    m = np.where((freqs >= fmin) & (freqs <= fmax))[0]
    if len(m) == 0:
        return []
    band_max = float(np.max(amp[m]))
    thr = max(floor_mult * floor, rel * band_max)
    cand = [k for k in m if 0 < k < len(amp) - 1 and amp[k] > thr
            and amp[k] >= amp[k - 1] and amp[k] >= amp[k + 1]]
    cand.sort(key=lambda k: -amp[k])
    kept = []
    for k in cand:
        if all(abs(freqs[k] - freqs[j]) >= min_sep for j in kept):
            kept.append(k)
    kept.sort(key=lambda k: freqs[k])
    return [{"hz": round(float(freqs[k]), 3), "mg": round(float(amp[k]), 3)} for k in kept]


@app.post("/api/rawcapture")
def rawcapture():
    dev = str(request.args.get("device") or "unknown")[:32]
    fs = float(request.args.get("fs", "800"))
    rng = float(request.args.get("range_g", "2"))
    axis = int(request.args.get("axis", "2"))
    raw = request.get_data()
    x = np.frombuffer(raw, dtype="<i2").astype(np.float64)
    if x.size < 1024:
        return jsonify(ok=False, error="too few samples", got=int(x.size)), 400

    g = x * rng / 32768.0            # int16 counts -> g  (±rng g full scale)
    g = g - g.mean()
    nsamp = int(g.size)
    xw = g * np.hanning(nsamp)
    pad = 1 << int(np.ceil(np.log2(nsamp * 4)))     # zero-pad 4x for smooth peaks
    X = np.fft.rfft(xw, n=pad)
    freqs = np.fft.rfftfreq(pad, 1.0 / fs)
    amp = np.abs(X) * 4.0 / nsamp * 1000.0          # mg, single-sided (Hann CG=0.5)

    band = (freqs >= 20) & (freqs <= 130)
    floor = float(np.median(amp[band])) if band.any() else 0.0
    low = _find_lines(freqs, amp, floor, 25, 35)
    high = _find_lines(freqs, amp, floor, 55, 62)

    rc = RawCap(device_id=dev, ts=utcnow(), axis=axis, fs=fs, n=nsamp,
                noise_floor_mg=floor, n_units=len(low) + len(high),
                peaks=json.dumps({"low": low, "high": high, "res_hz": fs / nsamp}))
    db.session.add(rc)
    db.session.commit()
    app.logger.info("rawcapture %s: %d low + %d high lines (floor %.3f mg)",
                    dev, len(low), len(high), floor)
    return jsonify(ok=True, res_hz=round(fs / nsamp, 4), noise_floor_mg=round(floor, 3),
                   low=low, high=high, n_units_est=len(low) + len(high))


@app.get("/api/rawcapture/results")
def rawcapture_results():
    q = RawCap.query
    dev = request.args.get("device")
    if dev:
        q = q.filter_by(device_id=dev)
    limit = min(int(request.args.get("limit", "30")), 200)
    rows = q.order_by(RawCap.ts.desc()).limit(limit).all()
    return jsonify([{
        "ts": r.ts.replace(tzinfo=timezone.utc).isoformat(),
        "axis": r.axis, "res_hz": round(r.fs / r.n, 4) if r.n else None,
        "noise_floor_mg": r.noise_floor_mg, "n_units": r.n_units,
        "peaks": json.loads(r.peaks) if r.peaks else None,
    } for r in rows])


@app.get("/health")
def health():
    return jsonify(ok=True, ts=utcnow().isoformat())


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/sleep")
def sleep_view():
    return render_template("sleep.html")


@app.get("/live")
def live_view():
    return render_template("live.html")


@app.get("/report")
def report_view():
    return render_template("report.html")


@app.get("/lowfreq")
def lowfreq_view():
    return render_template("lowfreq.html")


@app.get("/washer")
def washer_view():
    return render_template("washer.html")


@app.get("/trends")
def trends_view():
    return render_template("trends.html")


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
                             ("band2_rms_g", "REAL"), ("band2_lo_hz", "REAL"), ("band2_hi_hz", "REAL"),
                             ("dom_amp_ms2", "REAL"), ("noise_floor_ms2", "REAL"), ("snr", "REAL")]:
                if col not in have:
                    db.session.execute(db.text(f"ALTER TABLE readings ADD COLUMN {col} {typ}"))
            # device_state live-snapshot columns (added after the table existed)
            have_ds = {row[1] for row in db.session.execute(db.text("PRAGMA table_info(device_state)"))}
            if have_ds:
                for col, typ in [("live_ts", "DATETIME"), ("live_accel_rms_g", "REAL"),
                                 ("live_band1_rms_g", "REAL"), ("live_band2_rms_g", "REAL"),
                                 ("live_vel_rms_mm_s", "REAL"), ("live_dom_freq_hz", "REAL"),
                                 ("live_fw_version", "INTEGER"),
                                 ("live_dom_amp_ms2", "REAL"), ("live_snr", "REAL")]:
                    if col not in have_ds:
                        db.session.execute(db.text(f"ALTER TABLE device_state ADD COLUMN {col} {typ}"))
            db.session.commit()
        except Exception as e:  # noqa: BLE001
            app.logger.warning("column migration skipped: %s", e)


init_db()
if RETENTION_DAYS > 0:
    threading.Thread(target=prune_loop, daemon=True).start()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=True)

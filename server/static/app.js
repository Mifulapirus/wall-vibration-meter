// Wall Vibration Meter — history dashboard. Vanilla canvas, no external libs.
const ZONE_COLORS = ['#21c07a', '#e6cc00', '#ff8a1e', '#ff4d4d'];
const ZONE_NAMES  = ['GOOD', 'FAIR', 'HIGH', 'SEVERE'];
const Z = { z1: 0.3, z2: 1.0, z3: 3.0 };   // updated from data

const el = (id) => document.getElementById(id);
const qs = () => `device=${encodeURIComponent(el('device').value)}&hours=${el('range').value}`;

// --- Noise-floor / SNR gate for the dominant frequency --------------------
// A MEMS accelerometer's low-frequency 1/f noise makes the "dominant" peak land
// at low freq whenever there's no real signal. Estimate the quiet floor from
// the data (20th-percentile acceleration) and only trust the dominant frequency
// when a reading's energy clearly exceeds it.
let gActiveThresh = 0;   // accel (mg) above which the dominant freq is "real" (0 = ungated)
const accelMg = (r) => (r.accel_rms_g || 0) * 1000;
function noiseFloorMg(rows) {
  const v = rows.map(accelMg).filter(x => x > 0).sort((a, b) => a - b);
  return v.length < 8 ? 0 : v[Math.floor(v.length * 0.2)];
}
const activeThreshMg = (floor) => Math.max(floor * 1.5, floor + 3);
// A reading's dominant frequency is "real" when its peak clears the noise floor.
// Prefer the on-device SNR (v5+); fall back to the accel-floor heuristic.
const isActive = (r) => (r.snr != null) ? r.snr > 2.5 : (gActiveThresh === 0 || accelMg(r) > gActiveThresh);

// Focus the frequency charts on the AC source range (~28-120 Hz), with margin.
const VIEW_FMIN = 20, VIEW_FMAX = 130;
const clampF = (f) => Math.max(VIEW_FMIN, Math.min(VIEW_FMAX, f));

// Time-range options (value = hours, fractional for minute ranges). The API's
// `hours` param accepts fractions, so 1 min = 1/60 h. Populated from JS so the
// list can change without a server/template restart.
const RANGES = [
  { label: '1 min', hours: 1 / 60 },
  { label: '5 min', hours: 5 / 60 },
  { label: '10 min', hours: 10 / 60 },
  { label: '1 h', hours: 1 },
  { label: '6 h', hours: 6 },
  { label: '24 h', hours: 24, default: true },
  { label: '7 d', hours: 168 },
  { label: '30 d', hours: 720 },
];
function populateRanges() {
  const sel = el('range');
  const cur = sel.value;
  sel.innerHTML = '';
  RANGES.forEach(r => {
    const o = document.createElement('option');
    o.value = r.hours; o.textContent = r.label;
    if (r.default) o.selected = true;
    sel.appendChild(o);
  });
  if (cur && RANGES.some(r => String(r.hours) === cur)) sel.value = cur;
}

function setStatus(t, cls) { const s = el('status'); s.textContent = t; s.className = 'status ' + (cls || ''); }
function fmtTime(iso) { const d = new Date(iso); return d.toLocaleString(); }

// Device is considered disconnected if it hasn't pushed for ~5 cycles.
// A measurement/push cycle is ~5 s at FFT_SIZE=4096 (fw v8+), so ~30 s of
// silence = offline. (Generous for older 1.3 s-cycle firmware, which is fine.)
const STALE_MS = 30000;

async function loadDevices() {
  const res = await fetch('/api/devices');
  const devs = await res.json();
  const sel = el('device');
  const cur = sel.value;
  sel.innerHTML = '';
  if (!devs.length) { sel.innerHTML = '<option>no devices yet</option>'; return; }
  for (const d of devs) {
    const o = document.createElement('option');
    o.value = d.device_id;
    const fw = d.latest && d.latest.fw_version != null ? ' · fw' + d.latest.fw_version : '';
    o.textContent = d.device_id + fw + ' (' + d.count + ')';
    sel.appendChild(o);
  }
  if (cur) sel.value = cur;
}

// --- Session pause/resume --------------------------------------------------
let gPaused = false;
function renderSession() {
  const b = el('sessionBtn');
  b.textContent = gPaused ? '▶ Resume' : '⏸ Pause';
  b.classList.toggle('paused', gPaused);
  el('pausedBadge').style.display = gPaused ? '' : 'none';
}
async function loadSession() {
  const dev = el('device').value;
  if (!dev) return;
  try {
    const s = await fetch('/api/session/' + encodeURIComponent(dev)).then(r => r.json());
    gPaused = !!s.paused; renderSession();
  } catch (e) { /* leave as-is */ }
}
async function toggleSession() {
  const dev = el('device').value;
  if (!dev) return;
  const s = await fetch('/api/session/' + encodeURIComponent(dev), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: !gPaused }),
  }).then(r => r.json());
  gPaused = !!s.paused; renderSession();
}

// Latest readings currently plotted on the line charts. Kept client-side so the
// fast poll can extend the charts live without re-fetching the whole history.
let curRows = [];

// Cheap, frequent poll: latest reading -> live tiles + live chart tips.
async function refreshTiles() {
  const dev = encodeURIComponent(el('device').value);
  try {
    // /api/latest = last stored reading (tiles); /api/live = last push time
    // (fresh even while paused) -> the true device connection state.
    const [d, live, snd] = await Promise.all([
      fetch('/api/latest?device=' + dev, { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/live/' + dev, { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/noise/latest?prefix=DSL-', { cache: 'no-store' }).then(r => r.json()).catch(() => ({})),
    ]);
    updateTiles(d);
    updateSoundTile(snd);
    // Append the newest point so the velocity/frequency charts advance at the
    // same 2 s cadence as the tiles (the periodic full refresh resyncs/decimates).
    if (d && d.ts && (!curRows.length || d.ts > curRows[curRows.length - 1].ts)) {
      curRows.push(d);
      drawStrength(curRows);
      drawActivity(curRows);
      drawFreq(curRows);
    }
    // Connection chip: live if the device pushed within ~5 cycles, else offline.
    const ageMs = (live && live.valid && live.ts) ? (Date.now() - new Date(live.ts).getTime()) : Infinity;
    if (ageMs > STALE_MS) setStatus('● disconnected', 'err');
    else setStatus('● live', 'ok');
  } catch (e) {
    setStatus('● offline', 'err');
  }
}

// Live sound level tile — newest pushed dB reading from the DSL meter.
function updateSoundTile(n) {
  const span = el('soundAvg'), tile = el('soundTile');
  if (!span || !tile) return;
  if (n && n.spl_db != null) {
    span.textContent = n.spl_db.toFixed(1);
    const ageMs = n.ts ? (Date.now() - new Date(n.ts).getTime()) : Infinity;
    tile.style.opacity = ageMs > STALE_MS ? '0.5' : '1';   // dim when the feed goes stale
  } else {
    span.textContent = '--';
    tile.style.opacity = '0.5';
  }
}

// Heavier poll: the full time-series + spectra (spectrogram) for the charts.
async function refreshCharts() {
  try {
    const [rows, specs, units] = await Promise.all([
      fetch('/api/readings?' + qs(), { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/spectra?' + qs(), { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/units?' + qs(), { cache: 'no-store' }).then(r => r.json()),
    ]);
    curRows = rows;
    // Share the vibration window with the noise overlay so the x-axes line up.
    vibBounds = rows.length >= 2 ? timeBounds(rows) : null;
    drawStrength(rows);
    drawActivity(rows);
    drawFreq(rows);
    drawUnits(units);
    drawSpectrogram(specs);
    await refreshNoise();
    el('meta').textContent = `${rows.length} readings · ${specs.length} spectra in view`;
  } catch (e) {
    setStatus('error — ' + e.message, 'err');
  }
}

// --- Imported noise (dB) overlay ------------------------------------------
// Any dB sources imported via /compare or /sleep are drawn on their own panel
// over the SAME time window as the vibration charts, so sound and wall-vibration
// read together. The panel hides itself when no sources exist yet.
//
// Every night/capture is imported as its OWN source (<METER>[-A|-C]-<YYYY-MM-DD>),
// so the source list grows forever and listing them all made the legend unusable.
// The legend therefore names only the sources that actually have readings inside
// the window on screen, labelled by what was measured rather than by the import
// batch. That also means we only fetch the sources that can possibly show.
const NOISE_FAMILY_COLORS = {   // stable per meter, so a meter keeps its colour
  eS528L: '#35a9ff',            // the calibrated reference
  DSL: '#ff8a1e',
  TAS: '#c77dff',
  WD: '#ff6f91',
  Average: '#21c07a',
};
const NOISE_FALLBACK = ['#ffd24a', '#4dd0e1', '#9ccc65', '#b39ddb'];
const NOISE_METER_NAMES = { WD: 'Washer / dryer', 'DSL-out': 'DSL (long run)', 'eS528L-night': 'eS528L' };
const DB_SLEEP = 30, DB_EVENT = 45;   // WHO bedroom guidance (indoor)

// Named events annotated on the chart. `match` derives the span from the
// first/last of the sources it matches (the capture IS the event); `from`/`to`
// (local wall-clock) pins an event that has no source of its own.
const NOISE_EVENTS = [
  // WD-… is one run per day; WD1-/WD2-… are numbered runs when a day has several.
  { label: 'Washer / dryer', match: /^WD\d*-/ },
  { label: 'Water pump', from: '2026-07-16T06:40:00', to: '2026-07-16T07:30:00' },
];

let noiseVisible = {};   // source -> bool
let noiseColor = {};     // source -> css color
let noiseData = {};      // source -> [{ts, spl_db}] over the current window
let noiseSources = [];   // [{source, count, first, last}] from the API
let vibBounds = null;    // [t0, t1] from the vibration rows, for x-axis sync

// <METER>[-A|-C]-<YYYY-MM-DD>, tolerating legacy names with neither part.
function parseNoiseSource(n) {
  const m = /^(.+?)(?:-([AC]))?(?:-(\d{4}-\d{2}-\d{2}))?$/.exec(n) || [];
  return { meter: m[1] || n, weighting: m[2] || null, date: m[3] || null };
}

function noiseLabel(n) {
  const { meter, weighting } = parseNoiseSource(n);
  // Plain eS528L is dBA by naming convention (C nights are tagged -C-).
  const w = weighting || (meter.split('-')[0] === 'eS528L' ? 'A' : null);
  const nice = NOISE_METER_NAMES[meter] || meter;
  return w ? `${nice} (dB${w})` : nice;
}

// Two captures of the same meter+weighting can land in one window (e.g. a live
// stream and an imported night); disambiguate those by date so the legend never
// shows the same text twice.
function noiseLabels(names) {
  const base = Object.fromEntries(names.map(n => [n, noiseLabel(n)]));
  const seen = {};
  names.forEach(n => { seen[base[n]] = (seen[base[n]] || 0) + 1; });
  return Object.fromEntries(names.map(n => {
    const d = parseNoiseSource(n).date;
    if (seen[base[n]] === 1) return [n, base[n]];
    return [n, d ? `${base[n]} ${d}` : n];   // no date to add? fall back to the raw name
  }));
}

async function loadNoiseSources() {
  try { noiseSources = await fetch('/api/noise/sources').then(r => r.json()); } catch (e) { return; }
  el('noisePanel').style.display = noiseSources.length ? '' : 'none';
}

// Window currently on screen: the vibration bounds when we have them (so the
// panels line up), else the selected hours back from now.
function noiseWindow() {
  if (vibBounds) return vibBounds;
  const t1 = Date.now();
  return [t1 - (parseFloat(el('range').value) || 24) * 3600e3, t1];
}

function buildNoiseLegend(names) {
  const leg = el('noiseLegend'); if (!leg) return;
  leg.innerHTML = '';
  if (!names.length) {
    leg.innerHTML = '<span class="dim">no dB readings in this window</span>';
    return;
  }
  const labels = noiseLabels(names);
  const used = new Set();
  names.forEach((n, i) => {
    if (!(n in noiseVisible)) noiseVisible[n] = true;
    const base = parseNoiseSource(n).meter.split('-')[0];
    let c = NOISE_FAMILY_COLORS[base];
    if (!c || used.has(c)) c = NOISE_FALLBACK[i % NOISE_FALLBACK.length];
    used.add(c); noiseColor[n] = c;

    const src = noiseSources.find(s => s.source === n) || {};
    const span = document.createElement('span');
    span.className = 'legtoggle'; span.style.cursor = 'pointer'; span.style.userSelect = 'none';
    span.title = `${n}${src.count ? ` — ${src.count.toLocaleString()} readings` : ''}`;
    span.innerHTML = `<i class="sw" style="background:${c}"></i> ${labels[n]}`;
    const paint = () => {
      span.style.opacity = noiseVisible[n] ? '1' : '0.4';
      span.style.textDecoration = noiseVisible[n] ? 'none' : 'line-through';
    };
    paint();
    span.addEventListener('click', () => { noiseVisible[n] = !noiseVisible[n]; paint(); drawNoise(); });
    leg.appendChild(span);
  });
  const hint = document.createElement('span');
  hint.className = 'dim'; hint.style.marginLeft = '6px'; hint.textContent = '(click to show/hide)';
  leg.appendChild(hint);
}

async function refreshNoise() {
  if (!noiseSources.length || el('noisePanel').style.display === 'none') return;
  const [w0, w1] = noiseWindow();
  // Only sources whose recorded span overlaps the window can draw anything —
  // skip fetching the rest (there is one source per night, and they add up).
  const cands = noiseSources
    .filter(s => Date.parse(s.last) >= w0 && Date.parse(s.first) <= w1)
    .map(s => s.source);
  const win = `from=${enc(new Date(w0).toISOString())}&to=${enc(new Date(w1).toISOString())}`;
  const got = await Promise.all(cands.map(n =>
    fetch(`/api/noise?source=${enc(n)}&${win}`, { cache: 'no-store' })
      .then(r => r.json()).then(d => [n, d]).catch(() => [n, []])));
  noiseData = Object.fromEntries(got.filter(([, d]) => d && d.length));
  buildNoiseLegend(Object.keys(noiseData));
  drawNoise();
}

// Concrete [start, end] for each named event that overlaps the window. A matched
// event yields one span PER capture, never a union: the washer's dBA and dBC
// files are different clock windows, and spanning them would invent noise across
// the gap between them.
function noiseEventSpans(t0, t1) {
  const spans = NOISE_EVENTS.flatMap(ev => ev.match
    ? noiseSources.filter(s => ev.match.test(s.source))
        .map(s => ({ label: ev.label, a: Date.parse(s.first), b: Date.parse(s.last) }))
    : [{ label: ev.label, a: Date.parse(ev.from), b: Date.parse(ev.to) }]);
  // But DO merge captures of the same event that overlap (e.g. simultaneous dBA
  // + dBC of one run), so a single real event draws a single band.
  spans.sort((p, q) => p.label === q.label ? p.a - q.a : (p.label < q.label ? -1 : 1));
  const merged = [];
  spans.forEach(s => {
    const last = merged[merged.length - 1];
    if (last && last.label === s.label && s.a <= last.b) last.b = Math.max(last.b, s.b);
    else merged.push({ ...s });
  });
  return merged.filter(e => e.b >= t0 && e.a <= t1);
}
const enc = encodeURIComponent;

function drawNoise() {
  const c = el('noiseChart'); if (!c) return;
  const ctx = c.getContext('2d'); const W = c.width, H = c.height, pad = 40;
  ctx.clearRect(0, 0, W, H);
  const shown = Object.keys(noiseData).filter(n => noiseVisible[n] && (noiseData[n] || []).length);
  const allPts = shown.flatMap(n => noiseData[n]);
  if (!allPts.length) { ctx.fillStyle = '#8b95a3'; ctx.font = '12px system-ui'; ctx.fillText('no dB data in this window', pad + 8, H / 2); return; }
  // x-axis: prefer the vibration window so it aligns with the charts above.
  const [t0, t1] = vibBounds || [
    Math.min(...allPts.map(p => new Date(p.ts).getTime())),
    Math.max(...allPts.map(p => new Date(p.ts).getTime())) + 1];
  let dbMax = DB_EVENT + 5, dbMin = 25;
  allPts.forEach(p => { if (p.spl_db != null) dbMax = Math.max(dbMax, p.spl_db + 3); });
  dbMax = Math.ceil(dbMax / 5) * 5;
  const xOf = (t) => pad + ((t - t0) / (t1 - t0)) * (W - pad - 10);
  const yOf = (v) => (H - pad) - ((v - dbMin) / (dbMax - dbMin)) * (H - pad - 10);

  // Compressor-ON shading (from the vibration SNR) behind the dB lines, so the
  // sound level reads together with when the AC was actually running.
  if (curRows && curRows.length) {
    ctx.fillStyle = 'rgba(33,192,122,0.13)';
    let spanStart = null, running = false;
    const flush = (x) => { if (spanStart != null) { ctx.fillRect(spanStart, 10, Math.max(1, x - spanStart), H - pad - 10); spanStart = null; } };
    curRows.forEach(r => {
      const t = new Date(r.ts).getTime();
      if (t < t0 || t > t1) return;
      const x = xOf(t), s = r.snr;
      if (s != null) { if (!running && s >= AC_SNR_ON) running = true; else if (running && s < AC_SNR_ON - 3) running = false; }
      if (running) { if (spanStart == null) spanStart = x; } else flush(x);
    });
    flush(xOf(t1));
  }

  // Named events (washer/dryer, water pump…) as labelled bands, so a spike has
  // an explanation on the chart instead of only in the legend.
  const events = noiseEventSpans(t0, t1);
  events.forEach(ev => {
    const xa = Math.max(pad, xOf(Math.max(ev.a, t0)));
    const xb = Math.min(W - 10, xOf(Math.min(ev.b, t1)));
    ctx.fillStyle = 'rgba(199,125,255,0.15)';
    ctx.fillRect(xa, 10, Math.max(2, xb - xa), H - pad - 10);
    ctx.strokeStyle = 'rgba(199,125,255,0.75)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(xa, 10); ctx.lineTo(xa, H - pad); ctx.stroke();
    ctx.setLineDash([]);
  });

  drawTimeAxis(ctx, W, H, pad, t0, t1);
  ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui';
  for (let v = dbMin; v <= dbMax; v += 10) ctx.fillText(v + ' dB', 2, yOf(v) + 3);
  // WHO reference lines
  const dash = (v, col, lbl) => {
    ctx.strokeStyle = col; ctx.setLineDash([5, 4]); ctx.beginPath();
    ctx.moveTo(pad, yOf(v)); ctx.lineTo(W - 10, yOf(v)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = col; ctx.fillText(lbl, pad + 4, yOf(v) - 3);
  };
  if (DB_EVENT <= dbMax) dash(DB_EVENT, 'rgba(255,77,77,0.7)', 'WHO 45 dB');
  if (DB_SLEEP >= dbMin) dash(DB_SLEEP, 'rgba(230,204,0,0.6)', 'WHO 30 dB');

  shown.forEach(n => {
    ctx.strokeStyle = noiseColor[n]; ctx.lineWidth = n === 'Average' ? 2.2 : 1.4; ctx.beginPath();
    let started = false;
    noiseData[n].forEach(p => {
      if (p.spl_db == null) { started = false; return; }
      const x = xOf(new Date(p.ts).getTime()), y = yOf(p.spl_db);
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
    });
    ctx.stroke();
  });

  // Event labels last, so the traces don't draw over them.
  ctx.font = '10px system-ui'; ctx.fillStyle = '#d9b3ff';
  events.forEach(ev => {
    const xa = Math.max(pad, xOf(Math.max(ev.a, t0)));
    const w = ctx.measureText(ev.label).width;
    ctx.fillText(ev.label, Math.min(xa + 3, W - 10 - w), 20);
  });
}

// Latest band edges (for spectrogram overlay). Fall back to fw<=3 single band.
let band1Lo = 25, band1Hi = 40, band2Lo = 50, band2Hi = 65;
const COL_B1 = '#c77dff', COL_B2 = '#ff8a1e';   // low band / compressor band colours
const b1mg = (r) => (r.band1_rms_g != null ? r.band1_rms_g : r.band_rms_g || 0) * 1000;
const b2mg = (r) => (r.band2_rms_g != null ? r.band2_rms_g : 0) * 1000;

// A compressor is "running" when the strongest peak stands well above the noise
// floor (SNR). Threshold calibrated against a night of Type-2 bedroom dB data:
// SNR>=10 matched when the AC was *audibly* disruptive (>~50 dB) with 88%
// agreement and zero missed loud periods, whereas SNR 3-10 mostly occurred at
// the quiet ~48 dB baseline (a compressor coupling faintly but not audible).
// OFF-hysteresis at 7 keeps the span from blinking near the threshold.
// Pre-v5 readings have no SNR, so fall back to the band totals.
const AC_SNR_ON = 10;         // turn "running" ON above this (× above noise)
const AC_SNR_OFF = 7;         // ...and OFF only below this (hysteresis kills flicker)
const AC_BAND_ON_MG = 4.5;    // fallback: band1+band2 total (mg)
function acOn(r) {            // instantaneous state (latest-reading tile)
  if (r.snr != null) return r.snr > AC_SNR_ON;
  const b = b1mg(r) + b2mg(r);
  return b > 0 ? b > AC_BAND_ON_MG : null;
}

// Compressor "strength" = amplitude of the dominant tone in mg — the physical
// magnitude you feel. Replaces RMS velocity on the dashboard, which de-weights
// the 58-120 Hz compressor tones (~1/f) and stayed flat whether the AC was on.
const domMg = (r) => (r.dom_amp_ms2 != null ? r.dom_amp_ms2 / 9.80665 * 1000 : 0);
const SNR_STRONG = 20;   // clearly strong coupling
const STRENGTH_NAMES  = ['quiet', 'ON', 'STRONG'];
const STRENGTH_COLORS = ['#8b95a3', '#e6cc00', '#ff8a1e'];
function strengthTier(d) {   // intensity tier from SNR (matches "is it running")
  const s = d.snr;
  if (s == null || s < AC_SNR_ON) return 0;
  return s < SNR_STRONG ? 1 : 2;
}

function updateTiles(d) {
  if (!d || !d.ts) { return; }
  el('vel').textContent = domMg(d).toFixed(1);
  // Gate the dominant frequency: show "—" when this reading is just noise floor.
  const freqReal = isActive(d);
  el('freq').textContent = freqReal ? (d.dom_freq_hz ?? 0).toFixed(1) : '—';
  el('freq').style.color = freqReal ? '' : 'var(--muted)';
  el('freqSnr').textContent = (d.snr != null && d.snr > 0) ? `${d.snr.toFixed(1)}× vs noise` : '';
  el('accel').textContent = ((d.accel_rms_g ?? 0) * 1000).toFixed(1);
  // AC compressor on/off status
  const on = acOn(d);
  el('acStatus').textContent = on == null ? '—' : (on ? 'ON' : 'quiet');
  el('acStatus').style.color = on ? 'var(--z0)' : 'var(--muted)';
  el('acTile').style.borderColor = on ? 'var(--z0)' : 'var(--line)';
  el('acDetail').textContent = on && d.dom_freq_hz
    ? `${d.dom_freq_hz.toFixed(0)} Hz` + (d.snr != null ? ` · ${d.snr.toFixed(0)}× vs noise` : '')
    : (on === false ? 'no compressor detected' : '');
  if (d.band1_lo_hz) {   // keep band edges for the spectrogram markers
    band1Lo = d.band1_lo_hz; band1Hi = d.band1_hi_hz; band2Lo = d.band2_lo_hz; band2Hi = d.band2_hi_hz;
  }
  el('fwBadge').textContent = d.fw_version != null ? 'fw v' + d.fw_version : '';
  const z = strengthTier(d);
  const col = STRENGTH_COLORS[z];
  const badge = el('zone');
  badge.textContent = STRENGTH_NAMES[z]; badge.className = 'badge';
  badge.style.color = col; badge.style.borderColor = col;
  const tile = el('velTile');
  tile.style.borderColor = col;
  tile.style.boxShadow = '0 0 0 1px ' + col + ', 0 0 24px -8px ' + col;
}

// --- Shared time-axis helpers ---------------------------------------------
function timeBounds(rows) {
  const t0 = new Date(rows[0].ts).getTime();
  const t1 = new Date(rows[rows.length - 1].ts).getTime();
  return [t0, Math.max(t1, t0 + 1)];
}
function drawTimeAxis(ctx, W, H, pad, t0, t1) {
  ctx.strokeStyle = '#262d38'; ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui'; ctx.lineWidth = 1;
  const ticks = 6;
  for (let i = 0; i <= ticks; i++) {
    const x = pad + (i / ticks) * (W - pad - 10);
    ctx.beginPath(); ctx.moveTo(x, 6); ctx.lineTo(x, H - pad); ctx.stroke();
    const t = new Date(t0 + (i / ticks) * (t1 - t0));
    const span = t1 - t0;
    const lbl = span < 36e5 ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : span < 864e5 ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : (t.getMonth() + 1) + '/' + t.getDate();
    ctx.fillText(lbl, x + 2, H - pad + 14);
  }
}

// Compressor vibration strength over time: dominant-tone amplitude (mg), which
// actually moves with the AC — unlike RMS velocity, which stayed flat because it
// de-weights the compressor frequencies.
function drawStrength(rows) {
  const c = el('velChart'), ctx = c.getContext('2d'); const W = c.width, H = c.height, pad = 40;
  ctx.clearRect(0, 0, W, H);
  if (rows.length < 2) return;
  const [t0, t1] = timeBounds(rows);
  let max = 4;
  for (const r of rows) max = Math.max(max, domMg(r));
  max = Math.ceil(max / 2) * 2;
  const yOf = (v) => (H - pad) - (Math.min(v, max) / max) * (H - pad - 10);
  const xOf = (t) => pad + ((t - t0) / (t1 - t0)) * (W - pad - 10);

  drawTimeAxis(ctx, W, H, pad, t0, t1);
  ctx.fillStyle = '#ffd24a'; ctx.fillText(max.toFixed(0) + ' mg', 2, 12); ctx.fillStyle = '#8b95a3'; ctx.fillText('0', 2, H - pad);

  // filled area under the strength curve
  ctx.beginPath(); let started = false, lastX = pad;
  rows.forEach(r => {
    const x = xOf(new Date(r.ts).getTime()), y = yOf(domMg(r));
    started ? ctx.lineTo(x, y) : (ctx.moveTo(x, H - pad), ctx.lineTo(x, y)); started = true; lastX = x;
  });
  if (started) { ctx.lineTo(lastX, H - pad); ctx.closePath(); ctx.fillStyle = 'rgba(255,210,74,0.16)'; ctx.fill(); }

  ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 1.6; ctx.beginPath();
  rows.forEach((r, i) => { const x = xOf(new Date(r.ts).getTime()), y = yOf(domMg(r)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
}

// Per-unit compressor strength (mg) over time — each rooftop unit on its own
// trace (from /api/units), so a unit that's running but not the loudest is still
// visible. Data comes from the stored spectra, so it also works over history.
const UNIT_DEFS = [
  { key: 'u28',  color: '#35a9ff' },   // 4-pole (~28 Hz)
  { key: 'u58',  color: '#21c07a' },   // 2-pole fundamental (~58 Hz)
  { key: 'u120', color: '#ff8a1e' },   // 2-pole 2nd harmonic (~120 Hz)
];
const unitVisible = { u28: true, u58: true, u120: true };   // toggled via the legend
let curUnits = [];                                          // cached so toggles redraw without refetch
function drawUnits(rows) {
  if (rows) curUnits = rows;
  const data = curUnits;
  const c = el('unitsChart'); if (!c) return;
  const ctx = c.getContext('2d'); const W = c.width, H = c.height, pad = 40;
  ctx.clearRect(0, 0, W, H);
  if (!data || data.length < 2) return;
  const vis = UNIT_DEFS.filter(u => unitVisible[u.key]);
  const [t0, t1] = timeBounds(data);
  // Scale to the visible traces only, so hiding a loud unit zooms in on the rest.
  let max = 4;
  for (const r of data) for (const u of vis) max = Math.max(max, r[u.key] || 0);
  max = Math.ceil(max / 2) * 2;
  const yOf = (v) => (H - pad) - (Math.min(v, max) / max) * (H - pad - 10);
  const xOf = (t) => pad + ((t - t0) / (t1 - t0)) * (W - pad - 10);
  drawTimeAxis(ctx, W, H, pad, t0, t1);
  ctx.fillStyle = '#8b95a3'; ctx.fillText(max.toFixed(0) + ' mg', 2, 12); ctx.fillText('0', 2, H - pad);
  for (const u of vis) {
    ctx.strokeStyle = u.color; ctx.lineWidth = 1.5; ctx.beginPath(); let started = false;
    data.forEach(r => {
      const v = r[u.key];
      if (v == null) { started = false; return; }
      const x = xOf(new Date(r.ts).getTime()), y = yOf(v);
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
    });
    ctx.stroke();
  }
}
// Clickable legend: show/hide each unit's trace.
document.querySelectorAll('#unitsLegend .legtoggle').forEach(span => {
  span.style.cursor = 'pointer'; span.style.userSelect = 'none';
  span.addEventListener('click', () => {
    const k = span.dataset.unit;
    unitVisible[k] = !unitVisible[k];
    span.style.opacity = unitVisible[k] ? '1' : '0.4';
    span.style.textDecoration = unitVisible[k] ? 'none' : 'line-through';
    drawUnits();   // redraw from cache, no refetch
  });
});

// AC compressor activity over time: signal strength (SNR) with the "running"
// periods shaded green, so on/off cycles are obvious at a glance.
function drawActivity(rows) {
  const c = el('bandChart'), ctx = c.getContext('2d'); const W = c.width, H = c.height, pad = 40;
  ctx.clearRect(0, 0, W, H);
  if (rows.length < 2) return;
  const [t0, t1] = timeBounds(rows);
  let max = AC_SNR_ON * 2;
  for (const r of rows) if (r.snr != null) max = Math.max(max, r.snr);
  max = Math.ceil(max / 5) * 5;
  const yOf = (v) => (H - pad) - (Math.min(v, max) / max) * (H - pad - 10);
  const xOf = (t) => pad + ((t - t0) / (t1 - t0)) * (W - pad - 10);

  // Shade contiguous "AC running" spans, with hysteresis: a steady-but-weak unit
  // that dips to the threshold stays latched "on" until SNR clearly drops, so the
  // shading doesn't blink. Genuine shutdowns (SNR -> 1-2) still break the span.
  ctx.fillStyle = 'rgba(33,192,122,0.16)';
  let spanStart = null, running = false;
  const flush = (x) => { if (spanStart != null) { ctx.fillRect(spanStart, 6, Math.max(1, x - spanStart), H - pad - 6); spanStart = null; } };
  rows.forEach((r) => {
    const x = xOf(new Date(r.ts).getTime());
    if (r.snr != null) {
      if (!running && r.snr >= AC_SNR_ON) running = true;
      else if (running && r.snr < AC_SNR_OFF) running = false;
    } else {
      running = acOn(r) === true;   // pre-v5 fallback (band totals, no hysteresis)
    }
    if (running) { if (spanStart == null) spanStart = x; } else flush(x);
  });
  flush(xOf(t1));

  drawTimeAxis(ctx, W, H, pad, t0, t1);

  // "AC on" threshold line
  const yT = yOf(AC_SNR_ON);
  ctx.strokeStyle = 'rgba(33,192,122,0.7)'; ctx.setLineDash([5, 4]); ctx.beginPath();
  ctx.moveTo(pad, yT); ctx.lineTo(W - 10, yT); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#8b95a3'; ctx.fillText(max + '×', 2, 12); ctx.fillText('0', 2, H - pad);
  ctx.fillStyle = '#21c07a'; ctx.fillText('AC-on threshold', pad + 5, yT - 3);

  // SNR line (v5+ readings)
  ctx.strokeStyle = '#35a9ff'; ctx.lineWidth = 1.5; ctx.beginPath(); let started = false;
  rows.forEach((r) => {
    if (r.snr == null) { started = false; return; }
    const x = xOf(new Date(r.ts).getTime()), y = yOf(r.snr);
    started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
  });
  ctx.stroke();
}

// Most common dominant-frequency bands in the window. Clusters readings whose
// dominant frequencies fall within `tol` Hz of each other (so a peak that jitters
// across 58-60 Hz reads as one band, not three), and returns the top clusters by
// how often they dominate — each with its mean frequency and share of the time.
function topFrequencies(rows, maxN, tol) {
  const freqs = [];
  for (const r of rows) { const f = r.dom_freq_hz; if (f != null && f > 0) freqs.push(f); }
  if (!freqs.length) return [];
  freqs.sort((a, b) => a - b);
  const clusters = []; let cur = [freqs[0]];
  for (let i = 1; i < freqs.length; i++) {
    if (freqs[i] - cur[cur.length - 1] <= tol) cur.push(freqs[i]);
    else { clusters.push(cur); cur = [freqs[i]]; }
  }
  clusters.push(cur);
  const total = freqs.length;
  return clusters
    .map(cl => ({ freq: cl.reduce((a, b) => a + b, 0) / cl.length, count: cl.length, pct: cl.length / total }))
    .sort((a, b) => b.count - a.count)
    .filter(t => t.pct >= 0.05)
    .slice(0, maxN);
}

function drawFreq(rows) {
  const c = el('freqChart'), ctx = c.getContext('2d'); const W = c.width, H = c.height, pad = 40;
  ctx.clearRect(0, 0, W, H);
  if (rows.length < 2) return;
  const [t0, t1] = timeBounds(rows);
  // Fixed y-axis focused on the AC source range; out-of-range points clamp to the edges.
  const yOf = (v) => (H - pad) - ((clampF(v) - VIEW_FMIN) / (VIEW_FMAX - VIEW_FMIN)) * (H - pad - 10);
  const xOf = (t) => pad + ((t - t0) / (t1 - t0)) * (W - pad - 10);
  drawTimeAxis(ctx, W, H, pad, t0, t1);
  ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui';
  for (let f = VIEW_FMIN; f <= VIEW_FMAX; f += 20) ctx.fillText(f + ' Hz', 2, yOf(f) + 3);

  // SNR gate: only count readings whose energy beats the noise floor.
  const floor = noiseFloorMg(rows);
  gActiveThresh = floor ? activeThreshMg(floor) : 0;
  const activeRows = rows.filter(isActive);

  // Labeled lines at the most frequent dominant-frequency bands, computed from
  // active (real-signal) readings only — noise-floor peaks are excluded.
  const tops = topFrequencies(activeRows, 3, 2.5);
  if (gActiveThresh && !activeRows.length) {
    ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui';
    ctx.fillText('quiet — no dominant above noise floor (' + floor.toFixed(0) + ' mg)', pad + 110, 12);
  }
  tops.forEach((t, i) => {
    if (t.freq < VIEW_FMIN || t.freq > VIEW_FMAX) return;   // don't label out-of-view bands
    const y = yOf(t.freq);
    ctx.strokeStyle = i === 0 ? 'rgba(53,169,255,0.8)' : 'rgba(255,255,255,0.28)';
    ctx.lineWidth = i === 0 ? 1.4 : 1;
    ctx.setLineDash([5, 4]); ctx.beginPath();
    ctx.moveTo(pad, y); ctx.lineTo(W - 10, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = i === 0 ? '#8ecbff' : '#c7d0dc';
    ctx.font = i === 0 ? 'bold 12px system-ui' : '11px system-ui';
    const label = `${t.freq.toFixed(1)} Hz · ${Math.round(t.pct * 100)}%`;
    ctx.fillText(label, pad + 5, y - 4);
  });
  ctx.font = '11px system-ui';

  // Dots: active readings coloured by severity zone; quiet (noise-floor)
  // readings dimmed grey so you can still see when it was quiet.
  rows.forEach((r) => {
    const x = xOf(new Date(r.ts).getTime()), y = yOf(r.dom_freq_hz || 0);
    ctx.fillStyle = isActive(r) ? ZONE_COLORS[r.zone | 0] : 'rgba(120,130,145,0.30)';
    ctx.fillRect(x - 1, y - 1, 2.5, 2.5);
  });
}

// Simple perceptual colour map (dark -> blue -> green -> yellow -> red).
function heat(v) { // v in [0,1]
  v = Math.max(0, Math.min(1, v));
  const stops = [[13,17,22],[30,60,130],[33,192,122],[230,204,0],[255,77,77]];
  const seg = v * (stops.length - 1); const i = Math.floor(seg); const f = seg - i;
  const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
  const r = a[0] + (b[0] - a[0]) * f, g = a[1] + (b[1] - a[1]) * f, bl = a[2] + (b[2] - a[2]) * f;
  return `rgb(${r|0},${g|0},${bl|0})`;
}

function drawSpectrogram(specs) {
  const c = el('spectro'), ctx = c.getContext('2d'); const W = c.width, H = c.height, pad = 40;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0e12'; ctx.fillRect(pad, 6, W - pad - 10, H - pad - 6);
  if (!specs.length) { ctx.fillStyle = '#8b95a3'; ctx.fillText('no spectra in range', pad + 8, H / 2); return; }

  const binHz = specs[0].bin_hz || 1;
  const nBins = specs[0].n_bins || specs[0].values.length;
  // Focus on the AC source band: only map bins within [VIEW_FMIN, VIEW_FMAX].
  const kLo = Math.max(1, Math.round(VIEW_FMIN / binHz));
  const kHi = Math.min(nBins - 1, Math.round(VIEW_FMAX / binHz));
  const kSpan = Math.max(1, kHi - kLo);
  // Normalise over the visible band only, so contrast lands where it matters.
  let vmax = 1e-9;
  for (const s of specs) for (let k = kLo; k <= kHi && k < s.values.length; k++) vmax = Math.max(vmax, s.values[k]);

  const gx = pad, gy = 6, gw = W - pad - 10, gh = H - pad - 6;
  const colW = Math.max(1, gw / specs.length);
  const t0 = new Date(specs[0].ts).getTime();
  const t1 = Math.max(new Date(specs[specs.length - 1].ts).getTime(), t0 + 1);

  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const x = gx + (gw * i) / specs.length;
    for (let k = kLo; k <= kHi && k < s.values.length; k++) {
      const y0 = gy + gh - ((k - kLo) / kSpan) * gh;
      const y1 = gy + gh - ((k + 1 - kLo) / kSpan) * gh;
      // log scaling makes weak lines visible
      const norm = Math.log10(1 + 9 * (s.values[k] / vmax));
      ctx.fillStyle = heat(norm);
      ctx.fillRect(x, y1, colW + 0.5, (y0 - y1) + 0.5);
    }
  }

  // Band markers: bracket each metric band on the (focused) frequency axis.
  const yF = (f) => gy + gh - ((clampF(f) - VIEW_FMIN) / (VIEW_FMAX - VIEW_FMIN)) * gh;
  ctx.font = '10px system-ui'; ctx.lineWidth = 1;
  const markBand = (lo, hi, col, label) => {
    ctx.strokeStyle = col; ctx.setLineDash([6, 4]);
    for (const f of [lo, hi]) { ctx.beginPath(); ctx.moveTo(gx, yF(f)); ctx.lineTo(gx + gw, yF(f)); ctx.stroke(); }
    ctx.setLineDash([]); ctx.fillStyle = col;
    ctx.fillText(label, gx + gw - 66, yF(hi) - 3);
  };
  markBand(band1Lo, band1Hi, 'rgba(199,125,255,0.85)', 'low band');
  markBand(band2Lo, band2Hi, 'rgba(255,138,30,0.85)', 'comp band');

  // Frequency axis (focused range)
  ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui';
  for (let f = VIEW_FMIN; f <= VIEW_FMAX; f += 20) {
    const y = gy + gh - ((f - VIEW_FMIN) / (VIEW_FMAX - VIEW_FMIN)) * gh;
    ctx.fillText(f + 'Hz', 2, y + 3);
  }
  drawTimeAxis(ctx, W, H, pad, t0, t1);
}

// Charts refresh fast for short ranges (where you're actively watching) and
// slower for long ranges (where the payload is large and barely changes).
function chartIntervalMs() {
  return (+el('range').value <= 6) ? 5000 : 20000;
}

let chartTimer = null;
function scheduleCharts() {
  if (chartTimer) clearInterval(chartTimer);
  chartTimer = setInterval(refreshCharts, chartIntervalMs());
}

function onControlsChange() {
  refreshTiles();
  refreshCharts();
  scheduleCharts();   // re-time the chart loop to the new range
}
el('device').addEventListener('change', () => { onControlsChange(); loadSession(); });
el('range').addEventListener('change', onControlsChange);
el('sessionBtn').addEventListener('click', toggleSession);

async function boot() {
  populateRanges();
  await loadDevices();
  await loadSession();               // pause/resume state for the selected device
  await refreshTiles();              // fast: live numbers appear immediately
  await loadNoiseSources();          // show the dB overlay panel if any sources exist
  setInterval(refreshTiles, 2000);    // live tiles + chart tips every 2 s
  setInterval(loadDevices, 30000);    // device list rarely changes
  setInterval(loadNoiseSources, 30000); // pick up newly-imported noise sources
  setInterval(loadSession, 5000);     // reflect pause state (in case toggled elsewhere)
  refreshCharts();                    // heavier: charts fill in without blocking the page
  scheduleCharts();                   // charts every 5 s / 20 s by range
}
boot();

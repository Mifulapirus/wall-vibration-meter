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
const isActive = (r) => gActiveThresh === 0 || accelMg(r) > gActiveThresh;

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
    o.textContent = d.device_id + ' (' + d.count + ')';
    sel.appendChild(o);
  }
  if (cur) sel.value = cur;
}

// Latest readings currently plotted on the line charts. Kept client-side so the
// fast poll can extend the charts live without re-fetching the whole history.
let curRows = [];

// Cheap, frequent poll: latest reading -> live tiles + live chart tips.
async function refreshTiles() {
  try {
    const d = await fetch('/api/latest?device=' + encodeURIComponent(el('device').value),
                          { cache: 'no-store' }).then(r => r.json());
    updateTiles(d);
    // Append the newest point so the velocity/frequency charts advance at the
    // same 2 s cadence as the tiles (the periodic full refresh resyncs/decimates).
    if (d && d.ts && (!curRows.length || d.ts > curRows[curRows.length - 1].ts)) {
      curRows.push(d);
      drawVelocity(curRows);
      drawBands(curRows);
      drawFreq(curRows);
    }
    setStatus('live', 'ok');
  } catch (e) {
    setStatus('error — ' + e.message, 'err');
  }
}

// Heavier poll: the full time-series + spectra (spectrogram) for the charts.
async function refreshCharts() {
  try {
    const [rows, specs] = await Promise.all([
      fetch('/api/readings?' + qs(), { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/spectra?' + qs(), { cache: 'no-store' }).then(r => r.json()),
    ]);
    curRows = rows;
    drawVelocity(rows);
    drawBands(rows);
    drawFreq(rows);
    drawSpectrogram(specs);
    el('meta').textContent = `${rows.length} readings · ${specs.length} spectra in view`;
  } catch (e) {
    setStatus('error — ' + e.message, 'err');
  }
}

// Latest band edges (for spectrogram overlay). Fall back to fw<=3 single band.
let band1Lo = 25, band1Hi = 40, band2Lo = 50, band2Hi = 65;
const COL_B1 = '#c77dff', COL_B2 = '#ff8a1e';   // low band / compressor band colours
const b1mg = (r) => (r.band1_rms_g != null ? r.band1_rms_g : r.band_rms_g || 0) * 1000;
const b2mg = (r) => (r.band2_rms_g != null ? r.band2_rms_g : 0) * 1000;

function updateTiles(d) {
  if (!d || !d.ts) { return; }
  el('vel').textContent = (d.vel_rms_mm_s ?? 0).toFixed(3);
  // Gate the dominant frequency: show "—" when this reading is just noise floor.
  const freqReal = isActive(d);
  el('freq').textContent = freqReal ? (d.dom_freq_hz ?? 0).toFixed(1) : '—';
  el('freq').style.color = freqReal ? '' : 'var(--muted)';
  el('accel').textContent = ((d.accel_rms_g ?? 0) * 1000).toFixed(1);
  el('band1').textContent = d.band1_rms_g != null ? b1mg(d).toFixed(1) : '--';
  el('band2').textContent = d.band2_rms_g != null ? b2mg(d).toFixed(1) : '--';
  if (d.band1_lo_hz) {
    band1Lo = d.band1_lo_hz; band1Hi = d.band1_hi_hz; band2Lo = d.band2_lo_hz; band2Hi = d.band2_hi_hz;
    el('band1Range').textContent = `${d.band1_lo_hz | 0}–${d.band1_hi_hz | 0} Hz`;
    el('band2Range').textContent = `${d.band2_lo_hz | 0}–${d.band2_hi_hz | 0} Hz`;
  }
  el('seen').textContent = fmtTime(d.ts);
  const z = d.zone | 0;
  const badge = el('zone');
  badge.textContent = ZONE_NAMES[z]; badge.className = 'badge z' + z;
  const tile = el('velTile');
  tile.style.borderColor = ZONE_COLORS[z];
  tile.style.boxShadow = '0 0 0 1px ' + ZONE_COLORS[z] + ', 0 0 24px -8px ' + ZONE_COLORS[z];
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

function drawVelocity(rows) {
  const c = el('velChart'), ctx = c.getContext('2d'); const W = c.width, H = c.height, pad = 40;
  ctx.clearRect(0, 0, W, H);
  if (rows.length < 2) return;
  const [t0, t1] = timeBounds(rows);
  let max = Z.z3 * 1.1;
  for (const r of rows) max = Math.max(max, r.vel_rms_mm_s || 0);
  const yOf = (v) => (H - pad) - (v / max) * (H - pad - 10);
  const xOf = (t) => pad + ((t - t0) / (t1 - t0)) * (W - pad - 10);

  // Zone bands
  const bands = [[0, Z.z1, '#21c07a'], [Z.z1, Z.z2, '#e6cc00'], [Z.z2, Z.z3, '#ff8a1e'], [Z.z3, max, '#ff4d4d']];
  for (const [lo, hi, col] of bands) { ctx.fillStyle = col + '18'; ctx.fillRect(pad, yOf(hi), W - pad - 10, yOf(lo) - yOf(hi)); }
  drawTimeAxis(ctx, W, H, pad, t0, t1);
  ctx.fillStyle = '#35a9ff'; ctx.fillText(max.toFixed(1) + ' mm/s', 2, 12); ctx.fillStyle = '#8b95a3'; ctx.fillText('0', 2, H - pad);

  ctx.strokeStyle = '#35a9ff'; ctx.lineWidth = 1.6; ctx.beginPath();
  rows.forEach((r, i) => { const x = xOf(new Date(r.ts).getTime()), y = yOf(r.vel_rms_mm_s || 0); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
}

// Two AC vibration bands over time — which type of rooftop unit is running.
function drawBands(rows) {
  const c = el('bandChart'), ctx = c.getContext('2d'); const W = c.width, H = c.height, pad = 40;
  ctx.clearRect(0, 0, W, H);
  if (rows.length < 2) return;
  const [t0, t1] = timeBounds(rows);
  let max = 1;
  for (const r of rows) max = Math.max(max, b1mg(r), b2mg(r));
  max = Math.ceil(max * 1.1);
  const yOf = (v) => (H - pad) - (v / max) * (H - pad - 10);
  const xOf = (t) => pad + ((t - t0) / (t1 - t0)) * (W - pad - 10);
  drawTimeAxis(ctx, W, H, pad, t0, t1);
  ctx.fillStyle = '#8b95a3'; ctx.fillText(max + ' mg', 2, 12); ctx.fillText('0', 2, H - pad);

  const line = (getter, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.beginPath();
    rows.forEach((r, i) => { const x = xOf(new Date(r.ts).getTime()), y = yOf(getter(r)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  };
  line(b1mg, COL_B1);   // low band (4-pole / fans)
  line(b2mg, COL_B2);   // compressor band (2-pole)
  el('band1Legend').textContent = `low band ${band1Lo | 0}–${band1Hi | 0} Hz`;
  el('band2Legend').textContent = `compressor band ${band2Lo | 0}–${band2Hi | 0} Hz`;
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
  let max = 10;
  for (const r of rows) max = Math.max(max, r.dom_freq_hz || 0);
  max = Math.ceil(max / 10) * 10;
  const yOf = (v) => (H - pad) - (v / max) * (H - pad - 10);
  const xOf = (t) => pad + ((t - t0) / (t1 - t0)) * (W - pad - 10);
  drawTimeAxis(ctx, W, H, pad, t0, t1);
  ctx.fillStyle = '#8b95a3'; ctx.fillText(max + ' Hz', 2, 12); ctx.fillText('0', 2, H - pad);

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
  const fmax = binHz * (nBins - 1);
  // Global max for normalisation (convert to mg).
  let vmax = 1e-9;
  for (const s of specs) for (let k = 1; k < s.values.length; k++) vmax = Math.max(vmax, s.values[k]);

  const gx = pad, gy = 6, gw = W - pad - 10, gh = H - pad - 6;
  const colW = Math.max(1, gw / specs.length);
  const t0 = new Date(specs[0].ts).getTime();
  const t1 = Math.max(new Date(specs[specs.length - 1].ts).getTime(), t0 + 1);

  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const x = gx + (gw * i) / specs.length;
    const n = s.values.length;
    for (let k = 1; k < n; k++) {
      const y0 = gy + gh - (k / (n - 1)) * gh;
      const y1 = gy + gh - ((k + 1) / (n - 1)) * gh;
      // log scaling makes weak lines visible
      const norm = Math.log10(1 + 9 * (s.values[k] / vmax));
      ctx.fillStyle = heat(norm);
      ctx.fillRect(x, y1, colW + 0.5, (y0 - y1) + 0.5);
    }
  }

  // Band markers: bracket each metric band on the frequency axis.
  const yF = (f) => gy + gh - (Math.min(f, fmax) / fmax) * gh;
  ctx.font = '10px system-ui'; ctx.lineWidth = 1;
  const markBand = (lo, hi, col, label) => {
    ctx.strokeStyle = col; ctx.setLineDash([6, 4]);
    for (const f of [lo, hi]) { ctx.beginPath(); ctx.moveTo(gx, yF(f)); ctx.lineTo(gx + gw, yF(f)); ctx.stroke(); }
    ctx.setLineDash([]); ctx.fillStyle = col;
    ctx.fillText(label, gx + gw - 66, yF(hi) - 3);
  };
  markBand(band1Lo, band1Hi, 'rgba(199,125,255,0.85)', 'low band');
  markBand(band2Lo, band2Hi, 'rgba(255,138,30,0.85)', 'comp band');

  // Frequency axis (right side labels)
  ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui';
  for (let f = 0; f <= fmax; f += 20) {
    const y = gy + gh - (f / fmax) * gh;
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
el('device').addEventListener('change', onControlsChange);
el('range').addEventListener('change', onControlsChange);

async function boot() {
  populateRanges();
  await loadDevices();
  await refreshCharts();              // load history first...
  await refreshTiles();              // ...then start live tips
  setInterval(refreshTiles, 2000);    // live tiles + chart tips every 2 s
  setInterval(loadDevices, 30000);    // device list rarely changes
  scheduleCharts();                   // charts every 5 s / 20 s by range
}
boot();

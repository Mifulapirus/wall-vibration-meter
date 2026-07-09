// Wall Vibration Meter dashboard — polls /api/vibration and draws the spectrum
// plus a rolling velocity history. No external libraries (device is offline).

const ZONE_COLORS = ['#21c07a', '#e6cc00', '#ff8a1e', '#ff4d4d'];
const ZONE_NAMES  = ['GOOD', 'FAIR', 'HIGH', 'SEVERE'];

const el = (id) => document.getElementById(id);
const history = [];          // {t, vel}
const HISTORY_MAX = 300;     // ~5 min at 1 Hz

function setStatus(text, cls) {
  const s = el('status');
  s.textContent = text;
  s.className = 'status ' + (cls || '');
}

async function poll() {
  try {
    const res = await fetch('/api/vibration', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d.valid) { setStatus('measuring…'); return; }
    update(d);
    setStatus('live', 'ok');
  } catch (e) {
    setStatus('offline — ' + e.message, 'err');
  }
}

function update(d) {
  el('vel').textContent   = d.vel_rms_mm_s.toFixed(3);
  el('freq').textContent  = d.dom_freq_hz.toFixed(1);
  el('accel').textContent = (d.accel_rms_g * 1000).toFixed(1);
  el('peak').textContent  = d.accel_peak_g.toFixed(3);

  const z = d.zone|0;
  const badge = el('zone');
  badge.textContent = ZONE_NAMES[z];
  badge.className = 'badge z' + z;
  const tile = el('velTile');
  tile.style.borderColor = ZONE_COLORS[z];
  tile.style.boxShadow = '0 0 0 1px ' + ZONE_COLORS[z] + ', 0 0 24px -6px ' + ZONE_COLORS[z];

  el('meta').textContent =
    `fs ${d.fs} Hz · N ${d.n} · ${d.bin_hz.toFixed(2)} Hz/bin · ` +
    `zones: <${d.z1} / <${d.z2} / <${d.z3} mm/s`;

  drawSpectrum(d);

  history.push({ vel: d.vel_rms_mm_s, z });
  if (history.length > HISTORY_MAX) history.shift();
  drawHistory(d);
}

function drawSpectrum(d) {
  const c = el('spectrum'), ctx = c.getContext('2d');
  const W = c.width, H = c.height, pad = 28;
  ctx.clearRect(0, 0, W, H);

  const spec = d.spectrum || [];
  const n = spec.length;
  if (!n) return;

  // Convert to mg for a friendly axis, find max (skip DC bin).
  let max = 1e-9;
  for (let k = 1; k < n; k++) max = Math.max(max, spec[k]);
  const maxMg = (max / 9.80665) * 1000;

  // Grid + axes
  ctx.strokeStyle = '#262d38'; ctx.fillStyle = '#8b95a3';
  ctx.font = '11px system-ui'; ctx.lineWidth = 1;
  const fmax = d.bin_hz * (n - 1);
  for (let f = 0; f <= fmax; f += 20) {
    const x = pad + (f / fmax) * (W - pad - 8);
    ctx.beginPath(); ctx.moveTo(x, 6); ctx.lineTo(x, H - pad); ctx.stroke();
    ctx.fillText(f + 'Hz', x + 2, H - pad + 14);
  }

  // Bars
  const base = H - pad;
  ctx.fillStyle = ZONE_COLORS[d.zone|0];
  for (let k = 1; k < n; k++) {
    const f = k * d.bin_hz;
    const x = pad + (f / fmax) * (W - pad - 8);
    const mg = (spec[k] / 9.80665) * 1000;
    const h = (mg / maxMg) * (base - 8);
    ctx.fillRect(x, base - h, Math.max(1, (W - pad) / n - 0.5), h);
  }

  // Dominant-frequency marker
  const xd = pad + (d.dom_freq_hz / fmax) * (W - pad - 8);
  ctx.strokeStyle = '#ffffff'; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(xd, 6); ctx.lineTo(xd, base); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#e6edf3';
  ctx.fillText(d.dom_freq_hz.toFixed(1) + ' Hz', xd + 4, 16);
  ctx.fillText('peak ' + maxMg.toFixed(1) + ' mg', pad, 16);
}

function drawHistory(d) {
  const c = el('history'), ctx = c.getContext('2d');
  const W = c.width, H = c.height, pad = 28;
  ctx.clearRect(0, 0, W, H);
  if (history.length < 2) return;

  let max = d.z3 * 1.1;
  for (const p of history) max = Math.max(max, p.vel);

  // Threshold bands
  const yOf = (v) => (H - pad) - (v / max) * (H - pad - 8);
  const bands = [[0, d.z1, '#21c07a'], [d.z1, d.z2, '#e6cc00'],
                 [d.z2, d.z3, '#ff8a1e'], [d.z3, max, '#ff4d4d']];
  for (const [lo, hi, col] of bands) {
    ctx.fillStyle = col + '18';
    ctx.fillRect(pad, yOf(hi), W - pad - 8, yOf(lo) - yOf(hi));
  }

  // Axis labels
  ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui';
  ctx.fillText(max.toFixed(1) + ' mm/s', 2, 12);
  ctx.fillText('0', 2, H - pad);

  // Line
  ctx.strokeStyle = ZONE_COLORS[d.zone|0]; ctx.lineWidth = 2;
  ctx.beginPath();
  history.forEach((p, i) => {
    const x = pad + (i / (HISTORY_MAX - 1)) * (W - pad - 8);
    const y = yOf(p.vel);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

poll();
setInterval(poll, 1000);

// Sleep-environment view: import phone/meter noise CSVs, then correlate noise
// with wall vibration against WHO sleep thresholds. Vanilla canvas, no libs.

// WHO bedroom guidance (indoor):
const DB_SLEEP = 30;   // LAeq for undisturbed sleep
const DB_EVENT = 45;   // LAmax above which awakenings occur
const VIB_PERC = 0.3;  // mm/s vibration perception threshold
const VIB_HIGH = 3.0;  // our "severe" zone

const el = (id) => document.getElementById(id);
const setStatus = (t, c) => { const s = el('status'); s.textContent = t; s.className = 'status ' + (c || ''); };
const enc = encodeURIComponent;

let currentNight = null;   // Date at local midnight of the night-start date

// ---- boot -----------------------------------------------------------------
async function boot() {
  el('tz').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  currentNight = defaultNight();

  el('importForm').addEventListener('submit', doImport);
  el('prevNight').addEventListener('click', () => { shiftNight(-1); });
  el('nextNight').addEventListener('click', () => { shiftNight(1); });
  ['device', 'source'].forEach(id => el(id).addEventListener('change', drawTimeline));
  ['nightStart', 'nightEnd'].forEach(id => el(id).addEventListener('change', () => { drawTimeline(); drawHeatmap(); }));
  ['hmMetric', 'hmDays'].forEach(id => el(id).addEventListener('change', drawHeatmap));

  await loadSelectors();
  await drawTimeline();
  await drawHeatmap();
  setStatus('ready', 'ok');
  setInterval(loadSelectors, 30000);
}

function defaultNight() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (now.getHours() < (+el('nightStart').value)) d.setDate(d.getDate() - 1);
  return d;
}
function shiftNight(days) {
  currentNight = new Date(currentNight);
  currentNight.setDate(currentNight.getDate() + days);
  drawTimeline();
}
function nightWindow(D) {
  const ns = +el('nightStart').value, ne = +el('nightEnd').value;
  const start = new Date(D); start.setHours(ns, 0, 0, 0);
  const end = new Date(D); if (ne <= ns) end.setDate(end.getDate() + 1);
  end.setHours(ne, 0, 0, 0);
  return [start, end];
}

async function loadSelectors() {
  try {
    const [devs, srcs] = await Promise.all([
      fetch('/api/devices').then(r => r.json()),
      fetch('/api/noise/sources').then(r => r.json()),
    ]);
    fillSelect('device', devs.map(d => d.device_id));
    fillSelect('source', srcs.map(s => s.source));
  } catch (e) { setStatus('error — ' + e.message, 'err'); }
}
function fillSelect(id, values) {
  const sel = el(id), cur = sel.value;
  sel.innerHTML = values.length ? '' : '<option value="">(none yet)</option>';
  values.forEach(v => { const o = document.createElement('option'); o.value = o.textContent = v; sel.appendChild(o); });
  if (cur && values.includes(cur)) sel.value = cur;
}

// ---- CSV import -----------------------------------------------------------
async function doImport(ev) {
  ev.preventDefault();
  const file = el('csv').files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  fd.append('source', el('src').value || 'noise');
  fd.append('tz', el('tz').value || 'UTC');
  el('importResult').textContent = 'importing…';
  try {
    const res = await fetch('/api/import/noise', { method: 'POST', body: fd });
    const d = await res.json();
    if (!d.ok) {
      el('importResult').textContent = 'failed: ' + (d.error || res.status) +
        (d.headers ? ' [cols: ' + d.headers.join(', ') + ']' : '');
      return;
    }
    el('importResult').textContent =
      `imported ${d.imported} rows (skipped ${d.skipped}) · ${d.columns.time} / ${d.columns.level}`;
    await loadSelectors();
    el('source').value = d.source;
    drawTimeline(); drawHeatmap();
  } catch (e) {
    el('importResult').textContent = 'error: ' + e.message;
  }
}

// ---- shared drawing helpers ----------------------------------------------
function clear(c) { const x = c.getContext('2d'); x.clearRect(0, 0, c.width, c.height); return x; }

// ---- combined night timeline ---------------------------------------------
async function drawTimeline() {
  const [start, end] = nightWindow(currentNight);
  el('nightLabel').textContent =
    `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} → ` +
    `${end.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;

  const dev = el('device').value, src = el('source').value;
  const q = `from=${enc(start.toISOString())}&to=${enc(end.toISOString())}`;
  let noise = [], vib = [];
  try {
    [noise, vib] = await Promise.all([
      src ? fetch(`/api/noise?source=${enc(src)}&${q}`).then(r => r.json()) : [],
      dev ? fetch(`/api/readings?device=${enc(dev)}&${q}&limit=4000`).then(r => r.json()) : [],
    ]);
  } catch (e) { setStatus('error — ' + e.message, 'err'); return; }

  const c = el('timeline'), ctx = clear(c), W = c.width, H = c.height;
  const padL = 46, padR = 48, padB = 26, padT = 12;
  const t0 = start.getTime(), t1 = end.getTime();
  const xOf = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);

  // night background
  ctx.fillStyle = '#0b0e18'; ctx.fillRect(padL, padT, W - padL - padR, H - padT - padB);

  // dB (left) axis scale
  let dbMax = 75; noise.forEach(n => dbMax = Math.max(dbMax, (n.lamax ?? n.spl_db ?? 0) + 4));
  const dbMin = 20;
  const yDb = (v) => (H - padB) - ((v - dbMin) / (dbMax - dbMin)) * (H - padT - padB);
  // mm/s (right) axis scale
  let vMax = VIB_HIGH + 0.4; vib.forEach(r => vMax = Math.max(vMax, (r.vel_rms_mm_s ?? 0) * 1.1));
  const yV = (v) => (H - padB) - (v / vMax) * (H - padT - padB);

  // hour gridlines + labels
  ctx.strokeStyle = '#20283a'; ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui'; ctx.lineWidth = 1;
  for (let t = new Date(start); t <= end; t.setHours(t.getHours() + 1)) {
    if (t.getHours() % 2) continue;
    const x = xOf(t.getTime());
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
    ctx.fillText(String(t.getHours()).padStart(2, '0'), x + 2, H - padB + 13);
  }

  // WHO threshold lines (left/dB axis)
  const dashLine = (y, col, lbl) => {
    ctx.strokeStyle = col; ctx.setLineDash([5, 4]); ctx.beginPath();
    ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = col; ctx.fillText(lbl, padL + 4, y - 3);
  };
  dashLine(yDb(DB_EVENT), '#ff4d4d', '45 dB');
  dashLine(yDb(DB_SLEEP), '#e6cc00', '30 dB');

  // dB axis ticks
  ctx.fillStyle = '#8b95a3';
  for (let v = dbMin; v <= dbMax; v += 10) ctx.fillText(v + '', 4, yDb(v) + 3);
  ctx.save(); ctx.fillStyle = '#35a9ff'; ctx.fillText('dB', 4, padT + 2); ctx.restore();
  ctx.fillStyle = '#ff8a1e'; ctx.fillText('mm/s', W - padR + 6, padT + 2);
  for (let i = 0; i <= 2; i++) { const v = vMax * i / 3; ctx.fillStyle = '#8b95a3'; ctx.fillText(v.toFixed(1), W - padR + 6, yV(v) + 3); }

  // noise: shade area above 45 dB, then draw line
  if (noise.length) {
    ctx.fillStyle = 'rgba(255,77,77,0.16)';
    noise.forEach((n, i) => {
      const v = n.spl_db; if (v == null || v <= DB_EVENT) return;
      const x = xOf(new Date(n.ts).getTime());
      ctx.fillRect(x - 1, yDb(v), 2, yDb(DB_EVENT) - yDb(v));
    });
    ctx.strokeStyle = '#35a9ff'; ctx.lineWidth = 1.4; ctx.beginPath();
    noise.forEach((n, i) => { const x = xOf(new Date(n.ts).getTime()), y = yDb(n.spl_db ?? dbMin); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }
  // vibration line (right axis)
  if (vib.length) {
    ctx.strokeStyle = '#ff8a1e'; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.9; ctx.beginPath();
    vib.forEach((r, i) => { const x = xOf(new Date(r.ts).getTime()), y = yV(r.vel_rms_mm_s ?? 0); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  if (!noise.length && !vib.length) {
    ctx.fillStyle = '#8b95a3'; ctx.fillText('no data for this night — import a noise CSV or pick another night', padL + 8, H / 2);
  }

  el('nightStats').innerHTML = statTiles(noise, vib, start, end);
  setStatus('live', 'ok');
}

// energy+time-weighted stats over the noise/vibration window
function statTiles(noise, vib, start, end) {
  const tiles = [];
  if (noise.length) {
    let e = 0, dur = 0, over = 0, peak = 0, events = 0, inEv = false;
    for (let i = 0; i < noise.length; i++) {
      const v = noise[i].spl_db; if (v == null) continue;
      const t = new Date(noise[i].ts).getTime();
      const tn = i + 1 < noise.length ? new Date(noise[i + 1].ts).getTime() : t;
      const d = Math.min(Math.max(tn - t, 0), 120000); // cap gaps at 2 min
      e += Math.pow(10, v / 10) * d; dur += d;
      if (v > DB_EVENT) over += d;
      peak = Math.max(peak, noise[i].lamax ?? v);
      if (!inEv && v >= DB_EVENT) { events++; inEv = true; } else if (inEv && v < DB_EVENT - 5) inEv = false;
    }
    const laeq = dur ? 10 * Math.log10(e / dur) : 0;
    const verdict = (laeq > DB_SLEEP + 5 || over > 0) ? 'FAIL' : 'ok';
    tiles.push(stat('Peak noise', peak.toFixed(0) + ' dB', peak > DB_EVENT ? 'z3' : 'z0'));
    tiles.push(stat('LAeq night', laeq.toFixed(0) + ' dB', laeq > 40 ? 'z2' : laeq > DB_SLEEP ? 'z1' : 'z0'));
    tiles.push(stat('Time > 45 dB', fmtDur(over), over > 0 ? 'z3' : 'z0'));
    tiles.push(stat('Loud events', String(events), events ? 'z2' : 'z0'));
    tiles.push(stat('Verdict', verdict, verdict === 'FAIL' ? 'z3' : 'z0'));
  }
  if (vib.length) {
    let pv = 0; vib.forEach(r => pv = Math.max(pv, r.vel_rms_mm_s ?? 0));
    tiles.push(stat('Peak vibration', pv.toFixed(2) + ' mm/s', pv > VIB_HIGH ? 'z3' : pv > VIB_PERC ? 'z1' : 'z0'));
  }
  return tiles.join('');
}
const stat = (label, val, z) => `<div class="stat ${z}"><div class="sv">${val}</div><div class="sl">${label}</div></div>`;
function fmtDur(ms) { const m = Math.round(ms / 60000); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }

// ---- multi-night heatmap --------------------------------------------------
function heatColor(metric, v) {
  if (v == null) return null;
  let stops;
  if (metric === 'vibration') stops = [[0, [20, 30, 45]], [VIB_PERC, [33, 120, 90]], [1, [230, 200, 0]], [VIB_HIGH, [255, 77, 77]]];
  else stops = [[25, [20, 30, 45]], [DB_SLEEP, [33, 150, 110]], [DB_EVENT, [230, 200, 0]], [60, [255, 138, 30]], [75, [255, 60, 60]]];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) if (v >= stops[i][0] && v <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
  if (v <= stops[0][0]) return `rgb(${stops[0][1].join(',')})`;
  if (v >= hi[0]) return `rgb(${hi[1].join(',')})`;
  const f = (v - lo[0]) / (hi[0] - lo[0]);
  const c = lo[1].map((a, k) => Math.round(a + (hi[1][k] - a) * f));
  return `rgb(${c.join(',')})`;
}

async function drawHeatmap() {
  const metric = el('hmMetric').value;
  const days = +el('hmDays').value;
  const bucket = 15;
  const offset = -new Date().getTimezoneOffset();  // minutes east of UTC
  const dev = el('device').value, src = el('source').value;
  const srcParam = metric === 'vibration' ? (dev ? `&device=${enc(dev)}` : '') : (src ? `&source=${enc(src)}` : '');
  let data;
  try {
    data = await fetch(`/api/heatmap?metric=${metric}&days=${days}&bucket=${bucket}&offset=${offset}${srcParam}`).then(r => r.json());
  } catch (e) { setStatus('error — ' + e.message, 'err'); return; }

  // Stitch per-calendar-date rows into per-night rows (evening D + morning D+1).
  const byDate = {}; data.days.forEach(d => byDate[d.date] = d.values);
  const perBucket = 60 / bucket;
  const ns = +el('nightStart').value, ne = +el('nightEnd').value;
  const startCol = ns * perBucket;
  const endCol = (ne <= ns ? ne : ne) * perBucket;        // morning cols on D+1
  const nightCols = (data.cols - startCol) + endCol;

  // Server keys days by the viewer's LOCAL date (offset applied), so match with
  // local Y-M-D strings — never toISOString(), which is UTC and shifts the date.
  const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dates = Object.keys(byDate).sort();
  const nights = [];
  if (dates.length) {
    const first = new Date(dates[0] + 'T00:00:00');
    const last = new Date(dates[dates.length - 1] + 'T00:00:00');
    for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
      const dk = ymdLocal(d);
      const nk = new Date(d); nk.setDate(nk.getDate() + 1);
      const dk2 = ymdLocal(nk);
      const ev = byDate[dk] || [], mo = byDate[dk2] || [];
      const row = [];
      for (let col = startCol; col < data.cols; col++) row.push(ev[col] ?? null);
      for (let col = 0; col < endCol; col++) row.push(mo[col] ?? null);
      if (row.some(v => v != null)) nights.push({ label: dk, row });
    }
  }

  const c = el('heatmap'), ctx = clear(c), W = c.width, H = c.height;
  const padL = 62, padB = 22, padT = 8, padR = 10;
  const gw = W - padL - padR, gh = H - padT - padB;
  ctx.fillStyle = '#0b0e12'; ctx.fillRect(padL, padT, gw, gh);
  if (!nights.length) { ctx.fillStyle = '#8b95a3'; ctx.font = '12px system-ui'; ctx.fillText('no ' + metric + ' data yet', padL + 8, H / 2); drawHmLegend(metric); return; }

  const rowH = gh / nights.length, colW = gw / nightCols;
  nights.forEach((n, r) => {
    const y = padT + r * rowH;
    n.row.forEach((v, cx) => { const col = heatColor(metric, v); if (col) { ctx.fillStyle = col; ctx.fillRect(padL + cx * colW, y, colW + 0.5, rowH + 0.5); } });
    ctx.fillStyle = '#8b95a3'; ctx.font = '10px system-ui';
    ctx.fillText(new Date(n.label + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' }), 4, y + rowH / 2 + 3);
  });
  // hour labels along bottom
  ctx.fillStyle = '#8b95a3'; ctx.font = '10px system-ui';
  for (let i = 0; i <= nightCols; i += 2 * perBucket) {
    const hr = ((ns + i / perBucket) % 24);
    ctx.fillText(String(hr).padStart(2, '0'), padL + i * colW - 4, H - padB + 13);
  }
  drawHmLegend(metric);
  el('meta').textContent = `${nights.length} nights · ${metric} · peak per ${bucket} min`;
}

function drawHmLegend(metric) {
  const L = el('hmLegend');
  const marks = metric === 'vibration' ? [0, VIB_PERC, 1, 2, VIB_HIGH] : [25, DB_SLEEP, DB_EVENT, 60, 75];
  const unit = metric === 'vibration' ? ' mm/s' : ' dB';
  L.innerHTML = 'peak: ' + marks.map(v =>
    `<span><i class="sw" style="background:${heatColor(metric, v)}"></i>${v}${unit}</span>`).join(' ');
}

boot();

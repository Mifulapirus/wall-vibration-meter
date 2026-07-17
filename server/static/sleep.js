// Sleep-environment view: import phone/meter noise CSVs, then correlate noise
// with wall vibration against WHO sleep thresholds. Vanilla canvas, no libs.

// WHO bedroom guidance (indoor):
const DB_SLEEP = 30;   // LAeq for undisturbed sleep
const DB_EVENT = 45;   // LAmax above which awakenings occur
// AC-compressor vibration is tonal at 58-120 Hz; SNR (dominant peak vs noise
// floor) tracks it honestly, unlike mm/s velocity which de-weights those
// frequencies by ~1/f and badly under-represents what you feel/hear.
const AC_SNR_ON  = 10;   // "audibly disruptive" threshold (noise-calibrated; matches dashboard)
const AC_SNR_OFF = 7;    // hysteresis so a steady unit doesn't blink on/off
const SNR_STRONG = 20;   // clearly strong coupling (heatmap color midpoint)

const el = (id) => document.getElementById(id);
const setStatus = (t, c) => { const s = el('status'); s.textContent = t; s.className = 'status ' + (c || ''); };
const enc = encodeURIComponent;

// Noise sources are plotted with app-wide consistent colours (matching /compare
// and the dashboard). The vibration SNR trace is violet here so it doesn't clash
// with DSL's orange on the shared timeline.
const NOISE_COLORS = { DSL: '#ff8a1e' };   // known colours; other sources get a fallback
const NOISE_FALLBACK = ['#4dd0e1', '#e879f9', '#ff6f91', '#9ccc65'];
const VIB_COL = '#b98cff';
let noiseColor = {};   // source -> css colour

function selectedSources() {
  const box = el('sources');
  return box ? [...box.querySelectorAll('input:checked')].map(i => i.value) : [];
}
// The source whose stats/heatmap represent the night — DSL (the connected meter)
// when it's shown, else the first selected source.
function primarySource() { const s = selectedSources(); return s.find(x => x.startsWith('DSL-')) || s[0] || ''; }

function renderSourcePicks(names) {
  const box = el('sources');
  const prev = selectedSources();
  if (!names.length) { box.innerHTML = '<span class="dim">(none yet)</span>'; return; }
  box.innerHTML = '';
  names.forEach((n, i) => {
    noiseColor[n] = NOISE_COLORS[n] || NOISE_FALLBACK[i % NOISE_FALLBACK.length];
    const lab = document.createElement('label'); lab.className = 'srcpick';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = n;
    cb.checked = prev.length ? prev.includes(n) : true;   // default: all on
    cb.addEventListener('change', () => { drawTimeline(); drawHeatmap(); });
    const sw = document.createElement('i'); sw.className = 'sw'; sw.style.background = noiseColor[n];
    lab.append(cb, sw, document.createTextNode(n));
    box.appendChild(lab);
  });
}

let currentNight = null;   // Date at local midnight of the night-start date

// ---- boot -----------------------------------------------------------------
async function boot() {
  el('tz').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  currentNight = defaultNight();

  el('importForm').addEventListener('submit', doImport);
  el('prevNight').addEventListener('click', () => { shiftNight(-1); });
  el('nextNight').addEventListener('click', () => { shiftNight(1); });
  el('device').addEventListener('change', () => { drawTimeline(); drawHeatmap(); });
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
    renderSourcePicks(srcs.map(s => s.source));
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
    const cb = [...el('sources').querySelectorAll('input')].find(i => i.value === d.source);
    if (cb) cb.checked = true;   // show the just-imported source
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

  const dev = el('device').value;
  const srcs = selectedSources();
  const q = `from=${enc(start.toISOString())}&to=${enc(end.toISOString())}`;
  let noiseBySrc = {}, vib = [];
  try {
    const [noiseArrs, vibArr] = await Promise.all([
      Promise.all(srcs.map(s => fetch(`/api/noise?source=${enc(s)}&${q}`).then(r => r.json()).then(d => [s, d]))),
      dev ? fetch(`/api/readings?device=${enc(dev)}&${q}&limit=4000`).then(r => r.json()) : Promise.resolve([]),
    ]);
    noiseBySrc = Object.fromEntries(noiseArrs);
    vib = vibArr;
  } catch (e) { setStatus('error — ' + e.message, 'err'); return; }
  // Primary source drives the WHO shading + night stats: DSL (the connected
  // meter) when shown, else the first selected source.
  const primary = srcs.find(x => x.startsWith('DSL-')) || srcs[0];
  const noise = primary ? (noiseBySrc[primary] || []) : [];
  const anyNoise = Object.values(noiseBySrc).some(a => a.length);

  const c = el('timeline'), ctx = clear(c), W = c.width, H = c.height;
  const padL = 46, padR = 48, padB = 26, padT = 12;
  const t0 = start.getTime(), t1 = end.getTime();
  const xOf = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);

  // night background
  ctx.fillStyle = '#0b0e18'; ctx.fillRect(padL, padT, W - padL - padR, H - padT - padB);

  // "AC compressor running" shading (SNR hysteresis: on >=3, off <2.2) drawn
  // behind everything, so a night shows at a glance WHEN the annoying tonal
  // vibration was actually present.
  if (vib.length) {
    ctx.fillStyle = 'rgba(33,192,122,0.16)';
    let spanStart = null, running = false;
    const flushV = (x) => { if (spanStart != null) { ctx.fillRect(spanStart, padT, Math.max(1, x - spanStart), H - padT - padB); spanStart = null; } };
    vib.forEach(r => {
      const x = xOf(new Date(r.ts).getTime()), s = r.snr;
      if (s != null) {
        if (!running && s >= AC_SNR_ON) running = true;
        else if (running && s < AC_SNR_OFF) running = false;
      }
      if (running) { if (spanStart == null) spanStart = x; } else flushV(x);
    });
    flushV(xOf(t1));
  }

  // dB (left) axis scale — fit to every shown source
  let dbMax = 75;
  Object.values(noiseBySrc).forEach(arr => arr.forEach(n => dbMax = Math.max(dbMax, (n.lamax ?? n.spl_db ?? 0) + 4)));
  const dbMin = 20;
  const yDb = (v) => (H - padB) - ((v - dbMin) / (dbMax - dbMin)) * (H - padT - padB);
  // SNR (right) axis scale — auto-scales to the night's peak, floor of 6x
  let sMax = AC_SNR_ON * 2; vib.forEach(r => sMax = Math.max(sMax, r.snr ?? 0));
  sMax = Math.ceil(sMax / 5) * 5;
  const yS = (v) => (H - padB) - (Math.min(v, sMax) / sMax) * (H - padT - padB);

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
  ctx.fillStyle = VIB_COL; ctx.fillText('SNR', W - padR + 6, padT + 2);
  for (let i = 0; i <= 3; i++) { const v = sMax * i / 3; ctx.fillStyle = '#8b95a3'; ctx.fillText(v.toFixed(0) + '×', W - padR + 6, yS(v) + 3); }

  // noise: shade the PRIMARY source's area above 45 dB (so a night's exceedances
  // pop without every source shading over each other), then draw each source's
  // dB line in its own colour.
  if (noise.length) {
    ctx.fillStyle = 'rgba(255,77,77,0.16)';
    noise.forEach((n) => {
      const v = n.spl_db; if (v == null || v <= DB_EVENT) return;
      const x = xOf(new Date(n.ts).getTime());
      ctx.fillRect(x - 1, yDb(v), 2, yDb(DB_EVENT) - yDb(v));
    });
  }
  srcs.forEach(s => {
    const arr = noiseBySrc[s]; if (!arr || !arr.length) return;
    ctx.strokeStyle = noiseColor[s] || '#35a9ff'; ctx.lineWidth = s === 'Average' ? 2.1 : 1.4;
    ctx.beginPath(); let started = false;
    arr.forEach(n => {
      if (n.spl_db == null) { started = false; return; }
      const x = xOf(new Date(n.ts).getTime()), y = yDb(n.spl_db);
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
    });
    ctx.stroke();
  });
  // vibration = compressor SNR (right axis). The dashed line marks the "AC on"
  // threshold; the trace breaks where a reading has no SNR.
  if (vib.length) {
    const yThr = yS(AC_SNR_ON);
    ctx.strokeStyle = 'rgba(33,192,122,0.55)'; ctx.setLineDash([4, 4]); ctx.beginPath();
    ctx.moveTo(padL, yThr); ctx.lineTo(W - padR, yThr); ctx.stroke(); ctx.setLineDash([]);

    ctx.strokeStyle = VIB_COL; ctx.lineWidth = 1.3; ctx.globalAlpha = 0.95; ctx.beginPath();
    let started = false;
    vib.forEach(r => {
      if (r.snr == null) { started = false; return; }
      const x = xOf(new Date(r.ts).getTime()), y = yS(r.snr);
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
    });
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  if (!anyNoise && !vib.length) {
    ctx.fillStyle = '#8b95a3'; ctx.fillText('no data for this night — import a noise CSV or pick another night', padL + 8, H / 2);
  }

  el('nightStats').innerHTML = statTiles(noise, vib, start, end);
  addFusionTiles(start, end, dev);
  drawStrength(vib, start, end);
  setStatus('live', 'ok');
}

// Fused sound+vibration metrics for this night (server /api/fusion) from the
// single DSL meter: the compressor's on-vs-off dB contribution and its duty
// cycle — correlating the vibration compressor detector with the sound level.
async function addFusionTiles(start, end, dev) {
  try {
    const q = `from=${enc(start.toISOString())}&to=${enc(end.toISOString())}` +
              `${dev ? `&device=${enc(dev)}` : ''}&asource=DSL-A&csource=DSL-C`;
    const d = await fetch(`/api/fusion?${q}`).then(r => r.json());
    const S = d.sound && d.sound.DSL, comp = d.compressor;
    const extra = [];
    if (comp && comp.duty_pct != null)
      extra.push(stat('AC duty', Math.round(comp.duty_pct) + '%', comp.duty_pct > 50 ? 'z3' : comp.duty_pct > 0 ? 'z1' : 'z0'));
    if (S && S.delta_leq != null)
      extra.push(stat('AC adds (dBC)', '+' + S.delta_leq.toFixed(1) + ' dB', S.delta_leq >= 6 ? 'z2' : 'z0'));
    if (extra.length) el('nightStats').insertAdjacentHTML('beforeend', extra.join(''));
  } catch (e) { /* fusion is best-effort; night tiles already rendered */ }
}

// Dominant-tone amplitude (mg) over the night — the physical strength of the
// compressor vibration, on its own axis so the timeline stays readable. Shares
// the night window and the same "compressor running" shading for alignment.
const domMg = (r) => (r.dom_amp_ms2 != null ? r.dom_amp_ms2 / 9.80665 * 1000 : null);
function drawStrength(vib, start, end) {
  const c = el('strength'); if (!c) return;
  const ctx = clear(c), W = c.width, H = c.height;
  const padL = 46, padR = 48, padB = 26, padT = 12;
  const t0 = start.getTime(), t1 = end.getTime();
  const xOf = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);

  ctx.fillStyle = '#0b0e18'; ctx.fillRect(padL, padT, W - padL - padR, H - padT - padB);

  // same "AC running" shading (SNR hysteresis) so it lines up with the timeline
  if (vib.length) {
    ctx.fillStyle = 'rgba(33,192,122,0.16)';
    let spanStart = null, running = false;
    const flushV = (x) => { if (spanStart != null) { ctx.fillRect(spanStart, padT, Math.max(1, x - spanStart), H - padT - padB); spanStart = null; } };
    vib.forEach(r => {
      const x = xOf(new Date(r.ts).getTime()), s = r.snr;
      if (s != null) { if (!running && s >= AC_SNR_ON) running = true; else if (running && s < AC_SNR_OFF) running = false; }
      if (running) { if (spanStart == null) spanStart = x; } else flushV(x);
    });
    flushV(xOf(t1));
  }

  // mg axis — auto-scale to the night's peak, floor of 4 mg, round to even
  let mMax = 4; vib.forEach(r => { const m = domMg(r); if (m != null) mMax = Math.max(mMax, m); });
  mMax = Math.ceil(mMax / 2) * 2;
  const yM = (v) => (H - padB) - (Math.min(v, mMax) / mMax) * (H - padT - padB);

  // hour gridlines + labels
  ctx.strokeStyle = '#20283a'; ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui'; ctx.lineWidth = 1;
  for (let t = new Date(start); t <= end; t.setHours(t.getHours() + 1)) {
    if (t.getHours() % 2) continue;
    const x = xOf(t.getTime());
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
    ctx.fillText(String(t.getHours()).padStart(2, '0'), x + 2, H - padB + 13);
  }
  // y ticks + unit
  ctx.fillStyle = '#8b95a3';
  for (let i = 0; i <= 2; i++) { const v = mMax * i / 2; ctx.fillText(v.toFixed(0), 6, yM(v) + 3); }
  ctx.fillStyle = '#ffd24a'; ctx.fillText('mg', 6, padT + 2);

  if (!vib.length) { ctx.fillStyle = '#8b95a3'; ctx.font = '12px system-ui'; ctx.fillText('no vibration data for this night', padL + 8, H / 2); return; }

  // filled area under the mg curve, then the line on top
  ctx.fillStyle = 'rgba(255,210,74,0.16)';
  let open = false;
  vib.forEach(r => {
    const m = domMg(r);
    const x = xOf(new Date(r.ts).getTime());
    if (m == null) { if (open) { ctx.lineTo(x, H - padB); ctx.closePath(); ctx.fill(); open = false; } return; }
    const y = yM(m);
    if (!open) { ctx.beginPath(); ctx.moveTo(x, H - padB); ctx.lineTo(x, y); open = true; }
    else ctx.lineTo(x, y);
  });
  if (open) { ctx.lineTo(xOf(new Date(vib[vib.length - 1].ts).getTime()), H - padB); ctx.closePath(); ctx.fill(); }

  ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 1.3; ctx.beginPath(); let started = false;
  vib.forEach(r => {
    const m = domMg(r);
    if (m == null) { started = false; return; }
    const x = xOf(new Date(r.ts).getTime()), y = yM(m);
    started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
  });
  ctx.stroke();
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
    // Peak SNR + how much of the night a compressor was actually running.
    let peakSnr = 0, onMs = 0, running = false;
    for (let i = 0; i < vib.length; i++) {
      const s = vib[i].snr; if (s == null) continue;
      peakSnr = Math.max(peakSnr, s);
      if (!running && s >= AC_SNR_ON) running = true;
      else if (running && s < AC_SNR_OFF) running = false;
      if (running) {
        const t = new Date(vib[i].ts).getTime();
        const tn = i + 1 < vib.length ? new Date(vib[i + 1].ts).getTime() : t;
        onMs += Math.min(Math.max(tn - t, 0), 120000); // cap gaps at 2 min
      }
    }
    let peakMg = 0; vib.forEach(r => { const m = domMg(r); if (m != null) peakMg = Math.max(peakMg, m); });
    tiles.push(stat('Peak SNR', peakSnr.toFixed(0) + '×', peakSnr > SNR_STRONG ? 'z3' : peakSnr > AC_SNR_ON ? 'z1' : 'z0'));
    tiles.push(stat('Peak tone', peakMg.toFixed(1) + ' mg', peakSnr > SNR_STRONG ? 'z2' : 'z0'));
    tiles.push(stat('AC on-time', fmtDur(onMs), onMs > 3 * 3600000 ? 'z3' : onMs > 0 ? 'z1' : 'z0'));
  }
  return tiles.join('');
}
const stat = (label, val, z) => `<div class="stat ${z}"><div class="sv">${val}</div><div class="sl">${label}</div></div>`;
function fmtDur(ms) { const m = Math.round(ms / 60000); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }

// ---- multi-night heatmap --------------------------------------------------
function heatColor(metric, v) {
  if (v == null) return null;
  let stops;
  if (metric === 'vibration') stops = [[0, [20, 30, 45]], [AC_SNR_ON, [33, 120, 90]], [SNR_STRONG, [230, 200, 0]], [30, [255, 77, 77]]];
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
  const dev = el('device').value, src = primarySource();
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
  const marks = metric === 'vibration' ? [0, 5, AC_SNR_ON, SNR_STRONG, 30] : [25, DB_SLEEP, DB_EVENT, 60, 75];
  const unit = metric === 'vibration' ? '×' : ' dB';
  L.innerHTML = 'peak: ' + marks.map(v =>
    `<span><i class="sw" style="background:${heatColor(metric, v)}"></i>${v}${unit}</span>`).join(' ');
}

boot();

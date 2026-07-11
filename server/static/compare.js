// Coordinated Sound — compare two independent meters (TAS vs DSL).
// Upload each meter's log, cross-correlate a shared ~1 kHz alignment tone to line
// up their clocks, then overlay both + an energy-averaged series, quantify how
// well they agree, and publish the aligned series to the dashboard/sleep views.
// Vanilla canvas, no libs — matches the rest of the app.

const el = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const setStatus = (t, c) => { const s = el('status'); s.textContent = t; s.className = 'status ' + (c || ''); };

const COL = { tas: '#35a9ff', dsl: '#ff8a1e', avg: '#21c07a', diff: '#c77dff' };
const vis = { tas: true, dsl: true, avg: true };   // legend toggles

let tas = [];        // [{t: ms, db, max}] — raw (TAS is the time reference)
let dsl = [];        // [{t: ms, db, max}] — raw, before offset is applied
let offsetSec = 0;   // seconds added to every DSL timestamp to match TAS
let corr = null;     // {lag, r, n} from the last auto-align

// ---- parsing --------------------------------------------------------------
async function parseOne(input, tz) {
  const f = input.files[0];
  if (!f) return null;
  const fd = new FormData();
  fd.append('file', f);
  fd.append('tz', tz);
  const d = await fetch('/api/coord/parse', { method: 'POST', body: fd }).then(r => r.json());
  if (!d.ok) throw new Error(`${f.name}: ${d.error || 'parse failed'}`);
  return d.series.map(p => ({ t: new Date(p.ts).getTime(), db: p.db, max: p.max }))
                 .filter(p => Number.isFinite(p.db))
                 .sort((a, b) => a.t - b.t);
}

async function analyze() {
  const tz = el('tz').value || 'UTC';
  if (!el('tasFile').files[0] || !el('dslFile').files[0]) {
    el('parseResult').textContent = 'pick both a TAS and a DSL file first'; return;
  }
  el('parseResult').textContent = 'parsing…';
  try {
    [tas, dsl] = await Promise.all([parseOne(el('tasFile'), tz), parseOne(el('dslFile'), tz)]);
    el('parseResult').textContent = `TAS ${tas.length} pts · DSL ${dsl.length} pts`;
    ['alignPanel', 'overlayPanel', 'agreePanel', 'savePanel'].forEach(id => el(id).style.display = '');
    autoAlign();       // seed a sensible offset, then draw everything
    setStatus('analyzed', 'ok');
  } catch (e) {
    el('parseResult').textContent = 'error — ' + e.message;
    setStatus('error', 'err');
  }
}

// ---- alignment ------------------------------------------------------------
function pearson(xs, ys) {
  const n = xs.length; if (n < 2) return -2;
  let sx = 0, sy = 0; for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; cov += a * b; vx += a * a; vy += b * b; }
  return (vx && vy) ? cov / Math.sqrt(vx * vy) : -2;
}

// Best integer-second lag to add to DSL so its level track lines up with TAS.
// Pearson r is bias/scale invariant, so a constant dB offset between the meters
// doesn't fool it — it locks onto the shared tone/envelope shape.
function bestLag() {
  const tmap = new Map();
  tas.forEach(p => tmap.set(Math.round(p.t / 1000), p.db));
  const dsec = dsl.map(p => ({ s: Math.round(p.t / 1000), db: p.db }));
  let best = { lag: 0, r: -2, n: 0 };
  for (let lag = -30; lag <= 30; lag++) {
    const xs = [], ys = [];
    dsec.forEach(d => { const v = tmap.get(d.s + lag); if (v != null) { xs.push(v); ys.push(d.db); } });
    if (xs.length < 5) continue;
    const r = pearson(xs, ys);
    if (r > best.r) best = { lag, r, n: xs.length };
  }
  return best;
}

function autoAlign() {
  corr = bestLag();
  offsetSec = corr.lag;
  el('offset').value = offsetSec;
  redraw();
}

// DSL with the current offset applied (a fresh shifted copy).
const dslAligned = () => dsl.map(p => ({ t: p.t + offsetSec * 1000, db: p.db, max: p.max }));

// ---- combined series (energy average on a 1 s grid) -----------------------
const eMean = (arr) => 10 * Math.log10(arr.reduce((s, v) => s + Math.pow(10, v / 10), 0) / arr.length);
function averaged() {
  const t = new Map(); tas.forEach(p => t.set(Math.round(p.t / 1000), p.db));
  const d = new Map(); dslAligned().forEach(p => d.set(Math.round(p.t / 1000), p.db));
  const secs = [...new Set([...t.keys(), ...d.keys()])].sort((a, b) => a - b);
  return secs.map(s => {
    const v = []; if (t.has(s)) v.push(t.get(s)); if (d.has(s)) v.push(d.get(s));
    return { t: s * 1000, db: eMean(v) };
  });
}

// Paired samples (same aligned second in both meters) — for agreement stats.
function pairs() {
  const t = new Map(); tas.forEach(p => t.set(Math.round(p.t / 1000), p.db));
  const out = [];
  dslAligned().forEach(p => { const s = Math.round(p.t / 1000); if (t.has(s)) out.push({ s, tas: t.get(s), dsl: p.db }); });
  return out.sort((a, b) => a.s - b.s);
}

// ---- shared chart helpers -------------------------------------------------
function clearC(c) { const x = c.getContext('2d'); x.clearRect(0, 0, c.width, c.height); return x; }
function tickTimes(ctx, x0, x1, t0, t1, yBase) {
  ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui'; ctx.strokeStyle = '#20283a'; ctx.lineWidth = 1;
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const x = x0 + (i / n) * (x1 - x0);
    ctx.beginPath(); ctx.moveTo(x, 8); ctx.lineTo(x, yBase); ctx.stroke();
    const d = new Date(t0 + (i / n) * (t1 - t0));
    ctx.fillText(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), x + 2, yBase + 14);
  }
}
// Second of the strongest level within the first 25 s — the alignment tone.
function tonePeak(series) {
  if (!series.length) return null;
  const t0 = series[0].t, win = series.filter(p => p.t - t0 <= 25000);
  return win.reduce((m, p) => p.db > m.db ? p : m, win[0]);
}

// ---- overlay chart --------------------------------------------------------
function drawOverlay() {
  const c = el('overlay'), ctx = clearC(c), W = c.width, H = c.height;
  const padL = 42, padR = 12, padT = 10, padB = 26;
  const da = dslAligned(), av = averaged();
  const all = [...(vis.tas ? tas : []), ...(vis.dsl ? da : []), ...(vis.avg ? av : [])];
  if (!all.length) return;
  const t0 = Math.min(...all.map(p => p.t)), t1 = Math.max(...all.map(p => p.t)) + 1;
  let dbMax = 0, dbMin = 999;
  all.forEach(p => { dbMax = Math.max(dbMax, p.db); dbMin = Math.min(dbMin, p.db); });
  dbMax = Math.ceil((dbMax + 3) / 5) * 5; dbMin = Math.floor((dbMin - 3) / 5) * 5;
  const xOf = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
  const yOf = (v) => (H - padB) - ((v - dbMin) / (dbMax - dbMin)) * (H - padT - padB);

  ctx.fillStyle = '#0b0e18'; ctx.fillRect(padL, padT, W - padL - padR, H - padT - padB);
  tickTimes(ctx, padL, W - padR, t0, t1, H - padB);
  ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui';
  for (let v = dbMin; v <= dbMax; v += 10) ctx.fillText(v + ' dB', 4, yOf(v) + 3);

  const line = (series, col, w) => {
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath();
    series.forEach((p, i) => { const x = xOf(p.t), y = yOf(p.db); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  };
  if (vis.avg) line(av, COL.avg, 2.4);
  if (vis.tas) line(tas, COL.tas, 1.5);
  if (vis.dsl) line(da, COL.dsl, 1.5);

  // tone-peak markers (▾) — should sit on the same vertical after alignment
  const mark = (series, col, on) => {
    if (!on) return; const pk = tonePeak(series); if (!pk) return;
    const x = xOf(pk.t); ctx.fillStyle = col; ctx.beginPath();
    ctx.moveTo(x - 5, padT); ctx.lineTo(x + 5, padT); ctx.lineTo(x, padT + 8); ctx.closePath(); ctx.fill();
  };
  mark(tas, COL.tas, vis.tas); mark(da, COL.dsl, vis.dsl);
}

// ---- difference-over-time -------------------------------------------------
function drawDiff() {
  const c = el('diff'), ctx = clearC(c), W = c.width, H = c.height;
  const padL = 40, padR = 10, padT = 10, padB = 24;
  const ps = pairs();
  ctx.fillStyle = '#0b0e18'; ctx.fillRect(padL, padT, W - padL - padR, H - padT - padB);
  if (ps.length < 2) { ctx.fillStyle = '#8b95a3'; ctx.fillText('no overlapping samples', padL + 8, H / 2); return; }
  const t0 = ps[0].s * 1000, t1 = ps[ps.length - 1].s * 1000 + 1;
  let amp = 2; ps.forEach(p => amp = Math.max(amp, Math.abs(p.dsl - p.tas)));
  amp = Math.ceil(amp / 2) * 2;
  const xOf = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
  const yOf = (v) => padT + (H - padT - padB) * (1 - (v + amp) / (2 * amp));
  tickTimes(ctx, padL, W - padR, t0, t1, H - padB);
  ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui';
  [amp, 0, -amp].forEach(v => ctx.fillText((v > 0 ? '+' : '') + v, 4, yOf(v) + 3));
  // zero line + mean-bias line
  const mean = ps.reduce((s, p) => s + (p.dsl - p.tas), 0) / ps.length;
  ctx.strokeStyle = '#3a4557'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(padL, yOf(0)); ctx.lineTo(W - padR, yOf(0)); ctx.stroke();
  ctx.strokeStyle = COL.diff; ctx.beginPath(); ctx.moveTo(padL, yOf(mean)); ctx.lineTo(W - padR, yOf(mean)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = COL.diff; ctx.fillText(`bias ${mean >= 0 ? '+' : ''}${mean.toFixed(1)} dB`, W - padR - 96, yOf(mean) - 4);
  // trace
  ctx.strokeStyle = COL.diff; ctx.lineWidth = 1.4; ctx.beginPath();
  ps.forEach((p, i) => { const x = xOf(p.s * 1000), y = yOf(p.dsl - p.tas); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
}

// ---- Bland–Altman ---------------------------------------------------------
function drawBA() {
  const c = el('ba'), ctx = clearC(c), W = c.width, H = c.height;
  const padL = 40, padR = 12, padT = 10, padB = 26;
  const ps = pairs();
  ctx.fillStyle = '#0b0e18'; ctx.fillRect(padL, padT, W - padL - padR, H - padT - padB);
  if (ps.length < 2) { ctx.fillStyle = '#8b95a3'; ctx.fillText('no overlapping samples', padL + 8, H / 2); return; }
  const means = ps.map(p => (p.tas + p.dsl) / 2), diffs = ps.map(p => p.dsl - p.tas);
  const mLo = Math.min(...means) - 2, mHi = Math.max(...means) + 2;
  const bias = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((s, v) => s + (v - bias) ** 2, 0) / Math.max(1, diffs.length - 1));
  const loA = bias - 1.96 * sd, hiA = bias + 1.96 * sd;
  const dLo = Math.min(loA, ...diffs) - 1, dHi = Math.max(hiA, ...diffs) + 1;
  const xOf = (v) => padL + ((v - mLo) / (mHi - mLo)) * (W - padL - padR);
  const yOf = (v) => padT + (H - padT - padB) * (1 - (v - dLo) / (dHi - dLo));

  ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui';
  ctx.fillText('mean level (dB) →', padL, H - 6);
  const dashAt = (v, col, lbl) => {
    ctx.strokeStyle = col; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(padL, yOf(v)); ctx.lineTo(W - padR, yOf(v)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = col; ctx.fillText(lbl, padL + 3, yOf(v) - 3);
  };
  dashAt(hiA, '#6b7688', `+1.96 SD ${hiA.toFixed(1)}`);
  dashAt(loA, '#6b7688', `−1.96 SD ${loA.toFixed(1)}`);
  dashAt(bias, COL.diff, `bias ${bias >= 0 ? '+' : ''}${bias.toFixed(1)}`);
  ps.forEach((p, i) => {
    ctx.fillStyle = 'rgba(74,168,255,0.75)';
    ctx.beginPath(); ctx.arc(xOf(means[i]), yOf(diffs[i]), 2.6, 0, 7); ctx.fill();
  });
}

// ---- stats tiles ----------------------------------------------------------
const stat = (label, val, z) => `<div class="stat ${z || ''}"><div class="sv">${val}</div><div class="sl">${label}</div></div>`;
function drawStats() {
  const ps = pairs();
  const leq = (s) => s.length ? eMean(s.map(p => p.db)) : NaN;
  const peak = (s) => s.length ? Math.max(...s.map(p => p.db)) : NaN;
  const tiles = [];
  tiles.push(stat('Offset applied', `${offsetSec >= 0 ? '+' : ''}${offsetSec}s`));
  if (corr) tiles.push(stat('Tone match r', corr.r.toFixed(3), corr.r > 0.9 ? 'z0' : corr.r > 0.6 ? 'z1' : 'z3'));
  tiles.push(stat('TAS Leq', leq(tas).toFixed(1) + ' dB'));
  tiles.push(stat('DSL Leq', leq(dslAligned()).toFixed(1) + ' dB'));
  tiles.push(stat('Avg Leq', leq(averaged()).toFixed(1) + ' dB', 'z0'));
  tiles.push(stat('TAS peak', peak(tas).toFixed(1) + ' dB'));
  tiles.push(stat('DSL peak', peak(dslAligned()).toFixed(1) + ' dB'));
  if (ps.length) {
    const diffs = ps.map(p => p.dsl - p.tas);
    const bias = diffs.reduce((s, v) => s + v, 0) / diffs.length;
    const rms = Math.sqrt(diffs.reduce((s, v) => s + v * v, 0) / diffs.length);
    tiles.push(stat('Mean bias (DSL−TAS)', `${bias >= 0 ? '+' : ''}${bias.toFixed(1)} dB`, Math.abs(bias) > 3 ? 'z2' : 'z0'));
    tiles.push(stat('RMS difference', rms.toFixed(1) + ' dB', rms > 3 ? 'z2' : 'z0'));
    tiles.push(stat('Paired samples', String(ps.length)));
  }
  el('cmpStats').innerHTML = tiles.join('');

  const note = corr
    ? `Auto-aligned at a ${corr.lag >= 0 ? '+' : ''}${corr.lag}s lag (correlation r=${corr.r.toFixed(3)} over ${corr.n} overlapping seconds). `
    : '';
  el('agreeNote').textContent = note +
    'Bland–Altman shows the difference between the meters against the level being measured: a flat cloud near the bias line means a constant offset (calibration), a sloped cloud means they disagree more at some levels.';
}

// ---- publish --------------------------------------------------------------
async function save() {
  el('saveResult').textContent = 'saving…';
  const body = {
    offset_sec: offsetSec, avg_method: 'energy',
    names: { tas: 'TAS', dsl: 'DSL', avg: 'Average' },
    tas: tas.map(p => ({ ts: new Date(p.t).toISOString(), db: p.db })),
    dsl: dsl.map(p => ({ ts: new Date(p.t).toISOString(), db: p.db })),
  };
  try {
    const d = await fetch('/api/coord/commit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(r => r.json());
    if (!d.ok) { el('saveResult').textContent = 'failed: ' + (d.error || ''); return; }
    const c = d.sources;
    el('saveResult').textContent =
      `saved · TAS ${c.TAS} · DSL ${c.DSL} · Average ${c.Average} rows (DSL shifted ${d.offset_sec >= 0 ? '+' : ''}${d.offset_sec}s)`;
    setStatus('published', 'ok');
  } catch (e) { el('saveResult').textContent = 'error: ' + e.message; }
}

// ---- redraw + wiring ------------------------------------------------------
function redraw() {
  drawOverlay(); drawDiff(); drawBA(); drawStats();
  el('alignInfo').textContent = corr
    ? `auto: ${corr.lag >= 0 ? '+' : ''}${corr.lag}s (r=${corr.r.toFixed(3)}, ${corr.n} pts) — nudge if the ▾ tone marks don't line up`
    : 'manual offset — click Auto-align to re-detect the tone';
  el('meta').textContent = tas.length && dsl.length
    ? `TAS ${tas.length} · DSL ${dsl.length} samples · DSL shifted ${offsetSec >= 0 ? '+' : ''}${offsetSec}s`
    : '—';
}

document.querySelectorAll('#overlayLegend .legtoggle').forEach(span => {
  span.style.cursor = 'pointer'; span.style.userSelect = 'none';
  span.addEventListener('click', () => {
    const k = span.dataset.k; vis[k] = !vis[k];
    span.style.opacity = vis[k] ? '1' : '0.4';
    span.style.textDecoration = vis[k] ? 'none' : 'line-through';
    drawOverlay();
  });
});
el('analyzeBtn').addEventListener('click', analyze);
el('autoBtn').addEventListener('click', autoAlign);
el('offset').addEventListener('change', () => { offsetSec = parseFloat(el('offset').value) || 0; corr = null; redraw(); });
el('nudgeDn').addEventListener('click', () => { offsetSec -= 1; el('offset').value = offsetSec; corr = null; redraw(); });
el('nudgeUp').addEventListener('click', () => { offsetSec += 1; el('offset').value = offsetSec; corr = null; redraw(); });
el('saveBtn').addEventListener('click', save);

el('tz').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
setStatus('ready', 'ok');

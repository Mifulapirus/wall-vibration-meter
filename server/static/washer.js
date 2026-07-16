// Washer & Dryer Noise Report — extracts and annotates the extremely loud
// in-unit laundry noise captured on 2026-07-15 (calibrated eS528L in dBA plus
// the DSL in dBC), separate from the normal AC monitoring. Vanilla canvas.

const el = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const f1 = (x) => (x == null || isNaN(x) ? 'n/a' : (+x).toFixed(1));
const f0 = (x) => (x == null || isNaN(x) ? 'n/a' : Math.round(+x));
const SRC_A = 'WD-A-2026-07-15';   // eS528L, dBA (afternoon)
const SRC_C = 'WD-C-2026-07-15';   // DSL, dBC (into the evening)

const leqOf = (v) => v.length ? 10 * Math.log10(v.reduce((s, x) => s + Math.pow(10, x / 10), 0) / v.length) : null;
function fmtDur(sec) {
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}
function analyze(readings) {
  const pts = readings.map(r => ({ t: Date.parse(r.ts), db: r.spl_db })).filter(p => p.db != null).sort((a, b) => a.t - b.t);
  const v = pts.map(p => p.db);
  const over = (thr) => v.filter(x => x >= thr).length;   // seconds (1 Hz)
  return {
    pts, n: v.length, peak: v.length ? Math.max(...v) : null, leq: leqOf(v),
    quietLeq: leqOf(v.filter(x => x < 65)),
    over70: over(70), over80: over(80), over90: over(90), over85: over(85),
    from: pts.length ? pts[0].t : null, to: pts.length ? pts[pts.length - 1].t : null,
  };
}

// Everyday reference points on the dB scale (for a non-technical reader).
function soundLike(db) {
  const t = [[40, 'a quiet library'], [50, 'a refrigerator'], [55, 'a normal washing machine'],
    [60, 'a normal conversation'], [65, 'an older dryer'], [70, 'a vacuum cleaner'],
    [75, 'a flushing toilet up close'], [80, 'a garbage disposal / busy city traffic'],
    [85, 'a food blender running'], [90, 'a lawnmower / shouting to be heard'],
    [95, 'a diesel truck passing close by'], [100, 'a jackhammer or chainsaw at close range'],
    [105, 'a rock concert']];
  let best = t[0]; for (const x of t) { if (db >= x[0]) best = x; else break; } return best[1];
}

const card = (n, unit, label, hint, color) =>
  `<div class="rcard"><div class="n"${color ? ` style="color:${color}"` : ''}>${n}${unit ? `<small> ${unit}</small>` : ''}</div>` +
  `<div class="l">${label}</div>${hint ? `<div class="h">${hint}</div>` : ''}</div>`;

async function load() {
  let a = { pts: [] }, c = { pts: [] };
  try {
    const [ra, rc] = await Promise.all([
      fetch(`/api/noise?source=${enc(SRC_A)}&hours=0&limit=40000`, { cache: 'no-store' }).then(r => r.json()),
      fetch(`/api/noise?source=${enc(SRC_C)}&hours=0&limit=40000`, { cache: 'no-store' }).then(r => r.json()),
    ]);
    a = analyze(ra); c = analyze(rc);
  } catch (e) { el('verdict').innerHTML = `<h2>Could not load: ${e.message}</h2>`; return; }

  const dt = (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const tm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  el('verdict').className = 'verdict poor';
  el('verdict').innerHTML =
    `<div class="badge2">In-unit appliance noise, excessive, ${a.from ? dt(a.from) : ''}</div>` +
    `<h2>The washer &amp; dryer are grossly over the level of a normal home appliance</h2>` +
    `<ul>` +
    `<li>During operation the in-unit washer/dryer reached a peak of <b>${f1(a.peak)} dBA</b> — about as loud as <b>${soundLike(a.peak)}</b> — inside the apartment.</li>` +
    `<li>It held a sustained average of <b>${f1(a.leq)} dBA</b> and stayed above <b>80 dBA</b> for <b>${fmtDur(a.over80)}</b> and above <b>90 dBA</b> for <b>${fmtDur(a.over90)}</b>.</li>` +
    `<li>A normal washing machine runs around <b>55 dBA</b>; this is roughly <b>${a.peak ? Math.round(Math.pow(2, (a.peak - 55) / 10)) : '?'}&times; as loud</b> at its peak.</li>` +
    `<li>The noise recurred over the day — captured again into the evening, with repeated bursts to <b>${f1(c.peak)} dBC</b>.</li>` +
    `</ul>`;

  el('cards').innerHTML =
    card(f1(a.peak), 'dBA', 'Peak level', soundLike(a.peak), '#ff6b60') +
    card(f1(a.leq), 'dBA', 'Sustained (Leq)', 'average while running') +
    card(fmtDur(a.over90), '', 'Time above 90 dBA', 'hearing-hazard range') +
    card(fmtDur(a.over80), '', 'Time above 80 dBA', 'garbage-disposal loud') +
    card(fmtDur(a.over70), '', 'Time above 70 dBA', 'louder than a vacuum') +
    card(f1(c.peak), 'dBC', 'Peak (evening)', 'recurred later the same day');

  el('aTitle').textContent = a.from ? `${dt(a.from)} · ${tm(a.from)}–${tm(a.to)} · calibrated eS528L (Type 2), A-weighted` : '';
  drawLevels('aChart', a.pts, { unit: 'dBA', loud: 80, peak: a.peak });
  el('pA').innerHTML =
    `The trace above is the sound level inside the apartment while the in-unit washer and dryer were running, measured with a calibrated Type&nbsp;2 meter. Rather than the steady low hum of a normal appliance, it repeatedly spikes into the red — peaking at <b>${f1(a.peak)} dBA</b> and averaging <b>${f1(a.leq)} dBA</b> across the cycle. For comparison, the quiet stretches between spikes sat around <b>${f0(a.quietLeq)} dBA</b> (the room's ordinary background). Sustained noise at these levels is in the range that causes hearing strain and makes normal conversation, rest, or sleep impossible in the same space.`;

  el('cTitle').textContent = c.from ? `${dt(c.from)} · ${tm(c.from)}–${tm(c.to)} · DSL, C-weighted` : '';
  drawLevels('cChart', c.pts, { unit: 'dBC', loud: 80, peak: c.peak });
  el('pC').innerHTML =
    `The same appliances were captured again later the same day. Against a quiet background near <b>${f0(c.quietLeq)} dBC</b> (the ordinary AC hum), the laundry produced repeated loud bursts — <b>${fmtDur(c.over90)}</b> above 90&nbsp;dBC and a peak of <b>${f1(c.peak)} dBC</b>. This is not a one-time event: the excessive appliance noise recurs whenever the machines run.`;

  drawScale(a.peak, a.leq);
  el('pScale').innerHTML =
    `A properly working home washing machine measures about <b>55&nbsp;dBA</b> and a dryer about <b>60&nbsp;dBA</b> — quieter than a normal conversation. This unit instead reached <b>${f1(a.peak)} dBA</b> (red marker): <b>${soundLike(a.peak)}</b>. Occupational guidelines (OSHA/NIOSH) flag sustained exposure above <b>85&nbsp;dBA</b> as a hearing hazard; this exceeded that for <b>${fmtDur(a.over85)}</b>. A household appliance producing these levels indoors is malfunctioning or improperly installed, not operating normally.`;

  el('pMethod').innerHTML =
    `Levels are recorded once per second. The A-weighted (dBA) data is from an ennoLogic eS528L Type&nbsp;2 (&plusmn;1.5&nbsp;dB) sound level meter placed in the living area; the C-weighted (dBC) data is from a second meter. "Time above" figures count the seconds at or over each level. Peaks are instantaneous maxima; the sustained (Leq) figure is the energy-average over the running period. Raw time-stamped data is available on request.`;

  el('meta').textContent = `${SRC_A}: ${a.n} samples · ${SRC_C}: ${c.n} samples`;
}

// ---- level-vs-time chart with loud (>threshold) shaded red -----------------
function drawLevels(canvasId, pts, opts) {
  const { unit, loud, peak } = opts;
  const cv = el(canvasId), dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 1000, H = 220;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const padL = 42, padR = 12, padT = 12, padB = 26;
  ctx.fillStyle = '#0b0e18'; ctx.fillRect(padL, padT, W - padL - padR, H - padT - padB);
  if (!pts.length) { ctx.fillStyle = '#8b95a3'; ctx.font = '12px system-ui'; ctx.fillText('no data', padL + 8, H / 2); return; }
  const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
  let dbMax = 0, dbMin = 40; pts.forEach(p => { dbMax = Math.max(dbMax, p.db); });
  dbMax = Math.ceil((dbMax + 3) / 10) * 10; dbMin = Math.min(40, Math.floor((Math.min(...pts.map(p => p.db)) - 3) / 10) * 10);
  const x = (t) => padL + (t - t0) / (t1 - t0) * (W - padL - padR);
  const y = (d) => (H - padB) - (d - dbMin) / (dbMax - dbMin) * (H - padT - padB);

  // time axis
  ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui'; ctx.strokeStyle = '#20283a'; ctx.lineWidth = 1;
  for (let i = 0; i <= 6; i++) {
    const t = t0 + (i / 6) * (t1 - t0), xx = x(t);
    ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, H - padB); ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillText(new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), xx, H - padB + 14);
  }
  ctx.textAlign = 'start';
  for (let d = dbMin; d <= dbMax; d += 10) ctx.fillText(d + '', 6, y(d) + 3);
  ctx.fillText(unit, 6, padT + 2);

  // loud threshold line
  if (loud <= dbMax) {
    ctx.strokeStyle = 'rgba(255,77,77,0.6)'; ctx.setLineDash([5, 4]); ctx.beginPath();
    ctx.moveTo(padL, y(loud)); ctx.lineTo(W - padR, y(loud)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#ff6b60'; ctx.fillText(`${loud} ${unit}`, padL + 4, y(loud) - 3);
  }
  // filled area, red above the loud line
  const draw = (colFill, colLine, clipAbove) => {
    ctx.save();
    ctx.beginPath();
    if (clipAbove) ctx.rect(padL, padT, W - padL - padR, y(loud) - padT);
    else ctx.rect(padL, y(loud), W - padL - padR, (H - padB) - y(loud));
    ctx.clip();
    ctx.beginPath(); ctx.moveTo(x(pts[0].t), H - padB);
    pts.forEach(p => ctx.lineTo(x(p.t), y(p.db)));
    ctx.lineTo(x(pts[pts.length - 1].t), H - padB); ctx.closePath();
    ctx.fillStyle = colFill; ctx.fill();
    ctx.restore();
  };
  draw('rgba(255,77,77,0.35)', null, true);         // above loud -> red
  draw('rgba(53,169,255,0.16)', null, false);       // below loud -> blue
  // outline
  ctx.strokeStyle = '#35a9ff'; ctx.lineWidth = 1; ctx.beginPath();
  pts.forEach((p, i) => { const xx = x(p.t), yy = y(p.db); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); });
  ctx.stroke();
  // peak marker
  if (peak != null) {
    const pk = pts.reduce((m, p) => p.db > m.db ? p : m, pts[0]);
    ctx.fillStyle = '#ff4d4d'; ctx.beginPath(); ctx.arc(x(pk.t), y(pk.db), 3, 0, 7); ctx.fill();
    ctx.font = 'bold 11px system-ui'; ctx.fillText(`${pk.db.toFixed(1)} ${unit}`, x(pk.t) + 6, y(pk.db) + 3);
  }
}

// ---- dB reference scale ----------------------------------------------------
function drawScale(peak, leq) {
  const cv = el('scale'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 1000, H = 96;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const lo = 40, hi = 105, padL = 6, padR = 6, by = 44, bh = 16;
  const x = (v) => padL + (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (W - padL - padR);
  const g = ctx.createLinearGradient(padL, 0, W - padR, 0);
  g.addColorStop(0, '#21c07a'); g.addColorStop(0.35, '#e6cc00'); g.addColorStop(0.62, '#ff8a1e'); g.addColorStop(1, '#ff4d4d');
  ctx.fillStyle = g; ctx.fillRect(padL, by, W - padL - padR, bh);
  ctx.font = '10px system-ui'; ctx.textAlign = 'center';
  for (const [v, lab] of [[55, 'normal washer'], [60, 'conversation'], [70, 'vacuum'], [80, 'disposal'], [90, 'lawnmower'], [100, 'chainsaw']]) {
    const xx = x(v); ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(xx, by, 1, bh);
    ctx.fillStyle = '#8b95a3'; ctx.fillText(v, xx, by + bh + 12); ctx.fillText(lab, xx, by + bh + 24);
  }
  const marker = (v, col, labl) => {
    if (v == null) return; const xx = x(v);
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(xx, by - 3); ctx.lineTo(xx, by + bh + 3); ctx.stroke();
    ctx.fillStyle = col; ctx.font = 'bold 11px system-ui'; ctx.fillText(labl, xx, by - 8);
  };
  marker(55, '#3fb950', 'normal 55');
  marker(leq, '#e6cc00', 'avg ' + f0(leq));
  marker(peak, '#ff4d4d', 'PEAK ' + f0(peak));
  ctx.textAlign = 'start';
}

window.addEventListener('resize', () => load());
load();

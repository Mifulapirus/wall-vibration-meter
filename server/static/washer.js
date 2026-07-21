// Washer & Dryer Noise Report: the extremely loud in-unit laundry noise,
// separate from the normal AC monitoring. Vanilla canvas.
//
// Every laundry run is imported as its own pair of Noise sources:
//     WD<run?>[-DSL]-<A|C>-<YYYY-MM-DD>
// where the -DSL- infix marks the DSL meter and its absence means the
// calibrated eS528L (Type 2). <run> numbers multiple runs on one day.
//
// Which meter carries which weighting is NOT fixed: on 2026-07-15 the eS528L was
// on A and the DSL on C; on 2026-07-16 that inverted. So nothing here may assume
// "calibrated ⇒ dBA"; the weighting is read from the source name, and the
// dBA-only benchmarks (a normal 55 dBA washer, the OSHA/NIOSH 85 dBA line, the
// everyday-loudness comparisons) are shown ONLY when the calibrated meter really
// was A-weighted. Otherwise this report would attribute numbers to the wrong
// instrument and weighting.

const el = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const f1 = (x) => (x == null || isNaN(x) ? 'n/a' : (+x).toFixed(1));
const f0 = (x) => (x == null || isNaN(x) ? 'n/a' : Math.round(+x));

const RUN_RE = /^WD(\d*)(-DSL)?-([AC])-(\d{4}-\d{2}-\d{2})$/;

// Group the WD* sources into runs: { key, date, no, cal:{src,w}, dsl:{src,w} }.
function groupRuns(sources) {
  const runs = new Map();
  for (const s of sources) {
    const m = RUN_RE.exec(s.source);
    if (!m) continue;
    const [, no, isDsl, w, date] = m;
    const key = `${date}#${no || '0'}`;
    if (!runs.has(key)) runs.set(key, { key, date, no, cal: null, dsl: null, last: s.last });
    const r = runs.get(key);
    r[isDsl ? 'dsl' : 'cal'] = { src: s.source, w, n: s.count, first: s.first, last: s.last };
    if (s.last > r.last) r.last = s.last;
  }
  return [...runs.values()].sort((a, b) => (a.last < b.last ? 1 : -1));   // newest first
}
const runLabel = (r) => {
  const d = new Date(r.date + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
  return r.no ? `${d} · run ${r.no}` : d;
};
const meterName = (kind) => (kind === 'cal' ? 'calibrated eS528L (Type 2)' : 'DSL');

let gRuns = [], gRun = null;

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
  if (!gRun) return;
  const want = [gRun.cal, gRun.dsl];
  let got;
  try {
    got = await Promise.all(want.map(s => s
      ? fetch(`/api/noise?source=${enc(s.src)}&hours=0&limit=40000`, { cache: 'no-store' }).then(r => r.json())
      : Promise.resolve([])));
  } catch (e) { el('verdict').innerHTML = `<h2>Could not load: ${e.message}</h2>`; return; }
  const a = analyze(got[0]), c = analyze(got[1]);
  const aw = gRun.cal ? gRun.cal.w : null;     // weighting of the calibrated meter
  const cw = gRun.dsl ? gRun.dsl.w : null;     // weighting of the DSL
  const aU = aw ? 'dB' + aw : '';
  const cU = cw ? 'dB' + cw : '';
  // The everyday-loudness and 55 dBA / 85 dBA benchmarks are defined for
  // A-weighting only; quoting them against a dBC number would overstate the
  // level by the C-A difference (~17 dB in this room).
  const aIsA = aw === 'A';

  const dt = (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const tm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const span = (x) => (x.from ? `${dt(x.from)} · ${tm(x.from)}–${tm(x.to)}` : '');

  el('verdict').className = 'verdict poor';
  el('verdict').innerHTML =
    `<div class="badge2">In-unit appliance noise, excessive, ${a.from ? dt(a.from) : (c.from ? dt(c.from) : '')}</div>` +
    `<h2>The washer &amp; dryer are grossly over the level of a normal home appliance</h2>` +
    `<ul>` +
    (a.n ? `<li>During operation the in-unit washer/dryer reached a peak of <b>${f1(a.peak)} ${aU}</b>` +
      (aIsA ? ` (about as loud as <b>${soundLike(a.peak)}</b>)` : '') +
      ` inside the apartment, on the ${meterName('cal')}.</li>` +
      `<li>It held a sustained average of <b>${f1(a.leq)} ${aU}</b>, staying above <b>80 ${aU}</b> for <b>${fmtDur(a.over80)}</b> and above <b>90 ${aU}</b> for <b>${fmtDur(a.over90)}</b>.</li>` : '') +
    (a.n && aIsA ? `<li>A normal washing machine runs around <b>55 dBA</b>; this is roughly <b>${Math.round(Math.pow(2, (a.peak - 55) / 10))}&times; as loud</b> at its peak.</li>` : '') +
    (a.n && !aIsA ? `<li>This run was recorded <b>C-weighted (${aU})</b>, so the dBA benchmarks for a normal appliance do not apply to it; the figures above are not comparable to an A-weighted limit.</li>` : '') +
    (c.n ? `<li>A second meter (${meterName('dsl')}) recorded the same run at a peak of <b>${f1(c.peak)} ${cU}</b>.</li>` : '') +
    `</ul>`;

  el('cards').innerHTML =
    (a.n ? card(f1(a.peak), aU, 'Peak level', aIsA ? soundLike(a.peak) : 'C-weighted, not a dBA figure', '#ff6b60') +
      card(f1(a.leq), aU, 'Sustained (Leq)', 'average while running') +
      card(fmtDur(a.over90), '', `Time above 90 ${aU}`, aIsA ? 'hearing-hazard range' : '') +
      card(fmtDur(a.over85), '', `Time above 85 ${aU}`, aIsA ? 'risk of hearing damage' : '') +
      card(fmtDur(a.over70), '', `Time above 70 ${aU}`, '') : '') +
    (c.n ? card(f1(c.peak), cU, 'Peak (second meter)', 'DSL, reads ~7 dB high') : '');

  el('aSec').style.display = a.n ? '' : 'none';
  el('aHead').innerHTML = `Washer/dryer noise <span class="dim">(${meterName('cal')}, ${aU})</span>`;
  el('aTitle').textContent = a.n ? `${span(a)} · ${meterName('cal')}, ${aw}-weighted · ${gRun.cal.src}` : '';
  drawLevels('aChart', a.pts, { unit: aU, threshold: aIsA ? 85 : null, thresholdLabel: 'risk of hearing damage', peak: a.peak });
  el('pA').innerHTML = a.n
    ? `The trace above is the sound level inside the apartment while the in-unit laundry was running, measured with a calibrated Type&nbsp;2 meter. Rather than the steady low hum of a normal appliance, it repeatedly spikes into the red, peaking at <b>${f1(a.peak)} ${aU}</b> and averaging <b>${f1(a.leq)} ${aU}</b> across the cycle. The quiet stretches between spikes sat around <b>${f0(a.quietLeq)} ${aU}</b> (the room's ordinary background).` +
      (aIsA ? ` Sustained noise at this level fills the room like a gas lawnmower running a few feet away, and its peaks rival a motorcycle roaring past. It is a relentless, industrial roar erupting from a household appliance, loud enough that prolonged exposure physically damages hearing.` : ` Note this run was <b>C-weighted</b>: it includes low-frequency energy that A-weighting discards, so it must not be read against dBA limits.`)
    : '';

  el('cSec').style.display = c.n ? '' : 'none';
  el('cHead').innerHTML = `Second meter <span class="dim">(${meterName('dsl')}, ${cU})</span>`;
  el('cTitle').textContent = c.n ? `${span(c)} · DSL, ${cw}-weighted · ${gRun.dsl.src}` : '';
  drawLevels('cChart', c.pts, { unit: cU, threshold: null, peak: c.peak });
  el('pC').innerHTML = c.n
    ? `The same run recorded on the <b>DSL</b> meter (it reads roughly 7&nbsp;dB high against the calibrated eS528L, so treat its absolute levels as indicative only; its value here is timing and duration). Against a background near <b>${f0(c.quietLeq)} ${cU}</b>, the laundry produced repeated loud bursts: <b>${fmtDur(c.over90)}</b> above 90&nbsp;${cU} and a peak of <b>${f1(c.peak)} ${cU}</b>.`
    : '';

  // The dB scale is an A-weighted everyday reference; only meaningful for a dBA run.
  el('scale').style.display = aIsA ? '' : 'none';
  if (aIsA) {
    drawScale(a.peak, a.leq);
    el('pScale').innerHTML =
      `A properly working home washing machine measures about <b>55&nbsp;dBA</b> and a dryer about <b>60&nbsp;dBA</b>, quieter than everyday background noise. This unit instead reached <b>${f1(a.peak)} dBA</b> (red marker): <b>${soundLike(a.peak)}</b>. Occupational guidelines (OSHA/NIOSH) flag sustained exposure above <b>85&nbsp;dBA</b> as a hearing hazard; this exceeded that for <b>${fmtDur(a.over85)}</b>. A household appliance producing these levels indoors is malfunctioning or improperly installed, not operating normally.`;
  } else {
    el('pScale').innerHTML =
      `The everyday-loudness scale is defined for A-weighted (dBA) levels. This run was recorded <b>C-weighted</b>, so it is deliberately not plotted against it, because doing so would overstate the apparent loudness by the C&minus;A difference (about 17&nbsp;dB in this room). See a dBA run for that comparison.`;
  }

  el('pMethod').innerHTML =
    `Levels are recorded once per second. Readings marked <b>${meterName('cal')}</b> come from an ennoLogic eS528L Type&nbsp;2 (&plusmn;1.5&nbsp;dB) sound level meter in the living area; readings marked <b>${meterName('dsl')}</b> come from a second DSL meter that reads about 7&nbsp;dB high and is used for timing and duration rather than absolute level. <b>The weighting is stated per run</b> (A- or C-weighted) and is not assumed: dBA and dBC are different quantities and are never compared directly. "Time above" figures count the seconds at or over each level. Peaks are instantaneous maxima; the sustained (Leq) figure is the energy-average over the running period. Raw time-stamped data is available on request.`;

  el('meta').textContent = [gRun.cal && `${gRun.cal.src}: ${a.n} samples`,
                           gRun.dsl && `${gRun.dsl.src}: ${c.n} samples`].filter(Boolean).join(' · ');
}

async function boot() {
  let srcs = [];
  try { srcs = await fetch('/api/noise/sources', { cache: 'no-store' }).then(r => r.json()); }
  catch (e) { el('verdict').innerHTML = `<h2>Could not load sources: ${e.message}</h2>`; return; }
  gRuns = groupRuns(srcs);
  const sel = el('run');
  sel.innerHTML = '';
  if (!gRuns.length) {
    el('verdict').innerHTML = '<h2>No laundry runs imported yet</h2>';
    return;
  }
  gRuns.forEach((r, i) => {
    const o = document.createElement('option');
    o.value = r.key; o.textContent = runLabel(r);
    if (!i) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => {
    gRun = gRuns.find(r => r.key === sel.value) || gRuns[0];
    load();
  });
  gRun = gRuns[0];
  await load();
}

// ---- level-vs-time chart; area above the labelled threshold is shaded red ---
function drawLevels(canvasId, pts, opts) {
  const { unit, threshold, thresholdLabel, peak } = opts;
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

  // hearing-loss threshold line (drawn only when one applies to this weighting)
  const hasThr = threshold != null && threshold <= dbMax;
  if (hasThr) {
    ctx.strokeStyle = 'rgba(255,77,77,0.6)'; ctx.setLineDash([5, 4]); ctx.beginPath();
    ctx.moveTo(padL, y(threshold)); ctx.lineTo(W - padR, y(threshold)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#ff6b60';
    ctx.fillText(`${threshold} ${unit}${thresholdLabel ? ' · ' + thresholdLabel : ''}`, padL + 4, y(threshold) - 3);
  }
  // area trace under the curve; red above the threshold, blue below (all blue if no threshold)
  const traceFill = (colFill) => {
    ctx.beginPath(); ctx.moveTo(x(pts[0].t), H - padB);
    pts.forEach(p => ctx.lineTo(x(p.t), y(p.db)));
    ctx.lineTo(x(pts[pts.length - 1].t), H - padB); ctx.closePath();
    ctx.fillStyle = colFill; ctx.fill();
  };
  if (hasThr) {
    const clipped = (colFill, above) => {
      ctx.save(); ctx.beginPath();
      if (above) ctx.rect(padL, padT, W - padL - padR, y(threshold) - padT);
      else ctx.rect(padL, y(threshold), W - padL - padR, (H - padB) - y(threshold));
      ctx.clip(); traceFill(colFill); ctx.restore();
    };
    clipped('rgba(255,77,77,0.35)', true);    // above threshold -> red
    clipped('rgba(53,169,255,0.16)', false);  // below threshold -> blue
  } else {
    traceFill('rgba(53,169,255,0.16)');
  }
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
boot();

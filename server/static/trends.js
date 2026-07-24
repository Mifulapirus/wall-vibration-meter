// Rooftop-AC noise trend — computed live from every recorded master-bedroom
// night, so the page updates itself as new nights are imported. dBA anchors on
// the calibrated eS528L (plain `eS528L-<date>` / legacy `eS528L-night`); dBC on
// the dated `DSL-C-<date>` for the same nights. Location-specific sources
// (second bedroom, co-location tests, C-weighted eS528L nights) are excluded by
// the name patterns, matching the habitability report's night selector.

const el = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const f1 = (x) => (x == null || isNaN(x) ? 'n/a' : (+x).toFixed(1));

const leqOf = (v) => (v.length ? 10 * Math.log10(v.reduce((s, x) => s + Math.pow(10, x / 10), 0) / v.length) : null);
const pctl = (v, p) => {
  const s = [...v].sort((a, b) => a - b), k = (s.length - 1) * p / 100;
  const lo = Math.floor(k), hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (k - lo);
};
function fit(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return { m: sxy / sxx, b: my - sxy / sxx * mx, r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0 };
}
const HANDLING = 65;   // dBA self-noise/handling cut (dBA only)

async function nightStats(src, from, to, cut) {
  const rows = await fetch(`/api/noise?source=${enc(src)}&from=${enc(from)}&to=${enc(to)}&limit=6000`, { cache: 'no-store' })
    .then(r => r.json());
  let v = rows.map(r => r.spl_db).filter(x => x != null);
  if (cut != null) v = v.filter(x => x <= cut);
  if (!v.length) return null;
  return { leq: leqOf(v), l50: pctl(v, 50), l90: pctl(v, 10), n: v.length };
}
// Night's calendar date: the date embedded in the source name, else the date of
// the last (morning) reading for the legacy `eS528L-night`.
const nameDate = (s) => { const m = s.match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const dayNum = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);
const fmtDate = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });

const NS = 'http://www.w3.org/2000/svg';
const mk = (t, a) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };

function draw(svgId, nights, cfg) {
  const svg = el(svgId); svg.innerHTML = '';
  const W = 720, H = 320, L = 44, R = 16, T = 16, B = 44, pw = W - L - R, ph = H - T - B;
  const days = nights.map(n => n.day), d0 = Math.min(...days), d1 = Math.max(...days), span = Math.max(1, d1 - d0);
  const x = (d) => L + ((d - d0) / span) * pw;
  const y = (v) => T + (1 - (v - cfg.ymin) / (cfg.ymax - cfg.ymin)) * ph;

  for (let v = cfg.ymin; v <= cfg.ymax; v += cfg.step) {
    svg.appendChild(mk('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }));
    const t = mk('text', { x: L - 8, y: y(v) + 3.5, 'text-anchor': 'end' }); t.textContent = v; svg.appendChild(t);
  }
  (cfg.who || []).forEach(w => {
    svg.appendChild(mk('line', { x1: L, x2: W - R, y1: y(w.v), y2: y(w.v), class: 'who ' + w.cls }));
    const t = mk('text', { x: W - R, y: y(w.v) - 4, 'text-anchor': 'end', class: 'who-lab ' + w.cls }); t.textContent = w.lab; svg.appendChild(t);
  });
  nights.forEach(n => {
    const t = mk('text', { x: x(n.day), y: H - B + 18, 'text-anchor': 'middle' });
    t.textContent = new Date(n.date + 'T12:00:00').getDate(); svg.appendChild(t);
  });
  const at = mk('text', { x: L, y: H - 6, 'text-anchor': 'start', 'font-size': 10.5, fill: 'var(--muted)' });
  at.textContent = 'night ending (day of month)'; svg.appendChild(at);

  [['l90', 'l90'], ['l50', 'l50'], ['leq', 'leq']].forEach(([key, cls]) => {
    const pts = nights.map(n => [x(n.day), y(n[key])]);
    svg.appendChild(mk('polyline', { points: pts.map(p => p.join(',')).join(' '), class: `actual s-${cls}` }));
    const f = fit(days, nights.map(n => n[key]));
    svg.appendChild(mk('line', { x1: x(d0), y1: y(f.b + f.m * d0), x2: x(d1), y2: y(f.b + f.m * d1), class: `trend s-${cls}` }));
    pts.forEach(p => svg.appendChild(mk('circle', { cx: p[0], cy: p[1], r: 3.6, class: `pt f-${cls}` })));
  });
}

function niceRange(vals, pad, stepGuess) {
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const ymin = Math.floor((lo - pad) / stepGuess) * stepGuess;
  const ymax = Math.ceil((hi + pad) / stepGuess) * stepGuess;
  return { ymin, ymax, step: stepGuess };
}

async function boot() {
  let srcs = [];
  try { srcs = await fetch('/api/noise/sources', { cache: 'no-store' }).then(r => r.json()); }
  catch (e) { el('verdict').innerHTML = `<h2>Could not load data: ${e.message}</h2>`; return; }

  const dbaSrc = srcs.filter(s => /^eS528L-(night|\d{4}-\d{2}-\d{2})$/.test(s.source) && s.count > 100);
  // Collect dBA nights (calibrated anchor).
  let dba = await Promise.all(dbaSrc.map(async s => {
    const st = await nightStats(s.source, s.first, s.last, HANDLING);
    const iso = nameDate(s.source) || new Date(s.last).toISOString().slice(0, 10);
    return st && { src: s.source, iso, day: dayNum(iso), date: iso, ...st };
  }));
  dba = dba.filter(Boolean).sort((a, b) => a.day - b.day);
  if (dba.length < 2) { el('verdict').innerHTML = '<div class="badge2">Trend</div><h2>Not enough nights yet</h2><p>Need at least two recorded master-bedroom nights.</p>'; return; }
  const dbaDates = new Set(dba.map(n => n.iso));

  // dBC nights for the SAME master nights only.
  const dbcSrc = srcs.filter(s => /^DSL-C-\d{4}-\d{2}-\d{2}$/.test(s.source) && s.count > 100 && dbaDates.has(nameDate(s.source)));
  let dbc = await Promise.all(dbcSrc.map(async s => {
    const st = await nightStats(s.source, s.first, s.last, null);
    const iso = nameDate(s.source);
    return st && { src: s.source, iso, day: dayNum(iso), date: iso, ...st };
  }));
  dbc = dbc.filter(Boolean).sort((a, b) => a.day - b.day);

  // Charts
  draw('chartA', dba, { ...niceRange(dba.flatMap(n => [n.leq, n.l90]), 2, 2), who: [
    { v: 45, lab: 'WHO event 45', cls: 'who-45' }, { v: 40, lab: 'WHO night 40', cls: 'who-40' },
  ] });
  if (dbc.length >= 2) draw('chartC', dbc, niceRange(dbc.flatMap(n => [n.leq, n.l90]), 2, 4));
  else el('chartC').closest('.sec').style.display = 'none';

  // Trend numbers
  const fA = fit(dba.map(n => n.day), dba.map(n => n.leq));
  const wkA = fA.m * 7, spanD = dba[dba.length - 1].day - dba[0].day;
  const loudest = dba.reduce((m, n) => (n.leq > m.leq ? n : m), dba[0]);
  const up = fA.m > 0.02, down = fA.m < -0.02;
  const dir = up ? 'up' : down ? 'down' : '';

  el('verdict').className = 'verdict ' + dir;
  el('verdict').innerHTML =
    `<div class="badge2">Trend · ${dba.length} nights over ${spanD} days</div>` +
    `<h2>${down ? 'AC noise is trending downward' : up ? 'No downward trend — noise is holding, drifting up' : 'AC noise is holding steady'}</h2>` +
    `<p>Across ${dba.length} monitored master-bedroom nights, LAeq is ${up ? 'rising' : down ? 'falling' : 'flat'} at ` +
    `<b>${wkA >= 0 ? '+' : ''}${wkA.toFixed(1)} dB/week</b> (r=${fA.r.toFixed(2)}). ` +
    `The loudest night on record is <b>${fmtDate(loudest.iso)}</b> at <b>${f1(loudest.leq)} dBA</b>` +
    `${loudest.iso === dba[dba.length - 1].iso ? ', which is also the most recent' : ''}.</p>`;

  const nAbove40 = dba.filter(n => n.leq > 40).length;
  el('stats').innerHTML =
    `<div class="rcard"><div class="n ${dir}">${wkA >= 0 ? '+' : ''}${wkA.toFixed(1)}</div><div class="l">dB/week trend in LAeq</div></div>` +
    `<div class="rcard"><div class="n">${dba.length}</div><div class="l">nights monitored</div></div>` +
    `<div class="rcard"><div class="n">${Math.round(nAbove40 / dba.length * 100)}<small>%</small></div><div class="l">of nights above WHO 40 dBA</div></div>` +
    `<div class="rcard"><div class="n ${dir}">${f1(loudest.leq)}</div><div class="l">dBA — loudest night (${fmtDate(loudest.iso)})</div></div>`;

  // Table (join dBC by date)
  const cByDate = {}; dbc.forEach(n => cByDate[n.iso] = n);
  el('tbody').innerHTML = dba.map((n, i) => {
    const c = cByDate[n.iso] || {}, last = i === dba.length - 1;
    const cell = (v) => `<td>${v == null ? '—' : f1(v)}</td>`;
    return `<tr><td>${fmtDate(n.iso)}</td>${cell(n.leq)}${cell(n.l50)}${cell(n.l90)}${cell(c.leq)}${cell(c.l50)}${cell(c.l90)}</tr>`;
  }).join('');

  el('method').innerHTML =
    `Each recorded night is pulled from the server and reduced to LAeq (energy average), L50 (median), and L90 (the quiet AC-off floor). ` +
    `dBA is the calibrated ennoLogic eS528L Type 2 (self-noise above ${HANDLING} dBA excluded); dBC is the second DSL meter, shown for direction only because it over-reads and its placement varied. ` +
    `Trend lines are ordinary least-squares fits against calendar day, so gaps between nights are spaced truthfully. With a handful of nights the slope is indicative rather than statistically conclusive — the point is the direction, and the absence of improvement.`;
  el('meta').textContent = `${dba.length} dBA nights, ${dbc.length} dBC nights · ${fmtDate(dba[0].iso)}–${fmtDate(dba[dba.length - 1].iso)}`;
}

boot();

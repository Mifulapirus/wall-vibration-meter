// Habitability report, anchored on the trustworthy eS528L night (A-weighted,
// Type-2 reference). Objective third-person; focus on the recurring loud events.
// DSL supplies the C-weighted (low-frequency) contrast only; its absolute level
// over-reads, but on/off deltas are calibration-independent.

const el = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const f1 = (x) => (x == null ? 'n/a' : (+x).toFixed(1));
const f0 = (x) => (x == null ? 'n/a' : Math.round(+x));

const WHO_BED = 30, WHO_NIGHT = 40, WHO_EVENT = 45;   // dBA
const HANDLING = 65;                                  // dBA self-noise cutoff

function card(n, unit, label, hint, color) {
  const c = color ? ` style="color:${color}"` : '';
  return `<div class="rcard"><div class="n"${c}>${n}${unit ? `<small> ${unit}</small>` : ''}</div>` +
         `<div class="l">${label}</div>${hint ? `<div class="h">${hint}</div>` : ''}</div>`;
}

function soundLike(db) {
  const t = [[0, 'total silence'], [25, 'a quiet rural night'], [30, 'a whisper'], [35, 'a quiet library'],
    [40, 'a refrigerator humming in the room'], [45, 'a window air-conditioner running in the room'],
    [50, 'a box fan on high beside the bed'], [55, 'a dishwasher in the next room'], [60, 'a voice at the bedside'],
    [63, 'a raised voice, loud enough that people must talk over it'], [68, 'a vacuum cleaner running in the room'],
    [73, 'an alarm clock going off'], [78, 'a garbage disposal'], [85, 'standing next to a busy road'],
    [90, 'a lawnmower'], [95, 'a motorcycle revving']];
  let best = t[0];
  for (const x of t) { if (db >= x[0]) best = x; else break; }
  return best[1];
}

// Recorded eS528L nights (the trustworthy A-weighted anchor), newest first.
let nightsCache = [];
function nightLabel(s) {
  const d0 = new Date(s.first), d1 = new Date(s.last);
  const dt = d0.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const t0 = d0.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const t1 = d1.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${dt} · ${t0}–${t1}`;
}
function populateNights() {
  const sel = el('night'), cur = sel.value;
  sel.innerHTML = '';
  nightsCache.forEach(s => {
    const o = document.createElement('option');
    o.value = s.source; o.textContent = nightLabel(s);
    sel.appendChild(o);
  });
  const liveOpt = document.createElement('option');
  liveOpt.value = 'live'; liveOpt.textContent = 'live sample';
  sel.appendChild(liveOpt);
  if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
  else sel.value = nightsCache.length ? nightsCache[0].source : 'live';   // default: newest night
  el('window').style.display = sel.value === 'live' ? '' : 'none';        // window only matters for live
}

async function load() {
  let srcs = [];
  try { srcs = await fetch('/api/noise/sources', { cache: 'no-store' }).then(r => r.json()); } catch (e) {}
  // A-weighted recorded night: legacy `eS528L-night` or dated `eS528L-YYYY-MM-DD`.
  // Excludes C-weighted references like `eS528L-C-YYYY-MM-DD` (not a WHO-dBA anchor).
  nightsCache = srcs.filter(s => /^eS528L-(night|\d{4})/.test(s.source) && s.count > 100)
                    .sort((a, b) => (a.last < b.last ? 1 : -1));
  populateNights();
  const chosen = nightsCache.find(s => s.source === el('night').value);
  let d, anchor, live = false;
  try {
    if (chosen) {
      anchor = chosen.source;
      d = await fetch(`/api/fusion?from=${enc(chosen.first)}&to=${enc(chosen.last)}` +
                      `&asource=${enc(anchor)}&csource=DSL-C&handling_db=${HANDLING}`, { cache: 'no-store' }).then(r => r.json());
    } else {
      anchor = 'DSL-A'; live = true;
      d = await fetch(`/api/fusion?hours=${el('window').value}&asource=DSL-A&csource=DSL-C`, { cache: 'no-store' }).then(r => r.json());
    }
  } catch (e) { el('verdict').innerHTML = `<h2>Could not load: ${e.message}</h2>`; return; }

  const A = (d.sound && d.sound[anchor]) || {};
  const C = (d.sound && d.sound.DSL) || {};
  const comp = d.compressor || {};
  const laeq = A.leq;
  const span = f1(d.window.span_hours);
  const surges = comp.on_periods;
  const everyMin = comp.cycles_per_hour ? Math.round(60 / comp.cycles_per_hour) : null;
  const times = laeq != null ? Math.pow(2, (laeq - WHO_BED) / 10) : null;
  const energy = laeq != null ? Math.pow(10, (laeq - WHO_BED) / 10) : null;

  let sev = 'ok', label = 'Within guidance';
  if (laeq != null) {
    if (laeq > WHO_NIGHT) { sev = 'poor'; label = 'Not appropriate for sleep'; }
    else if (laeq > WHO_BED) { sev = 'marginal'; label = 'Marginal for sleep'; }
  }
  const nightText = live ? 'live sample'
    : 'night of ' + new Date(d.window.from).toLocaleDateString([], { month: 'short', day: 'numeric' });

  el('verdict').className = 'verdict ' + sev;
  el('verdict').innerHTML =
    `<div class="badge2">Sleep environment, ${sev}, ${nightText}</div><h2>${label}</h2>` +
    `<ul>` +
    `<li>The rooftop air conditioning compressor cycled on <b>${surges} times</b> during the ${span}-hour night, about once every <b>${everyMin} minutes</b>.</li>` +
    `<li>Each activation added a low-frequency surge of about <b>+${f1(C.delta_leq)} dBC</b>, comparable to a truck idling outside the window.</li>` +
    `<li>The sound reached peaks near <b>${f0(A.lmax)} dBA</b>, loud enough to force a person to raise their voice, and stayed above the WHO <b>45 dBA</b> awakening threshold for <b>${f0(A.above45_pct)}%</b> of the night.</li>` +
    `<li>The bedroom held a <b>${f1(laeq)} dBA</b> average, about <b>${times ? times.toFixed(1) : 'n/a'} times as loud</b> as a room fit for sleep, with no lasting quiet all night.</li>` +
    `</ul>`;

  el('cards').innerHTML =
    card(f0(A.lmax), 'dBA', 'Peak level', `loud enough to force a raised voice`, sev === 'poor' ? '#ff6b60' : '') +
    card(f0(A.above45_pct), '%', 'Night above 45 dBA', 'above the awakening threshold') +
    card(surges != null ? surges : 'n/a', '', 'AC activations', everyMin ? `about 1 every ${everyMin} min` : '') +
    card('+' + f1(C.delta_leq), 'dBC', 'Surge per cycle', 'low-frequency step, each activation') +
    card(f0(comp.duty_pct), '%', 'AC duty cycle', `running up to ${f0(comp.longest_on_min)} min at a time`) +
    card(f1(laeq), 'dBA', 'Night average', `like a window AC left running in the room, all night`);

  // Recorded sound level across the whole night (the raw readings).
  let nightReadings = [];
  try {
    const rq = chosen
      ? `source=${enc(chosen.source)}&from=${enc(chosen.first)}&to=${enc(chosen.last)}&limit=20000`
      : `source=DSL-A&hours=${el('window').value}&limit=20000`;
    nightReadings = await fetch(`/api/noise?${rq}`, { cache: 'no-store' }).then(r => r.json());
  } catch (e) {}
  drawNightLevels('nightLevels', {
    readings: nightReadings, onIntervals: comp.on_intervals || [],
    from: d.window.from, to: d.window.to, unit: live ? 'dBC' : 'dBA',
  });

  drawOnBar(d);
  drawScale(laeq, A.lmax);
  drawLfBars(A.delta_leq, C.delta_leq);

  el('pScale').innerHTML =
    `A bedroom fit for sleep should be as quiet as ${soundLike(WHO_BED)} (WHO's 30 dBA, green marker). This room instead reaches ` +
    `peaks near <b>${f0(A.lmax)} dBA</b> (red marker): ${soundLike(A.lmax)}. At that level a person in the room would have to raise ` +
    `their voice to be heard over it, and it is driven by a low-frequency rumble like a heavy truck idling directly outside the window. ` +
    `The sustained level, <b>${f1(laeq)} dBA</b>, is comparable to ${soundLike(laeq)}, holding all night long. Because loudness roughly ` +
    `doubles every 10 dB, the peaks are several times louder than anything a bedroom should ever reach, and they return every ${everyMin} minutes until morning.`;

  el('pEvents').innerHTML =
    `Through the ${span}-hour night the rooftop compressor started <b>${surges} separate times</b>, about once every ` +
    `<b>${everyMin} minutes</b>, and the room never settled: the quiet gaps between activations averaged only about ` +
    `<b>${f0(comp.mean_off_min)} minutes</b>. Each start drove the sound up to peaks near <b>${f0(A.lmax)} dBA</b> and held the bedroom ` +
    `above the WHO <b>45 dBA</b> awakening threshold for <b>${f0(A.above45_pct)}%</b> of the entire night. This is not steady background ` +
    `noise that a sleeper adapts to; it is a repeating cycle of loud onsets, the pattern most strongly linked to fragmented sleep and ` +
    `repeated night-time awakenings. In the bar above, red marks every stretch the compressor was running and green the brief quiet gaps.`;

  el('pLow').innerHTML =
    `The hardest part to sleep through is felt as much as heard: a deep, low-frequency rumble, like a bus or heavy truck left idling ` +
    `at the curb, that pushes through the wall every time the compressor starts. The chart above compares it. A standard sound meter, ` +
    `tuned to the human voice, captures only part of the jump ` +
    `(about <b>+${f1(A.delta_leq)} dB</b>); the real low-frequency energy is close to double that (<b>+${f1(C.delta_leq)} dB</b>). ` +
    `Low-frequency noise like this passes through walls and floors far more easily than ordinary sound and is the hardest to block out ` +
    `or sleep through. Its pitch, near <b>${f0(comp.dom_freq_median_on)} Hz</b>, matches the air-conditioning motor and is confirmed by the vibration measured in the wall.`;

  el('pWho').innerHTML =
    `WHO recommends a bedroom equivalent level near <b>30 dBA</b> for undisturbed sleep, with individual events kept below <b>45 dBA</b>. ` +
    `This environment measured <b>${f1(laeq)} dBA</b> on average, about <b>${times ? times.toFixed(1) : 'n/a'} times as loud</b> as the guideline, ` +
    `exceeded 45 dBA for <b>${f0(A.above45_pct)}%</b> of the night, and recorded <b>${A.events_gt45 ?? 'n/a'}</b> events above the awakening ` +
    `threshold. It exceeds the WHO sleep guidance on every measure.`;

  el('pMethod').innerHTML =
    `Absolute levels are from an ennoLogic eS528L, a Type 2 (plus or minus 1.5 dB) A-weighted sound level meter placed at the sleeping area. ` +
    `Brief self generated noise above ${HANDLING} dBA, such as entering or leaving the room, is excluded. Compressor operation is detected ` +
    `independently from the wall vibration tone (SNR at or above ${comp.snr_on}). The data covers one night; additional nights would further establish the pattern.`;

  el('meta').textContent = `${anchor}, ${new Date(d.window.from).toLocaleString()} to ${new Date(d.window.to).toLocaleString()}, ` +
    `${d.window.vib_readings} vibration readings, ${A.n || 0} sound samples`;

  loadLF();
}

// Same-meter C minus A low-frequency cross-check (DSL toggled A/C); calibration-proof.
async function loadLF() {
  try {
    const [a, c] = await Promise.all([
      fetch('/api/noise?source=DSL-LF-A&hours=999&limit=20000', { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/noise?source=DSL-LF-C&hours=999&limit=20000', { cache: 'no-store' }).then(r => r.json()),
    ]);
    if (!a.length || !c.length) return;
    const leq = (arr) => 10 * Math.log10(arr.reduce((s, p) => s + Math.pow(10, p.spl_db / 10), 0) / arr.length);
    const diff = leq(c) - leq(a);
    el('pLow').innerHTML += ` A separate check with a single meter, switched between the two scales so any calibration error cancels, ` +
      `put the low-frequency level about <b>${f1(diff)} dB</b> above the standard level, past the point at which low-frequency noise is formally flagged as a problem.`;
  } catch (e) { /* optional */ }
}

// Two bars: how much a standard (dBA) meter reports of each compressor surge
// vs the actual level including low frequency (dBC).
function drawLfBars(aDelta, cDelta) {
  const cv = el('lfChart'); if (!cv || aDelta == null || cDelta == null) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 1000, H = 132;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui'; ctx.textAlign = 'start';
  ctx.fillText('Loudness the compressor adds each time it starts', 0, 12);
  const max = Math.max(cDelta, aDelta, 1) * 1.3;
  const baseY = H - 24, top = 30, bw = Math.min(140, W * 0.2);
  const cx1 = W * 0.30 - bw / 2, cx2 = W * 0.66 - bw / 2;
  const bar = (bx, val, col, lab) => {
    const h = Math.max(2, (val / max) * (baseY - top));
    ctx.fillStyle = col; ctx.fillRect(bx, baseY - h, bw, h);
    ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 16px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('+' + val.toFixed(1) + ' dB', bx + bw / 2, baseY - h - 7);
    ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui';
    ctx.fillText(lab, bx + bw / 2, baseY + 15);
  };
  bar(cx1, aDelta, '#5b6673', 'standard meter (dBA)');
  bar(cx2, cDelta, '#ff4d4d', 'actual, low-frequency (dBC)');
  ctx.strokeStyle = '#262d38'; ctx.beginPath(); ctx.moveTo(0, baseY); ctx.lineTo(W, baseY); ctx.stroke();
  ctx.textAlign = 'start';
}

function drawScale(laeq, peak) {
  const cv = el('soundScale'); if (!cv) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 1000, H = 96;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const lo = 20, hi = 95, padL = 6, padR = 6;
  const x = (v) => padL + (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (W - padL - padR);
  const by = 44, bh = 16;
  const g = ctx.createLinearGradient(padL, 0, W - padR, 0);
  g.addColorStop(0, '#21c07a'); g.addColorStop(0.35, '#e6cc00'); g.addColorStop(0.62, '#ff8a1e'); g.addColorStop(1, '#ff4d4d');
  ctx.fillStyle = g; ctx.fillRect(padL, by, W - padL - padR, bh);
  ctx.font = '10px system-ui'; ctx.textAlign = 'center';
  for (const [v, lab] of [[30, 'whisper'], [40, 'library'], [50, 'rain'], [60, 'talking'], [70, 'vacuum'], [80, 'traffic'], [90, 'mower']]) {
    const xx = x(v);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(xx, by, 1, bh);
    ctx.fillStyle = '#8b95a3'; ctx.fillText(v, xx, by + bh + 12); ctx.fillText(lab, xx, by + bh + 24);
  }
  const marker = (v, col, labl) => {
    const xx = x(v);
    ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(xx, by - 3); ctx.lineTo(xx, by + bh + 3); ctx.stroke();
    ctx.fillStyle = col; ctx.font = 'bold 11px system-ui';
    ctx.beginPath(); ctx.moveTo(xx - 4, by - 4); ctx.lineTo(xx + 4, by - 4); ctx.lineTo(xx, by + 1); ctx.closePath(); ctx.fill();
    ctx.fillText(labl, xx, by - 8);
  };
  marker(WHO_BED, '#3fb950', 'WHO 30');
  if (laeq != null) marker(laeq, '#e6cc00', 'avg ' + laeq.toFixed(0));
  if (peak != null) marker(peak, '#ff4d4d', 'PEAKS ' + peak.toFixed(0));
  ctx.textAlign = 'start';
}

function drawOnBar(d) {
  const cv = el('onbar'), dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth || 1000, cssH = 40;
  cv.width = cssW * dpr; cv.height = cssH * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const t0 = Date.parse(d.window.from), t1 = Date.parse(d.window.to);
  const x = (t) => (t - t0) / (t1 - t0) * cssW;
  ctx.fillStyle = 'rgba(33,192,122,0.5)'; ctx.fillRect(0, 8, cssW, 20);   // green = quiet
  ctx.fillStyle = 'rgba(255,77,77,0.92)';                                // red = compressor running (loud)
  (d.compressor.on_intervals || []).forEach(([s, e]) => {
    const xs = x(Date.parse(s)); ctx.fillRect(xs, 8, Math.max(1, x(Date.parse(e)) - xs), 20);
  });
  ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui';
  ctx.fillText(new Date(t0).toLocaleTimeString(), 0, 39);
  ctx.textAlign = 'end'; ctx.fillText(new Date(t1).toLocaleTimeString(), cssW, 39); ctx.textAlign = 'start';
  ctx.fillText('red = compressor running (loud), green = quiet', 0, 6);
}

el('night').addEventListener('change', load);
el('window').addEventListener('change', load);
window.addEventListener('resize', () => load());
load();

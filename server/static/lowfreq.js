// Low-Frequency Noise Report — a focused companion to /report.
// The case for low-frequency dominance rests on two calibration-independent
// measurements: (1) the C-minus-A gap from the SAME meter switched between the
// A and C scales (a constant calibration error cancels in the difference), and
// (2) the tonal frequencies of the wall vibration the compressor drives. Both
// are things an ordinary dBA reading throws away. Vanilla canvas, no libs.

const el = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const f1 = (x) => (x == null ? 'n/a' : (+x).toFixed(1));
const f0 = (x) => (x == null ? 'n/a' : Math.round(+x));

// C-A difference criteria: >15 dB flags a low-frequency problem (Broner &
// Roberts; UK DEFRA NANR45 rating method), >20 dB is strongly LF-dominant.
const CA_FLAG = 15, CA_STRONG = 20;
const TONES = [28, 58, 120];   // compressor lines we expect (4-pole, 2-pole fund., 2-pole 2nd harmonic)
const G = 9.80665;

const leqOf = (arr) => {
  const v = arr.map(p => p.spl_db).filter(x => x != null);
  return v.length ? 10 * Math.log10(v.reduce((s, x) => s + Math.pow(10, x / 10), 0) / v.length) : null;
};

// ---- night selector (shared shape with /report) ---------------------------
let nightsCache = [];
function nightLabel(s) {
  const d0 = new Date(s.first), d1 = new Date(s.last);
  return `${d0.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ` +
         `${d0.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–` +
         `${d1.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
function populateNights() {
  const sel = el('night'), cur = sel.value;
  sel.innerHTML = '';
  nightsCache.forEach(s => {
    const o = document.createElement('option'); o.value = s.source; o.textContent = nightLabel(s); sel.appendChild(o);
  });
  if (!nightsCache.length) { const o = document.createElement('option'); o.value = ''; o.textContent = '(no recorded nights)'; sel.appendChild(o); }
  if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
  else if (nightsCache.length) sel.value = nightsCache[0].source;
}

const card = (n, unit, label, hint, color) =>
  `<div class="rcard"><div class="n"${color ? ` style="color:${color}"` : ''}>${n}${unit ? `<small> ${unit}</small>` : ''}</div>` +
  `<div class="l">${label}</div>${hint ? `<div class="h">${hint}</div>` : ''}</div>`;

// ---- load -----------------------------------------------------------------
async function load() {
  let srcs = [];
  try { srcs = await fetch('/api/noise/sources', { cache: 'no-store' }).then(r => r.json()); } catch (e) {}
  nightsCache = srcs.filter(s => /^eS528L-/.test(s.source) && s.count > 100).sort((a, b) => (a.last < b.last ? 1 : -1));
  populateNights();
  const chosen = nightsCache.find(s => s.source === el('night').value);

  // (1) Same-meter C-A reference (DSL toggled A/C) — definitive, calibration-proof.
  let la = null, lc = null, ca = null;
  try {
    const [a, c] = await Promise.all([
      fetch('/api/noise?source=DSL-A&hours=999999&limit=20000', { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/noise?source=DSL-C&hours=999999&limit=20000', { cache: 'no-store' }).then(r => r.json()),
    ]);
    la = leqOf(a); lc = leqOf(c);
    if (la != null && lc != null) ca = lc - la;
  } catch (e) {}

  // (2) Per-night: compressor on/off deltas (LF excess) + tonal content.
  let d = null, units = [], spectra = [];
  if (chosen) {
    const win = `from=${enc(chosen.first)}&to=${enc(chosen.last)}`;
    try { d = await fetch(`/api/fusion?${win}&asource=${enc(chosen.source)}&csource=DSL&handling_db=65`, { cache: 'no-store' }).then(r => r.json()); } catch (e) {}
    try { units = await fetch(`/api/units?${win}&limit=8000`, { cache: 'no-store' }).then(r => r.json()); } catch (e) {}
    try { spectra = await fetch(`/api/spectra?${win}&limit=250`, { cache: 'no-store' }).then(r => r.json()); } catch (e) {}
  }
  render({ chosen, la, lc, ca, d, units, spectra });
}

function unitStat(units, key) {
  const v = units.map(r => r[key]).filter(x => x != null);
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  return { median: v[Math.floor(v.length / 2)], peak: v[v.length - 1] };
}

function render({ chosen, la, lc, ca, d, units, spectra }) {
  const A = (d && d.sound && d.sound[chosen && chosen.source]) || {};
  const C = (d && d.sound && d.sound.DSL) || {};
  const comp = (d && d.compressor) || {};
  const lfExcess = (A.delta_leq != null && C.delta_leq != null) ? (C.delta_leq - A.delta_leq) : null;
  const domHz = comp.dom_freq_median_on;
  const u120 = unitStat(units, 'u120'), u58 = unitStat(units, 'u58'), u28 = unitStat(units, 'u28');
  const strongest = [['120', u120], ['58', u58], ['28', u28]]
    .filter(x => x[1]).sort((a, b) => b[1].peak - a[1].peak)[0];

  // verdict severity from the same-meter C-A gap
  let sev = 'ok', headline = 'Not low-frequency dominant';
  if (ca != null) {
    if (ca >= CA_STRONG) { sev = 'poor'; headline = 'Strongly low-frequency dominant'; }
    else if (ca >= CA_FLAG) { sev = 'poor'; headline = 'Low-frequency dominant'; }
    else if (ca >= 10) { sev = 'marginal'; headline = 'Elevated low-frequency content'; }
  }
  const nightText = chosen ? 'night of ' + new Date(chosen.first).toLocaleDateString([], { month: 'short', day: 'numeric' }) : 'reference measurement';

  el('verdict').className = 'verdict ' + sev;
  el('verdict').innerHTML =
    `<div class="badge2">Low-frequency assessment, ${sev}, ${nightText}</div><h2>${headline}</h2>` +
    `<ul>` +
    `<li>Measured on one meter switched between the two scales, the sound carried about <b>${f1(ca)} dB more energy on the C scale than the A scale</b> — past the <b>${CA_FLAG} dB</b> line at which noise is formally rated low-frequency-dominated.</li>` +
    (lfExcess != null ? `<li>Each time the compressor started, it added <b>+${f1(C.delta_leq)} dB</b> to the full-spectrum (C) level but only <b>+${f1(A.delta_leq)} dB</b> to the A-weighted level — so about <b>${f1(lfExcess)} dB</b> of every activation is low-frequency energy a standard meter discards.</li>` : '') +
    (domHz ? `<li>The disturbance is <b>tonal</b>, concentrated near <b>${f0(domHz)} Hz</b> (plus lines at ~58 and ~28 Hz) — the air-conditioning motor's pitch, confirmed in the wall vibration.</li>` : '') +
    `<li>Low-frequency noise like this passes through walls and floors that stop ordinary sound, and is felt as much as heard — the pattern most resistant to sleep.</li>` +
    `</ul>`;

  el('cards').innerHTML =
    card(f1(ca), 'dB', 'C − A difference', `same meter, A vs C scale · ${CA_FLAG} dB = LF problem`, sev === 'poor' ? '#ff6b60' : '') +
    (lfExcess != null ? card('+' + f1(lfExcess), 'dB', 'Hidden by dBA', 'low-frequency part of each AC surge') : '') +
    (domHz ? card(f0(domHz), 'Hz', 'Dominant tone', 'compressor pitch in the wall') : '') +
    (strongest ? card(f1(strongest[1].peak), 'mg', `Strongest wall line (~${strongest[0]} Hz)`, 'peak vibration amplitude') : '') +
    (lc != null ? card(f0(lc), 'dBC', 'Full-spectrum level', 'C-weighted (includes low frequency)') : '');

  drawCA(la, lc);
  drawSpectrum(spectra);

  el('pWhy').innerHTML =
    `A-weighting (dBA) is built to match the ear's reduced sensitivity to low pitches, so it deliberately discounts energy below a few hundred hertz — by roughly <b>30-40 dB</b> at these frequencies. That is reasonable for speech-range noise, but this disturbance lives almost entirely in the low frequencies A-weighting throws away. Reading the <b>same meter</b> on both scales (so any calibration error cancels) gave <b>${f1(la)} dBA</b> but <b>${f1(lc)} dBC</b> — a <b>${f1(ca)} dB gap</b>. A C-minus-A difference above <b>${CA_FLAG} dB</b> is the standard flag for a low-frequency noise problem` +
    (ca != null && ca >= CA_STRONG ? `, and above <b>${CA_STRONG} dB</b> it is considered strongly low-frequency-dominant — which this is.` : `.`) +
    ` In short, a dBA number alone materially understates how loud and disturbing this noise actually is.`;

  const tone = strongest ? strongest[0] : (domHz ? f0(domHz) : '120');
  el('pTonal').innerHTML =
    `The chart above is the average vibration the compressor drives into the bedroom wall, by frequency. Rather than a broad hiss, the energy piles up into a few sharp <b>tones</b> — the strongest near <b>~${tone} Hz</b>, with companions around <b>58 Hz</b> and <b>28 Hz</b>. These are the running speeds and harmonics of the rooftop air-conditioning motors` +
    (u120 && u58 ? ` (peak wall amplitudes about <b>${f1(u120.peak)} mg</b> at 120 Hz and <b>${f1(u58.peak)} mg</b> at 58 Hz)` : '') +
    `. Discrete tones like these are singled out in every noise standard for an added penalty (typically <b>+3 to +6 dB</b>) because a pure tone is far more noticeable and annoying than the same energy spread across a broad band — and far harder to ignore or sleep through.`;

  el('pBehave').innerHTML =
    `Low-frequency noise does not behave like everyday sound. It is <b>structure-borne</b>: the compressor's vibration travels through the building frame — the very path measured here in the wall — rather than through the open air, so the walls, windows and insulation that block ordinary sound do little to stop it (those barriers attenuate high frequencies well and low frequencies poorly). Its long wavelengths <b>diffract around and pass through</b> partitions, and it is <b>felt as much as heard</b> — a pressure or rumble that can rattle objects and is perceived in the body, not just the ears. It is also the hardest noise to mask or adapt to, and the type most consistently linked in the research to disturbed, fragmented sleep even at modest A-weighted levels.`;

  el('pStandards').innerHTML =
    `<ul>` +
    `<li><b>WHO (Guidelines for Community Noise):</b> states that when "prominent low-frequency components are present, noise measures based on A-weighting are inappropriate," and that lower guideline limits should apply.</li>` +
    `<li><b>C-minus-A screening (Broner &amp; Roberts; UK DEFRA NANR45):</b> a C-weighted minus A-weighted difference greater than <b>${CA_FLAG}-${CA_STRONG} dB</b> indicates a low-frequency noise problem. This measured <b>${f1(ca)} dB</b>.</li>` +
    `<li><b>DIN 45680 / Danish &amp; Swedish LF methods:</b> assess low-frequency noise in one-third-octave bands from ~10-160 Hz against a dedicated low-frequency limit curve, with a tonal penalty. The dominant lines here (~${tone}, 58, 28 Hz) fall squarely in that range.</li>` +
    `</ul>`;

  el('pMethod').innerHTML =
    `The C-minus-A difference is measured on a single sound-level meter switched between the A and C weightings, so any calibration offset cancels in the difference (the absolute levels are not relied on). The tonal content is the wall vibration measured by an accelerometer on the bedroom wall, analysed by frequency; the compressor's on/off state is detected independently from that vibration. Handling noise (entering/leaving the room) is excluded. Levels above are indicative; a formal case would add a one-third-octave low-frequency measurement against the DIN 45680 curve.`;

  el('meta').textContent = (chosen ? `${chosen.source} · ${new Date(chosen.first).toLocaleString()} → ${new Date(chosen.last).toLocaleString()} · ` : '') +
    `C-A reference: DSL-A/DSL-C same-meter capture`;
}

// ---- C vs A bars (same meter) ---------------------------------------------
function drawCA(la, lc) {
  const cv = el('caChart'), dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 1000, H = 150;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (la == null || lc == null) { ctx.fillStyle = '#8b95a3'; ctx.font = '12px system-ui'; ctx.fillText('no A/C reference capture found', 8, H / 2); return; }
  ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui'; ctx.textAlign = 'start';
  ctx.fillText('Same meter, same noise, two scales', 0, 12);
  const max = Math.max(la, lc, 1) * 1.15;
  const baseY = H - 22, top = 28, bw = Math.min(150, W * 0.22);
  const cx1 = W * 0.30 - bw / 2, cx2 = W * 0.66 - bw / 2;
  const bar = (bx, val, col, lab) => {
    const h = Math.max(2, (val / max) * (baseY - top));
    ctx.fillStyle = col; ctx.fillRect(bx, baseY - h, bw, h);
    ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 17px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(val.toFixed(1) + ' dB', bx + bw / 2, baseY - h - 7);
    ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui'; ctx.fillText(lab, bx + bw / 2, baseY + 15);
  };
  bar(cx1, la, '#5b6673', 'A-weighted (dBA)');
  bar(cx2, lc, '#ff4d4d', 'C-weighted (dBC)');
  // gap bracket
  const yA = baseY - (la / max) * (baseY - top), yC = baseY - (lc / max) * (baseY - top);
  const gx = cx2 + bw + 12;
  ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 1.5; ctx.beginPath();
  ctx.moveTo(gx, yC); ctx.lineTo(gx + 8, yC); ctx.lineTo(gx + 8, yA); ctx.lineTo(gx, yA); ctx.stroke();
  ctx.fillStyle = '#ffd24a'; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'start';
  ctx.fillText(`+${(lc - la).toFixed(1)} dB`, gx + 12, (yA + yC) / 2 + 4);
  ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui';
  ctx.fillText('low-frequency', gx + 12, (yA + yC) / 2 + 19);
  ctx.textAlign = 'start';
}

// ---- averaged vibration spectrum ------------------------------------------
function drawSpectrum(spectra) {
  const cv = el('specChart'), dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 1000, H = 240;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const padL = 44, padR = 12, padT = 14, padB = 28;
  if (!spectra || !spectra.length) { ctx.fillStyle = '#8b95a3'; ctx.font = '12px system-ui'; ctx.fillText('no vibration spectra for this night', padL, H / 2); return; }

  const binHz = spectra[0].bin_hz || 0.78125;
  const n = spectra[0].n_bins || spectra[0].values.length;
  const FMAX = 200;
  const kMax = Math.min(n - 1, Math.round(FMAX / binHz));
  // mean amplitude per bin, in mg
  const mean = new Float64Array(kMax + 1);
  let cnt = 0;
  for (const s of spectra) {
    if (!s.values || s.values.length < kMax) continue;
    for (let k = 0; k <= kMax; k++) mean[k] += s.values[k];
    cnt++;
  }
  if (!cnt) { ctx.fillStyle = '#8b95a3'; ctx.fillText('no usable spectra', padL, H / 2); return; }
  let vmax = 1e-9;
  for (let k = 1; k <= kMax; k++) { mean[k] = mean[k] / cnt / G * 1000; if (mean[k] > vmax) vmax = mean[k]; }  // mg
  vmax = Math.ceil(vmax / 0.5) * 0.5;

  const x = (hz) => padL + (hz / FMAX) * (W - padL - padR);
  const y = (mg) => (H - padB) - (Math.min(mg, vmax) / vmax) * (H - padT - padB);

  // axes
  ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui'; ctx.strokeStyle = '#20283a'; ctx.lineWidth = 1;
  for (let hz = 0; hz <= FMAX; hz += 40) { const xx = x(hz); ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, H - padB); ctx.stroke(); ctx.textAlign = 'center'; ctx.fillText(hz + (hz === FMAX ? ' Hz' : ''), xx, H - padB + 14); }
  ctx.textAlign = 'start';
  for (let i = 0; i <= 2; i++) { const mg = vmax * i / 2; ctx.fillText(mg.toFixed(1), 4, y(mg) + 3); }
  ctx.fillText('mg', 4, padT + 2);

  // expected tone markers
  ctx.textAlign = 'center';
  for (const t of TONES) {
    if (t > FMAX) continue;
    ctx.strokeStyle = 'rgba(255,210,74,0.35)'; ctx.setLineDash([4, 4]); ctx.beginPath();
    ctx.moveTo(x(t), padT); ctx.lineTo(x(t), H - padB); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#ffd24a'; ctx.fillText(t + ' Hz', x(t), padT - 2 + 12);
  }
  ctx.textAlign = 'start';

  // filled spectrum
  ctx.beginPath(); ctx.moveTo(x(0), H - padB);
  for (let k = 1; k <= kMax; k++) ctx.lineTo(x(k * binHz), y(mean[k]));
  ctx.lineTo(x(kMax * binHz), H - padB); ctx.closePath();
  ctx.fillStyle = 'rgba(53,169,255,0.18)'; ctx.fill();
  ctx.strokeStyle = '#35a9ff'; ctx.lineWidth = 1.4; ctx.beginPath();
  for (let k = 1; k <= kMax; k++) { const xx = x(k * binHz), yy = y(mean[k]); k === 1 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy); }
  ctx.stroke();
}

el('night').addEventListener('change', load);
window.addEventListener('resize', () => load());
load();

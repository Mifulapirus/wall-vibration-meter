// Washer/Dryer repair report. Compares the after-fix cycle against the earlier
// (before-fix) cycles, all on the calibrated eS528L (A-weighted). Light document
// theme, print-friendly. Marks the normal-appliance and hazard levels.

const el = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const f0 = (x) => (x == null || isNaN(x) ? 'n/a' : Math.round(+x));
const leqOf = (v) => (v.length ? 10 * Math.log10(v.reduce((s, x) => s + Math.pow(10, x / 10), 0) / v.length) : null);
const pctl = (v, p) => { const s = [...v].sort((a, b) => a - b); const k = (s.length - 1) * p / 100; const lo = Math.floor(k), hi = Math.min(lo + 1, s.length - 1); return s[lo] + (s[hi] - s[lo]) * (k - lo); };
function fmtDur(sec) { const m = Math.floor(sec / 60), s = Math.round(sec % 60); return m ? `${m}m ${s}s` : `${s}s`; }
const fmtD = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
const tm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Calibrated eS528L dBA washer runs only (no -DSL- infix, A-weighted).
const RUN_RE = /^WD(\d*)-A-(\d{4}-\d{2}-\d{2})$/;
const AFTER_DATE = '2026-07-24';           // the attempted-fix recording
const NORMAL_WASHER = 55, NORMAL_DRYER = 60, HAZARD = 80;

async function runStats(s) {
  const rows = await fetch(`/api/noise?source=${enc(s.source)}&from=${enc(s.first)}&to=${enc(s.last)}&limit=8000`, { cache: 'no-store' }).then(r => r.json());
  const pts = rows.map(r => ({ t: Date.parse(r.ts), db: r.spl_db })).filter(p => p.db != null).sort((a, b) => a.t - b.t);
  const v = pts.map(p => p.db); if (!v.length) return null;
  const date = RUN_RE.exec(s.source)[2];
  return { src: s.source, date, after: date >= AFTER_DATE, pts, leq: leqOf(v), l50: pctl(v, 50), peak: Math.max(...v), over80: v.filter(x => x > 80).length, from: pts[0].t, to: pts[pts.length - 1].t };
}

async function boot() {
  let srcs;
  try { srcs = await fetch('/api/noise/sources', { cache: 'no-store' }).then(r => r.json()); }
  catch (e) { el('verdict').innerHTML = '<h2>Could not load the recordings.</h2>'; return; }
  const runsSrc = srcs.filter(s => RUN_RE.test(s.source) && s.count > 50);
  const runs = (await Promise.all(runsSrc.map(runStats))).filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : 1));
  const after = runs.filter(r => r.after).sort((a, b) => b.to - a.to)[0];
  const before = runs.filter(r => !r.after);
  if (!after) { el('verdict').innerHTML = '<h2>No after-fix recording found yet.</h2>'; return; }
  const worst = before.reduce((m, r) => ((!m || r.peak > m.peak) ? r : m), null);
  const good = after.peak <= NORMAL_DRYER;

  el('verdict').className = 'report verdict' + (good ? ' good' : '');
  el('verdict').innerHTML = worst
    ? `<h2>${good ? 'The repair brought the unit into the normal range' : 'The repair helped, but the unit is still too loud'}</h2>` +
      `<p>The loudest moment dropped from <b>${f0(worst.peak)} dBA</b> (recorded ${fmtD(worst.date)}) to <b>${f0(after.peak)} dBA</b>, about <b>${f0(worst.peak - after.peak)} dB quieter</b>, ` +
      `and the running average fell from <b>${f0(worst.leq)} dBA</b> to <b>${f0(after.leq)} dBA</b>. ` +
      (good
        ? `At these levels the unit is now comparable to a normal washer or dryer.`
        : `That is a large reduction, but at <b>${f0(after.leq)} dBA</b> average and <b>${f0(after.peak)} dBA</b> peak the unit is still well above a normal washer (<b>55 dBA</b>) or dryer (<b>60 dBA</b>), so it remains louder than is acceptable in a living space.`) +
      `</p>`
    : `<h2>After-fix recording captured</h2><p>Peak <b>${f0(after.peak)} dBA</b>, average <b>${f0(after.leq)} dBA</b>. No earlier calibrated cycle is on file to compare against.</p>`;

  el('ba').innerHTML =
    baCard('Loudest moment (peak)', worst ? worst.peak : null, after.peak) +
    baCard('Running average (Leq)', worst ? worst.leq : null, after.leq);

  drawScale(worst, after);
  drawTrace(after);
  el('traceSpan').textContent = after.pts.length ? `(${tm(after.from)}–${tm(after.to)})` : '';

  el('runsBody').innerHTML = runs.map(r =>
    `<tr class="${r.after ? 'after' : ''}"><td>${fmtD(r.date)}${r.after ? ' (after fix)' : ''}</td><td>${f0(r.peak)}</td><td>${f0(r.leq)}</td><td>${fmtDur(r.over80)}</td></tr>`).join('');

  const mins = Math.round((after.to - after.from) / 60000);
  el('method').innerHTML =
    `Levels are from an ennoLogic eS528L Type&nbsp;2 (&plusmn;1.5&nbsp;dB) calibrated sound level meter, A-weighted, recorded once per second at the sleeping area. ` +
    `The after-fix recording is the final part of a cycle (about <b>${mins} minutes</b>, the rinse and spin), not a full cycle, so it captures the loudest phase but not the earlier wash. ` +
    `The earlier cycles were fuller runs, which is why their averages cover more of the quieter phases. ` +
    `Normal-appliance references: a properly working washer is about 55&nbsp;dBA and a dryer about 60&nbsp;dBA; occupational guidance (OSHA/NIOSH) treats sustained exposure above 80&nbsp;dBA as a hearing hazard. Raw time-stamped data is available on request.`;
}

function baCard(lab, before, after) {
  const d = before != null ? before - after : null;
  return `<div class="baCard"><div class="lab">${lab}</div><div class="row">` +
    (before != null ? `<span class="before">${f0(before)}</span>` : '') +
    `<span class="after">${f0(after)}<small> dBA</small></span>` +
    (d != null ? `<span class="delta">${f0(d)} dB quieter</span>` : '') +
    `</div></div>`;
}

// Horizontal reference scale (40..100 dBA) with the normal / louder / hazard
// zones and before + after peak markers.
function drawScale(before, after) {
  const cv = el('scaleCanvas'); if (!cv) return;
  cv.width = 1000; cv.height = 120; const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, 1000, 120);
  const L = 26, R = 26, W = 1000, lo = 40, hi = 100, pw = W - L - R, barY = 58, barH = 24;
  const x = (v) => L + (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * pw;
  const zone = (a, b, col) => { ctx.fillStyle = col; ctx.fillRect(x(a), barY, x(b) - x(a), barH); };
  zone(lo, 60, '#d4eddb'); zone(60, 80, '#f6e6c6'); zone(80, hi, '#f4d2cf');
  ctx.font = '10.5px system-ui'; ctx.textAlign = 'center';
  ctx.fillStyle = '#2f7d4f'; ctx.fillText('normal appliance', x(50), barY + barH - 8);
  ctx.fillStyle = '#a9740f'; ctx.fillText('louder than normal', x(70), barY + barH - 8);
  ctx.fillStyle = '#c0392b'; ctx.fillText('hearing hazard', x(90), barY + barH - 8);
  ctx.fillStyle = '#5c6673'; ctx.font = '11px system-ui';
  for (let v = 40; v <= 100; v += 10) ctx.fillText(v, x(v), barY + barH + 16);
  // normal washer / dryer marks
  ctx.strokeStyle = '#2f7d4f'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.5;
  [NORMAL_WASHER, NORMAL_DRYER].forEach(v => { ctx.beginPath(); ctx.moveTo(x(v), barY); ctx.lineTo(x(v), barY + barH); ctx.stroke(); });
  ctx.setLineDash([]);
  ctx.fillStyle = '#2f7d4f'; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
  ctx.fillText('washer 55 · dryer 60', x(57.5), barY + barH + 32);
  // before/after peak markers (triangles above the bar)
  const tri = (v, col, lab) => {
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x(v), barY - 5); ctx.lineTo(x(v) - 6, barY - 15); ctx.lineTo(x(v) + 6, barY - 15); ctx.closePath(); ctx.fill();
    ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'center'; ctx.fillText(lab, x(v), barY - 20);
  };
  if (before) tri(before.peak, '#c0392b', `before ${f0(before.peak)}`);
  tri(after.peak, '#a9740f', `after ${f0(after.peak)}`);
}

// After-fix level over time, banded by the same normal / louder / hazard zones.
function drawTrace(after) {
  const cv = el('traceCanvas'); if (!cv) return;
  const pts = after.pts; cv.width = 1000; cv.height = 230; const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, 1000, 230);
  if (!pts.length) return;
  const L = 40, R = 14, T = 12, B = 26, W = 1000, H = 230, pw = W - L - R, ph = H - T - B;
  const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
  const dbMax = Math.ceil((Math.max(...pts.map(p => p.db)) + 3) / 10) * 10;
  const dbMin = Math.min(40, Math.floor((Math.min(...pts.map(p => p.db)) - 3) / 10) * 10);
  const x = (t) => L + (t - t0) / (t1 - t0) * pw, y = (v) => (H - B) - (v - dbMin) / (dbMax - dbMin) * (H - T - B);
  const band = (a, b, col) => { const yt = Math.max(T, y(Math.min(b, dbMax))), yb = Math.min(H - B, y(Math.max(a, dbMin))); if (yb - yt > 0.5) { ctx.fillStyle = col; ctx.fillRect(L, yt, W - L - R, yb - yt); } };
  band(-999, 60, 'rgba(47,125,79,0.12)'); band(60, 80, 'rgba(169,116,15,0.15)'); band(80, 999, 'rgba(192,57,43,0.15)');
  ctx.fillStyle = '#5c6673'; ctx.font = '11px system-ui'; ctx.textAlign = 'right';
  for (let v = dbMin; v <= dbMax; v += 10) { ctx.strokeStyle = '#e6eaef'; ctx.beginPath(); ctx.moveTo(L, y(v)); ctx.lineTo(W - R, y(v)); ctx.stroke(); ctx.fillText(v, L - 6, y(v) + 3); }
  ctx.textAlign = 'center';
  for (let i = 0; i <= 6; i++) { const t = t0 + (i / 6) * (t1 - t0); ctx.fillText(tm(t), x(t), H - B + 15); }
  ctx.strokeStyle = '#1a2230'; ctx.lineWidth = 1.2; ctx.beginPath();
  pts.forEach((p, i) => { const px = x(p.t), py = y(p.db); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); ctx.stroke();
  const line = (v, col, lab) => {
    if (v < dbMin || v > dbMax) return;
    ctx.strokeStyle = col; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(L, y(v)); ctx.lineTo(W - R, y(v)); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '11px system-ui'; ctx.textAlign = 'right'; const t = `${lab} (${v})`, w = ctx.measureText(t).width;
    ctx.fillStyle = 'rgba(255,255,255,0.82)'; ctx.fillRect(W - R - w - 6, y(v) - 12, w + 6, 13);
    ctx.fillStyle = col; ctx.fillText(t, W - R - 4, y(v) - 2);
  };
  line(NORMAL_DRYER, '#2f7d4f', 'a normal appliance');
  line(HAZARD, '#c0392b', 'hearing hazard');
  const pk = pts.reduce((m, p) => (p.db > m.db ? p : m), pts[0]);
  ctx.fillStyle = '#c0392b'; ctx.beginPath(); ctx.arc(x(pk.t), y(pk.db), 3.5, 0, 7); ctx.fill();
  ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'left'; ctx.fillText(`peak ${pk.db.toFixed(0)} dBA`, x(pk.t) + 6, y(pk.db) + 3);
}

boot();

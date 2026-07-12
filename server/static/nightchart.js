// Shared "sound level through the night" chart, used by /report and /lowfreq.
// Plots the night's recorded dB readings over time, with the WHO 30/45 dB sleep
// lines, awakening-level moments (>45 dB) shaded red, and the compressor-ON
// periods shaded green behind the trace. Vanilla canvas, no libs.
window.drawNightLevels = function (canvasId, opts) {
  const { readings, onIntervals, from, to, unit } = opts || {};
  const U = unit || 'dBA';
  const cv = document.getElementById(canvasId);
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 1000, H = 210;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const padL = 40, padR = 12, padT = 12, padB = 26;
  const t0 = Date.parse(from), t1 = Math.max(Date.parse(to), t0 + 1);
  const x = (t) => padL + (t - t0) / (t1 - t0) * (W - padL - padR);

  ctx.fillStyle = '#0b0e18'; ctx.fillRect(padL, padT, W - padL - padR, H - padT - padB);
  if (!readings || !readings.length) {
    ctx.fillStyle = '#8b95a3'; ctx.font = '12px system-ui';
    ctx.fillText('no sound-level readings for this night', padL + 8, H / 2); return;
  }

  const WHO_SLEEP = 30, WHO_EVENT = 45;
  let dbMax = WHO_EVENT + 5, dbMin = 25;
  readings.forEach(r => { if (r.spl_db != null) dbMax = Math.max(dbMax, r.spl_db + 3); });
  dbMax = Math.ceil(dbMax / 5) * 5;
  const y = (v) => (H - padB) - ((v - dbMin) / (dbMax - dbMin)) * (H - padT - padB);

  // compressor-ON shading (behind everything)
  ctx.fillStyle = 'rgba(33,192,122,0.16)';
  (onIntervals || []).forEach(([s, e]) => {
    const xs = x(Date.parse(s));
    ctx.fillRect(xs, padT, Math.max(1, x(Date.parse(e)) - xs), H - padT - padB);
  });

  // hour gridlines + labels (local wall-clock)
  ctx.strokeStyle = '#20283a'; ctx.fillStyle = '#8b95a3'; ctx.font = '11px system-ui'; ctx.lineWidth = 1;
  for (let t = new Date(t0); t.getTime() <= t1; t.setHours(t.getHours() + 1)) {
    if (t.getHours() % 2) continue;
    const xx = x(t.getTime());
    ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, H - padB); ctx.stroke();
    ctx.fillText(String(t.getHours()).padStart(2, '0'), xx + 2, H - padB + 13);
  }

  // WHO reference lines
  const dash = (v, col, lbl) => {
    ctx.strokeStyle = col; ctx.setLineDash([5, 4]); ctx.beginPath();
    ctx.moveTo(padL, y(v)); ctx.lineTo(W - padR, y(v)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = col; ctx.fillText(lbl, padL + 4, y(v) - 3);
  };
  if (WHO_EVENT <= dbMax) dash(WHO_EVENT, 'rgba(255,77,77,0.7)', `WHO 45 ${U}`);
  if (WHO_SLEEP >= dbMin) dash(WHO_SLEEP, 'rgba(230,204,0,0.6)', `WHO 30 ${U}`);

  // y ticks
  ctx.fillStyle = '#8b95a3';
  for (let v = dbMin; v <= dbMax; v += 10) ctx.fillText(v + '', 6, y(v) + 3);

  // awakening-level moments (>45) shaded red
  ctx.fillStyle = 'rgba(255,77,77,0.18)';
  readings.forEach(r => {
    if (r.spl_db == null || r.spl_db <= WHO_EVENT) return;
    const xx = x(Date.parse(r.ts));
    ctx.fillRect(xx - 1, y(r.spl_db), 2, y(WHO_EVENT) - y(r.spl_db));
  });

  // the trace
  ctx.strokeStyle = '#35a9ff'; ctx.lineWidth = 1.2; ctx.beginPath(); let started = false;
  readings.forEach(r => {
    if (r.spl_db == null) { started = false; return; }
    const xx = x(Date.parse(r.ts)), yy = y(r.spl_db);
    started ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); started = true;
  });
  ctx.stroke();
};

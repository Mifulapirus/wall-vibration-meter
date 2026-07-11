// Mounting helper: big live coupling meters. Reads /api/live (fresh even while
// paused) so you can hunt for the best wall-contact spot without logging the
// hunting transients to history.
const el = (id) => document.getElementById(id);
const ACCEL_SCALE = 15, ACCEL_FLOOR = 5.5, ACCEL_GOOD = 8.5;   // mg
const BAND_SCALE = 8;                                          // mg
const SNR_SCALE = 20;                                          // x
let device = '', paused = false, peakAccel = 0, peakBand1 = 0, peakSnr = 0;

const setStatus = (t, c) => { const s = el('status'); s.textContent = t; s.className = 'status ' + (c || ''); };
const enc = encodeURIComponent;
const colorFor = (mg) => mg >= ACCEL_GOOD ? '#21c07a' : mg >= 6 ? '#e6cc00' : '#ff4d4d';
const colorSnr = (x) => x >= 5 ? '#21c07a' : x >= 3 ? '#e6cc00' : '#ff4d4d';
const pct = (v, scale) => Math.min(100, Math.max(0, v / scale * 100)) + '%';

async function loadDevices() {
  const devs = await fetch('/api/devices').then(r => r.json());
  const sel = el('device'), cur = sel.value;
  sel.innerHTML = '';
  if (!devs.length) { sel.innerHTML = '<option>no devices</option>'; return; }
  devs.forEach(d => { const o = document.createElement('option'); o.value = d.device_id; o.textContent = d.device_id; sel.appendChild(o); });
  if (cur) sel.value = cur;
  device = sel.value;
}

function renderSession() {
  el('sessionBtn').textContent = paused ? '▶ Resume' : '⏸ Pause';
  el('sessionBtn').classList.toggle('paused', paused);
  el('pausedBadge').style.display = paused ? '' : 'none';
}
async function loadSession() {
  if (!device) return;
  try { paused = !!(await fetch('/api/session/' + enc(device)).then(r => r.json())).paused; renderSession(); } catch (e) {}
}
async function toggleSession() {
  if (!device) return;
  const s = await fetch('/api/session/' + enc(device), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: !paused }),
  }).then(r => r.json());
  paused = !!s.paused; renderSession();
}

async function poll() {
  if (!device) return;
  try {
    const d = await fetch('/api/live/' + enc(device), { cache: 'no-store' }).then(r => r.json());
    if (typeof d.paused === 'boolean' && d.paused !== paused) { paused = d.paused; renderSession(); }
    if (!d.valid) { setStatus('waiting for device…', 'err'); return; }

    const accel = (d.accel_rms_g || 0) * 1000;
    const b1 = (d.band1_rms_g || 0) * 1000;
    const b2 = (d.band2_rms_g || 0) * 1000;
    const snr = d.snr || 0;
    const domAmpMg = (d.dom_amp_ms2 || 0) / 9.80665 * 1000;
    peakAccel = Math.max(peakAccel, accel);
    peakBand1 = Math.max(peakBand1, b1);
    peakSnr = Math.max(peakSnr, snr);

    // strongest signal (SNR) — the hero coupling metric
    el('snr').textContent = snr.toFixed(1);
    el('snr').style.color = colorSnr(snr);
    el('snrFill').style.width = pct(snr, SNR_SCALE);
    el('snrFill').style.background = colorSnr(snr);
    el('snrPeak').style.left = pct(peakSnr, SNR_SCALE);
    el('peakFreq').textContent = (d.dom_freq_hz || 0).toFixed(1);
    el('peakAmp').textContent = domAmpMg.toFixed(1);
    el('snrPeakVal').textContent = peakSnr.toFixed(1);

    el('accel').textContent = accel.toFixed(1);
    el('accel').style.color = colorFor(accel);
    el('accelFill').style.width = pct(accel, ACCEL_SCALE);
    el('accelFill').style.background = colorFor(accel);
    el('accelFloor').style.left = pct(ACCEL_FLOOR, ACCEL_SCALE);
    el('accelPeak').style.left = pct(peakAccel, ACCEL_SCALE);
    el('accelPeakVal').textContent = peakAccel.toFixed(1);

    el('band1').textContent = b1.toFixed(2);
    el('band1Fill').style.width = pct(b1, BAND_SCALE);
    el('band1Peak').style.left = pct(peakBand1, BAND_SCALE);
    el('band1PeakVal').textContent = peakBand1.toFixed(2);

    el('band2').textContent = b2.toFixed(2);
    el('vel').textContent = (d.vel_rms_mm_s || 0).toFixed(2);
    el('freq').textContent = (d.dom_freq_hz || 0).toFixed(1);
    const age = (Date.now() - new Date(d.ts).getTime()) / 1000;
    el('age').textContent = (age < 100 ? age.toFixed(1) : Math.round(age)) + 's';
    el('age').style.color = age > 5 ? '#ff4d4d' : '';
    setStatus(paused ? 'paused — live view' : 'live', 'ok');
  } catch (e) { setStatus('error — ' + e.message, 'err'); }
}

el('device').addEventListener('change', () => { device = el('device').value; peakAccel = peakBand1 = peakSnr = 0; loadSession(); });
el('sessionBtn').addEventListener('click', toggleSession);
el('resetBtn').addEventListener('click', () => { peakAccel = peakBand1 = peakSnr = 0; });

(async function () {
  await loadDevices();
  await loadSession();
  poll();
  setInterval(poll, 1000);
})();

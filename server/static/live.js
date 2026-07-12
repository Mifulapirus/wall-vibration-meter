// Real-time view: poll the Noise API for the live meter sources and show big
// current numbers + a rolling chart. Data is pushed by tools/meter_agent.py /
// meter_gui.py from the PC the USB meters are plugged into.

const SOURCES = [
  { name: 'DSL', color: '#ff8a1e' },
];
const FRESH_S = 6;          // a source is "live" if its newest sample is within this many seconds
const el = (id) => document.getElementById(id);
const enc = encodeURIComponent;

let data = {};              // source -> [{ts(ms), db}]
let windowMin = 10;

// Build the three cards once.
function buildCards() {
  const box = el('cards');
  box.innerHTML = '';
  for (const s of SOURCES) {
    const c = document.createElement('div');
    c.className = 'live-card';
    c.id = 'card-' + s.name;
    c.style.borderTopColor = s.color;
    c.innerHTML =
      `<div class="src" style="color:${s.color}">${s.name}</div>` +
      `<div class="db"><span id="v-${s.name}">--.-</span><small>dB</small></div>` +
      `<div class="sub" id="s-${s.name}">waiting…</div>`;
    box.appendChild(c);
  }
}

async function poll() {
  const hours = windowMin / 60;
  const results = await Promise.all(SOURCES.map(s =>
    fetch(`/api/noise?source=${enc(s.name)}&hours=${hours}&limit=5000`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : [])
      .then(rows => [s.name, rows.map(p => ({ ts: Date.parse(p.ts), db: p.spl_db }))])
      .catch(() => [s.name, []])
  ));
  data = Object.fromEntries(results);
  updateCards();
  draw();
}

function updateCards() {
  const now = Date.now();
  let anyFresh = false, newest = 0;
  for (const s of SOURCES) {
    const arr = data[s.name] || [];
    const card = el('card-' + s.name);
    if (!arr.length) {
      el('v-' + s.name).textContent = '--.-';
      el('s-' + s.name).textContent = 'no data';
      card.classList.add('stale');
      continue;
    }
    const last = arr[arr.length - 1];
    const ageS = (now - last.ts) / 1000;
    newest = Math.max(newest, last.ts);
    const fresh = ageS <= FRESH_S;
    anyFresh = anyFresh || fresh;
    card.classList.toggle('stale', !fresh);
    el('v-' + s.name).textContent = last.db.toFixed(1);
    const dbs = arr.map(p => p.db);
    const min = Math.min(...dbs), max = Math.max(...dbs);
    const ago = ageS < 2 ? 'just now' : `${Math.round(ageS)}s ago`;
    el('s-' + s.name).innerHTML =
      `<b>${min.toFixed(1)}</b>–<b>${max.toFixed(1)}</b> dB · ${arr.length} pts · ${ago}`;
  }
  const state = el('liveState');
  if (anyFresh) {
    state.innerHTML = '<span class="livedot"></span>live';
    state.className = 'status ok';
  } else {
    state.innerHTML = '<span class="livedot off"></span>' + (newest ? 'stale — no recent data' : 'no data');
    state.className = 'status';
  }
  el('meta').textContent = newest
    ? 'last sample ' + new Date(newest).toLocaleTimeString() + ' · window ' + windowMin + ' min'
    : '—';
}

function draw() {
  const cv = el('liveChart');
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth || 1000, cssH = 320;
  cv.width = cssW * dpr; cv.height = cssH * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 42, padR = 12, padT = 12, padB = 24;
  const w = cssW - padL - padR, h = cssH - padT - padB;
  const now = Date.now(), t0 = now - windowMin * 60 * 1000;

  // y-range from all visible points, with sane minimum span.
  let lo = Infinity, hi = -Infinity;
  for (const s of SOURCES) for (const p of (data[s.name] || [])) {
    if (p.ts < t0) continue;
    if (p.db < lo) lo = p.db; if (p.db > hi) hi = p.db;
  }
  if (!isFinite(lo)) { lo = 30; hi = 80; }
  if (hi - lo < 10) { const m = (hi + lo) / 2; lo = m - 5; hi = m + 5; }
  lo = Math.floor(lo - 2); hi = Math.ceil(hi + 2);

  const x = (t) => padL + (t - t0) / (now - t0) * w;
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * h;

  // grid + y labels
  ctx.strokeStyle = '#262d38'; ctx.fillStyle = '#8b95a3';
  ctx.font = '11px system-ui, sans-serif'; ctx.lineWidth = 1;
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const v = lo + (hi - lo) * i / steps, yy = y(v);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + w, yy); ctx.stroke();
    ctx.fillText(v.toFixed(0), 8, yy + 4);
  }
  // x labels (minutes ago)
  ctx.textAlign = 'center';
  for (let m = 0; m <= windowMin; m += Math.max(1, Math.round(windowMin / 5))) {
    const t = now - m * 60000, xx = x(t);
    ctx.fillText(m === 0 ? 'now' : `-${m}m`, xx, cssH - 8);
  }
  ctx.textAlign = 'start';

  // series
  for (const s of SOURCES) {
    const arr = (data[s.name] || []).filter(p => p.ts >= t0);
    if (arr.length < 1) continue;
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.8;
    ctx.beginPath();
    arr.forEach((p, i) => { const px = x(p.ts), py = y(p.db); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
    // dot on the latest point
    const last = arr[arr.length - 1];
    ctx.fillStyle = s.color;
    ctx.beginPath(); ctx.arc(x(last.ts), y(last.db), 3, 0, 7); ctx.fill();
  }
}

el('window').addEventListener('change', (e) => { windowMin = +e.target.value; poll(); });
window.addEventListener('resize', draw);
buildCards();
poll();
setInterval(poll, 2000);

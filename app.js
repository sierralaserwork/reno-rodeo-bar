/* =============================================================================
 * Bar Count + Fill the Boot — app.js
 * Vanilla, dependency-free SPA. Offline-first. No network calls at runtime.
 * Vendored libs (loaded before this file): window.qrcode, window.jsQR, window.XLSX
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * 0. Storage layer — localStorage (state) + IndexedDB (photos), both try/catch
 *    with in-memory fallbacks so it can never throw in a sandbox/preview.
 * ------------------------------------------------------------------------- */
const KEY = 'barcount.v2';
const SNAPKEY = 'barcount.snaps';
const memState = new Map();

function rawGet(k) { try { const v = localStorage.getItem(k); if (v != null) return v; } catch (e) {} return memState.has(k) ? memState.get(k) : null; }
function rawSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { memState.set(k, v); return false; } }
function validShape(s) { return s && typeof s === 'object' && s.settings && Array.isArray(s.days); }

let recoveredFrom = null;   // ISO time of the snapshot we recovered from (banner on boot)
let lastSnapAt = 0;
function readSnaps() { const r = rawGet(SNAPKEY); if (!r) return []; try { const a = JSON.parse(r); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function pushSnapshot(raw, force) {
  const now = Date.now();
  if (!force && now - lastSnapAt < 300000) return; // at most ~ every 5 min
  lastSnapAt = now;
  let snaps = readSnaps();
  // de-dupe: skip if identical to the newest snapshot
  if (snaps.length && snaps[snaps.length - 1].raw === raw) return;
  snaps.push({ t: new Date().toISOString(), raw });
  while (snaps.length > 10) snaps.shift();
  // best-effort write; on quota, trim oldest and retry a few times
  let ok = rawSet(SNAPKEY, JSON.stringify(snaps));
  let guard = 0;
  while (!ok && snaps.length > 1 && guard++ < 12) { snaps.shift(); ok = rawSet(SNAPKEY, JSON.stringify(snaps)); }
}
function newestSnapshot() {
  const snaps = readSnaps();
  for (let i = snaps.length - 1; i >= 0; i--) { try { const s = JSON.parse(snaps[i].raw); if (validShape(s)) return { t: snaps[i].t, state: s, raw: snaps[i].raw }; } catch (e) {} }
  return null;
}

const store = {
  load() {
    const raw = rawGet(KEY);
    if (raw != null) {
      try { const s = JSON.parse(raw); if (validShape(s)) return s; } catch (e) {}
      // The main key is unreadable/corrupt: DON'T silently reset to blank.
      // Preserve the bad bytes, then recover the newest good snapshot.
      try { rawSet(KEY + '.corrupt', raw); } catch (e) {} // one bounded copy of the bad bytes
      const snap = newestSnapshot();
      if (snap) { rawSet(KEY, snap.raw); recoveredFrom = snap.t; return snap.state; } // heal the live key now
      try { rawSet(KEY, JSON.stringify(defaultState())); } catch (e) {} // no snapshot: heal to blank so we don't re-stash every launch
    }
    return null;
  },
  save(state) {
    let raw;
    try { raw = JSON.stringify(state); } catch (e) { return; }
    const ok = rawSet(KEY, raw);
    if (ok) pushSnapshot(raw, false); // don't grow the snapshot blob if the primary write hit quota
  },
  checkpoint() { pushSnapshot(rawGet(KEY) || '', true); },   // force a restore point now
  snapshots() { return readSnaps(); },
};

/* Photos -> IndexedDB, with an in-memory Map fallback. Returns ids; getPhoto -> dataURL */
const memPhotos = new Map();
const photoDB = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open('barcount-photos', 1); }
      catch (e) { return resolve(null); }
      req.onupgradeneeded = () => { try { req.result.createObjectStore('photos'); } catch (e) {} };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return dbp;
  }
  return {
    async put(id, dataURL) {
      const db = await open();
      if (!db) { memPhotos.set(id, dataURL); return id; }
      return new Promise((resolve) => {
        try {
          const tx = db.transaction('photos', 'readwrite');
          tx.objectStore('photos').put(dataURL, id);
          tx.oncomplete = () => resolve(id);
          tx.onerror = () => { memPhotos.set(id, dataURL); resolve(id); };
        } catch (e) { memPhotos.set(id, dataURL); resolve(id); }
      });
    },
    async get(id) {
      if (memPhotos.has(id)) return memPhotos.get(id);
      const db = await open();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction('photos', 'readonly');
          const r = tx.objectStore('photos').get(id);
          r.onsuccess = () => resolve(r.result || null);
          r.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      });
    },
    async all() {
      const out = {};
      for (const [k, v] of memPhotos) out[k] = v;
      const db = await open();
      if (!db) return out;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction('photos', 'readonly');
          const st = tx.objectStore('photos');
          const ks = st.getAllKeys(); const vs = st.getAll();
          tx.oncomplete = () => { (ks.result || []).forEach((k, i) => out[k] = (vs.result || [])[i]); resolve(out); };
          tx.onerror = () => resolve(out);
        } catch (e) { resolve(out); }
      });
    },
  };
})();

/* ---------------------------------------------------------------------------
 * 1. Defaults + state
 * ------------------------------------------------------------------------- */
// Grid is 3-wide, so this order sets the rows:
//   row 1: Jack & Coke · Jack & Diet Coke · Cocktail
//   row 2: Margaritas · Specialty Drink · Wine
//   row 3: Coors Light · Coors Regular · Blue Moon
const DRINKS = ['Jack & Coke', 'Jack & Diet Coke', 'Cocktail',
  'Margaritas', 'Specialty Drink', 'Wine',
  'Coors Light', 'Coors Regular', 'Blue Moon'];
const BEER_DEFAULT = ['Coors Regular', 'Coors Light', 'Blue Moon'];
const DRINK_PRICES = [9, 9, 10, 11, 12, 8, 6, 6, 7]; // aligned to DRINKS order above

const CATALOG_DEFAULT = [
  { name: "Jack Daniel's", unitPrice: 42, recommendedQty: 3 },
  { name: 'Tequila', unitPrice: 38, recommendedQty: 2 },
  { name: 'Triple Sec', unitPrice: 16, recommendedQty: 1 },
  { name: 'Wine (case)', unitPrice: 96, recommendedQty: 2 },
  { name: 'Specialty Base', unitPrice: 34, recommendedQty: 1 },
  { name: 'Vodka', unitPrice: 30, recommendedQty: 2 },
  { name: 'Rum', unitPrice: 32, recommendedQty: 1 },
];
// oz per bottle/case for shrinkage math (best-effort, editable)
const POURS_DEFAULT = [
  { item: "Jack Daniel's", pourOz: 1.5, bottleOz: 33.8 },
  { item: 'Tequila', pourOz: 1.5, bottleOz: 33.8 },
  { item: 'Triple Sec', pourOz: 0.5, bottleOz: 25.4 },
  { item: 'Wine (case)', pourOz: 5, bottleOz: 25.4 * 12 },
  { item: 'Specialty Base', pourOz: 1.5, bottleOz: 33.8 },
  { item: 'Vodka', pourOz: 1.5, bottleOz: 33.8 },
  { item: 'Rum', pourOz: 1.5, bottleOz: 33.8 },
];
// which liquor each drink draws from (for shrinkage expected-use); beer => none
const POUR_MAP_DEFAULT = {
  'Jack & Coke': [["Jack Daniel's", 1.5]],
  'Jack & Diet Coke': [["Jack Daniel's", 1.5]],
  'Margaritas': [['Tequila', 1.5], ['Triple Sec', 0.5]],
  'Specialty Drink': [['Specialty Base', 1.5]],
  'Wine': [['Wine (case)', 5]],
  'Cocktail': [['Vodka', 1.5]],
};

function defaultState() {
  return {
    schema: 2,
    device: { name: '', role: null, kiosk: false, id: uid(), bootMilestone: 0, bootMilestoneDate: '' },
    settings: {
      event: "Reno Rodeo '26",
      numStations: 5,
      nights: 10,
      drinks: DRINKS.slice(),
      drinkPrices: DRINK_PRICES.slice(),
      beer: BEER_DEFAULT.slice(),
      tipEst: 3,           // assumed $ raised per person served (live boot meter)
      catalog: CATALOG_DEFAULT.map((c) => ({ ...c })),
      pours: POURS_DEFAULT.map((p) => ({ ...p })),
      pourMap: JSON.parse(JSON.stringify(POUR_MAP_DEFAULT)),
      boot: { goal: 41500, cause: 'Special Kids Rodeo', pastYears: [{ year: 2024, total: 41500 }, { year: 2023, total: 37400 }] },
      teamPhones: [],
      teamEmails: [],
      adminPin: '4296',
    },
    days: [],            // manager: merged nights
    currentDayId: null,  // manager: selected night
    myShifts: [],        // bartender: this phone's shifts
    myDoor: { buckets: {}, total: 0, taps: [] }, // door: this phone's count
  };
}

function migrate(s) {
  if (!s || typeof s !== 'object') return defaultState();
  const d = defaultState();
  // shallow-merge top level, deep-merge settings, keep arrays from saved
  const out = Object.assign({}, d, s);
  out.device = Object.assign({}, d.device, s.device || {});
  out.settings = Object.assign({}, d.settings, s.settings || {});
  out.settings.boot = Object.assign({}, d.settings.boot, (s.settings && s.settings.boot) || {});
  if (!out.settings.adminPin) out.settings.adminPin = d.settings.adminPin; // always keep a manager PIN set
  if (!out.device.id) out.device.id = uid();                                // stable per-phone id (door merge)
  out.days = Array.isArray(s.days) ? s.days : [];
  out.days.forEach((day) => {
    if (!Array.isArray(day.doorPhones)) day.doorPhones = [];
    // Preserve a pre-existing (legacy/demo) door count as a baseline phone so the first
    // additive door import doesn't wipe it.
    if (!day.doorPhones.length && day.door && (day.door.total || Object.keys(day.door.buckets || {}).length)) {
      day.doorPhones.push({ id: 'legacy-door', name: 'Door', total: day.door.total || 0, buckets: day.door.buckets || {} });
    }
    // Keep tips sized to the station count so every reader (Excel, leaderboard, recap) is consistent.
    if (Array.isArray(day.tips)) { for (let i = day.tips.length; i < out.settings.numStations; i++) day.tips.push({ station: i + 1, bucketTotal: 0, verified: false, verifiedBy: '' }); }
  });
  out.myShifts = Array.isArray(s.myShifts) ? s.myShifts : [];
  out.myShifts.forEach((sh) => { if (!Array.isArray(sh.servedTaps)) sh.servedTaps = []; });
  out.myDoor = Object.assign({ buckets: {}, total: 0, taps: [] }, s.myDoor || {});
  if (!Array.isArray(out.myDoor.taps)) out.myDoor.taps = [];
  return out;
}

let S = migrate(store.load());
const save = () => store.save(S);

/* ---------------------------------------------------------------------------
 * 2. Small helpers
 * ------------------------------------------------------------------------- */
const app = () => document.getElementById('app');
function uid() { return 'x' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3); } // hoisted: used at module-init by defaultState()
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = (a) => a.reduce((x, y) => x + (Number(y) || 0), 0);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function usd(n, dec = 0) {
  const v = Number(n) || 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function nowMin() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function bucketOf(min) { return Math.floor(min / 15) * 15; }
function minToLabel(min) {
  let h = Math.floor(min / 60) % 24, m = min % 60;
  const ap = h < 12 ? 'AM' : 'PM'; let hh = h % 12; if (hh === 0) hh = 12;
  return hh + ':' + String(m).padStart(2, '0') + ' ' + ap;
}
function todayISO() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

let toastT;
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
}

/* Modal sheet (PIN, confirm, prompts) */
function sheet(html) {
  closeSheet();
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap'; wrap.id = 'sheet';
  wrap.innerHTML = `<div class="sheet-bg"></div><div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('.sheet-bg').addEventListener('click', closeSheet);
  return wrap;
}
function closeSheet() { const s = document.getElementById('sheet'); if (s) s.remove(); }

function askPin(title, cb) {
  if (!S.settings.adminPin) {
    // No PIN yet — let them set one now.
    const w = sheet(`<h3 class="sh-h">Set an admin PIN</h3>
      <p class="muted">Create a PIN to protect verifying tips, settings, and the kiosk lock.</p>
      <input class="inp" id="pin1" inputmode="numeric" type="password" placeholder="New PIN" autocomplete="off">
      <div class="row2"><button class="btn" id="pc">Cancel</button><button class="btn btn--go" id="pk">Save PIN</button></div>`);
    w.querySelector('#pc').onclick = closeSheet;
    w.querySelector('#pk').onclick = () => {
      const v = w.querySelector('#pin1').value.trim();
      if (!v) return toast('Enter a PIN');
      S.settings.adminPin = v; save(); closeSheet(); cb && cb(true);
    };
    setTimeout(() => w.querySelector('#pin1').focus(), 50);
    return;
  }
  const w = sheet(`<h3 class="sh-h">${esc(title || 'Enter admin PIN')}</h3>
    <input class="inp" id="pinx" inputmode="numeric" type="password" placeholder="PIN" autocomplete="off">
    <div class="row2"><button class="btn" id="pc">Cancel</button><button class="btn btn--go" id="pk">Unlock</button></div>`);
  const tryIt = () => {
    const v = w.querySelector('#pinx').value.trim();
    if (v === S.settings.adminPin) { closeSheet(); cb && cb(true); }
    else { toast('Wrong PIN'); w.querySelector('#pinx').value = ''; }
  };
  w.querySelector('#pc').onclick = closeSheet;
  w.querySelector('#pk').onclick = tryIt;
  w.querySelector('#pinx').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryIt(); });
  setTimeout(() => w.querySelector('#pinx').focus(), 50);
}

function confirmSheet(title, msg, okLabel, cb) {
  const w = sheet(`<h3 class="sh-h">${esc(title)}</h3><p class="muted">${esc(msg)}</p>
    <div class="row2"><button class="btn" id="cc">Cancel</button><button class="btn btn--go" id="ck">${esc(okLabel || 'OK')}</button></div>`);
  w.querySelector('#cc').onclick = closeSheet;
  w.querySelector('#ck').onclick = () => { closeSheet(); cb && cb(); };
}

/* ---------------------------------------------------------------------------
 * 3. Router
 * ------------------------------------------------------------------------- */
const routes = {};
function route(hash, fn) { routes[hash] = fn; }
function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

let mgrUnlocked = false; // manager PIN entered this session
function gateManager(root) {
  root.innerHTML = `
  <section class="screen">
    <div class="barx"><span class="mono">MANAGER</span><span class="mono">🔒 locked</span></div>
    <p class="eyebrow">Reno Rodeo · Special Kids Rodeo</p>
    <h1 class="h1">Manager PIN</h1>
    <p class="muted">Enter the manager PIN to open the manager tools.</p>
    <button class="btn btn--go big" id="enter">Enter PIN</button>
    <button class="btn ghost" id="back">‹ Back to roles</button>
  </section>`;
  const ask = () => askPin('Enter manager PIN', () => { mgrUnlocked = true; render(); });
  root.querySelector('#enter').onclick = ask;
  root.querySelector('#back').onclick = () => go('');
  ask();
}
function render() {
  closeSheet();
  const root = app(); root.innerHTML = '';
  const hash = location.hash || '';
  // Role gate — an unset role goes to the picker, EXCEPT the public join landing (#/join),
  // which IS the onboarding screen a freshly-scanned phone should see.
  if (!S.device.role && hash !== '' && hash !== '#/' && hash.indexOf('#/join') !== 0) { return renderRolePicker(root); }
  // Manager PIN gate — every manager route ('#/manager', '#/m/...') is behind the PIN.
  if (hash.indexOf('#/m') === 0 && S.settings.adminPin && !mgrUnlocked) { return gateManager(root); }
  let fn = routes[hash];
  if (!fn) {
    // default by role
    if (S.device.role === 'bartender') fn = routes['#/count'] || renderRolePicker;
    else if (S.device.role === 'door') fn = routes['#/door'];
    else if (S.device.role === 'manager') fn = routes['#/manager'];
    else fn = renderRolePicker;
  }
  // Kiosk lock: bartender locked to count screen
  if (S.device.kiosk && S.device.role === 'bartender' && hash !== '#/count') { return go('#/count'); }
  fn(root);
}
window.addEventListener('hashchange', render);

/* ---------------------------------------------------------------------------
 * 4. Screen 00 — Role picker
 * ------------------------------------------------------------------------- */
function renderRolePicker(root) {
  mgrUnlocked = false; // re-require the manager PIN on the next manager entry
  root.innerHTML = `
  <section class="screen">
    <div class="barx"><span class="mono">OFFLINE ✓</span><span class="mono">${esc(S.settings.event)}</span></div>
    <p class="eyebrow">Reno Rodeo · Special Kids Rodeo</p>
    <h1 class="h1">Who's on this phone?</h1>
    <p class="muted">Set your name + role once. Each phone = one person.</p>
    <label class="inp-lbl">Your name</label>
    <input class="inp" id="nm" placeholder="Type your name" value="${esc(S.device.name)}" autocomplete="name">
    <div class="stack">
      <button class="btn role" data-r="bartender">🍸&nbsp; Bartender</button>
      <button class="btn role" data-r="door">🚪&nbsp; Door / Line</button>
      <button class="btn role" data-r="manager">🛠&nbsp; Manager</button>
    </div>
    <p class="muted small">You can change this later in Settings (manager) or by resetting this phone.</p>
  </section>`;
  root.querySelectorAll('.role').forEach((b) => b.addEventListener('click', () => {
    const name = root.querySelector('#nm').value.trim();
    const r = b.dataset.r;
    if (!name && r !== 'manager') { toast('Type your name first'); root.querySelector('#nm').focus(); return; }
    S.device.name = name || 'Manager';
    S.device.role = r; save();
    if (r === 'bartender') go(S.myShifts.some((x) => x.active) ? '#/count' : '#/start');
    else if (r === 'door') go('#/door');
    else go('#/manager');
  }));
}
route('', renderRolePicker);
route('#/', renderRolePicker);

/* Public bartender onboarding — opened by scanning the staff QR (#/join). */
function renderJoin(root) {
  root.innerHTML = `
  <section class="screen">
    <div class="barx"><span class="mono">JOIN THE BAR</span><span class="mono">${esc(S.settings.event)}</span></div>
    <p class="eyebrow">Reno Rodeo · Special Kids Rodeo</p>
    <h1 class="h1">You're on the bar team 🍸</h1>
    <p class="muted">Type your name to start counting your shift. This phone is just you.</p>
    <label class="inp-lbl">Your name</label>
    <input class="inp" id="jnm" placeholder="Type your name" value="${esc(S.device.name)}" autocomplete="name" enterkeyhint="go">
    <button class="btn btn--go big" id="joinBtn">Start as Bartender ▸</button>
    <p class="muted small center">Working the door, or the manager? <button class="lnk" id="other">Pick a different role</button></p>
  </section>`;
  const start = () => {
    const name = root.querySelector('#jnm').value.trim();
    if (!name) { toast('Type your name first'); root.querySelector('#jnm').focus(); return; }
    S.device.name = name; S.device.role = 'bartender'; save();
    go(S.myShifts.some((x) => x.active) ? '#/count' : '#/start');
  };
  root.querySelector('#joinBtn').onclick = start;
  root.querySelector('#jnm').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
  root.querySelector('#other').onclick = () => go('');
}
route('#/join', renderJoin);
route('#/join/bartender', renderJoin);

/* ---------------------------------------------------------------------------
 * 5. Bartender — shift model + screens 01–04
 * ------------------------------------------------------------------------- */
function activeShift() { return S.myShifts.find((x) => x.active) || null; }
function newShift(station, mixer) {
  return { id: uid(), station, mixer: mixer || '', date: todayISO(), start: nowMin(), end: null, active: true,
    drinks: S.settings.drinks.map(() => 0), served: 0, buckets: {}, servedTaps: [], streak: 0, _curStreak: 0, _lastTap: -999, log: [] };
}

function renderStart(root) {
  const ns = S.settings.numStations;
  const segs = Array.from({ length: ns }, (_, i) => `<div class="s" data-st="${i + 1}">${i + 1}</div>`).join('');
  root.innerHTML = `
  <section class="screen">
    <div class="barx"><span class="mono">START SHIFT</span><span class="mono">You: ${esc(S.device.name)}</span></div>
    <h1 class="h1">Where are you working?</h1>
    <p class="lead">Pick your station</p>
    <div class="seg" id="seg">${segs}</div>
    <label class="inp-lbl">Your mixer</label>
    <input class="inp" id="mx" placeholder="Type mixer's name">
    <button class="btn btn--go big" id="startBtn">Start counting (clock starts)</button>
    ${S.myShifts.length ? `<button class="btn ghost" id="toQR">Show my QR / review</button>` : ''}
  </section>`;
  let st = 1;
  const seg = root.querySelector('#seg');
  seg.querySelectorAll('.s').forEach((s, i) => { if (i === 0) s.classList.add('on'); s.onclick = () => { seg.querySelectorAll('.s').forEach((x) => x.classList.remove('on')); s.classList.add('on'); st = Number(s.dataset.st); }; });
  root.querySelector('#startBtn').onclick = () => {
    S.myShifts.push(newShift(st, root.querySelector('#mx').value.trim()));
    save(); go('#/count');
  };
  const q = root.querySelector('#toQR'); if (q) q.onclick = () => go('#/qr');
}
route('#/start', renderStart);

function shiftTotal(sh) { return sum(sh.drinks); }

function renderCount(root) {
  const sh = activeShift();
  if (!sh) return go('#/start');
  const D = S.settings.drinks;
  const cells = D.map((name, i) => `
    <button class="cell" data-i="${i}">
      <span class="badge" data-b="${i}"></span>
      <span class="dn">${esc(name)}</span>
      <span class="ct" data-c="${i}">${sh.drinks[i]}</span>
    </button>`).join('');
  root.innerHTML = `
  <section class="screen count" id="countScreen">
    <div class="topbar">
      <span class="mono ellip">STA ${sh.station} · ${esc(S.device.name)}${sh.mixer ? ' / ' + esc(sh.mixer) : ''}</span>
      <span class="topact">
        <button class="lnk" id="undo">↩ Undo</button>
        <button class="lnk lock" id="lock">${S.device.kiosk ? '🔒' : '🔓'}</button>
      </span>
    </div>
    <div class="sticky-head">
      <div class="lbl">People served — timestamped</div>
      <div class="counter">
        <button class="pm" id="sMinus">−</button>
        <div class="counter-num" id="served">${sh.served}</div>
        <button class="pm pm--tan" id="sPlus">+</button>
      </div>
      <div class="boot-strip" title="Estimated, from people served">
        <div class="bs-bar"><div class="bs-fill" id="bsFill"></div></div>
        <div class="bs-lbl" id="bsLbl"></div>
      </div>
    </div>
    <div class="drink-grid">${cells}</div>
    <div class="count-foot">
      <button class="chip chip--tan" id="endmove">End / move</button>
      <span class="chip chip--k">Shift: <b id="stot">${shiftTotal(sh)}</b> drinks</span>
      <button class="chip" id="showqr">Show QR</button>
    </div>
  </section>`;

  const $ = (s) => root.querySelector(s);
  const refreshServed = () => { $('#served').textContent = sh.served; };
  const refreshDrink = (i) => { root.querySelector(`[data-c="${i}"]`).textContent = sh.drinks[i]; $('#stot').textContent = shiftTotal(sh); };
  if (!Array.isArray(sh.servedTaps)) sh.servedTaps = [];

  // Personal boot meter — estimated $ raised TONIGHT (this shift's date) from people served.
  const tonight = sh.date || todayISO();
  if (S.device.bootMilestoneDate !== tonight) { S.device.bootMilestone = 0; S.device.bootMilestoneDate = tonight; }
  const myServedTonight = () => sum(S.myShifts.filter((s) => (s.date || tonight) === tonight).map((s) => s.served || 0));
  const refreshBoot = () => {
    const raised = myServedTonight() * (S.settings.tipEst || 0);
    $('#bsLbl').textContent = `~${usd(raised)} for the kids 🤠`;
    $('#bsFill').style.width = ((raised % 100) / 100 * 100).toFixed(0) + '%';
  };

  $('#sPlus').onclick = () => {
    sh.served++; const b = bucketOf(nowMin()); sh.buckets[b] = (sh.buckets[b] || 0) + 1; sh.servedTaps.push(b);
    refreshServed(); refreshBoot();
    // milestone toast every $100 raised tonight
    const m = Math.floor(myServedTonight() * (S.settings.tipEst || 0) / 100);
    if (m > (S.device.bootMilestone || 0)) { S.device.bootMilestone = m; toast(`🤠 ~${usd(m * 100)} raised for the kids!`); }
    save();
  };
  $('#sMinus').onclick = () => {
    if (sh.served <= 0) return;
    sh.served--;
    // undo the bucket the LAST +1 actually landed in (not just the current clock bucket)
    const b = sh.servedTaps.length ? sh.servedTaps.pop() : bucketOf(nowMin());
    if (sh.buckets[b]) { sh.buckets[b]--; if (!sh.buckets[b]) delete sh.buckets[b]; }
    refreshServed(); refreshBoot(); save();
  };
  refreshBoot();

  // drinks: add-only, combo badge on rapid taps, streak tracking
  const comboState = {}; // i -> {n, t}
  root.querySelectorAll('.cell').forEach((cell) => {
    const i = Number(cell.dataset.i);
    cell.addEventListener('click', () => {
      const t = Date.now();
      sh.drinks[i]++;
      sh.log.push({ t, i });
      // streak: consecutive taps within 6s (any drink)
      if (t - sh._lastTap <= 6000) sh._curStreak++; else sh._curStreak = 1;
      sh._lastTap = t; if (sh._curStreak > sh.streak) sh.streak = sh._curStreak;
      // combo badge
      const c = comboState[i] || { n: 0, t: 0 };
      c.n = (t - c.t <= 900) ? c.n + 1 : 1; c.t = t; comboState[i] = c;
      const badge = root.querySelector(`[data-b="${i}"]`);
      if (c.n >= 2) { badge.textContent = '+' + c.n; badge.classList.add('show'); clearTimeout(badge._t); badge._t = setTimeout(() => badge.classList.remove('show'), 700); }
      refreshDrink(i); save();
    });
  });

  // Undo-last drink: tap once shows label, second tap confirms
  let undoArmed = false, undoT;
  $('#undo').onclick = () => {
    const last = sh.log[sh.log.length - 1];
    if (!last) { toast('Nothing to undo'); return; }
    if (!undoArmed) {
      undoArmed = true; $('#undo').textContent = '↩ Undo: ' + D[last.i] + '?';
      $('#undo').classList.add('armed');
      clearTimeout(undoT); undoT = setTimeout(() => { undoArmed = false; $('#undo').textContent = '↩ Undo'; $('#undo').classList.remove('armed'); }, 2500);
      return;
    }
    sh.log.pop(); if (sh.drinks[last.i] > 0) sh.drinks[last.i]--;
    refreshDrink(last.i); undoArmed = false; $('#undo').textContent = '↩ Undo'; $('#undo').classList.remove('armed'); clearTimeout(undoT); save();
  };

  $('#lock').onclick = () => {
    if (S.device.kiosk) {
      askPin('Enter PIN to unlock kiosk', () => { S.device.kiosk = false; save(); render(); });
    } else {
      const apply = () => { S.device.kiosk = true; save(); render(); toast('Kiosk locked — PIN to exit'); };
      if (!S.settings.adminPin) askPin('Set a PIN to lock kiosk', apply); else apply();
    }
  };
  $('#endmove').onclick = () => go('#/endmove');
  $('#showqr').onclick = () => go('#/qr');
}
route('#/count', renderCount);

function renderEndMove(root) {
  const sh = activeShift();
  if (!sh) return go('#/start');
  root.innerHTML = `
  <section class="screen">
    <div class="barx"><span class="mono">END / MOVE</span><span class="mono">${minToLabel(nowMin())}</span></div>
    <h1 class="h1">Leaving or moving?</h1>
    <p class="muted">Stamps your check-out. Your counts ride along under Station ${sh.station}. Whoever takes over counts on their own phone.</p>
    <button class="btn btn--go big" id="end">End my shift → Show QR</button>
    <button class="btn" id="move">Move to another station</button>
    <button class="btn ghost" id="cancel">Cancel</button>
  </section>`;
  root.querySelector('#end').onclick = () => { sh.end = nowMin(); sh.active = false; save(); store.checkpoint(); go('#/qr'); };
  root.querySelector('#move').onclick = () => {
    const ns = S.settings.numStations;
    const segs = Array.from({ length: ns }, (_, i) => `<button class="s" data-st="${i + 1}">${i + 1}</button>`).join('');
    const w = sheet(`<h3 class="sh-h">Move to station</h3><p class="muted">Closes this shift, opens a fresh one on this phone.</p>
      <label class="inp-lbl">New station</label><div class="seg" id="mseg">${segs}</div>
      <label class="inp-lbl">Mixer (optional)</label><input class="inp" id="mmix" value="${esc(sh.mixer)}">
      <div class="row2"><button class="btn" id="mc">Cancel</button><button class="btn btn--go" id="mok">Move</button></div>`);
    let nst = sh.station; const seg = w.querySelector('#mseg');
    seg.querySelectorAll('.s').forEach((s) => { if (Number(s.dataset.st) === nst) s.classList.add('on'); s.onclick = () => { seg.querySelectorAll('.s').forEach((x) => x.classList.remove('on')); s.classList.add('on'); nst = Number(s.dataset.st); }; });
    w.querySelector('#mc').onclick = closeSheet;
    w.querySelector('#mok').onclick = () => {
      sh.end = nowMin(); sh.active = false;
      S.myShifts.push(newShift(nst, w.querySelector('#mmix').value.trim()));
      save(); closeSheet(); go('#/count');
    };
  };
  root.querySelector('#cancel').onclick = () => go('#/count');
}
route('#/endmove', renderEndMove);

/* ---------- QR payload (compact) ---------- */
// Integrity checksum — recomputed on import to reject a garbled/partial scan.
function payloadChecksum(p) {
  if (p.r === 'b') return (p.s || []).reduce((a, sh) => a + sum(sh.d || []) + sum(Object.values(sh.b || {})), 0);
  if (p.r === 'd') return (p.t || 0) + sum(Object.values(p.b || {}));
  return 0;
}
function bartenderPayload() {
  const p = {
    v: 1, r: 'b', n: S.device.name, ev: S.settings.event,
    s: S.myShifts.map((sh) => ({ st: sh.station, mx: sh.mixer, a: sh.start, e: sh.end, d: sh.drinks, b: sh.buckets, k: sh.streak })),
  };
  p.c = payloadChecksum(p);
  return p;
}
function doorPayload() {
  const p = { v: 1, r: 'd', n: S.device.name || 'Door', ev: S.settings.event, id: S.device.id, b: S.myDoor.buckets, t: S.myDoor.total };
  p.c = payloadChecksum(p);
  return p;
}

function makeQRSvg(text) {
  for (const ec of ['M', 'L']) {
    try {
      const qr = qrcode(0, ec); qr.addData(text); qr.make();
      return qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
    } catch (e) { /* try lower EC */ }
  }
  return null;
}

function renderQR(root) {
  const payload = S.device.role === 'door' ? doorPayload() : bartenderPayload();
  const text = JSON.stringify(payload);
  const svg = makeQRSvg(text);
  const closed = S.device.role === 'door' ? true : !activeShift();
  root.innerHTML = `
  <section class="screen">
    <div class="barx"><span class="mono">SHOW QR · CLOSE</span><span class="mono">OFFLINE ✓</span></div>
    <h1 class="h1">Hand off to manager</h1>
    <div class="qr-box">${svg || '<p class="muted">QR too large — use Copy code below.</p>'}</div>
    <p class="muted center">Manager snaps a photo of this. No typing, no internet.<br>${text.length} chars · ${esc(S.device.name || 'Door')}</p>
    <button class="btn ghost" id="copy">Copy backup code</button>
    ${S.device.role === 'bartender' && !closed ? '<p class="muted small center">⚠ Shift still open — End it on the count screen to finalize times.</p>' : ''}
    <button class="btn" id="back">Back</button>
  </section>`;
  root.querySelector('#copy').onclick = () => copyText(text);
  root.querySelector('#back').onclick = () => go(S.device.role === 'door' ? '#/door' : (activeShift() ? '#/count' : '#/start'));
}
route('#/qr', renderQR);

/* ---------------------------------------------------------------------------
 * 6. Door — screen 05
 * ------------------------------------------------------------------------- */
function renderDoor(root) {
  const d = S.myDoor;
  if (!Array.isArray(d.taps)) d.taps = [];
  root.innerHTML = `
  <section class="screen door">
    <div class="topbar"><span class="mono">DOOR · LINE</span><span class="mono">OFFLINE ✓</span></div>
    <div class="sticky-head door-hero">
      <div class="lbl">People into the line · timestamped</div>
      <div class="counter big">
        <button class="pm pm--lg" id="dMinus">−</button>
        <div class="counter-num huge" id="dnum">${d.total}</div>
        <button class="pm pm--lg pm--tan" id="dPlus">+</button>
      </div>
      <div class="mono center muted" id="drate"></div>
    </div>
    <button class="btn" id="qr">Show QR at close</button>
  </section>`;
  const num = root.querySelector('#dnum');
  const rate = root.querySelector('#drate');
  const showRate = () => {
    const cur = bucketOf(nowMin()); const n = d.buckets[cur] || 0;
    rate.textContent = n ? `${n} in this 15-min block` : '';
  };
  root.querySelector('#dPlus').onclick = () => { d.total++; const b = bucketOf(nowMin()); d.buckets[b] = (d.buckets[b] || 0) + 1; d.taps.push(b); num.textContent = d.total; showRate(); save(); };
  root.querySelector('#dMinus').onclick = () => { if (d.total <= 0) return; d.total--; const b = d.taps.length ? d.taps.pop() : bucketOf(nowMin()); if (d.buckets[b]) { d.buckets[b]--; if (!d.buckets[b]) delete d.buckets[b]; } num.textContent = d.total; showRate(); save(); };
  root.querySelector('#qr').onclick = () => go('#/qr');
  showRate();
}
route('#/door', renderDoor);

/* ---------------------------------------------------------------------------
 * 7. Manager — night model + aggregation
 * ------------------------------------------------------------------------- */
function currentDay() {
  if (!S.days.length) return null;
  let d = S.days.find((x) => x.id === S.currentDayId);
  if (!d) { d = S.days[S.days.length - 1]; S.currentDayId = d.id; }
  return d;
}
function newDay(dayNum, date) {
  return {
    id: uid(), day: dayNum, date: date || todayISO(),
    shifts: [],        // merged: {person, role, station, mixer, start, end, drinks[], served, buckets{}, streak}
    door: { buckets: {}, total: 0 },
    doorPhones: [],    // multiple door phones, summed: [{id, name, total, buckets}]
    inventory: S.settings.catalog.map((c) => ({ name: c.name, opening: 0, closing: 0 })),
    order: { items: S.settings.catalog.map((c) => ({ name: c.name, unitPrice: c.unitPrice, recommendedQty: c.recommendedQty, orderedQty: 0 })), photoId: null, total: 0 },
    receiving: [],
    tips: Array.from({ length: S.settings.numStations }, (_, i) => ({ station: i + 1, bucketTotal: 0, verified: false, verifiedBy: '' })),
    bootAmount: null,  // null = auto from tips
    imported: [],      // labels of imported phones
  };
}
// Re-derive day.door from all door phones so existing reads (funnel etc.) keep working.
function recomputeDoor(day) {
  const phones = day.doorPhones || [];
  const buckets = {}; let total = 0;
  phones.forEach((ph) => { total += ph.total || 0; for (const k in (ph.buckets || {})) buckets[k] = (buckets[k] || 0) + ph.buckets[k]; });
  day.door = { total, buckets };
}
function ensureDay() {
  if (!currentDay()) { const d = newDay(S.days.length + 1); S.days.push(d); S.currentDayId = d.id; save(); }
  return currentDay();
}

/* aggregate a day's shifts by station */
function stationAgg(day) {
  const map = {};
  for (let i = 1; i <= S.settings.numStations; i++) map[i] = { station: i, served: 0, drinks: S.settings.drinks.map(() => 0), shifts: [] };
  day.shifts.forEach((sh) => {
    if (!map[sh.station]) map[sh.station] = { station: sh.station, served: 0, drinks: S.settings.drinks.map(() => 0), shifts: [] };
    const m = map[sh.station]; m.served += sh.served || 0; m.shifts.push(sh);
    (sh.drinks || []).forEach((c, i) => m.drinks[i] = (m.drinks[i] || 0) + (c || 0));
  });
  return map;
}
function dayTotals(day) {
  const served = sum(day.shifts.map((s) => s.served || 0));
  const drinks = sum(day.shifts.map((s) => sum(s.drinks || [])));
  const line = day.door ? day.door.total : 0;
  const tipsTotal = sum((day.tips || []).map((t) => t.bucketTotal || 0));
  const conv = line ? served / line : 0;
  const dpp = served ? drinks / served : 0;
  return { served, drinks, line, tipsTotal, conv, dpp };
}
function bootForDay(day) {
  if (day.bootAmount != null) return day.bootAmount;
  return dayTotals(day).tipsTotal; // auto-suggest from tips
}
function bootCumulativeThrough(day) {
  let total = 0;
  for (const d of S.days) { total += bootForDay(d); if (d.id === day.id) break; }
  return total;
}
// Live pace vs last year (idea #9)
function paceInfo() {
  const raised = sum(S.days.map((d) => bootForDay(d)));
  const elapsed = S.days.length;
  const nights = S.settings.nights || 10;
  const remaining = Math.max(0, nights - elapsed);
  const lastYear = ((S.settings.boot.pastYears || [])[0] || {}).total || S.settings.boot.goal || 0;
  const perNight = elapsed ? raised / elapsed : 0;
  const projected = perNight * nights;
  const ahead = lastYear ? projected >= lastYear : false;
  const needPerNight = remaining ? Math.max(0, (lastYear - raised) / remaining) : 0;
  return { raised, elapsed, nights, remaining, lastYear, perNight, projected, ahead, needPerNight };
}
function paceBanner() {
  const p = paceInfo();
  if (!p.elapsed || !p.lastYear) return '';
  if (p.ahead) return `<div class="pace ahead">🔥 On pace for ~${usd(p.projected)} — AHEAD of last year (${usd(p.lastYear)})</div>`;
  return `<div class="pace behind">Behind last year — need ~${usd(p.needPerNight)}/night for ${p.remaining} more night${p.remaining === 1 ? '' : 's'} to beat ${usd(p.lastYear)}</div>`;
}
// Tonight's plain-English brief (idea #10)
function tonightBrief(day) {
  const out = [];
  const t = dayTotals(day);
  const sp = sparkline(dayServedBuckets(day), 15);
  if (sp.peak != null) out.push({ text: `Busiest 15-min: ${minToLabel(sp.peak)} (${sp.peakVal} served)`, hash: '#/m/analytics' });
  const stArr = Object.values(stationAgg(day)).filter((s) => sum(s.drinks) > 0);
  if (stArr.length && t.drinks) { const top = stArr.slice().sort((a, b) => sum(b.drinks) - sum(a.drinks))[0]; out.push({ text: `Station ${top.station} carried ${Math.round(sum(top.drinks) / t.drinks * 100)}% of drinks`, hash: '#/m/analytics' }); }
  if (t.line) out.push({ text: `Conversion ${Math.round(t.conv * 100)}% · ${t.dpp.toFixed(1)} drinks/person`, hash: '#/m/analytics' });
  const low = (day.inventory || []).filter((it) => (it.opening || it.closing) && (it.closing || 0) <= 2);
  if (low.length) out.push({ text: `Low stock: ${low.map((l) => l.name).slice(0, 3).join(', ')}`, hash: '#/m/orders' });
  const p = paceInfo();
  if (p.elapsed && p.lastYear) out.push({ text: p.ahead ? `Ahead of last year — projecting ~${usd(p.projected)}` : `Need ~${usd(p.needPerNight)}/night to catch last year`, hash: '#/m/boot' });
  return out.slice(0, 4);
}
/* combine 15-min buckets bar-wide for a day -> {min: count} */
function dayServedBuckets(day) {
  const out = {};
  day.shifts.forEach((sh) => { for (const k in (sh.buckets || {})) out[k] = (out[k] || 0) + sh.buckets[k]; });
  return out;
}

/* ---------- Manager shell (top bar + tabbar) ---------- */
const MTABS = [
  { k: 'import', label: 'Import', hash: '#/m/import' },
  { k: 'inventory', label: 'Inv', hash: '#/m/inventory' },
  { k: 'orders', label: 'Order', hash: '#/m/orders' },
  { k: 'tips', label: 'Tips', hash: '#/m/tips' },
  { k: 'more', label: 'More', hash: '#/manager' },
];
function nightSelector() {
  const d = currentDay();
  const opts = S.days.map((x) => `<option value="${x.id}" ${x.id === S.currentDayId ? 'selected' : ''}>Day ${x.day} · ${x.date}</option>`).join('');
  return `<select class="night-sel" id="nightSel">${opts || '<option>No nights yet</option>'}</select>`;
}
function managerShell(activeKey, title, inner) {
  const tabs = MTABS.map((t) => `<button class="t ${t.k === activeKey ? 'on' : ''}" data-h="${t.hash}">${t.label}</button>`).join('');
  return `
  <section class="screen mgr">
    <div class="mgr-top">
      <button class="lnk" id="hubBtn">‹ Menu</button>
      <span class="mgr-title">${esc(title)}</span>
      ${nightSelector()}
    </div>
    <div class="mgr-body">${inner}</div>
    <nav class="tabbar">${tabs}</nav>
  </section>`;
}
function wireShell(root) {
  const hub = root.querySelector('#hubBtn'); if (hub) hub.onclick = () => go('#/manager');
  root.querySelectorAll('.tabbar .t').forEach((t) => t.onclick = () => go(t.dataset.h));
  const sel = root.querySelector('#nightSel');
  if (sel) sel.onchange = () => { S.currentDayId = sel.value; save(); render(); };
}

/* ---------- Manager hub (More) ---------- */
function renderManagerHub(root) {
  ensureDay();
  const d = currentDay();
  const t = dayTotals(d);
  const cards = [
    ['#/m/onboard', '🔗', 'Staff QR', 'Bartenders scan to join'],
    ['#/m/import', '📷', 'Import', 'Scan phone QRs'],
    ['#/m/inventory', '🧮', 'Inventory', 'Opening/closing bottles'],
    ['#/m/orders', '📝', 'Orders', 'Catalog + recommended'],
    ['#/m/receiving', '📦', 'Receiving', 'Verify vs ordered'],
    ['#/m/tips', '💵', 'Tips', 'Bucket ÷ served'],
    ['#/m/analytics', '📈', 'Analytics', 'Funnel + curves'],
    ['#/m/fun', '🏆', 'Fun Stats', 'Superlatives'],
    ['#/m/leaderboard', '🥇', 'Leaderboard', 'Rates + awards'],
    ['#/m/boot', '🥾', 'Fill the Boot', 'Per-day vs goal'],
    ['#/m/yoy', '📊', 'Year-over-year', 'Import goal + export'],
    ['#/m/recap', '💬', 'Team Recap', 'SMS · Email · Copy'],
    ['#/m/excel', '📑', 'Excel Export', 'Refreshed .xlsx'],
    ['#/m/history', '🗂', 'History + Backup', 'Save / restore'],
    ['#/m/settings', '⚙️', 'Settings', 'Stations, catalog, PIN'],
  ];
  root.innerHTML = `
  <section class="screen mgr">
    <div class="mgr-top">
      <span class="mgr-title">Manager</span>
      ${nightSelector()}
    </div>
    <div class="mgr-body">
      <div class="night-bar">
        <div><div class="lbl">Tonight</div><b>Day ${d.day} · ${d.date}</b></div>
        <button class="chip" id="newNight">+ New night</button>
      </div>
      ${paceBanner()}
      <div class="kpis">
        <div class="kpi"><div class="kn">${t.line}</div><div class="kl">line</div></div>
        <div class="kpi"><div class="kn">${t.served}</div><div class="kl">served</div></div>
        <div class="kpi"><div class="kn">${t.drinks}</div><div class="kl">drinks</div></div>
        <div class="kpi"><div class="kn">${usd(t.tipsTotal)}</div><div class="kl">tips</div></div>
      </div>
      ${(function () { const b = tonightBrief(d); return b.length ? `<div class="brief"><div class="lbl">Tonight's brief</div>${b.map((x) => `<button class="brief-line" data-bh="${x.hash}">› ${esc(x.text)}</button>`).join('')}</div>` : ''; })()}
      <div class="hub-grid">
        ${cards.map(([h, ic, ti, su]) => `<button class="hub-card" data-h="${h}"><span class="hc-ic">${ic}</span><span class="hc-ti">${ti}</span><span class="hc-su">${su}</span></button>`).join('')}
      </div>
    </div>
    <nav class="tabbar">${MTABS.map((tt) => `<button class="t ${tt.k === 'more' ? 'on' : ''}" data-h="${tt.hash}">${tt.label}</button>`).join('')}</nav>
  </section>`;
  root.querySelectorAll('.hub-card').forEach((c) => c.onclick = () => go(c.dataset.h));
  root.querySelectorAll('.brief-line').forEach((b) => b.onclick = () => go(b.dataset.bh));
  root.querySelectorAll('.tabbar .t').forEach((t2) => t2.onclick = () => go(t2.dataset.h));
  const sel = root.querySelector('#nightSel'); if (sel) sel.onchange = () => { S.currentDayId = sel.value; save(); render(); };
  root.querySelector('#newNight').onclick = () => {
    const w = sheet(`<h3 class="sh-h">New night</h3>
      <label class="inp-lbl">Day number</label><input class="inp" id="dn" type="number" value="${S.days.length + 1}">
      <label class="inp-lbl">Date</label><input class="inp" id="dd" type="date" value="${todayISO()}">
      <div class="row2"><button class="btn" id="nc">Cancel</button><button class="btn btn--go" id="nk">Create</button></div>`);
    w.querySelector('#nc').onclick = closeSheet;
    w.querySelector('#nk').onclick = () => { const day = newDay(Number(w.querySelector('#dn').value) || S.days.length + 1, w.querySelector('#dd').value); S.days.push(day); S.currentDayId = day.id; save(); closeSheet(); render(); };
  };
}
route('#/manager', renderManagerHub);

/* ---------------------------------------------------------------------------
 * 8. Import (06) — photo-scan QR + merge by station
 * ------------------------------------------------------------------------- */
const importUndo = []; // session-only stack of pre-merge snapshots, for one-tap undo

function validatePayload(p) {
  if (!p || typeof p !== 'object' || (p.r !== 'b' && p.r !== 'd')) return "This isn't a Bar Count QR.";
  if (p.r === 'b' && !Array.isArray(p.s)) return 'QR is missing shift data — retake the photo.';
  if (p.c != null && p.c !== payloadChecksum(p)) return 'QR came through garbled — retake a clearer, closer photo.';
  return null;
}

// Show a confirmation/preview before committing a scan (catches wrong-night / collision).
function previewMerge(day, p) {
  const err = validatePayload(p);
  if (err) { toast(err); return; }
  const go2 = () => showPreviewSheet(day, p);
  if (p.ev && p.ev !== S.settings.event) {
    confirmSheet('Different event?', `This QR says "${p.ev}", not "${S.settings.event}". Import it anyway?`, 'Import', go2);
  } else go2();
}
function showPreviewSheet(day, p) {
  let body, isUpdate;
  if (p.r === 'd') {
    const id = p.id || ('door-' + (p.n || 'door'));
    isUpdate = (day.doorPhones || []).some((x) => x.id === id);
    body = `<div class="lrow"><span>🚪 ${esc(p.n || 'Door')}</span><span class="v">${p.t || 0} in line</span></div>`;
  } else {
    isUpdate = day.shifts.some((x) => x.person === p.n);
    body = (p.s || []).map((sh) => `<div class="lrow"><span>Sta ${sh.st} · ${minToLabel(sh.a)}–${sh.e != null ? minToLabel(sh.e) : 'open'}</span><span class="v">${sum(Object.values(sh.b || {}))} served · ${sum(sh.d || [])} dr</span></div>`).join('');
  }
  const tag = isUpdate ? '<span class="tan">UPDATE</span>' : '<span class="ok">NEW</span>';
  const w = sheet(`<h3 class="sh-h">${esc(p.n || 'Door')} · ${tag}</h3>
    <p class="muted">${isUpdate ? 'Already imported — this replaces their numbers.' : 'New phone — adds to tonight.'}</p>
    <div class="rows">${body}</div>
    <div class="row2"><button class="btn" id="pc">Cancel</button><button class="btn btn--go" id="pk">${isUpdate ? 'Update' : 'Import'}</button></div>`);
  w.querySelector('#pc').onclick = closeSheet;
  w.querySelector('#pk').onclick = () => { applyMerge(day, p); closeSheet(); toast((isUpdate ? 'Updated ' : 'Imported ') + (p.n || 'Door')); render(); };
}

function applyMerge(day, p) {
  // snapshot the day so the merge can be undone in one tap
  importUndo.push({
    dayId: day.id,
    prevShifts: JSON.parse(JSON.stringify(day.shifts)),
    prevDoorPhones: JSON.parse(JSON.stringify(day.doorPhones || [])),
    prevDoor: JSON.parse(JSON.stringify(day.door || {})),
    prevImported: (day.imported || []).slice(),
  });
  if (importUndo.length > 20) importUndo.shift();
  if (p.r === 'd') {
    day.doorPhones = day.doorPhones || [];
    const id = p.id || ('door-' + (p.n || 'door'));
    const entry = { id, name: p.n || 'Door', total: p.t || 0, buckets: p.b || {} };
    const ex = day.doorPhones.find((x) => x.id === id);
    if (ex) Object.assign(ex, entry); else day.doorPhones.push(entry);
    recomputeDoor(day);
    // door display is driven by day.doorPhones (the single source of truth) — no fragile label bookkeeping
  } else {
    (p.s || []).forEach((sh) => {
      const exists = day.shifts.find((x) => x.person === p.n && x.start === sh.a && x.station === sh.st);
      const data = { mixer: sh.mx || '', end: sh.e, drinks: sh.d || [], served: sum(Object.values(sh.b || {})), buckets: sh.b || {}, streak: sh.k || 0 };
      if (exists) Object.assign(exists, data);
      else day.shifts.push(Object.assign({ id: uid(), person: p.n, role: 'bartender', station: sh.st, start: sh.a }, data));
    });
    const label = `${p.n} → Sta ${(p.s || []).map((x) => x.st).join('/')}`;
    day.imported = (day.imported || []).filter((l) => !l.startsWith(p.n + ' ')).concat(label);
  }
  save(); store.checkpoint();
}

function undoLastImport(day) {
  for (let i = importUndo.length - 1; i >= 0; i--) {
    if (importUndo[i].dayId === day.id) {
      const u = importUndo.splice(i, 1)[0];
      day.shifts = u.prevShifts; day.doorPhones = u.prevDoorPhones; day.door = u.prevDoor; day.imported = u.prevImported;
      save(); store.checkpoint(); return true;
    }
  }
  return false;
}

function decodeImageFile(file, cb) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    const max = 1000; let { width: w, height: h } = img;
    const scale = Math.min(1, max / Math.max(w, h)); w = Math.round(w * scale); h = Math.round(h * scale);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
    let res = null;
    try { const d = ctx.getImageData(0, 0, w, h); res = jsQR(d.data, w, h, { inversionAttempts: 'attemptBoth' }); } catch (e) {}
    URL.revokeObjectURL(url); cb(res ? res.data : null);
  };
  img.onerror = () => { URL.revokeObjectURL(url); cb(null); };
  img.src = url;
}

function renderImport(root) {
  ensureDay();
  const d = currentDay();
  const agg = stationAgg(d);
  const covered = (st) => agg[st] && (agg[st].served > 0 || agg[st].shifts.length > 0);
  const stationCells = Array.from({ length: S.settings.numStations }, (_, i) => i + 1)
    .map((st) => `<div class="cov ${covered(st) ? 'on' : ''}">Sta ${st}${covered(st) ? ' ✓' : ''}</div>`).join('');
  const doorOK = d.door && d.door.total > 0;
  const doorCell = `<div class="cov ${doorOK ? 'on' : ''}">Door${doorOK ? ' ✓' : ''}</div>`;
  const missing = Array.from({ length: S.settings.numStations }, (_, i) => i + 1).filter((st) => !covered(st)).length + (doorOK ? 0 : 1);

  const shiftRows = d.shifts.length
    ? d.imported.filter((l) => !l.startsWith('🚪')).map((l) => `<div class="lrow"><span>${esc(l)}</span><span class="v ok">✓ in</span></div>`).join('')
    : '';
  const doorRows = (d.doorPhones || []).map((ph) => `<div class="lrow"><span>🚪 ${esc(ph.name)}</span><span class="v">${ph.total} in line <button class="lnk" data-rmdoor="${esc(ph.id)}">✕</button></span></div>`).join('');
  const haveUndo = importUndo.some((u) => u.dayId === d.id);

  const inner = `
    <p class="muted">Photograph each phone's QR. You'll see a preview before it merges.</p>
    <div class="lbl">Coverage — ${missing ? missing + ' still out' : 'all in ✓'}</div>
    <div class="coverage">${stationCells}${doorCell}</div>
    <label class="btn btn--tan filein">📷 Snap a QR
      <input type="file" accept="image/*" capture="environment" id="qrfile" hidden>
    </label>
    <button class="btn ghost" id="paste">Paste backup code</button>
    ${haveUndo ? '<button class="btn ghost" id="undoImp">↩ Undo last import</button>' : ''}
    ${shiftRows || doorRows ? `<div class="lbl">Imported</div><div class="rows">${shiftRows}${doorRows}</div>` : '<p class="muted small">Nothing imported yet.</p>'}
    <p class="muted small">Day ${d.day}. Re-scanning a phone updates it; multiple door phones add together.</p>`;
  root.innerHTML = managerShell('import', 'Import', inner);
  wireShell(root);
  root.querySelector('#qrfile').onchange = (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    toast('Decoding…');
    decodeImageFile(f, (data) => {
      if (!data) { toast('No QR found — try a clearer, closer photo'); return; }
      let p; try { p = JSON.parse(data); } catch (err) { toast('QR is not Bar Count data'); return; }
      previewMerge(d, p);
    });
    e.target.value = '';
  };
  root.querySelector('#paste').onclick = () => {
    const w = sheet(`<h3 class="sh-h">Paste backup code</h3><p class="muted">Paste the code copied from a phone's Show-QR screen.</p>
      <textarea class="inp ta" id="pc" placeholder="{...}"></textarea>
      <div class="row2"><button class="btn" id="x">Cancel</button><button class="btn btn--go" id="ok">Preview</button></div>`);
    w.querySelector('#x').onclick = closeSheet;
    w.querySelector('#ok').onclick = () => {
      let p; try { p = JSON.parse(w.querySelector('#pc').value.trim()); } catch (e) { return toast('Invalid code'); }
      closeSheet(); previewMerge(d, p);
    };
  };
  const undoBtn = root.querySelector('#undoImp');
  if (undoBtn) undoBtn.onclick = () => { if (undoLastImport(d)) { toast('Undid last import'); render(); } };
  root.querySelectorAll('[data-rmdoor]').forEach((b) => b.onclick = () => {
    const id = b.dataset.rmdoor;
    confirmSheet('Remove door phone?', 'Removes this door phone from tonight and re-sums the line count.', 'Remove', () => {
      d.doorPhones = (d.doorPhones || []).filter((x) => x.id !== id);
      recomputeDoor(d);
      save(); render();
    });
  });
}
route('#/m/import', renderImport);

/* Staff onboarding QR — a URL QR that opens the app to bartender sign-up (#/join). */
function joinURL() { return location.href.split('#')[0] + '#/join'; }
function renderOnboard(root) {
  const url = joinURL();
  const svg = makeQRSvg(url);
  const inner = `
    <h2 class="title-sm">Bartenders: scan to join</h2>
    <p class="muted">Each bartender points their phone camera at this code. It opens the app, they type
      their name, and they're counting — no app store, no typing a link.</p>
    <div class="qr-box">${svg || '<p class="muted">QR unavailable.</p>'}</div>
    <p class="muted center small">${esc(url)}</p>
    <button class="btn btn--tan" id="copy">Copy link</button>
    <button class="btn ghost" id="open">Open it on this phone (preview)</button>
    <p class="muted small">Tip: screenshot or print this and tape it at each station. Works on any phone
      — they just need internet the first time it loads, then it runs offline.</p>`;
  root.innerHTML = managerShell('more', 'Staff QR', inner);
  wireShell(root);
  root.querySelector('#copy').onclick = () => copyText(url);
  root.querySelector('#open').onclick = () => go('#/join');
}
route('#/m/onboard', renderOnboard);

/* ---------------------------------------------------------------------------
 * 9. Inventory (07)
 * ------------------------------------------------------------------------- */
function renderInventory(root) {
  ensureDay();
  const d = currentDay();
  if (!d.inventory.length) d.inventory = S.settings.catalog.map((c) => ({ name: c.name, opening: 0, closing: 0 }));
  const rows = d.inventory.map((it, i) => `
    <div class="inv-row">
      <span class="inv-name">${esc(it.name)}</span>
      <input class="inp inp--mini" data-k="opening" data-i="${i}" type="number" inputmode="numeric" value="${it.opening || ''}" placeholder="open">
      <input class="inp inp--mini" data-k="closing" data-i="${i}" type="number" inputmode="numeric" value="${it.closing || ''}" placeholder="close">
      <span class="inv-used" data-u="${i}">${(it.opening || 0) - (it.closing || 0)}</span>
    </div>`).join('');
  const inner = `
    <div class="inv-head"><span>Liquor</span><span>Open</span><span>Close</span><span>Used</span></div>
    <div class="inv-list">${rows}</div>
    <p class="muted small">You type Opening &amp; Closing (bottles) · Used = Open − Close · 🍺 Beer = kegs, not counted.</p>`;
  root.innerHTML = managerShell('inventory', 'Inventory · Day ' + d.day, inner);
  wireShell(root);
  root.querySelectorAll('input[data-k]').forEach((inp) => inp.oninput = () => {
    const i = Number(inp.dataset.i), k = inp.dataset.k;
    d.inventory[i][k] = Number(inp.value) || 0;
    root.querySelector(`[data-u="${i}"]`).textContent = (d.inventory[i].opening || 0) - (d.inventory[i].closing || 0);
    save();
  });
}
route('#/m/inventory', renderInventory);

/* ---------------------------------------------------------------------------
 * 10. Orders (08) + Review (09)
 * ------------------------------------------------------------------------- */
function recommendedFor(name) {
  // last night's used for this item, else catalog default
  const idx = S.days.findIndex((x) => x.id === S.currentDayId);
  for (let j = idx - 1; j >= 0; j--) {
    const inv = (S.days[j].inventory || []).find((it) => it.name === name);
    if (inv && (inv.opening || inv.closing)) return Math.max(0, (inv.opening || 0) - (inv.closing || 0));
  }
  const c = S.settings.catalog.find((c) => c.name === name);
  return c ? c.recommendedQty : 0;
}
function renderOrders(root) {
  ensureDay();
  const d = currentDay();
  if (!d.order.items.length) d.order.items = S.settings.catalog.map((c) => ({ name: c.name, unitPrice: c.unitPrice, recommendedQty: c.recommendedQty, orderedQty: 0 }));
  const rows = d.order.items.map((it, i) => {
    const rec = recommendedFor(it.name);
    return `<div class="ord-row">
      <span class="ord-name">${esc(it.name)}<span class="mut"> ${usd(it.unitPrice)} · rec ${rec}</span></span>
      <input class="inp inp--mini" data-i="${i}" type="number" inputmode="numeric" value="${it.orderedQty || ''}" placeholder="${rec}">
    </div>`;
  }).join('');
  const inner = `
    <div class="rows">${rows}</div>
    <p class="muted small">Recommended = last night's used (or catalog default) · no beer (kegs).</p>
    <button class="btn btn--go" id="review">Review order ▸</button>`;
  root.innerHTML = managerShell('orders', 'Order sheet · Day ' + d.day, inner);
  wireShell(root);
  root.querySelectorAll('input[data-i]').forEach((inp) => inp.oninput = () => { d.order.items[Number(inp.dataset.i)].orderedQty = Number(inp.value) || 0; save(); });
  root.querySelector('#review').onclick = () => go('#/m/review');
}
route('#/m/orders', renderOrders);

async function renderReview(root) {
  ensureDay();
  const d = currentDay();
  const o = d.order;
  o.total = sum(o.items.map((it) => (it.orderedQty || 0) * (it.unitPrice || 0)));
  const onHand = sum(d.inventory.map((it) => it.closing || 0));
  const ordering = sum(o.items.map((it) => it.orderedQty || 0));
  save();
  const inner = `
    <h2 class="title-sm">Confirm &amp; snap the sheet</h2>
    <div class="rows">
      <div class="lrow"><span>On hand now (bottles)</span><span class="v">${onHand}</span></div>
      <div class="lrow"><span>Ordering</span><span class="v">+${ordering}</span></div>
      <div class="lrow"><span>Have tomorrow</span><span class="v tan">${onHand + ordering}</span></div>
      <div class="lrow"><span>Order total</span><span class="v">${usd(o.total)}</span></div>
    </div>
    <div id="photoWrap"></div>
    <label class="btn filein">📷 Attach photo of paper sheet
      <input type="file" accept="image/*" capture="environment" id="ordphoto" hidden></label>
    <button class="btn ghost" id="back">‹ Back to order</button>`;
  root.innerHTML = managerShell('orders', 'Order review · Day ' + d.day, inner);
  wireShell(root);
  const pw = root.querySelector('#photoWrap');
  if (o.photoId) { const url = await photoDB.get(o.photoId); if (url) pw.innerHTML = `<img class="photo" src="${url}" alt="order sheet">`; }
  root.querySelector('#ordphoto').onchange = (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    compressImage(f, async (dataURL) => { const id = uid(); await photoDB.put(id, dataURL); o.photoId = id; save(); toast('Photo attached'); render(); });
  };
  root.querySelector('#back').onclick = () => go('#/m/orders');
}
route('#/m/review', renderReview);

/* ---------------------------------------------------------------------------
 * 11. Receiving (10)
 * ------------------------------------------------------------------------- */
async function renderReceiving(root) {
  ensureDay();
  const d = currentDay();
  const idx = S.days.findIndex((x) => x.id === d.id);
  const prev = idx > 0 ? S.days[idx - 1] : null;
  const ordered = prev ? prev.order.items.filter((it) => it.orderedQty > 0) : [];
  if (!d.receiving.length && ordered.length) d.receiving = ordered.map((it) => ({ name: it.name, ordered: it.orderedQty, received: it.orderedQty }));
  const rows = d.receiving.length ? d.receiving.map((it, i) => {
    const short = (it.received || 0) < (it.ordered || 0);
    return `<div class="lrow"><span>${esc(it.name)} — ordered ${it.ordered}</span>
      <span class="v">got <input class="inp inp--mini" data-i="${i}" type="number" inputmode="numeric" value="${it.received}"> ${short ? '<b class="warn">⚠</b>' : '<b class="ok">✓</b>'}</span></div>`;
  }).join('') : '<p class="muted">No order from the previous night to receive against.</p>';
  const inner = `
    <h2 class="title-sm">What actually arrived?</h2>
    <div class="rows" id="recRows">${rows}</div>
    <div id="prevPhoto"></div>
    <p class="muted small">Shortfalls flagged ⚠ · shows last night's order-sheet photo.</p>`;
  root.innerHTML = managerShell('inventory', 'Receiving · Day ' + d.day, inner);
  wireShell(root);
  root.querySelectorAll('input[data-i]').forEach((inp) => inp.oninput = () => {
    d.receiving[Number(inp.dataset.i)].received = Number(inp.value) || 0; save();
    const it = d.receiving[Number(inp.dataset.i)];
    const flag = inp.parentElement.querySelector('b'); if (flag) { const short = it.received < it.ordered; flag.className = short ? 'warn' : 'ok'; flag.textContent = short ? '⚠' : '✓'; }
  });
  if (prev && prev.order.photoId) { const url = await photoDB.get(prev.order.photoId); if (url) root.querySelector('#prevPhoto').innerHTML = `<div class="lbl">Yesterday's order sheet</div><img class="photo" src="${url}" alt="prior order">`; }
}
route('#/m/receiving', renderReceiving);

/* ---------------------------------------------------------------------------
 * 12. Tips (11) — bucket ÷ served, PIN-verified
 * ------------------------------------------------------------------------- */
function renderTips(root) {
  ensureDay();
  const d = currentDay();
  const agg = stationAgg(d);
  // keep tips array sized to stations
  if (d.tips.length !== S.settings.numStations) {
    const old = d.tips.slice();
    d.tips = Array.from({ length: S.settings.numStations }, (_, i) => old[i] || { station: i + 1, bucketTotal: 0, verified: false, verifiedBy: '' });
  }
  const rows = d.tips.map((t, i) => {
    const served = agg[t.station] ? agg[t.station].served : 0;
    const pp = served ? t.bucketTotal / served : 0;
    return `<div class="tip-card ${t.verified ? 'verified' : ''}">
      <div class="tip-head"><b>Station ${t.station}</b>${t.verified ? `<span class="v ok">✓ verified${t.verifiedBy ? ' · ' + esc(t.verifiedBy) : ''}</span>` : `<button class="chip" data-vf="${i}">Verify (PIN)</button>`}</div>
      <div class="tip-body">
        <label class="inp-lbl">Bucket total $</label>
        <input class="inp" data-bt="${i}" type="number" inputmode="decimal" value="${t.bucketTotal || ''}" placeholder="0" ${t.verified ? 'disabled' : ''}>
        <div class="lrow"><span>÷ served (Sta ${t.station})</span><span class="v">${served}</span></div>
        <div class="lrow"><span>Score / person</span><span class="v tan">${usd(pp, 2)}</span></div>
      </div>
    </div>`;
  }).join('');
  const total = sum(d.tips.map((t) => t.bucketTotal || 0));
  const inner = `
    <p class="muted">All money → ${esc(S.settings.boot.cause)}. The “contest” is bragging rights.</p>
    ${rows}
    <div class="lrow big-row"><span>Night tips total</span><span class="v tan">${usd(total)}</span></div>`;
  root.innerHTML = managerShell('tips', 'Tips · Day ' + d.day, inner);
  wireShell(root);
  root.querySelectorAll('input[data-bt]').forEach((inp) => inp.oninput = () => {
    d.tips[Number(inp.dataset.bt)].bucketTotal = Number(inp.value) || 0; save();
    // live refresh score/person + totals
    renderTips(root);
  });
  root.querySelectorAll('[data-vf]').forEach((b) => b.onclick = () => {
    const i = Number(b.dataset.vf);
    askPin('Verify Station ' + d.tips[i].station + ' tips', () => { d.tips[i].verified = true; d.tips[i].verifiedBy = S.device.name || 'Manager'; save(); render(); });
  });
}
route('#/m/tips', renderTips);

/* ---------------------------------------------------------------------------
 * 13. Analytics (12)
 * ------------------------------------------------------------------------- */
function sparkline(buckets, blockMin) {
  const keys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  if (!keys.length) return { svg: '<span class="muted">no data</span>', peak: null };
  const lo = keys[0], hi = keys[keys.length - 1];
  const slots = {};
  for (const k of keys) { const slot = Math.floor(k / blockMin) * blockMin; slots[slot] = (slots[slot] || 0) + buckets[k]; }
  const sk = Object.keys(slots).map(Number).sort((a, b) => a - b);
  const max = Math.max(...sk.map((k) => slots[k]));
  let peakK = sk[0]; sk.forEach((k) => { if (slots[k] > slots[peakK]) peakK = k; });
  const W = 220, H = 46, bw = W / sk.length;
  const bars = sk.map((k, i) => { const hgt = max ? (slots[k] / max) * (H - 6) : 0; const x = i * bw; const isPk = k === peakK; return `<rect x="${x + 1}" y="${H - hgt}" width="${bw - 2}" height="${hgt}" rx="1.5" fill="${isPk ? 'var(--tan)' : 'var(--ink-2)'}"></rect>`; }).join('');
  return { svg: `<svg viewBox="0 0 ${W} ${H}" class="spark" preserveAspectRatio="none">${bars}</svg>`, peak: peakK, peakVal: slots[peakK] };
}

function fastestMixer(day) {
  const m = {};
  day.shifts.forEach((sh) => {
    if (!sh.mixer) return;
    const mins = (sh.end != null ? sh.end : nowMin()) - sh.start;
    const dr = sum(sh.drinks || []);
    if (mins <= 0) return;
    m[sh.mixer] = m[sh.mixer] || { drinks: 0, mins: 0 };
    m[sh.mixer].drinks += dr; m[sh.mixer].mins += mins;
  });
  let best = null;
  for (const name in m) { const rate = m[name].drinks / m[name].mins; if (!best || rate > best.rate) best = { name, rate }; }
  return best;
}
function topBartenderByTips(day) {
  const agg = stationAgg(day);
  const per = {};
  day.shifts.forEach((sh) => {
    const st = agg[sh.station]; if (!st || !st.served) return;
    const tip = (day.tips.find((t) => t.station === sh.station) || {}).bucketTotal || 0;
    const share = (sh.served || 0) / st.served;
    per[sh.person] = per[sh.person] || { tips: 0, served: 0 };
    per[sh.person].tips += tip * share; per[sh.person].served += sh.served || 0;
  });
  let best = null;
  for (const n in per) { if (per[n].served < 1) continue; const pp = per[n].tips / per[n].served; if (!best || pp > best.pp) best = { name: n, pp }; }
  return best;
}
function shrinkage(day) {
  // expected liquor used (bottles) from drinks×pour vs actual used
  const expected = {};
  const drinkTotals = S.settings.drinks.map((_, i) => sum(day.shifts.map((s) => (s.drinks || [])[i] || 0)));
  S.settings.drinks.forEach((name, i) => {
    const map = S.settings.pourMap[name]; if (!map) return;
    map.forEach(([liquor, oz]) => { expected[liquor] = (expected[liquor] || 0) + drinkTotals[i] * oz; });
  });
  const out = [];
  day.inventory.forEach((it) => {
    const used = (it.opening || 0) - (it.closing || 0);
    const pour = S.settings.pours.find((p) => p.item === it.name);
    if (!pour || !pour.bottleOz) return;
    const expBottles = (expected[it.name] || 0) / pour.bottleOz;
    const diff = used - expBottles;
    if (used || expBottles) out.push({ name: it.name, used, expected: expBottles, diff });
  });
  return out;
}
function revenueEstimate(day) {
  const drinkTotals = S.settings.drinks.map((_, i) => sum(day.shifts.map((s) => (s.drinks || [])[i] || 0)));
  return sum(drinkTotals.map((c, i) => c * (S.settings.drinkPrices[i] || 0)));
}

let analyticsBlock = 15;
function renderAnalytics(root) {
  ensureDay();
  const d = currentDay();
  const t = dayTotals(d);
  const buckets = dayServedBuckets(d);
  const sp = sparkline(buckets, analyticsBlock);
  const fm = fastestMixer(d);
  const tb = topBartenderByTips(d);
  const agg = stationAgg(d);
  const stArr = Object.values(agg).filter((s) => s.served > 0).sort((a, b) => b.served - a.served);
  const cap = stArr.length ? `Sta ${stArr[0].station} ▲${stArr.length > 1 ? ' / Sta ' + stArr[stArr.length - 1].station + ' ▼' : ''}` : '—';
  const shr = shrinkage(d).filter((s) => Math.abs(s.diff) >= 0.5);
  const rev = revenueEstimate(d);
  const inner = `
    <h2 class="title-sm">Funnel &amp; people</h2>
    <div class="funnel">
      <div class="fn"><span>Line</span><b>${t.line}</b></div><span class="arr">›</span>
      <div class="fn"><span>Ordered</span><b>${t.served}</b></div><span class="arr">›</span>
      <div class="fn"><span>Drinks</span><b>${t.drinks}</b></div>
    </div>
    <div class="lrow"><span>Conversion (served ÷ line)</span><span class="v">${(t.conv * 100).toFixed(0)}%</span></div>
    <div class="lrow"><span>Drinks / person</span><span class="v">${t.dpp.toFixed(1)}</span></div>
    <div class="card">
      <div class="lrow"><span>Busy / slow</span><span class="seg mini"><button class="s ${analyticsBlock === 15 ? 'on' : ''}" data-bl="15">15m</button><button class="s ${analyticsBlock === 30 ? 'on' : ''}" data-bl="30">30m</button></span></div>
      <div class="spark-wrap">${sp.svg}</div>
      ${sp.peak != null ? `<div class="mut center">peak ${minToLabel(sp.peak)} · ${sp.peakVal} served</div>` : ''}
    </div>
    <div class="lrow"><span>Top bartender (tips/person)</span><span class="v tan">${tb ? esc(tb.name) + ' ' + usd(tb.pp, 2) : '—'}</span></div>
    <div class="lrow"><span>Fastest mixer</span><span class="v">${fm ? esc(fm.name) + ' ' + fm.rate.toFixed(1) + '/min' : '—'}</span></div>
    <div class="lrow"><span>Line capacity</span><span class="v">${cap}</span></div>
    <div class="lrow"><span>Revenue estimate (drink sales)</span><span class="v">${usd(rev)}</span></div>
    <div class="card">
      <div class="lbl">Liquor shrinkage (used vs poured-for)</div>
      ${shr.length ? shr.map((s) => `<div class="lrow"><span>${esc(s.name)}</span><span class="v ${s.diff > 0 ? 'warn' : ''}">${s.diff > 0 ? '+' : ''}${s.diff.toFixed(1)} btl ${s.diff > 0 ? '⚠' : ''}</span></div>`).join('') : '<p class="muted small">Enter inventory + pours to see shrinkage.</p>'}
    </div>`;
  root.innerHTML = managerShell('more', 'Analytics · Day ' + d.day, inner);
  wireShell(root);
  root.querySelectorAll('[data-bl]').forEach((b) => b.onclick = () => { analyticsBlock = Number(b.dataset.bl); render(); });
}
route('#/m/analytics', renderAnalytics);

/* ---------------------------------------------------------------------------
 * 14. Fun Stats (17)
 * ------------------------------------------------------------------------- */
function funStats(day) {
  const drinkTotals = S.settings.drinks.map((_, i) => sum(day.shifts.map((s) => (s.drinks || [])[i] || 0)));
  const total = sum(drinkTotals);
  let dotnI = 0; drinkTotals.forEach((c, i) => { if (c > drinkTotals[dotnI]) dotnI = i; });
  const dotn = total ? `${S.settings.drinks[dotnI]} ×${drinkTotals[dotnI]}` : '—';
  const beerSet = new Set(S.settings.beer);
  const beer = sum(S.settings.drinks.map((n, i) => beerSet.has(n) ? drinkTotals[i] : 0));
  const cocktail = total - beer;
  const buckets = dayServedBuckets(day);
  const sp = sparkline(buckets, 15);
  let streak = null; day.shifts.forEach((s) => { if (s.streak && (!streak || s.streak > streak.k)) streak = { name: s.person, k: s.streak }; });
  const boot = bootForDay(day);
  const served = dayTotals(day).served;
  const peakRate = sp.peak != null ? (boot / Math.max(1, served)) * (sp.peakVal / 15) : 0;
  return { dotn, beer, cocktail, total, sp, streak, peakRate, boot };
}
function renderFun(root) {
  ensureDay();
  const d = currentDay();
  const f = funStats(d);
  const beerPct = f.total ? Math.round(f.beer / f.total * 100) : 0;
  // best night yet
  let best = null; S.days.forEach((x) => { const dr = dayTotals(x).drinks; if (!best || dr > best.dr) best = { day: x.day, dr }; });
  // beat last year pace
  const lastYear = (S.settings.boot.pastYears[0] || {}).total || S.settings.boot.goal;
  const cum = bootCumulativeThrough(d);
  const pace = lastYear ? Math.round(cum / lastYear * 100) : 0;
  const inner = `
    <h2 class="title-sm">Superlatives 🏆</h2>
    <div class="rows">
      <div class="lrow"><span>Drink of the night</span><span class="v tan">${esc(f.dotn)}</span></div>
      <div class="lrow"><span>Power hour (busiest 15-min)</span><span class="v">${f.sp.peak != null ? minToLabel(f.sp.peak) + ' · ' + f.sp.peakVal : '—'}</span></div>
      <div class="lrow"><span>Beer vs cocktail</span><span class="v">${beerPct}% / ${100 - beerPct}%</span></div>
      <div class="lrow"><span>Longest streak</span><span class="v">${f.streak ? esc(f.streak.name) + ' · ' + f.streak.k + ' in a row' : '—'}</span></div>
      <div class="lrow"><span>Fastest fundraising</span><span class="v">${usd(f.peakRate, 0)}/min peak</span></div>
      <div class="lrow"><span>Best night yet</span><span class="v">${best ? 'Day ' + best.day + ' · ' + best.dr + ' drinks' : '—'}</span></div>
      <div class="lrow"><span>Beat-last-year pace</span><span class="v ${pace >= 100 ? 'ok' : ''}">${pace}% of ${usd(lastYear)}</span></div>
    </div>`;
  root.innerHTML = managerShell('more', 'Fun Stats · Day ' + d.day, inner);
  wireShell(root);
}
route('#/m/fun', renderFun);

/* ---------------------------------------------------------------------------
 * 15. Leaderboard + awards (rates, qualifier, champion)
 * ------------------------------------------------------------------------- */
function peopleAgg() {
  const ppl = {}; // person -> stats
  const mixers = {};
  const duos = {};
  S.days.forEach((day) => {
    const agg = stationAgg(day);
    day.shifts.forEach((sh) => {
      const p = ppl[sh.person] = ppl[sh.person] || { name: sh.person, nights: new Set(), served: 0, drinks: 0, mins: 0, shifts: 0, tips: 0, streak: 0, lastEnd: 0 };
      p.nights.add(day.id); p.served += sh.served || 0; p.drinks += sum(sh.drinks || []);
      const mins = (sh.end != null ? sh.end : nowMin()) - sh.start; p.mins += Math.max(0, mins); p.shifts++;
      if (sh.streak > p.streak) p.streak = sh.streak;
      if ((sh.end || 0) > p.lastEnd) p.lastEnd = sh.end || 0;
      const st = agg[sh.station];
      const tip = (day.tips.find((t) => t.station === sh.station) || {}).bucketTotal || 0;
      if (st && st.served) p.tips += tip * ((sh.served || 0) / st.served);
      if (sh.mixer) {
        const m = mixers[sh.mixer] = mixers[sh.mixer] || { name: sh.mixer, drinks: 0, mins: 0 };
        m.drinks += sum(sh.drinks || []); m.mins += Math.max(1, mins);
        const key = sh.person + ' + ' + sh.mixer;
        const dd = duos[key] = duos[key] || { key, drinks: 0, mins: 0 };
        dd.drinks += sum(sh.drinks || []); dd.mins += Math.max(1, mins);
      }
    });
  });
  const arr = Object.values(ppl).map((p) => ({
    name: p.name, nights: p.nights.size, served: p.served, drinks: p.drinks, hours: p.mins / 60, shifts: p.shifts,
    tips: p.tips, streak: p.streak, lastEnd: p.lastEnd,
    tipsPP: p.served ? p.tips / p.served : 0,
    perHr: p.mins ? p.served / (p.mins / 60) : 0,
    drinksMin: p.mins ? p.drinks / p.mins : 0,
  }));
  return { people: arr, mixers: Object.values(mixers).map((m) => ({ name: m.name, rate: m.drinks / Math.max(1, m.mins) })), duos: Object.values(duos).map((d) => ({ name: d.key, rate: d.drinks / Math.max(1, d.mins) })) };
}
const QUALIFY = 25;
let lbMetric = 'tipsPP';
function renderLeaderboard(root) {
  ensureDay();
  const { people, mixers, duos } = peopleAgg();
  const labels = { tipsPP: 'Tips / person', perHr: 'People / hr', drinksMin: 'Drinks / min', tips: 'Total raised' };
  const fmtV = (p) => lbMetric === 'tipsPP' ? usd(p.tipsPP, 2) : lbMetric === 'perHr' ? p.perHr.toFixed(0) + '/hr' : lbMetric === 'drinksMin' ? p.drinksMin.toFixed(2) + '/min' : usd(p.tips);
  const qualified = people.filter((p) => lbMetric === 'tips' || p.served >= QUALIFY);
  const ranked = qualified.slice().sort((a, b) => (b[lbMetric] || 0) - (a[lbMetric] || 0));
  // overall champion: blended percentile across rate metrics
  const champ = (() => {
    const elig = people.filter((p) => p.served >= QUALIFY); if (elig.length < 2) return elig[0] || null;
    const pct = (key) => { const vals = elig.map((p) => p[key]).sort((a, b) => a - b); return (v) => vals.filter((x) => x <= v).length / vals.length; };
    const fT = pct('tipsPP'), fH = pct('perHr'), fD = pct('drinksMin');
    let best = null; elig.forEach((p) => { const sc = (fT(p.tipsPP) + fH(p.perHr) + fD(p.drinksMin)) / 3; if (!best || sc > best.sc) best = { p, sc }; });
    return best ? best.p : null;
  })();
  // awards
  const topMixer = mixers.sort((a, b) => b.rate - a.rate)[0];
  const topDuo = duos.sort((a, b) => b.rate - a.rate)[0];
  const workhorse = people.slice().sort((a, b) => (b.shifts - a.shifts) || (b.hours - a.hours))[0];
  const closer = people.slice().sort((a, b) => b.lastEnd - a.lastEnd)[0];
  const rookie = people.filter((p) => p.nights <= 2 && p.served >= QUALIFY).sort((a, b) => b.tipsPP - a.tipsPP)[0];
  const rushHero = people.slice().sort((a, b) => b.streak - a.streak)[0];
  const peoplesChamp = people.slice().sort((a, b) => b.served - a.served)[0];

  const rows = ranked.length ? ranked.map((p, i) => `
    <div class="lb-row"><span class="lb-rk">${i + 1}</span><span class="lb-nm">${esc(p.name)}<span class="mut"> · ${p.nights}n · ${p.served} served</span></span><span class="v tan">${fmtV(p)}</span></div>`).join('')
    : '<p class="muted">No qualified shifts yet (need ~' + QUALIFY + ' served).</p>';
  const award = (t, who, sub) => `<div class="award"><div class="aw-t">${t}</div><div class="aw-w">${who ? esc(who) : '—'}</div>${sub ? `<div class="mut">${esc(sub)}</div>` : ''}</div>`;
  const inner = `
    <div class="seg" id="metricSeg">${Object.keys(labels).map((k) => `<button class="s ${k === lbMetric ? 'on' : ''}" data-m="${k}">${labels[k]}</button>`).join('')}</div>
    <p class="muted small">Ranked by rate so a 1-night helper competes fairly. Qualifier: ~${QUALIFY}+ served.</p>
    <div class="rows">${rows}</div>
    <div class="card champ"><div class="lbl">Overall Rodeo Champion</div><div class="champ-name">${champ ? '🏆 ' + esc(champ.name) : '—'}</div><div class="mut">Blended percentile across rate metrics</div></div>
    <h2 class="title-sm">Awards</h2>
    <div class="awards">
      ${award('Top Tip Magnet', ranked[0] && ranked[0].name, ranked[0] && usd(ranked[0].tipsPP, 2) + '/person')}
      ${award("People's Champ", peoplesChamp && peoplesChamp.name, peoplesChamp && peoplesChamp.served + ' served')}
      ${award('Fastest Hands (mixer)', topMixer && topMixer.name, topMixer && topMixer.rate.toFixed(2) + '/min')}
      ${award('Best Duo', topDuo && topDuo.name, topDuo && topDuo.rate.toFixed(2) + '/min')}
      ${award('Workhorse', workhorse && workhorse.name, workhorse && workhorse.shifts + ' shifts · ' + workhorse.hours.toFixed(1) + 'h')}
      ${award('The Closer', closer && closer.name, closer && 'out ' + minToLabel(closer.lastEnd))}
      ${award('Rush Hour Hero', rushHero && rushHero.name, rushHero && rushHero.streak + ' streak')}
      ${award('Rookie of the Rodeo', rookie && rookie.name, rookie && usd(rookie.tipsPP, 2) + '/person')}
    </div>`;
  root.innerHTML = managerShell('more', 'Leaderboard', inner);
  wireShell(root);
  root.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => { lbMetric = b.dataset.m; render(); });
}
route('#/m/leaderboard', renderLeaderboard);

/* ---------------------------------------------------------------------------
 * 16. Fill the Boot (13)
 * ------------------------------------------------------------------------- */
function renderBoot(root) {
  ensureDay();
  const d = currentDay();
  const goal = S.settings.boot.goal || 0;
  const cum = bootCumulativeThrough(d);
  const pct = goal ? Math.round(cum / goal * 100) : 0;
  const dayRows = S.days.map((x) => {
    const amt = bootForDay(x); const auto = x.bootAmount == null;
    const isCur = x.id === d.id;
    return `<div class="lrow"><span>Day ${x.day}${isCur ? ' — tonight' : ''}</span>
      <span class="v">${isCur ? `<input class="inp inp--mini" id="bootInp" type="number" inputmode="decimal" value="${x.bootAmount != null ? x.bootAmount : ''}" placeholder="${Math.round(amt)}"> ${auto ? '<span class="mut">auto</span>' : ''}` : usd(amt) + (auto ? ' <span class="mut">auto</span>' : '')}</span></div>`;
  }).join('');
  const inner = `
    <h2 class="title-sm">Fill the Boot — tracker</h2>
    <div class="boot-big">
      <div class="lbl">Raised so far (cumulative)</div>
      <div class="boot-amt">${usd(cum)}</div>
      <div class="bar"><div class="bar-fill" style="width:${clamp(pct, 0, 100)}%"></div></div>
      <div class="mut">${pct}% of ${usd(goal)} goal · ${esc(S.settings.boot.cause)}</div>
    </div>
    ${paceBanner()}
    <div class="rows">${dayRows}</div>
    <p class="muted small">Tonight auto-suggests from tips — type to override. Numbers only; your boot graphic/file renders the visual.</p>
    <button class="btn ghost" id="resetBoot">Reset tonight to auto</button>`;
  root.innerHTML = managerShell('more', 'Fill the Boot · Day ' + d.day, inner);
  wireShell(root);
  const inp = root.querySelector('#bootInp');
  if (inp) inp.oninput = () => { d.bootAmount = inp.value === '' ? null : Number(inp.value) || 0; save(); render(); };
  root.querySelector('#resetBoot').onclick = () => { d.bootAmount = null; save(); render(); };
}
route('#/m/boot', renderBoot);

/* ---------------------------------------------------------------------------
 * 17. Year-over-year + export (14)
 * ------------------------------------------------------------------------- */
function renderYoY(root) {
  ensureDay();
  const rows = S.settings.boot.pastYears.map((y, i) => `<div class="lrow"><span>${y.year} total</span><span class="v">${usd(y.total)}</span></div>`).join('') || '<p class="muted">No past years yet — import a spreadsheet.</p>';
  const thisTotal = sum(S.days.map((d) => bootForDay(d)));
  const lastYear = (S.settings.boot.pastYears[0] || {}).total || 0;
  const pace = lastYear ? Math.round((thisTotal - lastYear) / lastYear * 100) : 0;
  const inner = `
    <h2 class="title-sm">Compare to past years</h2>
    <div class="rows">${rows}
      <div class="lrow"><span>This year so far</span><span class="v tan">${usd(thisTotal)}</span></div>
      <div class="lrow"><span>Pace vs last year</span><span class="v ${pace >= 0 ? 'ok' : 'warn'}">${pace >= 0 ? '+' : ''}${pace}%</span></div>
    </div>
    <label class="btn filein">⤓ Import past-years spreadsheet (.xlsx/.csv)
      <input type="file" accept=".xlsx,.xls,.csv" id="yoyfile" hidden></label>
    <p class="muted small">Sheet with columns <b>Year</b> + <b>Total</b>. First row = newest sets the goal.</p>
    <button class="btn btn--tan" id="expTotals">Export tonight's totals (.csv)</button>
    <p class="muted small">CSV of nightly totals for your external boot graphic file.</p>`;
  root.innerHTML = managerShell('more', 'Year-over-year', inner);
  wireShell(root);
  root.querySelector('#yoyfile').onchange = (e) => { const f = e.target.files && e.target.files[0]; if (f) importPastYears(f); e.target.value = ''; };
  root.querySelector('#expTotals').onclick = exportNightlyCSV;
}
route('#/m/yoy', renderYoY);

function importPastYears(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const wb = XLSX.read(r.result, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
      const years = [];
      rows.forEach((row) => {
        const y = parseInt(row[0], 10); const tot = parseFloat(String(row[1]).replace(/[^0-9.\-]/g, ''));
        if (!isNaN(y) && !isNaN(tot)) years.push({ year: y, total: tot });
      });
      if (!years.length) return toast('No Year/Total rows found');
      years.sort((a, b) => b.year - a.year);
      S.settings.boot.pastYears = years;
      S.settings.boot.goal = years[0].total; save(); toast('Imported ' + years.length + ' years · goal ' + usd(years[0].total)); render();
    } catch (e) { toast('Could not read spreadsheet'); }
  };
  r.readAsArrayBuffer(file);
}
function exportNightlyCSV() {
  let cum = 0;
  const lines = [['Day', 'Date', 'Served', 'Drinks', 'TipsTotal', 'BootAmount', 'Cumulative']];
  S.days.forEach((d) => { const t = dayTotals(d); const amt = bootForDay(d); cum += amt; lines.push([d.day, d.date, t.served, t.drinks, t.tipsTotal, amt, cum]); });
  const csv = lines.map((r) => r.join(',')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `boot-totals-${todayISO()}.csv`);
}

/* ---------------------------------------------------------------------------
 * 18. History + Backup (15)
 * ------------------------------------------------------------------------- */
function renderHistory(root) {
  const rows = S.days.length ? S.days.map((d) => { const t = dayTotals(d); return `<div class="lrow"><span>Day ${d.day} — ${d.date}</span><span class="v">${t.drinks} dr · ${usd(t.tipsTotal)}</span></div>`; }).join('') : '<p class="muted">No nights yet.</p>';
  const snaps = store.snapshots();
  const snapRows = snaps.length
    ? snaps.slice().reverse().map((s, i) => {
      let lbl = '';
      try { const st = JSON.parse(s.raw); lbl = `${(st.days || []).length} night${(st.days || []).length === 1 ? '' : 's'}`; } catch (e) { lbl = '—'; }
      const time = new Date(s.t); const hhmm = time.toLocaleString();
      return `<div class="lrow"><span>${esc(hhmm)} <span class="mut">· ${lbl}</span></span><button class="chip" data-snap="${snaps.length - 1 - i}">Restore</button></div>`;
    }).join('')
    : '<p class="muted small">No restore points yet — they accrue as you work.</p>';
  const inner = `
    <h2 class="title-sm">History — ${S.days.length} night${S.days.length === 1 ? '' : 's'}</h2>
    <div class="rows">${rows}</div>
    <button class="btn btn--tan" id="backup">⤓ Backup (export JSON)</button>
    <label class="btn filein">⤒ Restore (import JSON)<input type="file" accept="application/json,.json" id="restore" hidden></label>
    <div class="lbl">Auto restore points (on-device)</div>
    <div class="rows">${snapRows}</div>
    <button class="btn ghost" id="demo">Load demo night (for testing)</button>
    <p class="muted small">Backup includes all nights, settings, and photos. Keep one off-device each night. Restore points are kept automatically on this phone as a safety net.</p>`;
  root.innerHTML = managerShell('more', 'History + Backup', inner);
  wireShell(root);
  root.querySelector('#backup').onclick = exportBackup;
  root.querySelector('#restore').onchange = (e) => { const f = e.target.files && e.target.files[0]; if (f) importBackup(f); e.target.value = ''; };
  root.querySelector('#demo').onclick = () => confirmSheet('Load demo night?', 'Adds one fully-populated night so you can see analytics, leaderboard, and exports. You can delete it via Restore.', 'Load demo', () => { loadDemo(); render(); });
  root.querySelectorAll('[data-snap]').forEach((b) => b.onclick = () => {
    const idx = Number(b.dataset.snap); const snap = store.snapshots()[idx];
    if (!snap) return;
    confirmSheet('Restore this point?', `Replaces current data with the ${new Date(snap.t).toLocaleString()} save. A backup downloads first.`, 'Restore', () => {
      exportBackup();
      try { const st = JSON.parse(snap.raw); if (validShape(st)) { S = migrate(st); save(); toast('Restored'); render(); } else toast('That restore point is unreadable'); } catch (e) { toast('That restore point is unreadable'); }
    });
  });
}
route('#/m/history', renderHistory);

async function exportBackup() {
  // Capture the state SYNCHRONOUSLY up front — callers (guarded reset, snapshot restore) reassign S
  // right after, and photoDB.all() awaits, so reading S post-await would back up the wrong state.
  let stateSnap; try { stateSnap = JSON.parse(JSON.stringify(S)); } catch (e) { stateSnap = S; }
  const photos = await photoDB.all();
  const backup = { app: 'bar-count', schema: 2, exportedAt: new Date().toISOString(), state: stateSnap, photos };
  downloadBlob(new Blob([JSON.stringify(backup)], { type: 'application/json' }), `barcount-backup-${todayISO()}.json`);
  toast('Backup downloaded');
}

// Idea #1 — Guarded reset: force a backup, type RESET, then PIN, before wiping.
function guardedReset() {
  exportBackup(); // downloads a full JSON first
  const w = sheet(`<h3 class="sh-h">Erase this phone?</h3>
    <p class="muted">A full backup just downloaded. This wipes <b>all nights, settings, and counts</b> on this phone — it can't be undone without that backup. Type <b>RESET</b> to confirm.</p>
    <input class="inp" id="rt" placeholder="Type RESET" autocomplete="off" autocapitalize="characters">
    <div class="row2"><button class="btn" id="rc">Cancel</button><button class="btn btn--go" id="rk">Erase</button></div>`);
  w.querySelector('#rc').onclick = closeSheet;
  w.querySelector('#rk').onclick = () => {
    if (w.querySelector('#rt').value.trim().toUpperCase() !== 'RESET') { toast('Type RESET to confirm'); return; }
    closeSheet();
    askPin('Enter PIN to erase this phone', () => { S = defaultState(); save(); toast('Phone reset — backup was downloaded'); go(''); });
  };
  setTimeout(() => { const el = w.querySelector('#rt'); if (el) el.focus(); }, 50);
}
function importBackup(file) {
  const r = new FileReader();
  r.onload = async () => {
    try {
      const b = JSON.parse(r.result);
      if (!b.state) throw new Error('bad');
      S = migrate(b.state); save();
      if (b.photos) for (const k in b.photos) await photoDB.put(k, b.photos[k]);
      toast('Restored backup'); render();
    } catch (e) { toast('Invalid backup file'); }
  };
  r.readAsText(file);
}

/* ---------------------------------------------------------------------------
 * 19. Settings (16)
 * ------------------------------------------------------------------------- */
function renderSettings(root) {
  const st = S.settings;
  const inner = `
    <h2 class="title-sm">Settings</h2>
    <div class="set-grp">
      <label class="inp-lbl">Event name</label><input class="inp" id="sEvent" value="${esc(st.event)}">
      <label class="inp-lbl">Number of stations</label><input class="inp" id="sStations" type="number" min="1" max="12" value="${st.numStations}">
      <label class="inp-lbl">Number of nights</label><input class="inp" id="sNights" type="number" min="1" value="${st.nights}">
      <label class="inp-lbl">Boot goal $ (beat last year)</label><input class="inp" id="sGoal" type="number" value="${st.boot.goal}">
      <label class="inp-lbl">Cause</label><input class="inp" id="sCause" value="${esc(st.boot.cause)}">
      <label class="inp-lbl">Boot-meter est. $ per person served</label><input class="inp" id="sTipEst" type="number" inputmode="decimal" value="${st.tipEst}">
    </div>
    <div class="set-grp">
      <div class="lbl">9-drink grid (comma-separated)</div>
      <textarea class="inp ta" id="sDrinks">${esc(st.drinks.join(', '))}</textarea>
      <div class="lbl">Drink prices (same order, comma-separated)</div>
      <textarea class="inp ta" id="sPrices">${esc(st.drinkPrices.join(', '))}</textarea>
      <div class="lbl">Beer drinks (excluded from inventory; comma-separated)</div>
      <textarea class="inp ta" id="sBeer">${esc(st.beer.join(', '))}</textarea>
    </div>
    <div class="set-grp">
      <div class="lbl">Order catalog — name, price, recommended (one per line)</div>
      <textarea class="inp ta tall" id="sCatalog">${esc(st.catalog.map((c) => `${c.name}, ${c.unitPrice}, ${c.recommendedQty}`).join('\n'))}</textarea>
    </div>
    <div class="set-grp">
      <div class="lbl">Pours — liquor, pourOz, bottleOz (one per line, for shrinkage)</div>
      <textarea class="inp ta tall" id="sPours">${esc(st.pours.map((p) => `${p.item}, ${p.pourOz}, ${p.bottleOz}`).join('\n'))}</textarea>
    </div>
    <div class="set-grp">
      <label class="inp-lbl">Team phone numbers (recap SMS; comma-separated)</label>
      <textarea class="inp ta" id="sPhones">${esc(st.teamPhones.join(', '))}</textarea>
      <label class="inp-lbl">Team emails (recap Email; comma-separated)</label>
      <textarea class="inp ta" id="sEmails">${esc(st.teamEmails.join(', '))}</textarea>
    </div>
    <div class="set-grp">
      <label class="inp-lbl">Admin PIN</label><input class="inp" id="sPin" type="text" inputmode="numeric" value="${esc(st.adminPin)}" placeholder="set a PIN">
    </div>
    <button class="btn btn--go" id="saveSet">Save settings</button>
    <button class="btn ghost" id="reset">Reset this phone (role + data)</button>`;
  root.innerHTML = managerShell('more', 'Settings', inner);
  wireShell(root);
  root.querySelector('#saveSet').onclick = () => {
    st.event = root.querySelector('#sEvent').value.trim() || st.event;
    st.numStations = clamp(Number(root.querySelector('#sStations').value) || 4, 1, 12);
    st.nights = Math.max(1, Number(root.querySelector('#sNights').value) || 10);
    st.boot.goal = Number(root.querySelector('#sGoal').value) || 0;
    st.boot.cause = root.querySelector('#sCause').value.trim() || st.boot.cause;
    st.tipEst = Number(root.querySelector('#sTipEst').value) || 0;
    const drinks = root.querySelector('#sDrinks').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (drinks.length) st.drinks = drinks;
    st.drinkPrices = root.querySelector('#sPrices').value.split(',').map((s) => Number(s.trim()) || 0);
    st.beer = root.querySelector('#sBeer').value.split(',').map((s) => s.trim()).filter(Boolean);
    st.catalog = root.querySelector('#sCatalog').value.split('\n').map((l) => l.split(',')).filter((p) => p[0] && p[0].trim()).map((p) => ({ name: p[0].trim(), unitPrice: Number(p[1]) || 0, recommendedQty: Number(p[2]) || 0 }));
    st.pours = root.querySelector('#sPours').value.split('\n').map((l) => l.split(',')).filter((p) => p[0] && p[0].trim()).map((p) => ({ item: p[0].trim(), pourOz: Number(p[1]) || 0, bottleOz: Number(p[2]) || 0 }));
    st.teamPhones = root.querySelector('#sPhones').value.split(',').map((s) => s.trim()).filter(Boolean);
    st.teamEmails = root.querySelector('#sEmails').value.split(',').map((s) => s.trim()).filter(Boolean);
    st.adminPin = root.querySelector('#sPin').value.trim();
    save(); toast('Settings saved'); render();
  };
  root.querySelector('#reset').onclick = guardedReset;
}
route('#/m/settings', renderSettings);

/* ---------------------------------------------------------------------------
 * 20. Team Recap (18) — SMS + Email + Copy
 * ------------------------------------------------------------------------- */
function recapText(day, opts) {
  const t = dayTotals(day);
  const f = funStats(day);
  const cum = bootCumulativeThrough(day);
  const goal = S.settings.boot.goal;
  const tb = topBartenderByTips(day);
  const lines = [`🤠 ${S.settings.event} Bar — Day ${day.day}`];
  if (opts.boot) lines.push(`Raised ${usd(bootForDay(day))} tonight! Boot ${usd(cum)} (${goal ? Math.round(cum / goal * 100) : 0}% of goal 🔥)`);
  if (opts.tips && tb) lines.push(`🏆 Top tips/person: ${tb.name} ${usd(tb.pp, 2)}`);
  if (opts.drink) lines.push(`🍹 ${f.dotn} ran the night`);
  if (opts.power && f.sp.peak != null) lines.push(`⚡ Power hour ${minToLabel(f.sp.peak)} (${f.sp.peakVal} served)`);
  if (opts.funnel) lines.push(`📊 Line ${t.line} → Served ${t.served} → ${t.drinks} drinks`);
  lines.push('See you tomorrow! All to the ' + S.settings.boot.cause + ' 🙌');
  return lines.join('\n');
}
const recapOpts = { boot: true, tips: true, drink: true, power: false, funnel: false };
function renderRecap(root) {
  ensureDay();
  const d = currentDay();
  const text = recapText(d, recapOpts);
  const chips = [['boot', 'Boot total'], ['tips', 'Top tips'], ['drink', 'Drink of night'], ['power', 'Power hour'], ['funnel', 'Funnel']];
  const inner = `
    <h2 class="title-sm">Send everyone a recap</h2>
    <div class="chips">${chips.map(([k, l]) => `<button class="chip ${recapOpts[k] ? 'chip--tan' : ''}" data-o="${k}">${l}${recapOpts[k] ? ' ✓' : ''}</button>`).join('')}</div>
    <div class="recap-prev" id="prev">${esc(text).replace(/\n/g, '<br>')}</div>
    <button class="btn btn--tan" id="sms">💬 Open in Messages (SMS)</button>
    <button class="btn" id="email">✉️ Email recap</button>
    <button class="btn ghost" id="copy">Copy text</button>
    <p class="muted small">Composing works offline. SMS sends on basic signal; <b>email needs internet</b> — your mail app sends when connected. Nothing auto-sends.</p>`;
  root.innerHTML = managerShell('more', 'Team Recap · Day ' + d.day, inner);
  wireShell(root);
  root.querySelectorAll('[data-o]').forEach((b) => b.onclick = () => { recapOpts[b.dataset.o] = !recapOpts[b.dataset.o]; render(); });
  root.querySelector('#copy').onclick = () => copyText(text);
  root.querySelector('#sms').onclick = () => {
    const recips = S.settings.teamPhones.join(',');
    const sep = isIOS() ? '&' : '?';
    location.href = `sms:${recips}${sep}body=${encodeURIComponent(text)}`;
  };
  root.querySelector('#email').onclick = () => emailRecap(d, text);
}
route('#/m/recap', renderRecap);

async function emailRecap(day, text) {
  const subject = `${S.settings.event} Bar — Day ${day.day} recap`;
  const to = S.settings.teamEmails.join(',');
  // Try to share the Excel as an attachment where supported.
  try {
    const blob = workbookBlob();
    const file = new File([blob], excelName(), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ title: subject, text, files: [file] });
      return;
    }
  } catch (e) { /* fall back to mailto */ }
  // Fallback: open mail app prefilled, and download the xlsx for manual attach.
  const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text + '\n\n(Attach the downloaded Excel file.)')}`;
  try { downloadBlob(workbookBlob(), excelName()); } catch (e) {}
  location.href = mailto;
  toast('Mail app opening — attach the downloaded Excel');
}

/* ---------------------------------------------------------------------------
 * 21. Excel export (feature 1) — full workbook, regenerated each click
 * ------------------------------------------------------------------------- */
function excelName() { return `bar-count-${String(S.settings.event).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}-${todayISO()}.xlsx`; }

function buildWorkbook() {
  const wb = XLSX.utils.book_new();
  const D = S.settings.drinks;

  // Summary
  const summary = [['Day', 'Date', 'Line', 'Served', 'Drinks', 'Tips $', 'Conversion %', 'Drinks/Person']];
  S.days.forEach((d) => { const t = dayTotals(d); summary.push([d.day, d.date, t.line, t.served, t.drinks, t.tipsTotal, +(t.conv * 100).toFixed(1), +t.dpp.toFixed(2)]); });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary');

  // Drinks: night x station x 9 drinks
  const drinks = [['Day', 'Date', 'Station', ...D, 'Total']];
  S.days.forEach((d) => {
    const agg = stationAgg(d);
    Object.values(agg).forEach((st) => { if (sum(st.drinks) || st.served) drinks.push([d.day, d.date, st.station, ...st.drinks, sum(st.drinks)]); });
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(drinks), 'Drinks');

  // Tips: night x station
  const tips = [['Day', 'Date', 'Station', 'Bucket $', 'Served', '$/Person', 'Verified', 'Verified By']];
  S.days.forEach((d) => {
    const agg = stationAgg(d);
    (d.tips || []).forEach((t) => { const served = agg[t.station] ? agg[t.station].served : 0; tips.push([d.day, d.date, t.station, t.bucketTotal || 0, served, served ? +((t.bucketTotal || 0) / served).toFixed(2) : 0, t.verified ? 'Yes' : 'No', t.verifiedBy || '']); });
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tips), 'Tips');

  // Inventory: night x liquor
  const inv = [['Day', 'Date', 'Liquor', 'Opening', 'Closing', 'Used', 'Ordered', 'Received']];
  S.days.forEach((d) => {
    (d.inventory || []).forEach((it) => {
      const ord = ((d.order.items || []).find((o) => o.name === it.name) || {}).orderedQty || 0;
      const rec = ((d.receiving || []).find((r) => r.name === it.name) || {}).received;
      inv.push([d.day, d.date, it.name, it.opening || 0, it.closing || 0, (it.opening || 0) - (it.closing || 0), ord, rec == null ? '' : rec]);
    });
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(inv), 'Inventory');

  // Boot: per day
  const lastYear = (S.settings.boot.pastYears[0] || {}).total || 0;
  const boot = [['Day', 'Date', 'Amount $', 'Cumulative $', 'Goal $', '% of Goal', 'Vs Last Year $']];
  let cum = 0;
  S.days.forEach((d) => { const amt = bootForDay(d); cum += amt; boot.push([d.day, d.date, amt, cum, S.settings.boot.goal, S.settings.boot.goal ? +(cum / S.settings.boot.goal * 100).toFixed(1) : 0, lastYear ? +(cum - lastYear).toFixed(0) : '']); });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(boot), 'Boot');

  // People: per person aggregate
  const { people } = peopleAgg();
  const ppl = [['Name', 'Nights', 'Served', 'Drinks', 'Tips $', 'Tips/Person', 'Drinks/Min', 'People/Hr', 'Shifts', 'Hours', 'Longest Streak']];
  people.sort((a, b) => b.tipsPP - a.tipsPP).forEach((p) => ppl.push([p.name, p.nights, p.served, p.drinks, +p.tips.toFixed(0), +p.tipsPP.toFixed(2), +p.drinksMin.toFixed(2), +p.perHr.toFixed(1), p.shifts, +p.hours.toFixed(1), p.streak]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ppl), 'People');

  return wb;
}
function workbookBlob() {
  const out = XLSX.write(buildWorkbook(), { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

let xlsxHandle = null; // File System Access API handle for "save back"
function renderExcel(root) {
  ensureDay();
  const supportsFS = 'showSaveFilePicker' in window;
  const inner = `
    <h2 class="title-sm">Excel export</h2>
    <p class="muted">Builds a complete workbook from current data — regenerated each tap so it's always current.</p>
    <div class="rows">
      <div class="lrow"><span>Summary</span><span class="v">per night</span></div>
      <div class="lrow"><span>Drinks</span><span class="v">night × station × 9</span></div>
      <div class="lrow"><span>Tips</span><span class="v">night × station</span></div>
      <div class="lrow"><span>Inventory</span><span class="v">open/close/used/ord/recv</span></div>
      <div class="lrow"><span>Boot</span><span class="v">per day vs goal</span></div>
      <div class="lrow"><span>People</span><span class="v">per person + rates</span></div>
    </div>
    <button class="btn btn--go" id="dl">⤓ Download Excel (.xlsx)</button>
    ${supportsFS ? `<button class="btn" id="saveAs">Save to a file (pick once)</button><button class="btn ghost" id="saveBack">Save back to same file</button>` : ''}
    <p class="muted small">Filename: ${esc(excelName())}${supportsFS ? ' · “Save back” updates the same file (desktop Chrome/Edge).' : ''}</p>`;
  root.innerHTML = managerShell('more', 'Excel Export', inner);
  wireShell(root);
  root.querySelector('#dl').onclick = () => { downloadBlob(workbookBlob(), excelName()); toast('Excel downloaded'); };
  const sa = root.querySelector('#saveAs');
  if (sa) sa.onclick = async () => {
    try {
      xlsxHandle = await window.showSaveFilePicker({ suggestedName: excelName(), types: [{ description: 'Excel', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }] });
      await writeHandle(); toast('Saved — use “Save back” to refresh it');
    } catch (e) { if (e.name !== 'AbortError') toast('Could not save'); }
  };
  const sb = root.querySelector('#saveBack');
  if (sb) sb.onclick = async () => { if (!xlsxHandle) return toast('Pick a file first ("Save to a file")'); try { await writeHandle(); toast('File updated'); } catch (e) { toast('Could not write — pick the file again'); } };
}
async function writeHandle() {
  const w = await xlsxHandle.createWritable();
  await w.write(workbookBlob()); await w.close();
}
route('#/m/excel', renderExcel);

/* ---------------------------------------------------------------------------
 * 22. Shared utilities — download, copy, compress, demo
 * ------------------------------------------------------------------------- */
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('Copied'), () => fallbackCopy(text));
  } else fallbackCopy(text);
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); toast('Copied'); } catch (e) { toast('Copy failed — select manually'); } ta.remove();
}
function compressImage(file, cb) {
  const img = new Image(); const url = URL.createObjectURL(file);
  img.onload = () => {
    const max = 1200; let { width: w, height: h } = img;
    const scale = Math.min(1, max / Math.max(w, h)); w = Math.round(w * scale); h = Math.round(h * scale);
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    try { cb(c.toDataURL('image/jpeg', 0.7)); } catch (e) { cb(null); }
  };
  img.onerror = () => { URL.revokeObjectURL(url); cb(null); };
  img.src = url;
}

function loadDemo() {
  // Reuse the current empty night if there is one, else create a fresh night.
  let day = currentDay();
  if (!day || day.shifts.length || (day.door && day.door.total)) { day = newDay(S.days.length + 1); S.days.push(day); }
  S.currentDayId = day.id;
  const mkBuckets = (start, mins, shape) => { const b = {}; const n = Math.max(1, Math.round(mins / 15)); for (let i = 0; i < n; i++) { const k = bucketOf(start + i * 15); b[k] = shape[i % shape.length]; } return b; };
  // counts keyed by drink name so the demo is robust to any grid reorder
  const dv = (m) => S.settings.drinks.map((n) => m[n] || 0);
  const mk = (person, station, mixer, start, end, drinks, shape, streak) => { const buckets = mkBuckets(start, end - start, shape); return { id: uid(), person, role: 'bartender', station, mixer, start, end, drinks, served: sum(Object.values(buckets)), buckets, streak }; };
  day.shifts = [
    mk('Jane', 1, 'Tom', 19 * 60, 19 * 60 + 55, dv({ 'Jack & Coke': 22, 'Jack & Diet Coke': 9, 'Specialty Drink': 14, 'Margaritas': 31, 'Wine': 12, 'Coors Regular': 40, 'Coors Light': 55, 'Blue Moon': 18, 'Cocktail': 7 }), [10, 14, 18, 12], 9),
    mk('Mae', 1, 'Tom', 19 * 60 + 55, 21 * 60, dv({ 'Jack & Coke': 10, 'Jack & Diet Coke': 4, 'Specialty Drink': 6, 'Margaritas': 12, 'Wine': 5, 'Coors Regular': 20, 'Coors Light': 25, 'Blue Moon': 8, 'Cocktail': 3 }), [8, 12, 10, 6], 5),
    mk('Carlos', 2, 'Rita', 19 * 60, 21 * 60, dv({ 'Jack & Coke': 18, 'Jack & Diet Coke': 7, 'Specialty Drink': 20, 'Margaritas': 28, 'Wine': 9, 'Coors Regular': 33, 'Coors Light': 40, 'Blue Moon': 14, 'Cocktail': 11 }), [14, 20, 24, 16, 12, 10, 8, 6], 7),
    mk('Dee', 3, 'Sam', 19 * 60 + 30, 21 * 60, dv({ 'Jack & Coke': 12, 'Jack & Diet Coke': 5, 'Specialty Drink': 9, 'Margaritas': 15, 'Wine': 7, 'Coors Regular': 22, 'Coors Light': 28, 'Blue Moon': 10, 'Cocktail': 6 }), [9, 13, 15, 10], 4),
    mk('Pat', 4, 'Lou', 19 * 60 + 15, 21 * 60, dv({ 'Jack & Coke': 9, 'Jack & Diet Coke': 3, 'Specialty Drink': 7, 'Margaritas': 11, 'Wine': 5, 'Coors Regular': 18, 'Coors Light': 22, 'Blue Moon': 9, 'Cocktail': 4 }), [8, 11, 13, 9, 7, 6], 6),
  ];
  const servedTotal = sum(day.shifts.map((s) => s.served));
  // Door a bit above total served (so conversion reads < 100%). Use doorPhones so the demo is additive-safe.
  day.doorPhones = [{ id: 'door-demo', name: 'Door', total: Math.round(servedTotal * 1.25), buckets: mkBuckets(19 * 60, 120, [30, 52, 70, 58, 48, 40, 30, 22]) }];
  recomputeDoor(day);
  // Inventory consistent with pours, so shrinkage is ~0 except one intentionally-flagged item.
  const drinkTotals = S.settings.drinks.map((_, i) => sum(day.shifts.map((s) => (s.drinks || [])[i] || 0)));
  const expected = {};
  S.settings.drinks.forEach((name, i) => { const map = S.settings.pourMap[name]; if (!map) return; map.forEach(([liq, oz]) => expected[liq] = (expected[liq] || 0) + drinkTotals[i] * oz); });
  const bottlesFor = (name) => { const p = S.settings.pours.find((x) => x.item === name); return p && p.bottleOz ? (expected[name] || 0) / p.bottleOz : 0; };
  day.inventory = S.settings.catalog.map((c) => {
    let used = Math.max(0, Math.round(bottlesFor(c.name)));
    if (c.name === "Jack Daniel's") used += 3; // demo shrinkage flag
    const opening = used + 2; // keep a couple on hand
    return { name: c.name, opening, closing: opening - used };
  });
  day.order.items.forEach((it) => it.orderedQty = Math.max(1, Math.round(bottlesFor(it.name))));
  const agg = stationAgg(day);
  const tipByStation = { 1: 612, 2: 540, 3: 480, 4: 330 };
  day.tips = day.tips.map((t) => ({ ...t, bucketTotal: agg[t.station] && agg[t.station].served ? (tipByStation[t.station] || 300) : 0 }));
  save();
  toast('Demo night loaded');
}

/* ---------------------------------------------------------------------------
 * 23. Manager default route
 * ------------------------------------------------------------------------- */
route('#/manager', renderManagerHub);

/* ---------------------------------------------------------------------------
 * 24. Boot
 * ------------------------------------------------------------------------- */
(function init() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(() => {}));
  }
  render();
  if (recoveredFrom) { setTimeout(() => toast(`Recovered your data from ${new Date(recoveredFrom).toLocaleString()}`), 400); }
})();

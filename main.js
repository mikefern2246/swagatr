'use strict';

const {
  app, BrowserWindow, WebContentsView, ipcMain, powerSaveBlocker,
  Notification, nativeImage, session, dialog
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// กันไม่ให้ Chromium หน่วงเวลา/ลดความเร็วเกมที่ถูกซ่อนหรืออยู่แท็บหลัง
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// ---------- ค่าคงที่ของเลย์เอาต์ (ต้องตรงกับ index.html) ----------
const ROW = 52;
const TOP = ROW * 2;        // แถบบน 2 แถว
const HEAD = 30;            // หัวช่องเกมแต่ละจอ
const SIDEBAR_W = 360;      // แผงไอเทมด้านขวา
const GAP = 2;
const LAYOUTS = { single: 1, cols2: 2, rows2: 2, cols3: 3, grid4: 4 };

// ---------- กฎตรวจจับไอเทมเริ่มต้น ----------
const DEFAULT_RULES = [
  '# บรรทัดละ 1 กฎ (RegExp, ไม่สนตัวพิมพ์เล็กใหญ่) บรรทัดขึ้นต้น # คือคอมเมนต์',
  '# ใช้ (?<item>...) เป็นชื่อไอเทม และ (?<qty>...) เป็นจำนวน (ไม่ใส่ qty = 1)',
  '(?<!ไม่)(?:ได้รับ|เก็บได้|ดรอป|ตกได้|ได้ของ)\\s*[:：]?\\s*(?:ไอเทม\\s*)?(?<item>.+?)(?:\\s*[x×*]\\s*(?<qty>\\d+))?\\s*$',
  '(?:obtained|received|acquired|picked up|looted|dropped|you got|you found)\\s*[:：]?\\s*(?:an?\\s+|the\\s+)?(?<item>.+?)(?:\\s*[x×*]\\s*(?<qty>\\d+))?\\s*[.!]?\\s*$'
].join('\n');

const DEFAULT_IGNORE = 'ความเสียหาย|damage|ประสบการณ์|\\bexp\\b|\\bxp\\b|ถูกโจมตี|เลเวล|level';

const DEFAULT_SETTINGS = {
  rulesText: DEFAULT_RULES,
  ignoreText: DEFAULT_IGNORE,
  notify: true,
  notifyScope: 'all',   // 'all' | 'stealth'
  sound: true,
  debug: false,
  wsStructural: false
};

let win = null;
const views = new Map();      // gameId -> WebContentsView
const wcToGame = new Map();   // webContents.id -> gameId

const state = {
  games: [],        // { id, name, url, muted, zoom, stealth }
  activeId: null,
  mode: 'keep',     // 'keep' = ซ่อนแบบรันต่อเต็มที่ | 'hide' = ซ่อนจริง ประหยัดสุด
  layout: 'single',
  prevLayout: 'cols2',
  panelOpen: false,
  settings: Object.assign({}, DEFAULT_SETTINGS),
  settingsVersion: 1,
  ruleErrors: []
};

let feed = [];                // รายการไอเทมล่าสุด (เก่า -> ใหม่)
const totals = new Map();     // gameId -> Map(key -> {name,count,img})

// ---------- Utilities ----------
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
function cleanStr(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}
function normalizeUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch (e) { return null; }
}
function hostOf(url) { try { return new URL(url).host; } catch (e) { return url; } }
function findGame(id) { return state.games.find(g => g.id === id); }
function label(g) { return g.name || hostOf(g.url); }
function gameIndex(id) { return state.games.findIndex(g => g.id === id); }

function validateRules() {
  const errs = [];
  String(state.settings.rulesText).split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    try { new RegExp(t, 'iu'); } catch (e) { errs.push(`บรรทัด ${i + 1}: ${e.message}`); }
  });
  try {
    if (state.settings.ignoreText.trim()) new RegExp(state.settings.ignoreText, 'iu');
  } catch (e) { errs.push('รายการยกเว้น: ' + e.message); }
  state.ruleErrors = errs;
}

// ---------- Persist ----------
const stateFile = () => path.join(app.getPath('userData'), 'games.json');
const itemsFile = () => path.join(app.getPath('userData'), 'items.json');

function loadState() {
  try {
    const d = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (Array.isArray(d.games)) {
      state.games = d.games
        .filter(g => g && g.id && normalizeUrl(g.url))
        .map(g => ({
          id: String(g.id),
          name: cleanStr(g.name, 40),
          url: normalizeUrl(g.url),
          muted: !!g.muted,
          zoom: clamp(Number(g.zoom) || 1, 0.25, 3),
          stealth: false
        }));
    }
    state.mode = d.mode === 'hide' ? 'hide' : 'keep';
    state.layout = LAYOUTS[d.layout] ? d.layout : 'single';
    state.panelOpen = !!d.panelOpen;
    if (d.settings && typeof d.settings === 'object') {
      const s = d.settings;
      state.settings = {
        rulesText: typeof s.rulesText === 'string' && s.rulesText.trim() ? s.rulesText : DEFAULT_RULES,
        ignoreText: typeof s.ignoreText === 'string' ? s.ignoreText : DEFAULT_IGNORE,
        notify: s.notify !== false,
        notifyScope: s.notifyScope === 'stealth' ? 'stealth' : 'all',
        sound: s.sound !== false,
        debug: !!s.debug,
        wsStructural: !!s.wsStructural
      };
    }
    state.activeId = state.games.length ? state.games[0].id : null;
  } catch (e) { /* ครั้งแรกยังไม่มีไฟล์ */ }
  validateRules();
}

function saveState() {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({
      games: state.games.map(({ id, name, url, muted, zoom }) => ({ id, name, url, muted, zoom })),
      mode: state.mode,
      layout: state.layout,
      panelOpen: state.panelOpen,
      settings: state.settings
    }));
  } catch (e) { /* ignore */ }
}

function loadItems() {
  try {
    const d = JSON.parse(fs.readFileSync(itemsFile(), 'utf8'));
    if (d.totals && typeof d.totals === 'object') {
      for (const gid of Object.keys(d.totals)) {
        const m = new Map();
        (d.totals[gid] || []).forEach(([k, v]) => {
          if (v && v.name) m.set(String(k), { name: String(v.name), count: Number(v.count) || 0, img: typeof v.img === 'string' ? v.img : null });
        });
        totals.set(gid, m);
      }
    }
    if (Array.isArray(d.feed)) {
      feed = d.feed.filter(e => e && e.name).map(e => {
        const t = totals.get(e.gameId);
        const hit = t && t.get(String(e.name).toLowerCase());
        return Object.assign({}, e, { img: hit ? hit.img : null });
      });
    }
  } catch (e) { /* ไม่มีไฟล์ */ }
}

let saveTimer = null;
function saveItemsSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const out = { feed: feed.slice(-200).map(e => Object.assign({}, e, { img: null })), totals: {} };
      for (const [gid, m] of totals) out.totals[gid] = Array.from(m.entries());
      fs.writeFileSync(itemsFile(), JSON.stringify(out));
    } catch (e) { /* ignore */ }
  }, 3000);
}

// ---------- Snapshot / broadcast ----------
let lastPanes = [];

function snapshot() {
  return {
    games: state.games.map(g => ({ id: g.id, name: g.name, url: g.url, muted: g.muted, zoom: g.zoom, stealth: g.stealth })),
    activeId: state.activeId,
    mode: state.mode,
    layout: state.layout,
    panelOpen: state.panelOpen,
    panes: lastPanes,
    settings: state.settings,
    settingsVersion: state.settingsVersion,
    ruleErrors: state.ruleErrors,
    sidebarW: SIDEBAR_W,
    head: HEAD,
    fullscreen: !!(win && !win.isDestroyed() && win.isFullScreen())
  };
}

function totalsPayload() {
  const out = {};
  for (const [gid, m] of totals) {
    out[gid] = Array.from(m.values()).sort((a, b) => b.count - a.count);
  }
  return out;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function broadcast() { send('state', snapshot()); }

let totalsTimer = null;
function sendTotalsSoon() {
  if (totalsTimer) return;
  totalsTimer = setTimeout(() => { totalsTimer = null; send('totals', totalsPayload()); }, 250);
}

// ---------- Layout / split ----------
function slotRects(layout, W, H) {
  const y0 = TOP;
  const half = n => Math.floor((n - GAP) / 2);
  switch (layout) {
    case 'cols2': {
      const w = half(W);
      return [{ x: 0, y: y0, w, h: H }, { x: w + GAP, y: y0, w: W - w - GAP, h: H }];
    }
    case 'rows2': {
      const h = half(H);
      return [{ x: 0, y: y0, w: W, h }, { x: 0, y: y0 + h + GAP, w: W, h: H - h - GAP }];
    }
    case 'cols3': {
      const w = Math.floor((W - GAP * 2) / 3);
      return [0, 1, 2].map(i => ({ x: i * (w + GAP), y: y0, w: i === 2 ? W - 2 * (w + GAP) : w, h: H }));
    }
    case 'grid4': {
      const w = half(W), h = half(H);
      const w2 = W - w - GAP, h2 = H - h - GAP;
      return [
        { x: 0, y: y0, w, h }, { x: w + GAP, y: y0, w: w2, h },
        { x: 0, y: y0 + h + GAP, w, h: h2 }, { x: w + GAP, y: y0 + h + GAP, w: w2, h: h2 }
      ];
    }
    default:
      return [{ x: 0, y: y0, w: W, h: H }];
  }
}

function computePanes() {
  if (!win || win.isDestroyed()) return [];
  const [W, H] = win.getContentSize();
  const areaW = Math.max(W - (state.panelOpen ? SIDEBAR_W : 0), 200);
  const areaH = Math.max(H - TOP, 120);
  const rects = slotRects(state.layout, areaW, areaH);
  const n = rects.length;
  const ids = n === 1
    ? (state.activeId ? [state.activeId] : [])
    : state.games.slice(0, n).map(g => g.id);
  return rects.map((r, i) => ({
    id: ids[i] || null,
    idx: ids[i] ? gameIndex(ids[i]) : -1,
    x: r.x, y: r.y, w: r.w, h: r.h
  }));
}

function layout() {
  if (!win || win.isDestroyed()) return;
  const [W, H] = win.getContentSize();
  lastPanes = computePanes();

  for (const g of state.games) {
    const view = views.get(g.id);
    if (!view) continue;
    const pane = lastPanes.find(p => p.id === g.id);

    if (pane && !g.stealth) {
      view.setVisible(true);
      view.setBounds({ x: pane.x, y: pane.y + HEAD, width: pane.w, height: Math.max(pane.h - HEAD, 50) });
    } else if (state.mode === 'keep') {
      // ย้ายออกนอกหน้าต่าง: ไม่เห็นภาพ แต่เกมยังรันครบ (รวม animation loop)
      view.setVisible(true);
      view.setBounds({ x: -(W + 400), y: TOP, width: Math.max(W, 400), height: Math.max(H - TOP, 300) });
    } else {
      // ซ่อนจริง: Chromium หยุดวาดภาพ ประหยัด GPU สุด
      view.setVisible(false);
    }
  }
}

function refresh() { layout(); broadcast(); }

// ย้ายเกมเข้าช่องที่มองเห็น (ใช้ตอนกดแท็บเกมที่อยู่นอกช่อง)
function bringIntoView(id) {
  const n = LAYOUTS[state.layout] || 1;
  if (n === 1) return;
  const idx = gameIndex(id);
  if (idx < n) return;
  let target = gameIndex(state.activeId);
  if (target < 0 || target >= n) target = n - 1;
  const tmp = state.games[idx];
  state.games[idx] = state.games[target];
  state.games[target] = tmp;
}

// ---------- Game views ----------
function applyZoom(g) {
  const v = views.get(g.id);
  if (!v || v.webContents.isDestroyed()) return;
  try { v.webContents.setZoomFactor(g.zoom || 1); } catch (e) { /* ignore */ }
}

function createView(g) {
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:game-' + g.id,  // แยกคุกกี้/ล็อกอินต่อเกม เล่นหลายบัญชีได้
      preload: path.join(__dirname, 'game-preload.js'),
      backgroundThrottling: false,        // เกมไม่ถูกหน่วงเมื่อถูกซ่อน
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,   // ให้ตัวตรวจไอเทมทำงานถ้าเกมอยู่ใน iframe
      sandbox: true
    }
  });
  const wc = view.webContents;
  wcToGame.set(wc.id, g.id);
  wc.setAudioMuted(!!g.muted);
  wc.setWindowOpenHandler(({ url }) => (/^https?:/i.test(url) ? { action: 'allow' } : { action: 'deny' }));
  wc.on('did-finish-load', () => applyZoom(g));
  wc.on('destroyed', () => wcToGame.delete(wc.id));
  wc.loadURL(g.url).catch(() => { /* ERR_ABORTED ฯลฯ */ });
  win.contentView.addChildView(view);
  views.set(g.id, view);
}

function destroyView(id) {
  const view = views.get(id);
  if (!view) return;
  try { wcToGame.delete(view.webContents.id); } catch (e) {}
  try { win.contentView.removeChildView(view); } catch (e) {}
  try { view.webContents.close(); } catch (e) {}
  views.delete(id);
}

// ---------- ส่งค่ากฎไปยังหน้าเกม ----------
function gameConfig() {
  const s = state.settings;
  return { rules: s.rulesText, ignore: s.ignoreText, debug: s.debug, wsStructural: s.wsStructural, graceMs: 5000 };
}
function pushConfigToGames() {
  const cfg = gameConfig();
  for (const v of views.values()) {
    try {
      v.webContents.mainFrame.framesInSubtree.forEach(f => { try { f.send('game-config', cfg); } catch (e) {} });
    } catch (e) { /* ignore */ }
  }
}

ipcMain.handle('game-config', e => (wcToGame.has(e.sender.id) ? gameConfig() : null));

// ---------- รูปไอเทม ----------
const iconCache = new Map(); // url -> Promise<string|null>
const rasterPending = new Map();
let rasterId = 0;

function rasterize(dataUrl) {
  return new Promise(resolve => {
    if (!win || win.isDestroyed()) return resolve(null);
    const id = ++rasterId;
    const timer = setTimeout(() => { rasterPending.delete(id); resolve(null); }, 4000);
    rasterPending.set(id, v => { clearTimeout(timer); resolve(v); });
    win.webContents.send('rasterize', { id, dataUrl });
  });
}
ipcMain.on('raster-done', (e, id, out) => {
  if (!win || e.sender !== win.webContents) return;
  const f = rasterPending.get(id);
  if (!f) return;
  rasterPending.delete(id);
  f(typeof out === 'string' && out.startsWith('data:image/png') ? out : null);
});

async function fetchImageDataUrl(g, url) {
  if (/^data:image\//i.test(url)) return url;
  const ses = session.fromPartition('persist:game-' + g.id);
  const res = await ses.fetch(url, {
    headers: { Referer: g.url },
    referrer: g.url,
    signal: AbortSignal.timeout(4000)
  });
  if (!res.ok) return null;
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\//i.test(mime)) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 2000000) return null;
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function getIcon(g, url) {
  const key = g.id + '|' + url.slice(0, 500);
  if (iconCache.has(key)) return iconCache.get(key);
  const p = (async () => {
    try {
      const raw = await fetchImageDataUrl(g, url);
      if (!raw) return null;
      return await rasterize(raw); // แปลงเป็น PNG 96px (รองรับ webp/svg ด้วย)
    } catch (e) { return null; }
  })();
  if (iconCache.size > 300) iconCache.clear();
  iconCache.set(key, p);
  return p;
}

function validImg(u) {
  if (typeof u !== 'string') return null;
  if (u.length > 200000) return null;
  return /^(https?:\/\/|data:image\/)/i.test(u) ? u : null;
}

// ---------- รับเหตุการณ์จากหน้าเกม ----------
const recentKeys = new Map();

function lookupTotalsImg(gameId, name) {
  const m = totals.get(gameId);
  const hit = m && m.get(name.toLowerCase());
  return hit ? hit.img : null;
}

async function onGameEvent(gameId, p) {
  const g = findGame(gameId);
  if (!g || !p || typeof p !== 'object') return;

  if (p.kind === 'debug') {
    if (!state.settings.debug) return;
    send('debug', { t: Date.now(), gameId, gameName: label(g), idx: gameIndex(g.id), src: cleanStr(p.src, 12), text: cleanStr(p.text, 300) });
    return;
  }
  if (p.kind !== 'item') return;

  const name = cleanStr(p.name, 80);
  if (!name) return;
  const qty = clamp(parseInt(p.qty, 10) || 1, 1, 1000000);
  const key = gameId + '|' + name.toLowerCase() + '|' + qty + '|' + cleanStr(p.text, 80);
  const now = Date.now();
  const last = recentKeys.get(key);
  if (last && now - last < 700) return;
  recentKeys.set(key, now);
  if (recentKeys.size > 500) {
    for (const [k, t] of recentKeys) if (now - t > 5000) recentKeys.delete(k);
  }

  let img = null;
  const url = validImg(p.img);
  if (url) img = await getIcon(g, url);
  if (!img) img = lookupTotalsImg(gameId, name);

  addEntry({
    t: now, gameId, gameName: label(g), name, qty, img,
    text: cleanStr(p.text, 200), src: cleanStr(p.src || 'dom', 12)
  });
}

function addEntry(entry) {
  feed.push(entry);
  if (feed.length > 500) feed.splice(0, feed.length - 500);

  let m = totals.get(entry.gameId);
  if (!m) { m = new Map(); totals.set(entry.gameId, m); }
  const k = entry.name.toLowerCase();
  const cur = m.get(k) || { name: entry.name, count: 0, img: null };
  cur.count += entry.qty;
  if (entry.img) cur.img = entry.img;
  m.set(k, cur);

  send('item', entry);
  sendTotalsSoon();
  saveItemsSoon();
  queueNotify(entry);
}

ipcMain.on('game-event', (e, p) => {
  const gid = wcToGame.get(e.sender.id);
  if (!gid) return; // รับเฉพาะจากหน้าเกมที่โปรแกรมสร้างเอง
  onGameEvent(gid, p).catch(() => {});
});

// ---------- แจ้งเตือน ----------
const batches = new Map();
const liveNotifications = new Set();

function queueNotify(entry) {
  const s = state.settings;
  if (!s.notify) return;
  const g = findGame(entry.gameId);
  if (!g) return;
  if (s.notifyScope === 'stealth' && !g.stealth) return;
  let b = batches.get(g.id);
  if (!b) { b = { items: [], timer: null }; batches.set(g.id, b); }
  b.items.push(entry);
  if (!b.timer) b.timer = setTimeout(() => flushNotify(g.id), 1200);
}

function flushNotify(id) {
  const b = batches.get(id);
  batches.delete(id);
  const g = findGame(id);
  if (!b || !g || !Notification.isSupported()) return;

  const merged = new Map();
  for (const e of b.items) {
    const k = e.name.toLowerCase();
    const x = merged.get(k) || { name: e.name, qty: 0, img: null };
    x.qty += e.qty;
    if (!x.img) x.img = e.img;
    merged.set(k, x);
  }
  const list = Array.from(merged.values());
  const lines = list.slice(0, 5).map(x => `• ${x.name}${x.qty > 1 ? ' ×' + x.qty : ''}`);
  if (list.length > 5) lines.push(`… และอีก ${list.length - 5} รายการ`);

  let icon;
  const first = list.find(x => x.img);
  if (first) {
    try { icon = nativeImage.createFromDataURL(first.img); } catch (e) { icon = undefined; }
  }

  const n = new Notification({
    title: `🎁 จอ #${gameIndex(g.id) + 1} ${label(g)}${g.stealth ? ' (Stealth)' : ''} ได้ไอเทม`,
    body: lines.join('\n'),
    icon,
    silent: !state.settings.sound
  });
  liveNotifications.add(n);
  const done = () => liveNotifications.delete(n);
  n.on('click', () => {
    done();
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    if (findGame(id)) { bringIntoView(id); state.activeId = id; refresh(); }
  });
  n.on('close', done);
  n.on('failed', done);
  n.show();
}

// ---------- Actions from UI ----------
function exportCsv() {
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [['time', 'game', 'item', 'qty', 'text', 'source'].join(',')];
  feed.forEach(e => rows.push([
    new Date(e.t).toISOString(), esc(e.gameName), esc(e.name), e.qty, esc(e.text), esc(e.src)
  ].join(',')));
  return dialog.showSaveDialog(win, {
    defaultPath: 'items.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  }).then(r => {
    if (r.canceled || !r.filePath) return { ok: true };
    fs.writeFileSync(r.filePath, '﻿' + rows.join('\n'), 'utf8');
    return { ok: true };
  }).catch(() => ({ error: 'บันทึกไฟล์ไม่สำเร็จ' }));
}

function handleAct(type, p) {
  p = p || {};
  switch (type) {
    case 'state':
      return snapshot();

    case 'feed':
      return { feed: feed.slice(-300), totals: totalsPayload() };

    case 'add': {
      const url = normalizeUrl(p.url);
      if (!url) return { error: 'URL ไม่ถูกต้อง' };
      const g = { id: crypto.randomUUID(), name: cleanStr(p.name, 40), url, muted: false, zoom: 1, stealth: false };
      state.games.push(g);
      createView(g);
      bringIntoView(g.id);
      state.activeId = g.id;
      saveState();
      refresh();
      return { ok: true };
    }

    case 'select':
      if (findGame(p.id)) { bringIntoView(p.id); state.activeId = p.id; refresh(); }
      return { ok: true };

    case 'stealth': {
      const g = findGame(p.id);
      if (g) { g.stealth = !g.stealth; refresh(); }
      return { ok: true };
    }

    case 'stealthAll':
      state.games.forEach(g => { g.stealth = !!p.value; });
      refresh();
      return { ok: true };

    case 'reload': {
      const v = views.get(p.id);
      if (v) v.webContents.reload();
      return { ok: true };
    }

    case 'mute': {
      const g = findGame(p.id);
      const v = views.get(p.id);
      if (g && v) {
        g.muted = !g.muted;
        v.webContents.setAudioMuted(g.muted);
        saveState();
        refresh();
      }
      return { ok: true };
    }

    case 'zoom': {
      const g = findGame(p.id);
      if (g) {
        const next = p.value != null ? Number(p.value) : (g.zoom || 1) + Number(p.delta || 0);
        g.zoom = Math.round(clamp(next || 1, 0.25, 3) * 100) / 100;
        applyZoom(g);
        saveState();
        broadcast();
      }
      return { ok: true };
    }

    case 'move': {
      const i = gameIndex(p.id);
      const j = i + (p.dir < 0 ? -1 : 1);
      if (i >= 0 && j >= 0 && j < state.games.length) {
        const t = state.games[i]; state.games[i] = state.games[j]; state.games[j] = t;
        saveState();
        refresh();
      }
      return { ok: true };
    }

    case 'layout': {
      if (LAYOUTS[p.layout]) {
        state.layout = p.layout;
        if (state.layout !== 'single') bringIntoView(state.activeId);
        saveState();
        refresh();
      }
      return { ok: true };
    }

    case 'maximize': {
      if (state.layout !== 'single') {
        state.prevLayout = state.layout;
        state.layout = 'single';
        if (findGame(p.id)) state.activeId = p.id;
      } else {
        state.layout = state.prevLayout || 'cols2';
        bringIntoView(state.activeId);
      }
      saveState();
      refresh();
      return { ok: true };
    }

    case 'remove': {
      destroyView(p.id);
      state.games = state.games.filter(g => g.id !== p.id);
      totals.delete(p.id);
      feed = feed.filter(e => e.gameId !== p.id);
      if (state.activeId === p.id) state.activeId = state.games.length ? state.games[0].id : null;
      saveState();
      saveItemsSoon();
      refresh();
      send('totals', totalsPayload());
      return { ok: true };
    }

    case 'mode':
      state.mode = p.mode === 'hide' ? 'hide' : 'keep';
      saveState();
      refresh();
      return { ok: true };

    case 'panel':
      state.panelOpen = p.value == null ? !state.panelOpen : !!p.value;
      saveState();
      refresh();
      return { ok: true };

    case 'winsize': {
      if (!win) return { ok: true };
      if (win.isFullScreen()) win.setFullScreen(false);
      if (p.preset === 'max') { win.maximize(); return { ok: true }; }
      if (win.isMaximized()) win.unmaximize();
      const w = clamp(parseInt(p.w, 10) || 1280, 800, 7680);
      const h = clamp(parseInt(p.h, 10) || 720, 500, 4320);
      win.setContentSize(w, h);
      win.center();
      return { ok: true };
    }

    case 'fullscreen':
      if (win) win.setFullScreen(!win.isFullScreen());
      return { ok: true };

    case 'saveSettings': {
      const s = state.settings;
      if (typeof p.rulesText === 'string') s.rulesText = p.rulesText.slice(0, 20000);
      if (typeof p.ignoreText === 'string') s.ignoreText = p.ignoreText.slice(0, 2000);
      s.notify = !!p.notify;
      s.notifyScope = p.notifyScope === 'stealth' ? 'stealth' : 'all';
      s.sound = !!p.sound;
      s.debug = !!p.debug;
      s.wsStructural = !!p.wsStructural;
      state.settingsVersion++;
      validateRules();
      saveState();
      pushConfigToGames();
      broadcast();
      return { ok: true, errors: state.ruleErrors };
    }

    case 'resetRules':
      state.settings.rulesText = DEFAULT_RULES;
      state.settings.ignoreText = DEFAULT_IGNORE;
      state.settingsVersion++;
      validateRules();
      saveState();
      pushConfigToGames();
      broadcast();
      return { ok: true };

    case 'testNotify': {
      const g = findGame(p.id) || findGame(state.activeId);
      if (!g) return { error: 'ยังไม่มีเกม' };
      addEntry({
        t: Date.now(), gameId: g.id, gameName: label(g),
        name: 'ไอเทมทดสอบ', qty: 1, img: null, text: 'ทดสอบแจ้งเตือน', src: 'test'
      });
      return { ok: true };
    }

    case 'clearItems': {
      if (p.id) {
        feed = feed.filter(e => e.gameId !== p.id);
        totals.delete(p.id);
      } else {
        feed = [];
        totals.clear();
      }
      saveItemsSoon();
      send('totals', totalsPayload());
      send('feed-cleared', p.id || null);
      return { ok: true };
    }

    case 'exportItems':
      return exportCsv();

    default:
      return { error: 'unknown action' };
  }
}

ipcMain.handle('act', (event, type, payload) => {
  // รับคำสั่งเฉพาะจากหน้าควบคุมของโปรแกรมเอง ไม่รับจากหน้าเว็บเกม
  if (!win || event.sender !== win.webContents) return { error: 'forbidden' };
  return handleAct(type, payload);
});

// ---------- Window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#090d16',
    title: 'WebGame Controller',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.once('did-finish-load', () => {
    state.games.forEach(createView);
    refresh();
  });

  ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach(ev => win.on(ev, refresh));
  win.on('closed', () => { win = null; views.clear(); wcToGame.clear(); });
}

app.whenReady().then(() => {
  loadState();
  loadItems();
  powerSaveBlocker.start('prevent-app-suspension'); // กันเครื่องหลับตัดเกมขณะรันเบื้องหลัง
  createWindow();
});

app.on('window-all-closed', () => app.quit());

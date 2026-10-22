'use strict';

/*
 * ทำงานในหน้าเกมแต่ละจอ: ตรวจจับ "ได้ไอเทม/ดรอป" แล้วส่งให้โปรแกรมหลัก
 * ตรวจ 2 ทาง
 *   1) ข้อความที่ปรากฏบนหน้าเกม (DOM) เช่น ล็อกแชต/ระบบ/ป๊อปอัปแจ้งเตือนในเกม
 *   2) ข้อความที่เกมรับผ่าน WebSocket (ดักจากฝั่งหน้าเว็บ)
 * ถ้าเกมวาดทุกอย่างบน <canvas> และส่งข้อมูลเป็นไบนารี จะอ่านไม่ได้ (ดูโหมด Debug ใน README)
 */

const { ipcRenderer, webFrame } = require('electron');

const TOKEN = Math.random().toString(36).slice(2) + Date.now().toString(36);
const START = Date.now();

let cfg = { rules: '', ignore: '', debug: false, wsStructural: false, graceMs: 5000 };
let rules = [];
let ignoreRe = null;

function compile() {
  rules = [];
  String(cfg.rules || '').split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    try { rules.push(new RegExp(t, 'iu')); } catch (e) { /* ข้ามกฎที่ผิด */ }
  });
  try { ignoreRe = cfg.ignore && cfg.ignore.trim() ? new RegExp(cfg.ignore, 'iu') : null; } catch (e) { ignoreRe = null; }
}

ipcRenderer.invoke('game-config').then(c => { if (c) { cfg = c; compile(); } }).catch(() => {});
ipcRenderer.on('game-config', (_e, c) => { if (c) { cfg = c; compile(); } });

// ---------- Helpers ----------
const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function cleanName(s) {
  let n = norm(s);
  n = n.replace(/^[\[\]【】「」『』"'“”‘’()（）<>\s:：-]+|[\[\]【】「」『』"'“”‘’()（）<>\s.!,:：-]+$/g, '');
  n = n.replace(/^(ไอเทม|item)\s*[:：]?\s*/i, '');
  if (!n || n.length > 80 || /^\d+$/.test(n)) return '';
  return n;
}

function matchText(text) {
  if (!text || text.length < 3 || text.length > 200) return null;
  if (ignoreRe && ignoreRe.test(text)) return null;
  for (const r of rules) {
    const m = r.exec(text);
    if (!m) continue;
    const g = m.groups || {};
    const name = cleanName(g.item != null ? g.item : m[1]);
    if (!name) continue;
    const qty = parseInt(g.qty, 10);
    return { name, qty: qty > 0 ? qty : 1 };
  }
  return null;
}

const armed = () => Date.now() - START >= (cfg.graceMs || 0);

// ---------- ส่งเหตุการณ์ ----------
function sendItem(name, qty, img, text, src) {
  try {
    ipcRenderer.send('game-event', { kind: 'item', name, qty, img: img || null, text: String(text).slice(0, 200), src });
  } catch (e) { /* ignore */ }
}

let dbgCount = 0, dbgWindow = 0;
const dbgSeen = new Map();
function debugSend(text, src) {
  if (!cfg.debug) return;
  const now = Date.now();
  if (now - dbgWindow > 1000) { dbgWindow = now; dbgCount = 0; }
  if (dbgCount >= 15) return;
  const last = dbgSeen.get(text);
  if (last && now - last < 5000) return;
  dbgSeen.set(text, now);
  if (dbgSeen.size > 800) dbgSeen.clear();
  dbgCount++;
  try { ipcRenderer.send('game-event', { kind: 'debug', text: String(text).slice(0, 300), src }); } catch (e) { /* ignore */ }
}

// ---------- หารูปไอเทม ----------
const imgIndex = new Map(); // ชื่อ(พิมพ์เล็ก) -> src
const IMG_EXT = /\.(png|jpe?g|webp|gif|svg|avif)(\?|#|$)/i;

function okSrc(s) {
  if (!s || typeof s !== 'string') return null;
  if (s.startsWith('data:')) return /^data:image\//i.test(s) && s.length < 100000 ? s : null;
  return /^https?:/i.test(s) ? s : null;
}

function indexImg(img) {
  const src = okSrc(img.currentSrc || img.src);
  if (!src) return;
  [img.alt, img.title].forEach(n => {
    n = norm(n).toLowerCase();
    if (n && n.length <= 80) imgIndex.set(n, src);
  });
  if (imgIndex.size > 3000) imgIndex.clear();
}

function bgUrl(el) {
  try {
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg.match(/url\((['"]?)(.*?)\1\)/);
    return m ? okSrc(new URL(m[2], location.href).href) : null;
  } catch (e) { return null; }
}

function imgOf(node) {
  if (!node || node.nodeType !== 1) return null;
  if (node.tagName === 'IMG') return okSrc(node.currentSrc || node.src);
  const i = node.querySelector && node.querySelector('img');
  return i ? okSrc(i.currentSrc || i.src) : null;
}

function findImage(el, name) {
  try {
    const byName = imgIndex.get(name.toLowerCase());
    if (byName) return byName;
    if (!el) return null;
    let s = imgOf(el);
    if (s) return s;
    s = imgOf(el.previousElementSibling) || imgOf(el.nextElementSibling);
    if (s) return s;
    let p = el.parentElement;
    for (let d = 0; p && d < 2; d++, p = p.parentElement) {
      if (p.childElementCount > 6) break;
      s = imgOf(p);
      if (s) return s;
    }
    s = bgUrl(el);
    if (s) return s;
    const kids = el.children;
    for (let i = 0; i < kids.length && i < 5; i++) {
      s = bgUrl(kids[i]);
      if (s) return s;
    }
  } catch (e) { /* ignore */ }
  return null;
}

// ---------- ตรวจจาก DOM ----------
const seenNodes = new WeakSet();
const textRecent = new Map();

function handleText(text, el, isCharData) {
  text = norm(text);
  if (!text || text.length > 200) return;
  const now = Date.now();
  if (isCharData) {
    const last = textRecent.get(text);
    if (last && now - last < 1500) return;
    textRecent.set(text, now);
    if (textRecent.size > 500) textRecent.clear();
  }
  debugSend(text, 'dom');
  if (!armed()) return;
  const m = matchText(text);
  if (!m) return;
  sendItem(m.name, m.qty, findImage(el, m.name), text, 'dom');
}

function collect(node, out, depth) {
  if (out.length >= 80) return;
  if (node.nodeType === 3) {
    if (node.parentElement) out.push({ el: node.parentElement, text: node.nodeValue, node });
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = node.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'CANVAS') return;
  if (tag === 'IMG') { indexImg(node); return; }

  if (node.querySelectorAll) {
    const imgs = node.querySelectorAll('img[alt],img[title]');
    for (let i = 0; i < imgs.length && i < 40; i++) indexImg(imgs[i]);
  }
  const text = node.textContent || '';
  if (!text) return;
  if (text.length <= 200 && node.childElementCount <= 6) {
    out.push({ el: node, text, node });
    return;
  }
  if (depth >= 4) return;
  for (const c of node.childNodes) collect(c, out, depth + 1);
}

let queue = [];
let flushTimer = null;
function schedule(entry) {
  if (queue.length < 400) queue.push(entry);
  if (!flushTimer) flushTimer = setTimeout(flush, 50);
}
function flush() {
  flushTimer = null;
  const batch = queue;
  queue = [];
  for (const q of batch) {
    try {
      if (q.chars) {
        handleText(q.text, q.el, true);
      } else {
        const out = [];
        collect(q.node, out, 0);
        for (const o of out) {
          if (o.node.nodeType === 1) {
            if (seenNodes.has(o.node)) continue;
            seenNodes.add(o.node);
          }
          handleText(o.text, o.el, false);
        }
      }
    } catch (e) { /* ignore */ }
  }
}

try {
  new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'childList') {
        m.addedNodes.forEach(n => schedule({ node: n }));
      } else if (m.type === 'characterData') {
        const p = m.target.parentElement;
        if (p) schedule({ chars: true, el: p, text: m.target.nodeValue });
      }
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
} catch (e) { /* ไม่มี document */ }

// ---------- ตรวจจาก WebSocket ----------
const WS_HOOK = `(() => {
  if (window.__wgcWs) return; window.__wgcWs = 1;
  const T = ${JSON.stringify(TOKEN)}, O = window.WebSocket;
  if (!O) return;
  const post = s => {
    if (typeof s !== 'string' || !s) return;
    let bad = 0; const n = Math.min(s.length, 400);
    for (let i = 0; i < n; i++) if (s.charCodeAt(i) === 0xFFFD) bad++;
    if (bad > n * 0.2) return;
    try { window.postMessage({ __wgc: T, data: s.slice(0, 6000) }, '*'); } catch (e) {}
  };
  const take = d => {
    try {
      if (typeof d === 'string') post(d);
      else if (d instanceof ArrayBuffer) post(new TextDecoder().decode(d));
      else if (ArrayBuffer.isView(d)) post(new TextDecoder().decode(d));
      else if (typeof Blob !== 'undefined' && d instanceof Blob && d.size < 100000) d.text().then(post).catch(() => {});
    } catch (e) {}
  };
  function W(u, p) {
    const ws = p === undefined ? new O(u) : new O(u, p);
    ws.addEventListener('message', e => take(e.data));
    return ws;
  }
  W.prototype = O.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) W[k] = O[k];
  try { Object.defineProperty(window, 'WebSocket', { value: W, configurable: true, writable: true }); }
  catch (e) { window.WebSocket = W; }
})();`;

try { webFrame.executeJavaScript(WS_HOOK).catch(() => {}); } catch (e) { /* ignore */ }

const wsRecent = new Map();
const IMG_KEY = /icon|img|image|thumb|sprite|picture|pic/i;
const NAME_KEY = /^(name|item_?name|itemName|title|label)$/i;
const QTY_KEY = /^(qty|count|amount|quantity|num|number)$/i;
const TYPE_KEYS = ['type', 'event', 'evt', 'cmd', 'op', 'action', 't', 'msg', 'method', 'name', 'kind'];
const DROP_WORDS = /drop|loot|reward|obtain|gain|pickup|pick_up|acquire|get_?item|item_?add|bag_?add/i;

function imgFromObject(o) {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === 'string' && IMG_KEY.test(k) && (IMG_EXT.test(v) || /^data:image\//.test(v) || /^(https?:)?\//.test(v))) {
      try { return okSrc(new URL(v, location.href).href) || okSrc(v); } catch (e) { /* ignore */ }
    }
  }
  return null;
}

function walkJson(v, ctx, depth) {
  if (depth > 6 || ctx.count++ > 300) return;
  if (typeof v === 'string') {
    const t = norm(v);
    if (t.length >= 3 && t.length <= 200) {
      const m = matchText(t);
      if (m) ctx.hits.push({ name: m.name, qty: m.qty, img: ctx.parentImg || imgIndex.get(m.name.toLowerCase()) || null, text: t, src: 'ws' });
    }
    return;
  }
  if (Array.isArray(v)) { v.forEach(x => walkJson(x, ctx, depth + 1)); return; }
  if (v && typeof v === 'object') {
    const img = imgFromObject(v);
    if (cfg.wsStructural && ctx.dropLike) {
      const nameKey = Object.keys(v).find(k => NAME_KEY.test(k) && typeof v[k] === 'string');
      const qtyKey = Object.keys(v).find(k => QTY_KEY.test(k) && typeof v[k] === 'number');
      if (nameKey && qtyKey) {
        const name = cleanName(v[nameKey]);
        if (name) ctx.hits.push({ name, qty: Math.max(1, Math.floor(v[qtyKey])), img: img || imgIndex.get(name.toLowerCase()) || null, text: 'ws:' + name, src: 'ws-json' });
      }
    }
    const saved = ctx.parentImg;
    if (img) ctx.parentImg = img;
    for (const k of Object.keys(v)) walkJson(v[k], ctx, depth + 1);
    ctx.parentImg = saved;
  }
}

function onWs(s) {
  const head = norm(s.slice(0, 300));
  debugSend(head, 'ws');
  if (!armed()) return;

  const now = Date.now();
  const key = s.slice(0, 300);
  const last = wsRecent.get(key);
  if (last && now - last < 800) return;
  wsRecent.set(key, now);
  if (wsRecent.size > 400) wsRecent.clear();

  const first = s.trimStart()[0];
  if (first === '{' || first === '[') {
    let data;
    try { data = JSON.parse(s); } catch (e) { data = null; }
    if (data !== null) {
      let dropLike = false;
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const typeStr = TYPE_KEYS.map(k => (typeof data[k] === 'string' ? data[k] : '')).join(' ');
        dropLike = DROP_WORDS.test(typeStr);
      }
      const ctx = { count: 0, hits: [], parentImg: null, dropLike };
      walkJson(data, ctx, 0);
      ctx.hits.slice(0, 20).forEach(h => sendItem(h.name, h.qty, h.img, h.text, h.src));
      return;
    }
  }
  // ข้อความธรรมดา: ลองทีละบรรทัด
  s.split(/\r?\n/).slice(0, 10).forEach(line => {
    const t = norm(line);
    const m = matchText(t);
    if (m) sendItem(m.name, m.qty, imgIndex.get(m.name.toLowerCase()) || null, t, 'ws');
  });
}

window.addEventListener('message', ev => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.__wgc !== TOKEN || typeof d.data !== 'string') return;
  try { onWs(d.data); } catch (e) { /* ignore */ }
});

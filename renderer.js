'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const act = (type, payload) => window.api.act(type, payload);

  let state = { games: [], activeId: null, mode: 'keep', layout: 'single', panelOpen: false, panes: [], settings: {}, settingsVersion: 0, ruleErrors: [], head: 30 };
  let totals = {};
  let feed = [];
  let allStealth = false;
  let curTab = 'feed';
  let appliedSettingsVersion = -1;
  let unread = 0;
  const debugLines = [];

  // ---------- helpers ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const hostOf = url => { try { return new URL(url).host; } catch (e) { return url; } };
  const gname = g => g.name || hostOf(g.url);
  const timeStr = t => new Date(t).toLocaleTimeString('th-TH', { hour12: false });
  const safeImg = s => (typeof s === 'string' && /^data:image\//i.test(s) ? s : null);
  const idxOf = id => state.games.findIndex(g => g.id === id);

  function iconBtn(text, title, onClick, opts) {
    const b = el('button', 'ib' + (opts && opts.on ? ' on' : ''), text);
    b.title = title;
    if (opts && opts.disabled) b.disabled = true;
    else b.addEventListener('click', ev => { ev.stopPropagation(); onClick(); });
    return b;
  }

  // ---------- แท็บ + แถบควบคุมบน ----------
  function renderToolbar() {
    const tabs = $('tabs');
    tabs.textContent = '';
    state.games.forEach((g, i) => {
      const t = el('button', 'tab' + (g.id === state.activeId ? ' active' : '') + (g.stealth ? ' stealth' : ''));
      t.title = g.url;
      t.append(el('span', '', g.stealth ? '🖤' : '🟢'), el('span', 'tname', '#' + (i + 1) + ' ' + gname(g)));
      t.addEventListener('click', () => act('select', { id: g.id }));
      tabs.append(t);
    });
    $('layoutSel').value = state.layout;
    $('modeSel').value = state.mode;
    $('btnStealthAll').disabled = state.games.length === 0;
    allStealth = state.games.length > 0 && state.games.every(g => g.stealth);
    $('btnStealthAll').textContent = allStealth ? '🔓 เปิดทั้งหมด' : '🖤 ทั้งหมด';
    $('btnPanel').classList.toggle('primary', state.panelOpen);
    const b = $('badge');
    b.style.display = unread > 0 && !state.panelOpen ? 'inline' : 'none';
    b.textContent = unread > 99 ? '99+' : unread;
  }

  // ---------- ช่องเกม ----------
  function renderPanes() {
    const root = $('panes');
    root.textContent = '';
    const multi = state.layout !== 'single';

    state.panes.forEach(p => {
      const pane = el('div', 'pane' + (p.id && p.id === state.activeId ? ' active' : ''));
      Object.assign(pane.style, { left: p.x + 'px', top: p.y + 'px', width: p.w + 'px', height: p.h + 'px' });

      const g = p.id ? state.games.find(x => x.id === p.id) : null;
      if (!g) {
        const body = el('div', 'pbody empty', state.games.length ? 'ช่องว่าง' : 'ยังไม่มีเกม กรอก URL ด้านบนแล้วกดเพิ่มเกม');
        body.style.top = '0';
        pane.append(body);
        root.append(pane);
        return;
      }

      const head = el('div', 'phead');
      head.addEventListener('click', () => act('select', { id: g.id }));
      head.addEventListener('dblclick', () => { if (state.games.length > 1 || multi) act('maximize', { id: g.id }); });

      const name = el('span', 'pname', gname(g));
      name.title = g.url;
      const zoomPct = Math.round((g.zoom || 1) * 100);
      const i = idxOf(g.id);

      head.append(
        el('span', 'pidx', '#' + (i + 1)),
        el('span', '', g.stealth ? '🖤' : '🟢'),
        name,
        iconBtn('◀', 'ย้ายไปช่องก่อนหน้า', () => act('move', { id: g.id, dir: -1 }), { disabled: i <= 0 }),
        iconBtn('▶', 'ย้ายไปช่องถัดไป', () => act('move', { id: g.id, dir: 1 }), { disabled: i >= state.games.length - 1 }),
        el('span', 'sep'),
        iconBtn('−', 'ย่อขนาดภาพเกม', () => act('zoom', { id: g.id, delta: -0.1 })),
        (() => {
          const z = el('button', 'ib zl', zoomPct + '%');
          z.title = 'คลิกเพื่อรีเซ็ตเป็น 100%';
          z.addEventListener('click', ev => { ev.stopPropagation(); act('zoom', { id: g.id, value: 1 }); });
          return z;
        })(),
        iconBtn('+', 'ขยายขนาดภาพเกม', () => act('zoom', { id: g.id, delta: 0.1 })),
        el('span', 'sep'),
        iconBtn('🖤', g.stealth ? 'เปิดหน้าจอคืน' : 'Stealth (ซ่อนหน้าจอ เกมยังรันต่อ)', () => act('stealth', { id: g.id }), { on: g.stealth }),
        iconBtn('🔄', 'รีโหลดเกม', () => act('reload', { id: g.id })),
        iconBtn(g.muted ? '🔇' : '🔊', g.muted ? 'เปิดเสียง' : 'ปิดเสียง', () => act('mute', { id: g.id })),
        iconBtn('⛶', multi ? 'ขยายจอนี้เต็มพื้นที่ / กลับไปแบ่งจอ' : 'กลับไปแบ่งจอ', () => act('maximize', { id: g.id }), { disabled: !multi && state.games.length < 2 }),
        iconBtn('✕', 'ปิดเกมนี้', () => { if (confirm('ปิดเกมนี้และลบออกจากรายการ?')) act('remove', { id: g.id }); })
      );
      pane.append(head);

      if (g.stealth) {
        const body = el('div', 'pbody');
        const box = el('div');
        box.append(
          el('div', 'big', '⚡'),
          el('div', 'title', 'STEALTH ACTIVE'),
          el('div', '', 'ซ่อนหน้าจอแล้ว เกมยังทำงานอยู่เบื้องหลัง'),
          el('div', 'sub', state.mode === 'keep' ? 'โหมด: รันต่อเต็มที่' : 'โหมด: ซ่อนจริง (ประหยัดสุด)')
        );
        const b = el('button', 'btn primary', '🔓 เปิดหน้าจอคืน');
        b.style.marginTop = '12px';
        b.addEventListener('click', () => act('stealth', { id: g.id }));
        box.append(b);
        body.append(box);
        pane.append(body);
      }
      root.append(pane);
    });
  }

  // ---------- แผงไอเทม ----------
  function fillFilter() {
    const sel = $('filterSel');
    const cur = sel.value;
    sel.textContent = '';
    const o = el('option', '', 'ทุกจอ'); o.value = '';
    sel.append(o);
    state.games.forEach((g, i) => {
      const op = el('option', '', '#' + (i + 1) + ' ' + gname(g));
      op.value = g.id;
      sel.append(op);
    });
    sel.value = state.games.some(g => g.id === cur) ? cur : '';
  }

  function itemRow(img, title, sub, count) {
    const row = el('div', 'item');
    const src = safeImg(img);
    if (src) { const im = el('img'); im.src = src; im.alt = ''; row.append(im); }
    else row.append(el('div', 'noimg', '🎁'));
    const meta = el('div', 'meta');
    meta.append(el('b', '', title), el('small', '', sub));
    row.append(meta);
    if (count != null) row.append(el('div', 'cnt', '×' + count));
    return row;
  }

  function entryLabel(e) {
    const i = idxOf(e.gameId);
    return timeStr(e.t) + ' · ' + (i >= 0 ? 'จอ #' + (i + 1) + ' ' : '') + e.gameName;
  }

  function renderFeed() {
    const box = $('pg-feed');
    box.textContent = '';
    const f = $('filterSel').value;
    const list = feed.filter(e => !f || e.gameId === f).slice(-150).reverse();
    if (!list.length) {
      box.append(el('div', 'hint', 'ยังไม่มีไอเทมที่ตรวจจับได้\nเมื่อเกมแจ้งว่าได้ของ จะแสดงที่นี่พร้อมแจ้งเตือน ถ้าไม่ขึ้น ให้เปิดโหมด Debug ในแท็บตั้งค่า'));
      box.firstChild.style.whiteSpace = 'pre-line';
      return;
    }
    list.forEach(e => box.append(itemRow(e.img, e.name + (e.qty > 1 ? ' ×' + e.qty : ''), entryLabel(e), null)));
  }

  function renderSummary() {
    const box = $('pg-sum');
    box.textContent = '';
    const f = $('filterSel').value;
    let any = false;
    state.games.forEach((g, i) => {
      if (f && g.id !== f) return;
      const rows = totals[g.id] || [];
      if (!rows.length) return;
      any = true;
      const sum = rows.reduce((a, r) => a + r.count, 0);
      box.append(el('div', 'ghead', 'จอ #' + (i + 1) + ' ' + gname(g) + ' — รวม ' + sum + ' ชิ้น / ' + rows.length + ' ชนิด'));
      rows.forEach(r => box.append(itemRow(r.img, r.name, '', r.count)));
    });
    if (!any) box.append(el('div', 'hint', 'ยังไม่มีข้อมูลสรุป'));
  }

  function renderSidebarLists() { renderFeed(); renderSummary(); }

  function applyPanelVisibility() {
    $('side').classList.toggle('open', state.panelOpen);
    if (state.panelOpen) { unread = 0; }
  }

  function setTab(tab) {
    curTab = tab;
    document.querySelectorAll('.stab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    ['feed', 'sum', 'set'].forEach(t => $('pg-' + t).classList.toggle('active', t === tab));
    $('filterBar').style.display = tab === 'set' ? 'none' : 'flex';
  }

  function fillSettings() {
    const s = state.settings || {};
    $('setNotify').checked = s.notify !== false;
    $('setScope').value = s.notifyScope === 'stealth' ? 'stealth' : 'all';
    $('setSound').checked = s.sound !== false;
    $('setWs').checked = !!s.wsStructural;
    $('setRules').value = s.rulesText || '';
    $('setIgnore').value = s.ignoreText || '';
    $('setDebug').checked = !!s.debug;
    $('dbgWrap').style.display = s.debug ? 'block' : 'none';
  }

  function showRuleErrors() {
    $('setErrs').textContent = (state.ruleErrors || []).join('\n');
  }

  function renderAll() {
    renderToolbar();
    renderPanes();
    applyPanelVisibility();
    fillFilter();
    if (state.settingsVersion !== appliedSettingsVersion) {
      appliedSettingsVersion = state.settingsVersion;
      fillSettings();
    }
    showRuleErrors();
  }

  // ---------- toast ----------
  let toastTimer = null;
  function showToast(e) {
    const src = safeImg(e.img);
    $('toastImg').style.display = src ? 'block' : 'none';
    if (src) $('toastImg').src = src;
    const i = idxOf(e.gameId);
    $('toastText').textContent = (i >= 0 ? 'จอ #' + (i + 1) + ': ' : '') + e.name + (e.qty > 1 ? ' ×' + e.qty : '');
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 6000);
  }

  // ---------- events ----------
  function showErr(msg) {
    $('err').textContent = msg || '';
    if (msg) setTimeout(() => { $('err').textContent = ''; }, 4000);
  }

  async function addGame() {
    const r = await act('add', { url: $('urlInput').value, name: $('nameInput').value });
    if (r && r.error) return showErr(r.error);
    $('nameInput').value = '';
  }

  $('addBtn').addEventListener('click', addGame);
  $('urlInput').addEventListener('keydown', e => { if (e.key === 'Enter') addGame(); });
  $('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') addGame(); });

  $('layoutSel').addEventListener('change', e => act('layout', { layout: e.target.value }));
  $('modeSel').addEventListener('change', e => act('mode', { mode: e.target.value }));
  $('btnStealthAll').addEventListener('click', () => act('stealthAll', { value: !allStealth }));
  $('btnPanel').addEventListener('click', () => act('panel', {}));

  $('winSel').addEventListener('change', e => {
    const v = e.target.value;
    e.target.value = '';
    if (!v) return;
    if (v === 'full') return act('fullscreen');
    if (v === 'max') return act('winsize', { preset: 'max' });
    const [w, h] = v.split('x').map(Number);
    act('winsize', { w, h });
  });

  document.querySelectorAll('.stab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('filterSel').addEventListener('change', renderSidebarLists);
  $('btnExport').addEventListener('click', () => act('exportItems'));
  $('btnClear').addEventListener('click', () => {
    const id = $('filterSel').value;
    if (confirm(id ? 'ล้างรายการไอเทมของจอนี้?' : 'ล้างรายการไอเทมทั้งหมด?')) act('clearItems', { id: id || null });
  });

  $('setDebug').addEventListener('change', e => { $('dbgWrap').style.display = e.target.checked ? 'block' : 'none'; });

  $('btnSave').addEventListener('click', async () => {
    const r = await act('saveSettings', {
      notify: $('setNotify').checked,
      notifyScope: $('setScope').value,
      sound: $('setSound').checked,
      wsStructural: $('setWs').checked,
      rulesText: $('setRules').value,
      ignoreText: $('setIgnore').value,
      debug: $('setDebug').checked
    });
    $('setMsg').textContent = r && r.errors && r.errors.length ? '' : '✔ บันทึกแล้ว';
    setTimeout(() => { $('setMsg').textContent = ''; }, 3000);
  });
  $('btnReset').addEventListener('click', () => { if (confirm('คืนกฎและรายการยกเว้นเป็นค่าเริ่มต้น?')) act('resetRules'); });
  $('btnTest').addEventListener('click', async () => {
    const r = await act('testNotify', { id: state.activeId });
    if (r && r.error) { $('setMsg').textContent = ''; $('setErrs').textContent = r.error; }
  });
  $('btnDbgClear').addEventListener('click', () => { debugLines.length = 0; $('dbgLog').value = ''; });

  // ---------- จาก main ----------
  window.api.onState(s => { state = s; renderAll(); });

  window.api.onItem(e => {
    feed.push(e);
    if (feed.length > 500) feed.shift();
    if (!state.panelOpen) unread++;
    showToast(e);
    renderToolbar();
    if (state.panelOpen) renderFeed();
  });

  window.api.onTotals(t => { totals = t || {}; if (state.panelOpen) renderSummary(); });

  window.api.onFeedCleared(id => {
    feed = id ? feed.filter(e => e.gameId !== id) : [];
    renderSidebarLists();
  });

  window.api.onDebug(d => {
    const i = idxOf(d.gameId);
    debugLines.push('[' + timeStr(d.t) + '] จอ#' + (i + 1) + ' ' + d.src + ': ' + d.text);
    if (debugLines.length > 250) debugLines.shift();
    const box = $('dbgLog');
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    box.value = debugLines.join('\n');
    if (stick) box.scrollTop = box.scrollHeight;
  });

  // แปลงรูปไอเทมเป็น PNG 96px (รองรับ webp/svg) แล้วส่งกลับให้ main
  window.api.onRasterize(async ({ id, dataUrl }) => {
    try {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const S = 96;
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      const ctx = c.getContext('2d');
      const k = Math.min(S / (img.naturalWidth || S), S / (img.naturalHeight || S), 4);
      const w = Math.max(1, Math.round((img.naturalWidth || S) * k));
      const h = Math.max(1, Math.round((img.naturalHeight || S) * k));
      ctx.drawImage(img, Math.floor((S - w) / 2), Math.floor((S - h) / 2), w, h);
      window.api.rasterDone(id, c.toDataURL('image/png'));
    } catch (e) {
      window.api.rasterDone(id, null);
    }
  });

  setTab('feed');
  Promise.all([window.api.getState(), window.api.getFeed()]).then(([s, f]) => {
    state = s;
    feed = (f && f.feed) || [];
    totals = (f && f.totals) || {};
    renderAll();
    renderSidebarLists();
  });
})();

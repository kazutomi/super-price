/* スーパー価格比較 — データはすべてブラウザ内（IndexedDB）に保存 */
(() => {
  'use strict';

  const APP_ID = 'super-price-compare';
  const SCHEMA = 1;
  const APP_VERSION = '2026092901';
  const TAX = { incl: 0, excl8: 0.08, excl10: 0.10 };
  const TAX_LABEL = { incl: '税込', excl8: '税抜8%', excl10: '税抜10%' };
  const WEIGHT = { g: 1, kg: 1000 };
  const VOLUME = { ml: 1, L: 1000 };

  // ---------- 保存層 ----------
  const DB_NAME = 'super-price';
  const OS = 'kv';
  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('no idb')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(OS);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function idbGet(key) {
    try {
      const db = await openDB();
      return await new Promise((res, rej) => {
        const r = db.transaction(OS).objectStore(OS).get(key);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    } catch { const v = localStorage.getItem(DB_NAME + ':' + key); return v ? JSON.parse(v) : undefined; }
  }
  async function idbSet(key, val) {
    try {
      const db = await openDB();
      await new Promise((res, rej) => {
        const tx = db.transaction(OS, 'readwrite');
        tx.objectStore(OS).put(val, key);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch { localStorage.setItem(DB_NAME + ':' + key, JSON.stringify(val)); }
  }

  // ---------- 状態 ----------
  let state = emptyState();
  let meta = { lastExport: null };
  function emptyState() { return { app: APP_ID, schema: SCHEMA, stores: [], items: [], entries: [] }; }
  const save = () => idbSet('state', state);
  const now = () => Date.now();
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const alive = (arr) => arr.filter(x => !x.deleted);
  const byId = (arr, id) => arr.find(x => x.id === id);
  const collator = new Intl.Collator('ja');

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function fmtDate(s) { if (!s) return ''; const [y, m, d] = s.split('-'); return `${y}/${+m}/${+d}`; }
  function fmtDateTime(t) { const d = new Date(t); return d.toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  const yen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
  const yen1 = (n) => '¥' + (n >= 100 ? Math.round(n).toLocaleString('ja-JP') : n.toFixed(n >= 10 ? 1 : 2));
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  const num = (n) => Number.isInteger(n) ? String(n) : String(+n.toFixed(3));

  // ---------- 計算 ----------
  function taxedPrice(e) { return e.price * (1 + (TAX[e.tax] || 0)); }
  function dimension(e) {
    if (e.unit in WEIGHT) return { key: 'w', label: '重さで比較（100gあたり）', base: 100 * 1, suffix: '/100g', total: e.size * WEIGHT[e.unit] * e.packs };
    if (e.unit in VOLUME) return { key: 'v', label: '容量で比較（100mlあたり）', base: 100, suffix: '/100ml', total: e.size * VOLUME[e.unit] * e.packs };
    return { key: 'c:' + e.unit, label: `数で比較（1${e.unit}あたり）`, base: 1, suffix: '/' + e.unit, total: e.size * e.packs };
  }
  function unitPrice(e) { const d = dimension(e); return d.total > 0 ? taxedPrice(e) / d.total * d.base : Infinity; }
  function qtyText(e) { return `${num(e.size)}${e.unit}` + (e.packs > 1 ? ` × ${e.packs}` : ''); }
  const productKey = (e) => [e.itemId, e.storeId, (e.maker || '').trim(), e.size, e.unit, e.packs].join('|');
  function newer(a, b) { // a が b より新しい記録か
    if (a.date !== b.date) return a.date > b.date;
    return (a.createdAt || 0) > (b.createdAt || 0);
  }

  // 品名ごとに、商品（店×製造元×容量）の最新記録を集計
  function productsOf(itemId) {
    const map = new Map();
    for (const e of alive(state.entries)) {
      if (e.itemId !== itemId) continue;
      if (!byId(state.stores, e.storeId) || byId(state.stores, e.storeId).deleted) continue;
      const k = productKey(e);
      const p = map.get(k);
      if (!p) map.set(k, { key: k, latest: e, count: 1 });
      else { p.count++; if (newer(e, p.latest)) p.latest = e; }
    }
    return [...map.values()];
  }

  // ---------- 描画 ----------
  const $ = (s) => document.querySelector(s);
  const listEl = $('#list');
  const qEl = $('#q');

  function render() {
    const q = qEl.value.trim().toLowerCase();
    const items = alive(state.items).sort((a, b) => collator.compare(a.name, b.name));
    if (!items.length) {
      listEl.innerHTML = `<div class="empty"><strong>まだ品名がありません</strong>「＋ 品名」から小麦粉などの品名を追加し、スーパーごとの価格を記録してください。</div>`;
      return;
    }
    let html = '';
    let shown = 0;
    for (const item of items) {
      const products = productsOf(item.id);
      if (q) {
        const hitItem = item.name.toLowerCase().includes(q);
        const hitSub = products.some(p => {
          const s = byId(state.stores, p.latest.storeId);
          return (s && s.name.toLowerCase().includes(q)) || (p.latest.maker || '').toLowerCase().includes(q) || (p.latest.memo || '').toLowerCase().includes(q);
        });
        if (!hitItem && !hitSub) continue;
      }
      shown++;
      html += renderCard(item, products);
    }
    listEl.innerHTML = shown ? html : `<div class="empty"><strong>該当する品名がありません</strong>検索語を変えてみてください。</div>`;
  }

  function renderCard(item, products) {
    // 比較軸ごとにグループ化
    const groups = new Map();
    for (const p of products) {
      const d = dimension(p.latest);
      if (!groups.has(d.key)) groups.set(d.key, { label: d.label, list: [] });
      groups.get(d.key).list.push(p);
    }
    const gs = [...groups.values()].sort((a, b) => b.list.length - a.list.length);
    let body = '';
    let bestText = '';
    if (!products.length) {
      body = `<div class="card-empty">まだ価格が記録されていません。</div>`;
    } else {
      gs.forEach((g, gi) => {
        g.list.sort((a, b) => unitPrice(a.latest) - unitPrice(b.latest));
        if (gs.length > 1) body += `<div class="dim-label">${esc(g.label)}</div>`;
        const min = unitPrice(g.list[0].latest);
        if (gi === 0) {
          const s = byId(state.stores, g.list[0].latest.storeId);
          bestText = `最安 ${esc(s ? s.name : '')}`;
        }
        body += '<ul class="rows">';
        for (const p of g.list) {
          const e = p.latest;
          const s = byId(state.stores, e.storeId);
          const up = unitPrice(e);
          const d = dimension(e);
          const cheapest = g.list.length > 1 && up <= min + 1e-9;
          const tp = taxedPrice(e);
          const priceText = e.tax === 'incl' ? `${yen(e.price)}（税込）` : `${yen(e.price)}（${TAX_LABEL[e.tax]}）→ ${yen(tp)}`;
          body += `<li class="row-wrap"><button type="button" class="row${cheapest ? ' cheapest' : ''}" data-product="${esc(p.key)}">
            <div class="store">${esc(s ? s.name : '（不明）')}${cheapest ? '<span class="badge">最安</span>' : ''}${p.count > 1 ? `<span class="badge old">履歴${p.count}</span>` : ''}</div>
            <div class="right"><div class="unit-price">${yen1(up)}<small>${esc(d.suffix)}</small></div><div class="price">${esc(priceText)}</div></div>
            <div class="detail">${esc(e.maker || '製造元未記入')}・${esc(qtyText(e))}・${esc(fmtDate(e.date))}</div>
            ${e.memo ? `<div class="memo">${esc(e.memo)}</div>` : ''}
          </button><button type="button" class="copy-btn" data-copy="${esc(p.key)}" aria-label="別のスーパーで記録（コピー）" title="別のスーパーで記録（コピー）"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg></button></li>`;
        }
        body += '</ul>';
      });
    }
    return `<article class="card">
      <div class="card-head">
        <h2>${esc(item.name)}</h2>
        ${bestText ? `<span class="best">${bestText}</span>` : ''}
        <button type="button" class="icon-btn" data-edit-item="${esc(item.id)}" aria-label="${esc(item.name)} を編集">✎</button>
      </div>
      ${body}
      <div class="card-foot"><button type="button" class="btn small primary" data-add-entry="${esc(item.id)}">＋ 価格を記録</button></div>
    </article>`;
  }

  // ---------- トースト ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // ---------- ダイアログ共通 ----------
  document.querySelectorAll('dialog').forEach(d => {
    d.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-close]')) d.close();
      if (ev.target === d) { // 背景クリック
        const r = d.getBoundingClientRect();
        if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) d.close();
      }
    });
  });

  // ---------- 品名 ----------
  const itemDlg = $('#itemDlg'), itemForm = $('#itemForm');
  let editingItemId = null;
  function openItem(id) {
    editingItemId = id || null;
    const item = id ? byId(state.items, id) : null;
    $('#itemDlgTitle').textContent = item ? '品名を編集' : '品名を追加';
    itemForm.name.value = item ? item.name : '';
    $('#itemDelete').hidden = !item;
    itemDlg.showModal();
    setTimeout(() => itemForm.name.focus(), 50);
  }
  itemForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = itemForm.name.value.trim();
    if (!name) return;
    const dup = alive(state.items).find(i => i.name === name && i.id !== editingItemId);
    if (dup) { toast('同じ品名がすでにあります'); return; }
    if (editingItemId) {
      const it = byId(state.items, editingItemId); it.name = name; it.updatedAt = now();
    } else {
      state.items.push({ id: uid(), name, updatedAt: now() });
    }
    save(); render(); itemDlg.close();
  });
  $('#itemDelete').addEventListener('click', () => {
    const it = byId(state.items, editingItemId);
    if (!it) return;
    const n = alive(state.entries).filter(e => e.itemId === it.id).length;
    if (!confirm(`「${it.name}」を削除しますか？${n ? `\n記録 ${n} 件も削除されます。` : ''}`)) return;
    const t = now();
    it.deleted = true; it.updatedAt = t;
    state.entries.forEach(e => { if (e.itemId === it.id && !e.deleted) { e.deleted = true; e.updatedAt = t; } });
    save(); render(); itemDlg.close(); toast('削除しました');
  });
  $('#btnAddItem').addEventListener('click', () => openItem());

  // ---------- 価格記録 ----------
  const entryDlg = $('#entryDlg'), entryForm = $('#entryForm');
  let entryCtx = null; // { itemId, entryId? }
  function fillStoreSelect(selected) {
    const stores = alive(state.stores).sort((a, b) => collator.compare(a.name, b.name));
    const sel = entryForm.storeId;
    sel.innerHTML = (stores.length ? '' : '<option value="" disabled selected>店舗を追加してください</option>') +
      stores.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('') +
      '<option value="__new">＋ 新しい店を追加…</option>';
    if (selected && stores.some(s => s.id === selected)) sel.value = selected;
    else if (stores.length) sel.value = stores[0].id;
    sel.dataset.prev = sel.value;
  }
  function fillMakerList(itemId) {
    const makers = [...new Set(alive(state.entries).filter(e => e.itemId === itemId && e.maker).map(e => e.maker))];
    $('#makerList').innerHTML = makers.map(m => `<option value="${esc(m)}">`).join('');
  }
  let lastStoreId = null;
  // コピー時の既定店舗：同じ商品の記録がまだない店を優先
  function suggestStoreForCopy(src) {
    const stores = alive(state.stores).sort((a, b) => collator.compare(a.name, b.name));
    const has = new Set(alive(state.entries).filter(e => productKey({ ...e, storeId: '' }) === productKey({ ...src, storeId: '' })).map(e => e.storeId));
    const free = stores.find(s => !has.has(s.id));
    return free ? free.id : (stores.find(s => s.id !== src.storeId) || stores[0] || {}).id;
  }
  function latestOfProduct(key) {
    return alive(state.entries).filter(e => productKey(e) === key).sort((a, b) => (newer(a, b) ? -1 : 1))[0];
  }
  function openEntry({ itemId, entryId, template, copy }) {
    entryCtx = { itemId, entryId: entryId || null };
    const item = byId(state.items, itemId);
    const e = entryId ? byId(state.entries, entryId) : template;
    $('#entryDlgTitle').textContent = entryId ? '記録を編集' : copy ? '別のスーパーで記録' : '価格を記録';
    $('#entryItemName').textContent = item ? item.name : '';
    $('#copyNote').hidden = !copy;
    fillStoreSelect(copy ? suggestStoreForCopy(template) : e ? e.storeId : lastStoreId);
    fillMakerList(itemId);
    const f = entryForm;
    f.maker.value = e ? (e.maker || '') : '';
    f.size.value = e ? e.size : '';
    f.unit.value = e ? e.unit : 'g';
    f.packs.value = e ? e.packs : 1;
    f.price.value = entryId && e ? e.price : '';
    f.tax.value = e ? e.tax : 'incl';
    f.date.value = entryId && e ? e.date : today();
    f.memo.value = entryId && e ? (e.memo || '') : '';
    updatePreview();
    entryDlg.showModal();
    setTimeout(() => (copy ? f.storeId : template ? f.price : (alive(state.stores).length ? f.maker : f.storeId)).focus(), 50);
  }
  entryForm.storeId.addEventListener('change', () => {
    const sel = entryForm.storeId;
    if (sel.value !== '__new') { sel.dataset.prev = sel.value; return; }
    const name = (prompt('新しい店名') || '').trim();
    if (!name) { sel.value = sel.dataset.prev || ''; return; }
    let s = alive(state.stores).find(x => x.name === name);
    if (!s) { s = { id: uid(), name, updatedAt: now() }; state.stores.push(s); save(); }
    fillStoreSelect(s.id);
  });
  function readEntryForm() {
    const f = entryForm;
    return {
      storeId: f.storeId.value,
      maker: f.maker.value.trim(),
      size: parseFloat(f.size.value),
      unit: f.unit.value,
      packs: Math.max(1, parseInt(f.packs.value, 10) || 1),
      price: parseFloat(f.price.value),
      tax: f.tax.value,
      date: f.date.value || today(),
      memo: f.memo.value.trim(),
    };
  }
  function updatePreview() {
    const e = readEntryForm();
    const el = $('#entryPreview');
    if (!(e.size > 0) || !(e.price >= 0) || isNaN(e.price)) { el.textContent = ''; return; }
    const d = dimension(e);
    el.textContent = `単価 ${yen1(unitPrice(e))}${d.suffix}` + (e.tax !== 'incl' ? `（税込 ${yen(taxedPrice(e))}）` : '');
  }
  entryForm.addEventListener('input', updatePreview);
  entryForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = readEntryForm();
    if (!v.storeId || v.storeId === '__new') { toast('スーパーを選んでください'); return; }
    if (!(v.size > 0)) { toast('容量を入力してください'); return; }
    if (isNaN(v.price) || v.price < 0) { toast('価格を入力してください'); return; }
    if (entryCtx.entryId) {
      Object.assign(byId(state.entries, entryCtx.entryId), v, { updatedAt: now() });
    } else {
      state.entries.push({ id: uid(), itemId: entryCtx.itemId, ...v, createdAt: now(), updatedAt: now() });
    }
    lastStoreId = v.storeId;
    save(); render(); entryDlg.close();
    if (productDlg.open) renderProduct();
    toast('保存しました');
  });
  listEl.addEventListener('click', (ev) => {
    const add = ev.target.closest('[data-add-entry]');
    if (add) { openEntry({ itemId: add.dataset.addEntry }); return; }
    const ed = ev.target.closest('[data-edit-item]');
    if (ed) { openItem(ed.dataset.editItem); return; }
    const cp = ev.target.closest('[data-copy]');
    if (cp) { const src = latestOfProduct(cp.dataset.copy); if (src) openEntry({ itemId: src.itemId, template: src, copy: true }); return; }
    const row = ev.target.closest('[data-product]');
    if (row) openProduct(row.dataset.product);
  });

  // ---------- 商品詳細・履歴 ----------
  const productDlg = $('#productDlg');
  let currentProductKey = null;
  function openProduct(key) { currentProductKey = key; renderProduct(); productDlg.showModal(); }
  function renderProduct() {
    const recs = alive(state.entries).filter(e => productKey(e) === currentProductKey)
      .sort((a, b) => (newer(a, b) ? -1 : 1));
    if (!recs.length) { productDlg.close(); return; }
    const e = recs[0];
    const item = byId(state.items, e.itemId), s = byId(state.stores, e.storeId);
    $('#productTitle').textContent = `${item ? item.name : ''}｜${s ? s.name : ''}`;
    $('#productSub').textContent = `${e.maker || '製造元未記入'}・${qtyText(e)}`;
    $('#productHistory').innerHTML = recs.map(r => `<li>
      <div class="h-main"><b>${yen(taxedPrice(r))}</b>${r.tax !== 'incl' ? `<span class="muted small">（${TAX_LABEL[r.tax]} ${yen(r.price)}）</span>` : ''}
        ・${esc(fmtDate(r.date))}・${esc(yen1(unitPrice(r)) + dimension(r).suffix)}
        ${r.memo ? `<div class="h-memo">${esc(r.memo)}</div>` : ''}</div>
      <button type="button" class="btn small ghost" data-h-edit="${esc(r.id)}">編集</button>
      <button type="button" class="btn small ghost danger" data-h-del="${esc(r.id)}">削除</button>
    </li>`).join('');
  }
  $('#productCopy').addEventListener('click', () => {
    const src = latestOfProduct(currentProductKey);
    if (src) openEntry({ itemId: src.itemId, template: src, copy: true });
  });
  $('#productNew').addEventListener('click', () => {
    const recs = alive(state.entries).filter(e => productKey(e) === currentProductKey).sort((a, b) => (newer(a, b) ? -1 : 1));
    if (recs[0]) openEntry({ itemId: recs[0].itemId, template: recs[0] });
  });
  $('#productHistory').addEventListener('click', (ev) => {
    const ed = ev.target.closest('[data-h-edit]');
    if (ed) { const e = byId(state.entries, ed.dataset.hEdit); openEntry({ itemId: e.itemId, entryId: e.id }); return; }
    const del = ev.target.closest('[data-h-del]');
    if (del && confirm('この記録を削除しますか？')) {
      const e = byId(state.entries, del.dataset.hDel); e.deleted = true; e.updatedAt = now();
      save(); render(); renderProduct(); toast('削除しました');
    }
  });
  // 編集で商品キーが変わった場合に備え、編集ダイアログを閉じたら詳細も閉じる
  entryDlg.addEventListener('close', () => {
    if (productDlg.open && entryCtx && entryCtx.entryId) {
      const e = byId(state.entries, entryCtx.entryId);
      if (e && productKey(e) !== currentProductKey) productDlg.close();
    }
  });

  // ---------- 店舗 ----------
  const storesDlg = $('#storesDlg');
  function renderStores() {
    const stores = alive(state.stores).sort((a, b) => collator.compare(a.name, b.name));
    $('#storeList').innerHTML = stores.map(s => {
      const n = alive(state.entries).filter(e => e.storeId === s.id).length;
      return `<li><span class="s-name">${esc(s.name)}</span><span class="s-count">${n}件</span>
        <button type="button" class="btn small ghost" data-s-rename="${esc(s.id)}">名前変更</button>
        <button type="button" class="btn small ghost danger" data-s-del="${esc(s.id)}">削除</button></li>`;
    }).join('');
  }
  $('#btnStores').addEventListener('click', () => { renderStores(); storesDlg.showModal(); });
  $('#storeAddForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target, name = f.name.value.trim();
    if (!name) return;
    if (alive(state.stores).some(s => s.name === name)) { toast('同じ店名がすでにあります'); return; }
    state.stores.push({ id: uid(), name, updatedAt: now() });
    f.reset(); save(); renderStores(); render();
  });
  $('#storeList').addEventListener('click', (ev) => {
    const rn = ev.target.closest('[data-s-rename]');
    if (rn) {
      const s = byId(state.stores, rn.dataset.sRename);
      const name = (prompt('店名を変更', s.name) || '').trim();
      if (!name || name === s.name) return;
      if (alive(state.stores).some(x => x.name === name && x.id !== s.id)) { toast('同じ店名がすでにあります'); return; }
      s.name = name; s.updatedAt = now(); save(); renderStores(); render();
      return;
    }
    const del = ev.target.closest('[data-s-del]');
    if (del) {
      const s = byId(state.stores, del.dataset.sDel);
      const n = alive(state.entries).filter(e => e.storeId === s.id).length;
      if (!confirm(`「${s.name}」を削除しますか？${n ? `\nこの店の記録 ${n} 件も削除されます。` : ''}`)) return;
      const t = now();
      s.deleted = true; s.updatedAt = t;
      state.entries.forEach(e => { if (e.storeId === s.id && !e.deleted) { e.deleted = true; e.updatedAt = t; } });
      save(); renderStores(); render(); toast('削除しました');
    }
  });

  // ---------- 同期（書き出し・読み込み） ----------
  const syncDlg = $('#syncDlg');
  function renderSync() {
    $('#appVersion').textContent = 'アプリのバージョン：' + APP_VERSION;
    $('#syncStats').textContent = `品名 ${alive(state.items).length}・店舗 ${alive(state.stores).length}・記録 ${alive(state.entries).length}`;
    $('#lastExport').textContent = meta.lastExport ? `この端末での最終書き出し：${fmtDateTime(meta.lastExport)}` : 'この端末ではまだ書き出していません';
  }
  $('#btnSync').addEventListener('click', () => { renderSync(); syncDlg.showModal(); });

  $('#btnExport').addEventListener('click', async () => {
    const data = { ...state, exportedAt: new Date().toISOString() };
    const json = JSON.stringify(data, null, 1);
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const fname = `super-prices-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
    const blob = new Blob([json], { type: 'application/json' });
    let done = false;
    // タッチ端末（iPhone等）は共有シートで AirDrop / iCloud Drive に保存できる
    const touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    if (touch && navigator.canShare) {
      try {
        const file = new File([blob], fname, { type: 'application/json' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: fname });
          done = true;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    if (!done) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    meta.lastExport = Date.now(); idbSet('meta', meta); renderSync();
    toast('書き出しました');
  });

  function validImport(d) {
    return d && typeof d === 'object' && d.app === APP_ID && Array.isArray(d.stores) && Array.isArray(d.items) && Array.isArray(d.entries);
  }
  function mergeArr(local, incoming) {
    const m = new Map(local.map(x => [x.id, x]));
    let changed = 0;
    for (const x of incoming) {
      const cur = m.get(x.id);
      if (!cur || (x.updatedAt || 0) > (cur.updatedAt || 0)) { m.set(x.id, x); changed++; }
    }
    return { arr: [...m.values()], changed };
  }
  $('#importFile').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { alert('ファイルを読み込めませんでした（JSONではありません）'); return; }
    if (!validImport(data)) { alert('このアプリの書き出しファイルではありません'); return; }
    const mode = document.querySelector('input[name="importMode"]:checked').value;
    const info = `品名 ${alive(data.items).length}・店舗 ${alive(data.stores).length}・記録 ${alive(data.entries).length}` +
      (data.exportedAt ? `\n書き出し日時：${fmtDateTime(data.exportedAt)}` : '');
    if (mode === 'replace') {
      if (!confirm(`この端末のデータをすべて置き換えます。\n\n読み込むファイル：\n${info}`)) return;
      state = { app: APP_ID, schema: SCHEMA, stores: data.stores, items: data.items, entries: data.entries };
      await save(); render(); renderSync(); toast('置き換えました');
    } else {
      if (!confirm(`統合します（同じデータは更新日時の新しい方を残します）。\n\n読み込むファイル：\n${info}`)) return;
      const s = mergeArr(state.stores, data.stores), i = mergeArr(state.items, data.items), e = mergeArr(state.entries, data.entries);
      state.stores = s.arr; state.items = i.arr; state.entries = e.arr;
      await save(); render(); renderSync();
      toast(`統合しました（更新 ${s.changed + i.changed + e.changed} 件）`);
    }
  });

  // ---------- 起動 ----------
  qEl.addEventListener('input', render);
  (async () => {
    const s = await idbGet('state');
    if (validImport(s)) state = s;
    const m = await idbGet('meta');
    if (m) meta = m;
    render();
  })();
})();

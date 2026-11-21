// Kagibako — PC の画面だけで使う操作（マウス・キーボード）
// メニューバー・右クリックメニュー・ツリーのドラッグ移動・ツリーの幅・キー操作。スマホの画面では使わない
import { h, modal } from './ui.js';
import * as M from './model.js';
import * as store from './store.js';
import * as host from './host.js';
import * as D from './domain.js';
import { HOWTO, SHORTCUTS } from './help.js';
import { isPhone } from './ui-phone.js';
import {
  editLocked, toggleReadOnly, renderTree, sortSelected, select, selected, touch, openOfficialSite, addFolder, addItem, duplicateItem, moveNode, moveTarget, startRename, phoneNewItem, deleteNode, copyText, save, lock, menuGroups, runMenu, printDialog, generatorDialog, autoTypeItem, helpDialog, helpTabs, openHelpTab, S, settings, $tree, $detail, $layout, $mbar,
} from './app.js';

// ---- ツリーのドラッグ＆ドロップで移動（PC のマウス操作。スマホは一覧の長押しドラッグ（ui-phone.js）か「移動先…」で） ----
const DRAG_TYPE = 'application/x-kagibako-node'; // 他のアプリへ文字として落ちないよう、独自の種類だけで運ぶ
let treeDrag = null; // { id, target: { targetId, pos }, openId, openAt }
const treeDraggable = () => !settings.readOnly && !S.search.trim();

function clearDropMarks() {
  if (!$tree) return;
  for (const el of $tree.querySelectorAll('.drop-before, .drop-after, .drop-inside')) el.classList.remove('drop-before', 'drop-after', 'drop-inside');
  $tree.classList.remove('drop-root');
}

/** マウスの位置から、前・後・フォルダの中 のどこに落とすか */
function treeDropPos(ev, nodeEl) {
  const r = nodeEl.getBoundingClientRect();
  const y = (ev.clientY - r.top) / Math.max(1, r.height);
  if (nodeEl.classList.contains('folder')) return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside';
  return y < 0.5 ? 'before' : 'after';
}

function setupTreeDnD(tree) {
  tree.addEventListener('dragstart', (ev) => {
    const el = ev.target.closest?.('.node[draggable="true"]');
    if (!el) return;
    treeDrag = { id: el.dataset.id, target: null, openId: null, openAt: 0 };
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData(DRAG_TYPE, el.dataset.id);
    el.classList.add('dragging');
  });
  tree.addEventListener('dragover', (ev) => {
    if (!treeDrag || !ev.dataTransfer.types.includes(DRAG_TYPE)) return; // ファイルなど、よそからのドラッグは受けない
    const el = ev.target.closest('.node');
    clearDropMarks();
    const targetId = el?.dataset.id || null;
    const pos = el ? treeDropPos(ev, el) : null;
    if (!M.canMoveNode(S.vault, treeDrag.id, targetId, pos)) { treeDrag.target = null; ev.dataTransfer.dropEffect = 'none'; return; }
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    treeDrag.target = { targetId, pos };
    if (el) el.classList.add(`drop-${pos}`); else tree.classList.add('drop-root');
    // 閉じたフォルダの上で少し止まると開く（中の好きな位置に落とせるように）
    if (el && pos === 'inside') {
      const f = M.findById(S.vault, targetId)?.node;
      if (f && !f.open && f.children.length) {
        if (treeDrag.openId !== targetId) { treeDrag.openId = targetId; treeDrag.openAt = Date.now(); }
        else if (Date.now() - treeDrag.openAt > 700) { f.open = true; treeDrag.openId = null; renderTree(); }
      }
    } else treeDrag.openId = null;
  });
  tree.addEventListener('dragleave', (ev) => { if (!tree.contains(ev.relatedTarget)) clearDropMarks(); });
  tree.addEventListener('drop', (ev) => {
    if (!treeDrag || !ev.dataTransfer.types.includes(DRAG_TYPE)) return;
    ev.preventDefault();
    const { id, target } = treeDrag;
    treeDrag = null;
    clearDropMarks();
    if (!target || editLocked()) return;
    if (!M.moveNodeTo(S.vault, id, target.targetId, target.pos)) return;
    touch(M.findById(S.vault, id).node);
    select(id);
  });
  tree.addEventListener('dragend', () => {
    treeDrag = null;
    clearDropMarks();
    for (const el of tree.querySelectorAll('.dragging')) el.classList.remove('dragging');
  });
}

// ---- ドロップダウン（メニューバー・右クリックメニュー共通） ----
let openDrop = null;
function closeDropdown() { openDrop?.close(); }

/**
 * items: [{ label, key, checked, disabled, run }] または '-'
 * 位置は anchor（ボタンの下）か、x/y（右クリックした位置）。
 * avoid（長押しした行の四角）を渡すと、その下（入らなければ上）に離して出す＝指の下にメニューをかぶせない
 */
function dropdown(items, { anchor = null, x = 0, y = 0, avoid = null, onClose = null, onSide = null } = {}) {
  closeDropdown();
  let closed = false;
  const menu = h('div', { class: 'dropdown', role: 'menu' }, items.map((it) => (it === '-'
    ? h('div', { class: 'dd-sep', role: 'separator' })
    : h('button', { class: 'dd-item', role: it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem', 'aria-checked': it.checked !== undefined ? String(!!it.checked) : null, disabled: !!it.disabled, onclick: () => { close(); it.run(); } },
      h('span', { class: 'dd-check', 'aria-hidden': 'true' }, it.checked ? '✓' : ''),
      h('span', { class: 'dd-label' }, it.label),
      h('span', { class: 'dd-key' }, it.key || '')))));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  let left = x, top = y;
  if (anchor) { const a = anchor.getBoundingClientRect(); left = a.left; top = a.bottom; }
  if (avoid) {
    const GAP = 8;
    left = avoid.left;
    const below = innerHeight - 4 - (avoid.bottom + GAP), above = avoid.top - GAP - 4;
    if (r.height <= below) top = avoid.bottom + GAP;
    else if (r.height <= above) top = avoid.top - GAP - r.height;
    else top = below >= above ? innerHeight - r.height - 4 : 4; // どちらにも入らないときは広いほうへ寄せる
  }
  if (left + r.width > innerWidth - 4) left = Math.max(4, innerWidth - r.width - 4);
  if (!avoid && top + r.height > innerHeight - 4) top = Math.max(4, anchor ? innerHeight - r.height - 4 : top - r.height);
  top = Math.max(4, top);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const buttons = () => [...menu.querySelectorAll('.dd-item:not(:disabled)')];
  const onDown = (e) => { if (!menu.contains(e.target) && !(anchor && anchor.contains(e.target))) close(); };
  const onKey = (e) => {
    const list = buttons();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); anchor?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && onSide) { e.preventDefault(); onSide(e.key === 'ArrowLeft' ? -1 : 1); }
    else if (e.key === 'Tab') close();
  };
  const onBlurWin = () => close();
  function close() {
    if (closed) return;
    closed = true;
    menu.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('blur', onBlurWin);
    removeEventListener('resize', onBlurWin);
    if (openDrop?.menu === menu) openDrop = null;
    onClose?.();
  }
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  addEventListener('blur', onBlurWin);
  addEventListener('resize', onBlurWin);
  openDrop = { close, anchor, menu };
  buttons()[0]?.focus();
  return openDrop;
}

const toDropItems = (items) => items.map((x) => (x === '-' ? '-' : { label: x[1], key: x[2]?.key, checked: x[2]?.checked, disabled: x[2]?.disabled, run: () => runMenu(x[0]) }));

/** PC（広い画面）用のメニューバー */
function menuBar() {
  const bar = h('nav', { class: 'menubar', 'aria-label': 'メニューバー' });
  const btns = [];
  const open = (i) => {
    const b = btns[i];
    const group = menuGroups()[i];
    btns.forEach((x) => x.classList.remove('open'));
    b.classList.add('open');
    b.setAttribute('aria-expanded', 'true');
    dropdown(toDropItems(group[3]), {
      anchor: b,
      onClose: () => { b.classList.remove('open'); b.setAttribute('aria-expanded', 'false'); },
      onSide: (d) => open((i + d + btns.length) % btns.length),
    });
  };
  menuGroups().forEach(([id, title, acc], i) => {
    const b = h('button', { class: 'mb-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', dataset: { menu: id, acc } }, title, h('span', { class: 'mb-acc' }, `(${acc})`));
    b.addEventListener('click', () => { if (openDrop?.anchor === b) closeDropdown(); else open(i); });
    b.addEventListener('pointerenter', () => { if (openDrop && openDrop.anchor !== b && btns.includes(openDrop.anchor)) open(i); });
    btns.push(b);
    bar.append(b);
  });
  bar.openByAcc = (letter) => { const i = btns.findIndex((b) => b.dataset.acc === letter); if (i >= 0) { open(i); return true; } return false; };
  return bar;
}

/** ツリーの右クリックメニュー（スマホは一覧の長押し） */
function treeContextMenu(ev) {
  if (S.screen !== 'main') return;
  const phone = isPhone();
  ev.preventDefault();
  // PC：押したものを選んでから、選んでいるものについてのメニューを出す。
  // スマホ：選ぶとアイテムの画面に切り替わってしまうので選ばずに、長押ししたもの（一覧の行・タイル・フォルダ）をそのまま使う
  const nodeEl = ev.target.closest(phone ? '[data-id]' : '.node');
  let e;
  if (phone) e = nodeEl?.dataset.id ? M.findById(S.vault, nodeEl.dataset.id) : null;
  else {
    if (nodeEl?.dataset.id && S.sel !== nodeEl.dataset.id) select(nodeEl.dataset.id);
    e = selected();
  }
  const ro = !!settings.readOnly;
  let x = ev.clientX, y = ev.clientY;
  if (!x && !y) { const r = (nodeEl || ev.target).getBoundingClientRect(); x = r.left + 20; y = r.bottom; } // キーボード（Shift+F10）から
  const it = e?.node.type === 'item' ? e.node : null;
  const items = [];
  if (it) {
    items.push(
      { label: `${it.accountName || 'ID'} をコピー`, disabled: !it.account, run: () => copyText(it.account, it.accountName || 'ID') },
      { label: `${it.passwordName || 'パスワード'} をコピー`, disabled: !it.password, run: () => copyText(it.password, it.passwordName || 'パスワード') },
      { label: '公式サイトを開く', disabled: !D.hostOf(it.url), run: () => openOfficialSite(it) });
    if (host.isDesktop) items.push({ label: '自動入力', run: () => autoTypeItem(it, { useHotkeyTarget: false }) });
    items.push('-');
  }
  // スマホは長押ししたものを選ばないので、作る場所をここで決める：
  //   アイテム … 長押ししたのがフォルダならその中、アイテムなら今見ているフォルダの中
  //   フォルダ … 今見ている場所（☰ メニューの「新しいフォルダ」と同じ）
  items.push(
    { label: '新しいアイテム', disabled: ro, run: phone ? () => phoneNewItem(e?.node.type === 'folder' ? e.node.id : S.phoneFolder) : addItem },
    { label: '新しいフォルダ', disabled: ro, run: phone ? () => runMenu('newFolder') : () => addFolder(false) });
  // 「この中にフォルダを作る」「名前順に並べ替え」は選んでいるフォルダが相手なので PC だけ（スマホはフォルダの「…」から）
  if (e?.node.type === 'folder' && !phone) items.push({ label: 'この中にフォルダを作る', disabled: ro, run: () => addFolder(true) });
  if (e && nodeEl) {
    items.push('-');
    // スマホ：名前の欄がある画面を探さなくても、ここから名前を変えられるように（PC は F2・メニューの「名前を変える」）
    if (phone) items.push({ label: '名前を変える', disabled: ro, run: () => startRename(e.node.id) });
    if (it) items.push({ label: '複製', disabled: ro, run: () => duplicateItem(it, e.parent) });
    items.push(
      { label: '上へ', disabled: ro || moveTarget(e.node, e.parent, -1) < 0, run: () => moveNode(e.node, e.parent, -1) },
      { label: '下へ', disabled: ro || moveTarget(e.node, e.parent, 1) < 0, run: () => moveNode(e.node, e.parent, 1) });
    if (e.node.type === 'folder' && !phone) items.push({ label: '名前順に並べ替え', disabled: ro, run: sortSelected });
    items.push('-', { label: '削除', disabled: ro, run: () => deleteNode(e.node, e.parent) });
  }
  // スマホ：長押しした行・タイルの下（入らなければ上）に出す。指の下に出すと、そのまま動かしてドラッグしにくいため
  dropdown(items, phone && nodeEl ? { avoid: nodeEl.getBoundingClientRect() } : { x, y });
}

/** ツリーの幅（ドラッグで変更）と、入力欄の最大幅 */
function applyLayoutSettings() {
  document.body.classList.toggle('pane-wide', settings.paneWidth === 'wide');
  document.body.classList.toggle('pane-full', settings.paneWidth === 'full');
  if (!$layout) return;
  $layout.classList.toggle('custom-side', settings.sideWidth > 0);
  $layout.style.setProperty('--side-w', `${settings.sideWidth || 0}px`);
}

function splitter() {
  const el = h('div', { class: 'splitter', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'ツリーの幅（ドラッグで変更・ダブルクリックで元に戻す）', title: 'ドラッグでツリーの幅を変更（ダブルクリックで元に戻す）', tabindex: '0' });
  const clampW = (w) => Math.round(Math.max(160, Math.min(w, Math.min(720, innerWidth - 320))));
  const persist = () => store.setSetting('settings', { ...settings });
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('drag');
    const left = $layout.getBoundingClientRect().left;
    const move = (m) => { settings.sideWidth = clampW(m.clientX - left); applyLayoutSettings(); };
    const up = () => { el.classList.remove('drag'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); persist(); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
  el.addEventListener('dblclick', () => { settings.sideWidth = 0; applyLayoutSettings(); persist(); });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = settings.sideWidth || $layout.querySelector('.sidebar').getBoundingClientRect().width;
    settings.sideWidth = clampW(cur + (e.key === 'ArrowLeft' ? -20 : 20));
    applyLayoutSettings();
    persist();
  });
  return el;
}

async function shortcutsDialog() {
  const v = await modal({
    title: 'キー操作の一覧',
    wide: true,
    body: [h('table', { class: 'kv shortcuts' }, SHORTCUTS.filter(([k]) => host.isDesktop || !k.includes('Ctrl + Alt')).map(([k, d]) => h('tr', {}, h('th', {}, h('kbd', {}, k)), h('td', {}, d))))],
    buttons: [...helpTabs().filter(([k]) => k !== 'shortcuts').map(([k, label]) => ({ label, value: k })), { label: '閉じる', value: null, kind: 'primary' }],
  });
  return openHelpTab(v);
}

// キーボードショートカット（PC）
addEventListener('keydown', (e) => {
  if (S.screen !== 'main' || document.querySelector('.overlay')) return;
  // Alt + F / E / T / V / H でメニューバーを開く
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^Key[FETVH]$/.test(e.code) && $mbar?.isConnected && $mbar.offsetParent) {
    if ($mbar.openByAcc(e.code.slice(3))) { e.preventDefault(); return; }
  }
  if (document.querySelector('.dropdown')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const inField = isEditable(e.target);
  const sel = selected();
  const item = sel?.node.type === 'item' ? sel.node : null;
  const run = (fn) => { e.preventDefault(); fn(); };
  const focusSearch = () => { const s = document.querySelector('.search'); s?.focus(); s?.select(); };
  if (ctrl && !e.altKey) {
    if (k === 's') return run(() => (e.shiftKey ? save({ as: 'kagi' }) : save()));
    if (k === 'f') return run(focusSearch);
    if (k === 'l') return run(() => lock());
    if (k === 'n') return run(() => (e.shiftKey ? addFolder(false) : addItem()));
    if (k === 'g') return run(() => generatorDialog()); // 生成だけ（選んでいるアイテムには触れない）
    if (k === 'e') return run(toggleReadOnly);
    if (k === 'p' && !host.isAndroid) return run(printDialog); // Android の画面（WebView）は印刷できないので、キーボードをつないでいても受けない
    if (k === 'd' && item) return run(() => duplicateItem(item, sel.parent));
    if (k === 'b' && item) return run(() => copyText(item.account, item.accountName || 'ID'));
    if (k === 'u' && item) return run(() => openOfficialSite(item));
    if (k === 't' && item && host.isDesktop) return run(() => autoTypeItem(item, { useHotkeyTarget: false }));
    // Ctrl+C：文字を選んでいない・入力欄の外ならパスワードをコピー（入力欄の中では普通のコピー）。Ctrl+Shift+C はいつでもパスワード
    if (k === 'c' && item && (e.shiftKey || (!inField && !String(getSelection())))) return run(() => copyText(item.password, item.passwordName || 'パスワード'));
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && sel && !inField) return run(() => moveNode(sel.node, sel.parent, e.key === 'ArrowUp' ? -1 : 1));
    return;
  }
  if (e.altKey || e.shiftKey) return;
  if (e.key === 'F1') return run(() => helpDialog(HOWTO));
  if (e.key === 'F3') return run(focusSearch);
  if (e.key === 'F2' && sel) return run(() => { const t = $detail.querySelector(sel.node.type === 'item' ? '.title-input' : 'input'); t?.focus(); t?.select(); });
  if (e.key === 'Delete' && sel && !inField) return run(() => deleteNode(sel.node, sel.parent));
  if (e.key === 'Escape' && e.target.classList?.contains('search') && S.search) return run(() => { e.target.value = ''; S.search = ''; renderTree(); });
});

/** 文字を入力できる場所か（ここでは Delete・Ctrl+C などを普段どおりに使う） */
function isEditable(el) {
  return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** ツリーの中で ↑ ↓ を押したら、前・次の項目を選ぶ */
function treeArrowKeys(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  const labels = [...$tree.querySelectorAll('.node .label')];
  const i = labels.indexOf(e.target);
  if (i < 0) return;
  const next = labels[i + (e.key === 'ArrowUp' ? -1 : 1)];
  if (!next) return;
  e.preventDefault();
  const id = next.closest('.node').dataset.id;
  select(id);
  $tree.querySelector(`.node[data-id="${id}"] .label`)?.focus();
}

export { closeDropdown, setupTreeDnD, menuBar, treeContextMenu, applyLayoutSettings, splitter, shortcutsDialog, treeArrowKeys, treeDraggable };

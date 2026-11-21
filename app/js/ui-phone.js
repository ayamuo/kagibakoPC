// Kagibako — スマホの画面（Android版、または幅の狭い画面）
// 一覧 → アイテム の2段の画面と、☰ メニュー。暗号・ファイル形式・データの扱いは app.js や各モジュールと共通
import { h, clear, modal, fmtDateTime, toast } from './ui.js';
import { icon } from './icons.js';
import * as M from './model.js';
import * as host from './host.js';
import * as D from './domain.js';
import * as BC from './brandcheck.js';
import * as store from './store.js';
import {
  renderMain, renderTree, select, renderDetail, openOfficialSite, passwordHistoryDialog, copyText, menuGroups, runMenu, charSpans, S, settings, $tree,
  ibtn, pwHint, touch, editLocked,
} from './app.js';
import { closeDropdown } from './ui-pc.js';

// ---- スマホ向けの画面（Android版、または幅の狭い画面） ----
const phoneMQ = typeof matchMedia === 'function' ? matchMedia('(max-width: 560px)') : null;
// 開発時（localhost）だけ、?phone=1 で幅に関係なくスマホの画面にする（Android の幅広い端末の確認用）
const forcePhone = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /[?&]phone=1(&|$)/.test(location.search);
// PC版アプリ（Windows）は、ウィンドウを狭くしても PC の画面のまま（自動入力などの PC の機能を使うため）。
// スマホの画面になるのは、Android版と、スマホのブラウザなど幅の狭い画面だけ
const isPhone = () => !host.isDesktop && (host.isAndroid || forcePhone || !!phoneMQ?.matches);
phoneMQ?.addEventListener?.('change', () => { if (S.screen === 'main') renderMain(); });

/** スマホの一覧の1行（大きく押しやすく。名前の下にドメイン。設定で選んだときだけ ID） */
function phoneRow(it, where = '') {
  // ID は人に見られやすい一覧には出さない（設定「スマホの一覧に ID も表示する」で出せる）
  const masked = !settings.phoneShowId || !!settings.view.maskAccount || (it.maskFields || []).includes('account');
  const host0 = D.hostOf(it.url);
  const sub = [!masked && it.account ? it.account : host0 ? D.registrableDomain(host0) : '', where].filter(Boolean).join('・');
  const expired = settings.expiryNotify !== 'off' && M.isExpired(it);
  return h('button', { class: `m-row${S.sel === it.id ? ' sel' : ''}`, dataset: { id: it.id }, onclick: () => select(it.id) },
    h('span', { class: 'm-ico', 'aria-hidden': 'true' }, icon(expired ? 'expired' : 'key')),
    h('span', { class: 'm-main' }, h('span', { class: 'm-name' }, it.name || '(名前なし)'), sub ? h('span', { class: 'm-sub' }, sub) : null),
    h('span', { class: 'm-chev', 'aria-hidden': 'true' }, '›'));
}

// ---- タイル表示：サービスごとの色と頭文字の「アイコン」 ----
// ロゴの画像は使わない（ネットから取ると、どのサービスを使っているかが外へ漏れる。同梱は商標の問題がある）
const AVATAR_COUNT = 12; // 色の数（app.css の .av-0〜.av-11）
const hashOf = (s) => { let x = 2166136261; for (const ch of s) { x ^= ch.codePointAt(0); x = Math.imul(x, 16777619) >>> 0; } return x; };

/** アイテムのアイコン（白い頭文字＋色）。一覧にある公式サイトなら、そのサービスの名前と色で揃える */
function avatarOf(it) {
  const host0 = D.hostOf(it.url);
  const brand = (host0 && BC.officialFor(host0)[0]) || BC.brandOfTitle(it.name || '') || null;
  const label = (brand?.name || it.name || '?').trim();
  const first = [...label][0] || '?';
  const text = /[a-z]/i.test(first) ? first.toUpperCase() : first;
  const key = brand?.id || (host0 ? D.registrableDomain(host0) : '') || label;
  // 色は CSS の .av-0〜.av-11（画面の安全設定で、要素に直接 style を書けないため）
  return h('span', { class: `m-av av-${hashOf(key) % AVATAR_COUNT}`, 'aria-hidden': 'true' }, text);
}

/** タイル1枚（アイコンと名前。期限切れは右上に印） */
function phoneTile(it) {
  const expired = settings.expiryNotify !== 'off' && M.isExpired(it);
  return h('button', { class: `m-tile${S.sel === it.id ? ' sel' : ''}`, dataset: { id: it.id }, onclick: () => select(it.id) },
    avatarOf(it),
    h('span', { class: 'm-tile-name' }, it.name || '(名前なし)'),
    expired ? h('span', { class: 'm-tile-badge', title: '有効期限切れ' }, icon('expired')) : null);
}

const tileMode = () => settings.phoneView !== 'list';
const phoneItems = (items) => (tileMode()
  ? h('div', { class: 'm-tiles' }, items.map((it) => phoneTile(it)))
  : h('div', { class: 'm-items' }, items.map((it) => phoneRow(it))));

/** 一覧の表示（タイル ⇔ リスト）を切り替えるボタン */
function phoneViewToggle() {
  const tile = tileMode();
  return ibtn(tile ? 'view-list' : 'view-tile', tile ? 'リスト表示にする' : 'タイル表示にする', async () => {
    settings.phoneView = tile ? 'list' : 'tile';
    await store.setSetting('settings', { ...settings });
    renderMain();
  }, { cls: 'small m-viewtoggle' });
}

/**
 * スマホの一覧：ファイルアプリのように「フォルダを押すと中に入る」形。
 * 上に今いる場所（すべて › 通販 › 使用頻度(低)）を出し、［‹］か Android の戻るで1つ上に戻る。
 * 階層が深くても表示が長くならず、フォルダとアイテムを絵で見分けられる
 */
function folderChain(id) {
  // ルートから id のフォルダまでのフォルダの並び（見つからなければ null）
  const find = (nodes, chain) => {
    for (const n of nodes) {
      if (n.type !== 'folder') continue;
      const next = [...chain, n];
      if (n.id === id) return next;
      const r = find(n.children, next);
      if (r) return r;
    }
    return null;
  };
  return id ? find(S.vault.children, []) : [];
}

/** いま開いているフォルダ（ルートなら null）。消えたフォルダなら上へ戻す */
function currentChain() {
  if (!S.phoneFolder) return [];
  const chain = folderChain(S.phoneFolder);
  if (!chain) { S.phoneFolder = null; return []; }
  return chain;
}

function openPhoneFolder(id) {
  S.phoneFolder = id || null;
  renderTree();
  scrollTo(0, 0);
}

/** 1つ上のフォルダへ。ルートにいれば false（Android の戻るでアプリを閉じる判断に使う） */
function phoneUp() {
  const chain = currentChain();
  if (!chain.length) return false;
  openPhoneFolder(chain.length > 1 ? chain[chain.length - 2].id : null);
  return true;
}

const countItems = (f) => M.listItems({ children: f.children }).length;

/** フォルダのタイル・行（フォルダの絵。押すと中に入る） */
function phoneFolderEntry(f) {
  const n = countItems(f);
  const subs = f.children.filter((c) => c.type === 'folder').length;
  const label = f.name || '(名前なし)';
  const aria = `フォルダ「${label}」を開く（アイテム ${n} 件）`;
  if (tileMode()) {
    return h('button', { class: 'm-tile m-folder', 'aria-label': aria, dataset: { id: f.id }, onclick: () => openPhoneFolder(f.id) },
      h('span', { class: 'm-av m-av-folder', 'aria-hidden': 'true' }, icon('folder')),
      h('span', { class: 'm-tile-name' }, label),
      h('span', { class: 'm-tile-count', 'aria-hidden': 'true' }, String(n)));
  }
  return h('button', { class: 'm-row m-folder', 'aria-label': aria, dataset: { id: f.id }, onclick: () => openPhoneFolder(f.id) },
    h('span', { class: 'm-ico', 'aria-hidden': 'true' }, icon('folder')),
    h('span', { class: 'm-main' }, h('span', { class: 'm-name' }, label),
      h('span', { class: 'm-sub' }, subs ? `アイテム ${n} 件・フォルダ ${subs}` : `アイテム ${n} 件`)),
    h('span', { class: 'm-chev', 'aria-hidden': 'true' }, '›'));
}

/** 今いる場所の表示（検索欄の下。押すとそのフォルダへ戻る） */
function renderPhoneCrumbs(chain) {
  const box = document.querySelector('.side-tools .m-crumbs');
  if (!box) return;
  if (!chain.length) { clear(box); box.hidden = true; return; }
  box.hidden = false;
  const here = chain[chain.length - 1];
  // data-folder：ドラッグ中の落とし先（そのフォルダへ移す。'' は最上位）
  const parts = [h('button', { class: 'm-crumb', dataset: { folder: '' }, onclick: () => openPhoneFolder(null) }, 'すべて')];
  chain.forEach((f, i) => {
    parts.push(h('span', { class: 'm-crumb-sep', 'aria-hidden': 'true' }, '›'));
    const last = i === chain.length - 1;
    parts.push(h('button', { class: `m-crumb${last ? ' here' : ''}`, 'aria-current': last ? 'page' : null, dataset: last ? null : { folder: f.id }, onclick: () => openPhoneFolder(f.id) }, f.name || '(名前なし)'));
  });
  const path = h('div', { class: 'm-crumb-path' }, parts);
  clear(box,
    h('button', { class: 'icon-btn m-up', 'aria-label': '1つ上のフォルダへ', title: '1つ上のフォルダへ', onclick: phoneUp }, icon('back')),
    path,
    h('button', { class: 'icon-btn m-sec-more', 'aria-label': `フォルダ「${here.name || ''}」の操作`, title: 'このフォルダの名前・並べ替え・削除', onclick: () => select(here.id) }, icon('more')));
  // 深い階層では、今いるフォルダの名前が見えるように右端まで送る
  requestAnimationFrame(() => { path.scrollLeft = path.scrollWidth; });
}

function renderPhoneList() {
  const chain = currentChain();
  renderPhoneCrumbs(chain);
  const here = chain.length ? chain[chain.length - 1].children : S.vault.children;
  const folders = here.filter((c) => c.type === 'folder');
  const items = here.filter((c) => c.type === 'item');
  const entries = [...folders.map((f) => phoneFolderEntry(f)), ...items.map((it) => (tileMode() ? phoneTile(it) : phoneRow(it)))];
  const empty = chain.length
    ? h('p', { class: 'muted pad' }, settings.readOnly ? 'このフォルダは空です' : 'このフォルダは空です。右下の［＋］で、このフォルダにアイテムやフォルダを作れます')
    : h('p', { class: 'muted pad' }, settings.readOnly ? 'アイテムがありません' : '右下の［＋］から追加できます');
  clear($tree, entries.length ? h('div', { class: tileMode() ? 'm-tiles' : 'm-items' }, entries) : empty);
}

// ---- 一覧のドラッグ：長押しでメニューが出たあと、指を離さずに動かすとドラッグに変わる（Android のホーム画面と同じ） ----
// ・フォルダの上で離す → そのフォルダの中へ。上の「すべて › …」の上で離す → そのフォルダへ
// ・「すべて › …」の上で少し止める → 一覧がその階層に変わる（別のフォルダへ移すため）。変わったあとは、
//   フォルダの上で離す → その中へ、それ以外の所で離す → 今見ているフォルダへ
// ・それ以外 → 同じ種類どうし（フォルダどうし・アイテムどうし）で並べ替え（一覧はフォルダが先・アイテムが後のため）
// ・長押しの前に指を動かしたときは、ふつうのスクロール
const DRAG_SLOP = 10; // これ以上動いたら「動かした」とみなす（px）
const EDGE = 64; // 画面の上下の端からこの幅に入ると自動でスクロール（px）
const SPRING_MS = 700; // 「すべて › …」の上でこの時間止まると、その階層を開く
// { id, el, x0, y0, x, y, armed, dragging, ghost, start, target, raf, moved: 階層を変えた, hover: 止まっている「すべて › …」, spring: そのタイマー, blocked: アイテムを最上位へ置こうとした }
let pd = null;

const isFolderEl = (el) => el.classList.contains('m-folder');
const entryEls = () => [...$tree.querySelectorAll('.m-tiles > [data-id], .m-items > [data-id]')];
const BLOCKED_MSG = 'アイテムは「すべて」の直下には置けません。フォルダの中に入れてください';

/** そのフォルダ（null は最上位）へ移せるか。今入っているフォルダへは移さない（何も変わらないため） */
function canDropInto(to) {
  const src = M.findById(S.vault, pd.id);
  if (!src || (src.parent?.id ?? null) === to) return false;
  return M.canMoveNode(S.vault, pd.id, to, to ? 'inside' : null);
}

/** 上の「すべて › …」のうち、落とせる所だけ点線で示す（アイテムは最上位に置けない、など） */
function markCrumbs() {
  for (const c of document.querySelectorAll('.m-crumb[data-folder]')) c.classList.toggle('m-drop-ok', canDropInto(c.dataset.folder || null));
}

function setupPhoneDrag(tree) {
  tree.addEventListener('touchstart', (ev) => {
    if (!isPhone() || ev.touches.length !== 1 || settings.readOnly || S.search.trim()) return;
    const el = ev.target.closest('[data-id]');
    if (!el || !tree.contains(el)) return;
    const t = ev.touches[0];
    endDrag();
    pd = { id: el.dataset.id, el, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, armed: false, dragging: false };
    addEventListener('touchmove', onDragMove, { passive: false });
    addEventListener('touchend', onDragEnd);
    addEventListener('touchcancel', onDragEnd);
  }, { passive: true });
  // 長押しのメニュー（treeContextMenu）が出たら、ここから動かせばドラッグになる
  tree.addEventListener('contextmenu', (ev) => { if (pd && pd.el.contains(ev.target)) pd.armed = true; }, true);
}

function onDragMove(ev) {
  if (!pd) return;
  const t = ev.touches[0];
  pd.x = t.clientX; pd.y = t.clientY;
  const moved = Math.hypot(pd.x - pd.x0, pd.y - pd.y0) > DRAG_SLOP;
  if (!pd.dragging) {
    if (!moved) return;
    if (!pd.armed || !ev.cancelable || editLocked()) { endDrag(); return; } // 長押しの前に動いた＝スクロール
    startDrag();
  }
  ev.preventDefault(); // ドラッグ中は画面をスクロールさせない（端での自動スクロールは別）
  dragOver();
  autoScroll();
}

function startDrag() {
  closeDropdown();
  const r = pd.el.getBoundingClientRect();
  const ghost = pd.el.cloneNode(true);
  ghost.classList.add('m-drag-ghost');
  ghost.removeAttribute('data-id');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.left = `${r.left}px`; ghost.style.top = `${r.top}px`;
  ghost.style.width = `${r.width}px`; ghost.style.height = `${r.height}px`;
  document.body.append(ghost);
  pd.el.classList.add('m-drag-src');
  pd.ghost = ghost;
  pd.dragging = true;
  pd.start = entryEls().indexOf(pd.el);
  markCrumbs();
}

function clearDropOn() {
  for (const el of document.querySelectorAll('.m-drop-on, .m-crumb-wait')) el.classList.remove('m-drop-on', 'm-crumb-wait');
}

/** 「すべて › …」の上で止まったら、少し待ってその階層を開く */
function springOn(crumb) {
  if (crumb === pd.hover) return;
  clearTimeout(pd.spring);
  pd.hover = crumb;
  if (crumb) pd.spring = setTimeout(() => springTo(crumb.dataset.folder || null), SPRING_MS);
}

function springTo(id) {
  if (!pd?.dragging) return;
  pd.hover = null;
  if (!pd.moved) {
    // 押した要素は、一覧を描き直しても指の動き（touchmove）を受け取り続けるよう、消さずに隠して残す
    pd.moved = true;
    pd.el.classList.add('m-drag-held');
    document.body.append(pd.el);
  }
  openPhoneFolder(id);
  markCrumbs();
  dragOver();
}

/** 指の下にあるものから、落とし先（フォルダの中・上のフォルダ・並べ替え）を決める */
function dragOver() {
  pd.ghost.style.transform = `translate(${pd.x - pd.x0}px, ${pd.y - pd.y0}px)`;
  clearDropOn();
  pd.target = null;
  pd.blocked = false;
  const under = document.elementFromPoint(pd.x, pd.y);
  const crumb = under?.closest('.m-crumb[data-folder]') || null;
  springOn(crumb);
  if (!under) return;
  if (crumb) {
    const to = crumb.dataset.folder || null;
    if (canDropInto(to)) { crumb.classList.add('m-drop-on'); pd.target = { into: to, el: crumb }; }
    else { crumb.classList.add('m-crumb-wait'); pd.blocked = !to; } // 止まっていれば開く（離しても移せない）
    return;
  }
  const over = under.closest('[data-id]');
  if (pd.moved) {
    // 階層を変えたあと：フォルダの上ならその中へ、上の欄より下のほかの所なら今見ているフォルダへ（並べ替えはしない）
    if (over && $tree.contains(over) && isFolderEl(over) && canDropInto(over.dataset.id)) {
      over.classList.add('m-drop-on'); pd.target = { into: over.dataset.id, el: over };
      return;
    }
    const top = document.querySelector('.side-tools')?.getBoundingClientRect().bottom ?? 0;
    if (pd.y <= top) return;
    const here = S.phoneFolder || null;
    if (canDropInto(here)) { $tree.classList.add('m-drop-on'); pd.target = { into: here, el: $tree }; } else pd.blocked = !here;
    return;
  }
  if (!over || over === pd.el || !$tree.contains(over)) return;
  const dragFolder = isFolderEl(pd.el);
  const list = entryEls();
  const forward = list.indexOf(pd.el) < list.indexOf(over); // 後ろ（右・下）へ動かしているか
  if (isFolderEl(over)) {
    // フォルダの上：アイテムなら中へ。
    // フォルダどうしは、真ん中なら中へ・向かっている先の端まで行ったら並べ替え（手前の端では何もしない。
    // 手前の端で入れ替えると、入れたいフォルダが指の下から逃げてしまうため）
    const r = over.getBoundingClientRect();
    const pos = tileMode() ? (pd.x - r.left) / r.width : (pd.y - r.top) / r.height; // タイルは横、リストは縦の位置（0〜1）
    const reorder = dragFolder && (forward ? pos > 0.75 : pos < 0.25);
    if (!reorder) {
      if ((!dragFolder || (pos >= 0.25 && pos <= 0.75)) && canDropInto(over.dataset.id)) {
        over.classList.add('m-drop-on'); pd.target = { into: over.dataset.id, el: over };
      }
      return;
    }
  }
  if (isFolderEl(over) !== dragFolder) return; // 種類が違うものとは入れ替えない
  // 並べ替え：触れたものの位置へ動かす（ほかはよける）
  if (forward) over.after(pd.el); else over.before(pd.el);
}

/** 画面の上下の端に指があるあいだ、少しずつスクロールする */
function autoScroll() {
  if (pd.raf) return;
  const step = () => {
    pd.raf = 0;
    if (!pd?.dragging) return;
    const top = document.querySelector('.side-tools')?.getBoundingClientRect().bottom ?? 0;
    const dy = pd.y < top + EDGE ? -12 : pd.y > innerHeight - EDGE ? 12 : 0;
    if (!dy) return;
    scrollBy(0, dy);
    dragOver();
    pd.raf = requestAnimationFrame(step);
  };
  pd.raf = requestAnimationFrame(step);
}

function onDragEnd(ev) {
  if (!pd) return;
  const d = pd;
  if (!d.dragging) { endDrag(); return; } // 動かさずに離した：長押しのメニューはそのまま
  ev.preventDefault?.();
  // ドラッグのあとに来る「押した」で、アイテムやフォルダが開かないようにする
  const eat = (e) => { e.preventDefault(); e.stopPropagation(); };
  addEventListener('click', eat, true);
  setTimeout(() => removeEventListener('click', eat, true), 400);
  const node = M.findById(S.vault, d.id)?.node;
  let msg = '';
  if (ev.type === 'touchend' && node && !editLocked()) {
    if (d.target) {
      if (M.moveNodeTo(S.vault, d.id, d.target.into, d.target.into ? 'inside' : null)) {
        touch(node);
        const dest = d.target.into ? M.findById(S.vault, d.target.into).node.name || '(名前なし)' : 'すべて';
        msg = `「${dest}」に移動しました`;
      }
    } else if (d.blocked) {
      msg = BLOCKED_MSG;
    } else if (!d.moved && entryEls().indexOf(d.el) !== d.start) {
      // 並べ替え：隣の同じ種類のものの前（なければ後ろ）へ
      const same = (el) => el && el.dataset.id && isFolderEl(el) === isFolderEl(d.el);
      const next = d.el.nextElementSibling, prev = d.el.previousElementSibling;
      const ok = same(next) ? M.moveNodeTo(S.vault, d.id, next.dataset.id, 'before')
        : same(prev) ? M.moveNodeTo(S.vault, d.id, prev.dataset.id, 'after') : false;
      if (ok) touch(node);
    }
  }
  endDrag();
  renderTree(); // 動かなかったとき（取り消し・決まりに反する所で離した）も元の並びに戻す
  if (msg) toast(msg);
}

function endDrag() {
  removeEventListener('touchmove', onDragMove, { passive: false });
  removeEventListener('touchend', onDragEnd);
  removeEventListener('touchcancel', onDragEnd);
  if (!pd) return;
  if (pd.raf) cancelAnimationFrame(pd.raf);
  clearTimeout(pd.spring);
  pd.ghost?.remove();
  if (pd.moved) pd.el.remove(); // 隠して残しておいた要素（一覧はもう描き直してある）
  else pd.el.classList.remove('m-drag-src');
  for (const c of document.querySelectorAll('.m-drop-ok')) c.classList.remove('m-drop-ok');
  clearDropOn();
  pd = null;
}

/** スマホのアイテム画面：入っている欄だけを大きく表示し、各欄に［コピー］ */
function phoneItemView({ node: it, path }) {
  const v = settings.view;
  const own = (k) => (it.maskFields || []).includes(k);
  const field = (label, value, { secret = false, key = '', mono = false, multiline = false } = {}) => {
    if (!value) return null;
    const shown = !secret || S.reveal.has(key);
    const text = !shown ? '••••••••' : key === 'password' && settings.colorChars !== false ? charSpans(value) : value;
    return h('div', { class: 'm-field' },
      h('div', { class: 'm-label' }, label),
      h('div', { class: 'm-line' },
        h('div', { class: `m-val${mono || secret ? ' mono' : ''}${multiline ? ' pre' : ''}` }, text),
        secret ? ibtn(shown ? 'hide' : 'show', shown ? `${label}を隠す` : `${label}を表示`, () => { if (S.reveal.has(key)) S.reveal.delete(key); else S.reveal.add(key); renderDetail(); }, { cls: 'm-btn' }) : null,
        ibtn('copy', `${label}をコピー`, () => copyText(value, label), { cls: 'primary m-btn' })));
  };
  const chk = BC.checkItem(it);
  const host0 = D.hostOf(it.url);
  const official = chk.official.find((b) => b === chk.titleBrand) || chk.official[0];
  const fields = [
    field(it.accountName || 'ID', it.account, { secret: !!v.maskAccount || own('account'), key: 'account' }),
    field(it.passwordName || 'パスワード', it.password, { secret: v.maskPassword !== false, key: 'password', mono: true }),
    pwHint(it),
    field(it.item1Name || '項目1', it.item1, { secret: !!v.maskItem1 || own('item1'), key: 'item1' }),
    field(it.item2Name || '項目2', it.item2, { secret: !!v.maskItem2 || own('item2'), key: 'item2' }),
    v.hideSerial ? null : field('シリアル番号', it.serialNumber, { mono: true }),
    v.hideEmail ? null : field('メール', it.email),
    field('メモ', it.comment, { multiline: true }),
  ].filter(Boolean);
  return h('div', { class: 'pane m-item' },
    h('div', { class: 'muted small' }, path.join(' / ')),
    h('div', { class: 'm-head' }, avatarOf(it), h('h2', { class: 'm-title' }, it.name || '(名前なし)')),
    host0 && !v.hideUrl ? h('button', { class: 'btn big m-open ib', onclick: () => openOfficialSite(it) }, icon('open-site'), '公式サイトを開く', h('span', { class: 'm-domain' }, D.registrableDomain(host0))) : null,
    chk.lookalike ? h('div', { class: 'warn small danger-box' }, icon('warning'), ' 偽ドメインの疑い：', BC.lookalikeText(chk.lookalike))
      : chk.level === 'ok' ? h('div', { class: 'small m-okline' }, icon('ok'), official ? ` ${official.name}の公式ドメイン` : ' 自分で確認した公式ドメイン') : null,
    fields.length ? fields : h('p', { class: 'muted' }, 'まだ何も入っていません。'),
    v.hideDates || !it.expirationDate ? null : h('p', { class: 'muted small' }, `有効期限: ${it.expirationDate}`),
    it.passwordHistory?.length ? h('button', { class: 'link small', onclick: () => passwordHistoryDialog(it) }, `変更前のパスワード（${it.passwordHistory.length} 件）`) : null,
    settings.readOnly ? h('p', { class: 'muted small' }, '👁 閲覧のみモードです（メニューから編集できるようにできます）')
      : h('button', { class: 'btn m-edit ib', onclick: () => { S.mobileEdit = true; renderDetail(); } }, icon('edit'), '編集する'),
    h('p', { class: 'muted small' }, `更新: ${fmtDateTime(it.modified)}`));
}

// ---- スマホの ☰ メニュー：上によく使うものを絵付きのボタンで、下に残りを見出しごとにたたんで並べる ----
const QUICK = [ // [メニューの項目, 表示名, 絵]
  ['save', '保存', 'save'], ['lock', 'ロック', 'lock'], ['newFolder', '新しいフォルダ', 'add-folder'], ['gen', 'パスワード生成', 'generate'],
  ['pwCheck', 'パスワード点検', 'shield'], ['urlAudit', 'URL 点検', 'open-site'], ['settings', '設定', 'settings'], ['howto', '使い方', 'help'],
];
const GROUP_ICON = { file: 'new-file', tools: 'key', view: 'show', help: 'faq' };
let lastOpenGroup = null; // 最後に開いた見出し（次にメニューを開いたときも開いておく）

async function menuDialog() {
  let picked = null;
  const pick = (k) => (e) => { picked = k; e.currentTarget.closest('.overlay').querySelector('.modal-head .icon-btn').click(); };
  const groups = menuGroups();
  const all = new Map(groups.flatMap(([, , , items]) => items.filter((x) => x !== '-').map((x) => [x[0], x])));
  const quickKeys = new Set(QUICK.map(([k]) => k));
  const quick = h('div', { class: 'm-quick' }, QUICK.filter(([k]) => all.has(k)).map(([k, label, ic]) =>
    h('button', { class: 'm-quick-btn', disabled: !!all.get(k)[2]?.disabled, onclick: pick(k) }, icon(ic), h('span', {}, label))));
  // 下の段：上の段にあるものは除く。「編集」は出さない（追加は右下の［＋］、選んだものへの操作は一覧の長押しメニュー）。
  // 「閲覧のみにする」は「表示」へ
  const sections = groups.filter(([id]) => id !== 'edit').map(([id, title, , items]) => {
    let rows = items.filter((x) => x !== '-' && !quickKeys.has(x[0]) && !x[2]?.disabled);
    if (id === 'view' && all.has('readOnly')) rows = [all.get('readOnly'), ...rows];
    if (!rows.length) return null;
    const sec = h('details', { class: 'm-menu-sec', open: lastOpenGroup === id },
      h('summary', {}, icon(GROUP_ICON[id] || 'more'), h('span', { class: 'm-menu-title' }, title), h('span', { class: 'm-menu-count' }, String(rows.length))),
      rows.map(([k, label, o]) => h('button', { class: 'menu-item', onclick: pick(k) }, o?.checked ? `✓ ${label}` : label)));
    sec.addEventListener('toggle', () => { if (sec.open) lastOpenGroup = id; else if (lastOpenGroup === id) lastOpenGroup = null; });
    return sec;
  });
  await modal({
    title: 'メニュー',
    wide: true,
    cls: 'm-menu',
    body: [h('p', { class: 'm-menu-label' }, 'よく使う'), quick, h('div', { class: 'm-menu-secs' }, sections)],
    buttons: [],
  });
  if (picked) await runMenu(picked);
}

export { phoneRow, renderPhoneList, phoneItemView, menuDialog, isPhone, phoneViewToggle, avatarOf, phoneUp, openPhoneFolder, setupPhoneDrag };

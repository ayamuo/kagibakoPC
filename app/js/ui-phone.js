// Kagibako — スマホの画面（Android版、または幅の狭い画面）
// 一覧 → アイテム の2段の画面と、☰ メニュー。暗号・ファイル形式・データの扱いは app.js や各モジュールと共通
import { h, clear, modal, fmtDateTime } from './ui.js';
import { icon } from './icons.js';
import * as M from './model.js';
import * as host from './host.js';
import * as D from './domain.js';
import * as BC from './brandcheck.js';
import * as store from './store.js';
import {
  renderMain, renderTree, select, renderDetail, openOfficialSite, passwordHistoryDialog, copyText, menuGroups, runMenu, charSpans, S, settings, $tree,
  ibtn, pwHint,
} from './app.js';

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
    return h('button', { class: 'm-tile m-folder', 'aria-label': aria, onclick: () => openPhoneFolder(f.id) },
      h('span', { class: 'm-av m-av-folder', 'aria-hidden': 'true' }, icon('folder')),
      h('span', { class: 'm-tile-name' }, label),
      h('span', { class: 'm-tile-count', 'aria-hidden': 'true' }, String(n)));
  }
  return h('button', { class: 'm-row m-folder', 'aria-label': aria, onclick: () => openPhoneFolder(f.id) },
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
  const parts = [h('button', { class: 'm-crumb', onclick: () => openPhoneFolder(null) }, 'すべて')];
  chain.forEach((f, i) => {
    parts.push(h('span', { class: 'm-crumb-sep', 'aria-hidden': 'true' }, '›'));
    const last = i === chain.length - 1;
    parts.push(h('button', { class: `m-crumb${last ? ' here' : ''}`, 'aria-current': last ? 'page' : null, onclick: () => openPhoneFolder(f.id) }, f.name || '(名前なし)'));
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
    ? h('p', { class: 'muted pad' }, settings.readOnly ? 'このフォルダは空です' : 'このフォルダは空です。右下の［＋］で、このフォルダにアイテムを作れます')
    : h('p', { class: 'muted pad' }, settings.readOnly ? 'アイテムがありません' : '右下の［＋］から追加できます');
  clear($tree, entries.length ? h('div', { class: tileMode() ? 'm-tiles' : 'm-items' }, entries) : empty);
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

/** スマホ（狭い画面）用：☰ で開く一覧 */
async function menuDialog() {
  let picked = null;
  const pick = (k) => (e) => { picked = k; e.target.closest('.overlay').querySelector('.modal-head .icon-btn').click(); };
  await modal({
    title: 'メニュー',
    wide: true,
    body: [h('div', { class: 'menu-groups' }, menuGroups().map(([, title, , items]) => h('section', { class: 'menu' },
      h('h3', {}, title),
      items.filter((x) => x !== '-' && !x[2]?.disabled).map(([k, label, o]) => h('button', { class: 'menu-item', onclick: pick(k) }, o?.checked ? `✓ ${label}` : label)))))],
    buttons: [],
  });
  if (picked) await runMenu(picked);
}

export { phoneRow, renderPhoneList, phoneItemView, menuDialog, isPhone, phoneViewToggle, avatarOf, phoneUp, openPhoneFolder };

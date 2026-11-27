// Kagibako（鍵箱） — メイン画面
import { h, clear, toast, modal, confirmDialog, passwordPrompt, fmtDateTime, capsWarning, abandonAllModals } from './ui.js';
import * as M from './model.js';
import * as L from './legacy.js';
import * as X from './vault.js';
import { classifyVault, classifyLegacy, compareHeaders, includesRev, absorbHeader, STATUS_TEXT } from './history.js';
import { diffVaults, mergeVaults } from './merge.js';
import * as store from './store.js';
import * as fio from './fileio.js';
import { generatePassword, estimateBits, strengthLabel, ALL_SYMBOLS, SYMBOL_PRESETS, normalizeSymbols } from './generator.js';
import * as host from './host.js';
import * as AT from './autotype.js';
import * as CSV from './csv.js';
import * as D from './domain.js';
import * as BC from './brandcheck.js';
import * as HL from './health.js';
import { BRANDS, CATEGORIES } from './brands.js';
import { GUIDE, DISCLAIMER, DISCLAIMER_VERSION } from './guide.js';
import { HOWTO, FAQ, SHORTCUTS, forHost } from './help.js';
import { icon } from './icons.js';
import { phoneRow, renderPhoneList, phoneItemView, menuDialog, isPhone, phoneViewToggle, phoneUp, setupPhoneDrag, tutorialDialog, maybeShowTutorial, BROWSER_CHOICES } from './ui-phone.js';
import { startPractice } from './practice.js';
import { closeDropdown, setupTreeDnD, menuBar, treeContextMenu, applyLayoutSettings, splitter, shortcutsDialog, treeArrowKeys, treeDraggable } from './ui-pc.js';

const APP_VERSION = '0.9.3';
// スマホ版を Play ストアで公開したら true にする（「このアプリをレビューする」を出し、紹介の URL をストアのページにする）
const PLAY_STORE_LISTED = false;
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=jp.kagibako';
const INTRO_URL = 'https://ayamuo.github.io/kagibako_official/'; // ストアで公開するまでの紹介先（公式サイトのスマホアプリのページ）
const $app = document.getElementById('app');
// Android版：画面全体で、ボタンや説明の文字を長押しで選べないようにする（app.css の html.android）
if (host.isAndroid) document.documentElement.classList.add('android');

/**
 * アイコンのボタン。label はマウスを乗せたとき・読み上げで出る名前。
 * text を渡すと絵の横に文字も出す（渡さなければ絵だけ）
 */
function ibtn(name, label, onclick, { cls = '', text = null, title = null, ...attrs } = {}) {
  return h('button', { class: `btn ib${text ? '' : ' icon-only'}${cls ? ` ${cls}` : ''}`, title: title || label, 'aria-label': label, onclick, ...attrs },
    icon(name), text ? h('span', { class: 'ib-text' }, text) : null);
}

// ---------------- 状態 ----------------
const S = {
  screen: 'start',
  file: null,      // { name, bytes, handle, lastModified, kind:'kagi'|'legacy', text? , env? }
  kind: null,      // 現在の保存形式
  vault: null,
  header: null,    // .kagi のヘッダ（版情報）
  session: null,   // Argon2id で導出した AES 鍵（スナップショット・下書き・.kagi 用）
  legacyKey: null, // .idm を読むときの鍵（比較・下書きの復元で読み直すときに使う）
  knownKey: null,
  dirty: false,
  sel: null,
  search: '',
  mobileDetail: false,
  banner: null,
  reveal: new Set(),
  pendingDraftCheck: false,
};
const DEFAULT_VIEW = { maskAccount: false, maskPassword: true, maskItem1: false, maskItem2: false, hideSerial: false, hideUrl: false, hideEmail: false, hideFile: false, hideDates: false };
const DEFAULT_SEARCH = { fields: { name: true, account: true, password: false, item1: true, item2: true, names: true, serialNumber: true, url: true, email: true, file: true, comment: true }, caseSensitive: false };
const settings = {
  deviceName: '', autoLockMin: 5, lockOnHide: false, clipSec: 30,
  // 表示・編集
  readOnly: false, validDays: 0, expiryNotify: 'off', expiryWarnDays: 30, rememberLast: true, fontScale: 100,
  density: host.isDesktop ? 'compact' : 'comfortable',
  view: { ...DEFAULT_VIEW }, search: structuredClone(DEFAULT_SEARCH),
  // PC版
  autoTypeTemplate: AT.DEFAULT_TEMPLATE, autoStartDelay: 400, keyDelay: 5, minimizeAfterType: false, autoTypeVia: 'type',
  customTemplates: [], // [{ name, template }]
  hotkey: 'ctrl+alt+a', closeToTray: true, minimizeToTray: true, topMost: false, browserPath: '', autoSaveOnClose: false,
  androidBrowser: 'chrome', // Android：［公式サイトを開く］のブラウザ。'chrome'（入っていれば Chrome）か 'default'（端末の既定）
  backupEnabled: true, backupDir: '', backupKeep: 30,
  // 画面の幅：ツリーの幅（px）と、右側の入力欄の最大幅（'normal' | 'wide' | 'full'）
  colorChars: true, sideWidth: 0, paneWidth: 'normal',
  openLastOnStart: true, // 起動したら前回のファイルのパスワード入力画面を出す
  // スマホの一覧：表示のしかた（tile / list）、ID も出すか（既定は出さない＝人に見られても ID が分からない）
  phoneView: 'tile', phoneShowId: false,
  theme: 'auto', // 'auto'（端末に合わせる）| 'light' | 'dark'
};

function loadSettings(saved) {
  Object.assign(settings, saved || {});
  settings.view = { ...DEFAULT_VIEW, ...(saved?.view || {}) };
  settings.search = { ...DEFAULT_SEARCH, ...(saved?.search || {}), fields: { ...DEFAULT_SEARCH.fields, ...(saved?.search?.fields || {}) } };
  if (!Array.isArray(settings.customTemplates)) settings.customTemplates = [];
  if (saved && 'expiryNotice' in saved && !('expiryNotify' in saved)) settings.expiryNotify = saved.expiryNotice ? 'banner' : 'off'; // 以前の設定から引き継ぐ
  delete settings.expiryNotice;
  // パスワードの定期変更は推奨されなくなったため、以前の既定値（1年の期限・上部に表示）は「期限なし・通知しない」に改める（1回だけ）
  if (saved && !saved.expiryPolicy2) {
    if (saved.validDays === undefined || saved.validDays === 365) settings.validDays = 0;
    if (saved.expiryNotify === undefined || saved.expiryNotify === 'banner') settings.expiryNotify = 'off';
  }
  settings.expiryPolicy2 = true;
  if (saved && !saved.smartInput1 && (saved.autoTypeTemplate === undefined || saved.autoTypeTemplate === AT.CLASSIC_TEMPLATE)) settings.autoTypeTemplate = AT.DEFAULT_TEMPLATE;
  settings.smartInput1 = true;
  // 入力のたびに最小化されると開き直すのが手間なので、既定を「最小化しない（ブラウザの後ろに回るだけ）」に改める（1回だけ）
  if (saved && !saved.afterType2) settings.minimizeAfterType = false;
  settings.afterType2 = true;
  // × は終了ではなくタスクトレイにしまうのを既定にする（1回だけ）。Windows の起動時に自動で立ち上がることはしない
  if (saved && !saved.trayClose2) settings.closeToTray = true;
  settings.trayClose2 = true;
}

/** 文字の大きさ（％）と表示の密度 */
function applyFontScale() {
  document.documentElement.style.fontSize = `${Math.max(80, Math.min(160, settings.fontScale || 100))}%`;
  document.body.classList.toggle('compact', settings.density === 'compact');
  if (settings.theme === 'light' || settings.theme === 'dark') document.documentElement.dataset.theme = settings.theme;
  else delete document.documentElement.dataset.theme;
}
let lastActivity = Date.now();
let hostInfo = { defaultBackupDir: '' };
let pendingHotkey = null; // ロック中にホットキーが押されたとき、解除後に自動入力の画面を出す

function guessDevice() {
  const ua = navigator.userAgent;
  if (/iPhone|Android.+Mobile/.test(ua)) return 'スマホ';
  if (/iPad|Android/.test(ua)) return 'タブレット';
  return 'PC';
}

function markDirty() {
  S.dirty = true;
  document.querySelector('.dirty-dot')?.classList.add('on');
}

// ---------------- 起動 ----------------
// 起動の途中で何が起きても「読み込み中…」のまま止めない。
//   ・アプリの設定など（設定・最近使ったファイルなど）が読めない → 初期値で進め、知らせる（.kagi ファイルは別なので開ける）
//   ・ほかのエラー → どこで何が起きたかと［もう一度読み込む］を出す（showBootError）
//   ・このファイル自体が読み込めない・返事を待ったまま進まない → js/boot-watch.js の見張りが 15 秒後に知らせる
let bootStep = 'アプリの読み込み';
function setBootStep(s) { bootStep = s; window.__kagibakoBootStep = s; }

async function boot() {
  try {
    await bootInner();
  } catch (e) {
    console.error(e);
    showBootError(e);
  }
}

// 「アプリの設定など」が壊れたときに、ID・パスワードの入ったファイルが壊れたと勘違いしないよう、いつも同じ言い方で添える
const KAGI_SAFE = 'ID・パスワードなどのアカウント情報は、あなたの .kagi ファイルに入っていて、無事です。';
const MEMO_WHAT = 'アプリの設定など（設定・最近使ったファイルの一覧・端末内の控え・ロック中の下書き）';
const KAGI_UNTOUCHED = host.isDesktop ? '.kagi ファイルと自動バックアップには触りません' : '.kagi ファイルには触りません'; // 自動バックアップは PC 版だけ

function showBootError(e) {
  // 画面がもう出ているときは、知らせるだけにする（使える画面を消さない）
  if (!$app.querySelector('.boot')) { toast(`起動の途中でエラーが起きました（${bootStep}: ${errText(e)}）。${KAGI_SAFE}`, 9000); return; }
  clear($app, h('div', { class: 'center-card boot-error' },
    h('h1', {}, '起動できませんでした'),
    h('p', { class: 'info-box' }, KAGI_SAFE),
    h('p', {}, '起動の途中でエラーが起きました。'),
    h('table', { class: 'kv' },
      h('tr', {}, h('th', {}, 'どこで'), h('td', {}, bootStep)),
      h('tr', {}, h('th', {}, '内容'), h('td', { class: 'mono path-text' }, errText(e)))),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn', onclick: () => resetMemoFlow() }, 'アプリの設定などを初期化'),
      h('button', { class: 'btn primary', onclick: () => location.reload() }, 'もう一度読み込む')),
    h('p', { class: 'muted small' }, `何度も起きる場合は、Kagibako を終了してから起動し直してください。それでも直らないときは［アプリの設定などを初期化］を試してください（${MEMO_WHAT}を空にします。${KAGI_UNTOUCHED}）。直らないときは、この画面の「どこで」「内容」を作者に知らせてください。`)));
}

/**
 * アプリの設定などを初期化する（設定の画面・知らせ・起動できなかった画面から）。
 * PC版・Android版は保存場所をまるごと退ける（消さないので戻せる）。終わったら読み込み直す
 */
async function resetMemoFlow() {
  if (S.dirty) {
    await modal({ title: '先に保存してください', body: [h('p', {}, '保存していない変更があります。初期化すると、開いているファイルは閉じます。先にファイルを保存してから、もう一度初期化してください。')] });
    return;
  }
  const v = await modal({
    title: 'アプリの設定などを初期化',
    body: [
      h('p', { class: 'info-box' }, `${KAGI_SAFE}初期化しても、${KAGI_UNTOUCHED}。`),
      h('p', {}, 'このアプリが自分用に覚えている次のものを、空にして最初からやり直します。'),
      h('ul', {},
        h('li', {}, '設定（画面の色・自動ロックの時間など。初期値に戻ります）'),
        h('li', {}, '最近使ったファイルの一覧（.kagi ファイルは［ファイルを開く］で開き直せます）'),
        h('li', {}, '端末内の控え（古い版での上書きを見つけるための、この端末の記録）'),
        h('li', {}, 'ロック中の下書き（保存していない変更）')),
      host.isDesktop || host.isAndroid
        ? h('p', { class: 'muted small' }, '消すのではなく、別の名前（store-old-日時）にして残すので、あとで元に戻すこともできます。開いているファイルは閉じます。')
        : h('p', { class: 'muted small' }, '開いているファイルは閉じます。')],
    buttons: [{ label: 'やめる', value: null }, { label: '初期化する', value: 'reset', kind: 'danger' }],
  });
  if (v !== 'reset') return;
  let movedTo = null;
  try { movedTo = await store.resetMemo(); } catch (e) {
    await modal({ title: '初期化できませんでした', body: [h('p', { class: 'info-box' }, KAGI_SAFE), h('p', {}, `アプリの設定などを初期化できませんでした（${errText(e)}）。Kagibako を終了してから、もう一度試してください。`)] });
    return;
  }
  await modal({
    title: '初期化しました',
    body: [h('p', { class: 'info-box' }, KAGI_SAFE),
      h('p', {}, 'アプリの設定などを空にしました。読み込み直して、最初の画面からやり直します。.kagi ファイルは［ファイルを開く］で開いてください。'),
      movedTo ? h('p', { class: 'muted small path-text' }, `前のものは次の場所に残しています（いらなければ消してかまいません）：${movedTo}`) : null],
    buttons: [{ label: '読み込み直す', value: true, kind: 'primary' }],
  });
  S.dirty = false; // 確かめ済み（保存していない変更は無い）。読み込み直しの確認を出さない
  location.reload();
}

async function bootInner() {
  if (window.top !== window.self) {
    // 他サイトに埋め込まれて操作を盗まれる（クリックジャッキング）のを防ぐ
    clear($app, h('p', { class: 'boot' }, 'このアプリは他のページに埋め込んで使えません。'));
    return;
  }
  if (!window.isSecureContext || !crypto?.subtle) {
    clear($app, h('div', { class: 'center-card' }, h('h1', {}, 'Kagibako'),
      h('p', { class: 'error' }, 'このページは安全な接続（https:// または http://localhost）で開いてください。暗号機能が使えません。')));
    return;
  }
  // PC版・Android版：0.9.3 までは WebView の保存場所に置いていた設定・端末内の控えなどを、一度だけ本体のファイルへ写す
  // （WebView の保存場所が応えなくても、待ち続けずに進む）
  setBootStep('前の版のアプリの設定などの引き継ぎ');
  const migrated = await store.migrateFromBrowserStorage().catch(() => 'failed');
  // アプリの設定などが読めなくても止めない：store が初期値を返し、onMemoProblem で知らせる
  setBootStep('アプリの設定などの読み込み');
  loadSettings(await store.getSetting('settings', {}));
  setBootStep('設定を画面に当てはめる');
  if (!settings.deviceName) settings.deviceName = guessDevice();
  applyFontScale();
  setBootStep('起動の準備');
  if (migrated === 'migrated' && host.isDesktop) toast('前の版の設定と端末内の控えを、Kagibako のフォルダの中（data）へ移しました。「最近使ったファイル」は、一度［ファイルを開く］で開き直してください。', 9000);
  else if (migrated === 'failed') toast(`前の版のアプリの設定などを引き継げませんでした（次の起動でもう一度試します）。${KAGI_SAFE}`, 9000);
  if (host.isDesktop) {
    // PC版はファイルが最初から手元にあるので、オフライン用の仕組み（Service Worker）は使わない。前の版で登録したものは外す
    navigator.serviceWorker?.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
    globalThis.caches?.keys?.().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
  } else if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  for (const ev of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true });
  setInterval(checkAutoLock, 10_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && settings.lockOnHide && S.screen === 'main') lock();
  });
  addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  // PC版：パスワード欄と、URL・メールなど日本語を打たない欄（data-ascii）に入ったら日本語入力をオフにする
  // （Windows では、パスワード欄でも日本語入力が効いてしまうことがある）
  if (host.isDesktop) {
    document.addEventListener('focusin', (e) => {
      if (e.target instanceof HTMLInputElement && (e.target.type === 'password' || e.target.dataset.ascii)) host.call('imeOff').catch(() => {});
    });
  }
  if (!host.isDesktop && navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if (host.isDesktop) {
    // 起動のときは本体の返事を長く待たない（返事が無くても画面は出す。ホットキーなどの設定は、設定を保存し直せば届く）
    setBootStep('PC 版の本体とのやり取り');
    try { hostInfo = await host.call('hello', {}, 5000); } catch { /* 旧版ホスト */ }
    host.on('hotkey', onHotkey);
    host.on('systemLock', () => { if (S.screen === 'main') lock(); }); // Windows のロック・スリープ・サインアウト
    host.on('minimized', () => { if (settings.lockOnHide && S.screen === 'main') lock(); });
    addEventListener('focus', refreshTargetLabels);
    await applyHostConfig(true, 5000);
  }
  if (host.isAndroid) {
    document.body.classList.add('native-insets'); // ステータスバー等の余白はアプリ側で確保済み
    setBootStep('アプリ本体とのやり取り');
    try { hostInfo = await host.call('hello', {}, 5000); } catch { /* 無視 */ }
    // 自動入力の設定画面から戻ってきたら状態を更新
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.screen === 'start') renderStart(); });
  }
  setBootStep('アプリの設定など（同意）の読み込み');
  const agreed = (await store.getSetting('disclaimerAccepted', 0)) >= DISCLAIMER_VERSION;
  setBootStep('前回のファイルを開く');
  if (agreed && settings.openLastOnStart !== false && (await openLastFile())) return;
  setBootStep('最初の画面を出す');
  renderStart();
  if (!agreed) await disclaimerDialog(true);
}

// アプリの設定など（設定・最近使ったファイルの一覧・端末内の控え・下書き）が読めない／壊れていた／書けないとき：
// 止めずに、一度だけ知らせる。ID・パスワードの入った .kagi ファイルとは別のものなので、ファイルの開く・見る・保存はそのまま使える
const memoProblemShown = new Set();
store.onMemoProblem((kind, e) => {
  if (memoProblemShown.has(kind)) return;
  memoProblemShown.add(kind);
  if (kind === 'write') {
    toast(`アプリの設定などを保存できませんでした（${errText(e)}）。${KAGI_SAFE}.kagi ファイルへの保存には影響ありません。`, 12000);
    return;
  }
  const what = kind === 'broken'
    ? [h('p', {}, `${MEMO_WHAT}の一部が壊れていたので、その部分を初期値に戻しました。`),
      h('p', { class: 'muted small path-text' }, `壊れていたものは消さずに、次の場所へ移してあります：${errText(e)}`)]
    : [h('p', {}, `${MEMO_WHAT}を読めませんでした。設定は初期値で動きます。古い版での上書きを見つける仕組みは、今は働きません。`),
      h('p', { class: 'muted small path-text' }, `理由：${errText(e)}`)];
  modal({
    title: 'アプリの設定などを読めませんでした',
    body: [h('p', { class: 'info-box' }, KAGI_SAFE + 'ファイルはいつもどおり開いて、見て、保存できます。'), ...what,
      h('p', { class: 'muted small' }, `何度も出るときは［アプリの設定などを初期化］で空にしてやり直せます（${KAGI_UNTOUCHED}）。`)],
    buttons: [{ label: 'アプリの設定などを初期化', value: 'reset' }, { label: 'このまま使う', value: null, kind: 'primary' }],
  }).then((v) => { if (v === 'reset') resetMemoFlow(); });
});

async function applyHostConfig(quiet = false, timeoutMs = 60_000) {
  if (!host.isDesktop) return;
  try {
    await host.call('topMost', { on: !!settings.topMost }, timeoutMs).catch(() => {});
    await host.call('config', { hotkey: settings.hotkey, closeToTray: settings.closeToTray, minimizeToTray: settings.minimizeToTray !== false }, timeoutMs);
  } catch (e) {
    if (!quiet) throw e;
    toast(e.message, 6000);
  }
}

function checkAutoLock() {
  if (S.screen !== 'main' || !settings.autoLockMin) return;
  // ダイアログを開いたままでもロックする（操作していれば lastActivity が更新されるので、使っている最中にはロックしない）
  if (Date.now() - lastActivity > settings.autoLockMin * 60_000) lock();
}

// ---------------- スタート画面 ----------------
/** ロゴ（金色の「kagibako」。鍵の形の文字） */
const brandLogo = (cls = '') => h('img', { src: 'icons/logo.webp', alt: 'Kagibako', width: 960, height: 245, decoding: 'async', class: `brand-logo ${cls}`.trim() });

async function renderStart() {
  S.screen = 'start';
  const recent = await fio.recentHandles().catch(() => []);
  const known = await store.listKnown().catch(() => []);
  clear($app,
    h('div', { class: 'start' },
      // 紺の帯にロゴと、最初に押すボタンをまとめる
      h('header', { class: 'start-hero' },
        h('h1', {}, brandLogo()),
        h('p', { class: 'hero-lead' }, '鍵箱 ― PC とスマホで使える、自分専用のパスワード管理'),
        h('div', { class: 'start-actions' },
          h('button', { class: 'btn primary big ib', onclick: openFileFlow }, icon('folder-open'), 'ファイルを開く'),
          h('button', { class: 'btn big ib', onclick: createFlow }, icon('new-file'), '新規作成'))),
      host.isAndroid ? await autofillCard({ where: 'start' }) : null,
      recent.length ? h('section', { class: 'card' }, h('h2', {}, '最近使ったファイル（この端末）'),
        h('ul', { class: 'plain-list' }, recent.map((r) => h('li', {},
          h('button', { class: 'link', onclick: async () => { try { const f = await fio.openRecent(r); if (f) beginUnlock(await offerNameFix(f)); } catch (e) { toast(e.message); } } }, r.name),
          h('span', { class: 'muted small' }, fmtDateTime(r.at)),
          h('button', { class: 'icon-btn', title: '一覧から外す', 'aria-label': '一覧から外す', onclick: async () => { await fio.forgetRecent(r.key); renderStart(); } }, icon('close')))))) : null,
      known.length ? h('section', { class: 'card' }, h('h2', {}, 'この端末に残っている版（暗号化済みの控え）'),
        h('p', { class: 'muted small' }, 'クラウドのファイルが古くなった・壊れた時の復旧用です。開くにはパスワードが必要です。'),
        h('ul', { class: 'plain-list' }, known.map((k) => h('li', {},
          h('button', { class: 'link', onclick: () => openSnapshotFlow(k, k.snapshots[0]) }, fio.cleanFileName(k.name) || k.key),
          h('span', { class: 'muted small' }, `第${k.head?.revision ?? '?'}版 / ${fmtDateTime(k.head?.savedAt)} / ${k.head?.device || ''}`),
          h('button', { class: 'icon-btn', title: 'この端末から削除', 'aria-label': 'この端末から削除', onclick: async () => {
            if (await confirmDialog('端末内の控えを削除', `「${k.name}」の控え（${k.snapshots.length}版）をこの端末から削除します。クラウドなどのファイルは削除されません。`, '削除', true)) { await store.deleteKnown(k.key); renderStart(); }
          } }, icon('close')))))) : null,
      h('section', { class: 'card muted small' },
        h('h2', {}, '使い方'),
        h('ol', {},
          h('li', {}, 'データは .kagi ファイル（Argon2id + AES-256-GCM で暗号化）に保存します。'),
          h('li', {}, 'スマホとはクラウド（Google ドライブ・OneDrive・iCloud 等）にファイルを置いて受け渡しします。'),
          h('li', {}, '開いたファイルがこの端末で扱った版より古いと「デグレ」として警告し、新しい版へ戻せます。')),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn ib', onclick: () => helpDialog(HOWTO) }, icon('help'), '使い方を見る'),
          h('button', { class: 'btn ib', onclick: () => helpDialog(FAQ) }, icon('faq'), 'よくある質問')),
        h('p', {}, `端末名: ${settings.deviceName}　`, h('button', { class: 'link', onclick: () => settingsDialog().then(renderStart) }, '設定'), `　v${APP_VERSION}`)),
      h('section', { class: 'card safety-card' },
        h('h2', { class: 'inline-ic' }, icon('shield'), '偽サイト・詐欺から身を守るために'),
        h('p', { class: 'small' }, 'メールや SMS のリンクからはログインせず、Kagibako に登録した URL（「公式サイトを開く」）やブックマークから開きましょう。'),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn', onclick: guideDialog }, '安全ガイドを読む'),
          h('button', { class: 'btn', onclick: () => disclaimerDialog(false) }, '免責事項')))));
}

async function openFileFlow() {
  try {
    const f = await fio.pickFile();
    if (f) beginUnlock(await offerNameFix(f));
  } catch (e) {
    toast(`開けませんでした: ${e.message}`);
  }
}

/**
 * Android版：ファイル名に余計な .txt が付いていたら（x.kagi.txt）、本当の名前を直すか聞く。
 * そのままだと、PC に戻したときもメモ帳のファイルとして扱われる
 */
async function offerNameFix(f) {
  const hd = f?.handle;
  if (!host.isAndroid || !hd?.android || !fio.hasExtraTxt(hd.name)) return f;
  const clean = fio.cleanFileName(hd.name);
  const v = await modal({
    title: 'ファイル名に「.txt」が付いています',
    body: [h('p', { class: 'pre' }, `「${hd.name}」

PC から受け渡すときに「.txt」が付いたようです（中身はそのままで、問題なく開けます）。
このままだと、PC に戻したときに Kagibako ではなくメモ帳のファイルとして扱われます。

名前を「${clean}」に直しますか？`)],
    buttons: [{ label: 'このまま開く', value: null }, { label: `「${clean}」に直す`, value: 'fix', kind: 'primary' }],
  });
  if (v !== 'fix') return f;
  try {
    const next = await fio.renameAndroidFile(hd, clean);
    toast(`名前を「${next.name}」に直しました`);
    return { ...f, name: fio.cleanFileName(next.name), handle: next };
  } catch (e) {
    await modal({ title: '名前を変えられませんでした', body: [h('p', { class: 'pre' }, `この保存場所では、アプリから名前を変えられないようです（${errText(e)}）。

Google ドライブなどのアプリで「${hd.name}」を「${clean}」に名前を変えてから、もう一度開いてください。今回はこのまま開きます。`)] });
    return f;
  }
}

function detectKind(bytes) {
  const head = new TextDecoder().decode(bytes.subarray(0, 64));
  if (/^\s*\{/.test(head)) return 'kagi';
  if (L.looksLikeLegacy(bytes)) return 'legacy';
  return null;
}

// ---------------- ロック解除 ----------------
/** ロック解除の画面の下段：別のファイル・新規作成 */
function unlockAltLinks() {
  return h('div', { class: 'unlock-alt' },
    h('button', { class: 'link', type: 'button', onclick: () => { wipeSession(); openFileFlow(); } }, '別のファイルを開く'),
    h('button', { class: 'link', type: 'button', onclick: () => { wipeSession(); createFlow(); } }, '新規作成'),
    h('button', { class: 'link', type: 'button', onclick: () => { wipeSession(); renderStart(); } }, '最初の画面へ'));
}

/**
 * 起動したら、前回開いたファイルのパスワード入力画面を出す（設定「起動したら前回のファイルを開く」）。
 * 画面を出したら true。前回のファイルが無い・読めないときは false（最初の画面を出す）
 */
async function openLastFile() {
  const r = (await fio.recentHandles().catch(() => []))[0];
  if (!r) return false;
  try {
    if (await fio.canReadWithoutAsking(r)) {
      const f = await fio.openRecent(r);
      if (!f) return false;
      await beginUnlock(f);
      return S.screen === 'unlock';
    }
  } catch { return false; }
  // PC版など：ファイルを読むのに一度押してもらう必要がある。パスワードを先に入れてもらい、［ロック解除］で読む
  quickUnlock(r);
  return true;
}

function quickUnlock(entry) {
  S.screen = 'unlock';
  const pw = h('input', { type: 'password', autocomplete: 'current-password', spellcheck: 'false', 'aria-label': 'パスワード' });
  const err = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'ロック解除');
  const form = h('form', { class: 'center-card', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    btn.disabled = true;
    try {
      const f = await fio.openRecent(entry);
      if (!f) throw new Error('ファイルを読めませんでした');
      await beginUnlock(f, { presetPassword: pw.value });
    } catch (ex) {
      err.textContent = `ファイルを開けませんでした（${errText(ex)}）。移動・削除されていないか確かめてください。`;
      btn.disabled = false;
    }
  } },
  h('div', { class: 'card-band' }, brandLogo('card-logo')),
  h('h1', {}, 'ロック解除'),
  h('p', { class: 'filename' }, entry.name),
  h('p', { class: 'muted small' }, '前回開いたファイル'),
  h('label', { class: 'field' }, h('span', {}, 'パスワード'), pw),
  capsWarning(pw),
  err,
  h('div', { class: 'row unlock-btns' }, btn),
  unlockAltLinks());
  clear($app, form);
  pw.focus();
}

async function beginUnlock(file, { afterLock = false, presetPassword = null } = {}) {
  const kind = detectKind(file.bytes);
  if (!kind) { toast('Kagibako のファイル（.kagi）ではないようです'); return; }
  file.kind = kind;
  let env = null, pre = null;
  if (kind === 'kagi') {
    try { env = X.parseEnvelope(new TextDecoder().decode(file.bytes)); }
    catch (e) { toast(e.message); return; }
    file.env = env;
    const known = await store.getKnown(store.knownKeyFor({ kind, header: env.header }));
    pre = classifyVault(env.header, known);
  }
  S.screen = 'unlock';
  const pw = h('input', { type: 'password', autocomplete: 'current-password', spellcheck: 'false', 'aria-label': 'パスワード' });
  const err = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'ロック解除');
  // Android：指紋・顔でのロック解除（ファイルごと。設定はロック解除の後に聞く）
  const bioKey = store.knownKeyFor({ kind, header: env?.header, fileName: file.name });
  let usedBio = false;
  const bioBtn = h('button', { class: 'btn ib', type: 'button', hidden: true, onclick: () => tryBio() }, icon('fingerprint'), '指紋・顔で開く');
  const tryBio = async () => {
    try {
      const r = await host.call('bioUnlock', { key: bioKey }, 0);
      pw.value = r.password;
      usedBio = true;
      form.requestSubmit();
    } catch (ex) {
      const m = errText(ex);
      if (m === 'invalidated') { bioBtn.hidden = true; err.textContent = '指紋や顔の登録が変わったため、安全のため指紋・顔でのロック解除を止めました。パスワードで開いてください（開いた後に設定し直せます）。'; }
      else if (m !== 'cancelled') err.textContent = '指紋・顔で開けませんでした。パスワードで開いてください。';
    }
  };
  const form = h('form', { class: 'center-card', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    btn.disabled = true; btn.textContent = '鍵を生成中…';
    const typed = !usedBio;
    const password = pw.value;
    try {
      await unlock(file, password, { afterLock });
      if (host.isAndroid && typed) await offerBioEnroll(bioKey, password);
      await maybeShowTutorial(); // スマホ：はじめての方に1回だけ使い方の案内（2回目からは出ない）
    } catch (ex) {
      if (usedBio && ex.name === 'WrongPasswordError') {
        // 保存していたパスワードが古い（PC でマスターパスワードを変えた など）
        host.call('bioRemove', { key: bioKey }).catch(() => {});
        bioBtn.hidden = true;
        err.textContent = 'マスターパスワードが変わったようです。パスワードで開いてください（開いた後に、指紋・顔での解除を設定し直せます）。';
        usedBio = false;
        btn.disabled = false; btn.textContent = 'ロック解除';
        pw.value = '';
        return;
      }
      usedBio = false;
      err.textContent = ex.name === 'WrongPasswordError' ? ex.message : `エラー: ${ex.message}`;
      btn.disabled = false; btn.textContent = 'ロック解除';
      pw.select();
    }
  } },
  h('div', { class: 'card-band' }, brandLogo('card-logo')),
  h('h1', { class: 'inline-ic' }, afterLock ? [icon('lock'), 'ロック中'] : 'ロック解除'),
  h('p', { class: 'filename' }, file.name),
  h('p', { class: 'muted small' }, kind === 'kagi' ? '.kagi' : '.idm 形式（読み込みのみ。保存すると .kagi 形式になります）'),
  env ? h('div', { class: `status-box st-${pre}` },
    h('div', {}, `第${env.header.revision}版 / 保存 ${fmtDateTime(env.header.savedAt)} / 端末: ${env.header.device || '不明'}`),
    h('div', {}, STATUS_TEXT[pre])) : null,
  h('label', { class: 'field' }, h('span', {}, 'パスワード'), pw),
  capsWarning(pw),
  err,
  h('div', { class: 'row unlock-btns' }, afterLock ? h('button', { class: 'btn', type: 'button', onclick: () => { wipeSession(); renderStart(); } }, '閉じる') : null, bioBtn, btn),
  unlockAltLinks());
  clear($app, form);
  pw.focus();
  // 起動時の画面でパスワードを先に入れてもらった場合は、そのまま開く
  if (presetPassword) { pw.value = presetPassword; form.requestSubmit(); }
  if (host.isAndroid) {
    host.call('bioStatus', { key: bioKey }).then((st) => {
      if (st?.status === 'ok' && st.enrolled && S.screen === 'unlock') { bioBtn.hidden = false; tryBio(); } // 設定済みなら、すぐ指紋・顔の画面を出す
    }).catch(() => {});
  }
}

/** Android：パスワードで開いた後、次から指紋・顔で開けるようにするか聞く（「今後聞かない」も選べる） */
const bioAskedThisSession = new Set();
async function offerBioEnroll(key, password) {
  const st = await host.call('bioStatus', { key }).catch(() => null);
  if (!st || st.status !== 'ok' || st.enrolled || bioAskedThisSession.has(key)) return;
  const declined = await store.getSetting('bioDeclined', {});
  if (declined[key]) return;
  bioAskedThisSession.add(key);
  const v = await modal({
    title: '👆 指紋・顔で開けるようにしますか？',
    body: [
      h('p', {}, '次からは、マスターパスワードを入れずに指紋や顔でこのファイルを開けます（出先ですぐ確かめたいときに便利です）。'),
      h('p', { class: 'muted small' }, 'パスワードは、この端末のセキュリティ領域にある鍵で暗号化して保存し、指紋や顔が通ったときだけ取り出します。指紋や顔を追加・削除すると使えなくなり、パスワードで開き直すことになります。設定はあとから「設定」で取り消せます。')],
    buttons: [{ label: '今後聞かない', value: 'never' }, { label: '今はしない', value: null }, { label: '指紋・顔で開けるようにする', value: 'yes', kind: 'primary' }],
  });
  if (v === 'never') { declined[key] = true; await store.setSetting('bioDeclined', declined); return; }
  if (v !== 'yes') return;
  try {
    await host.call('bioEnroll', { key, password }, 0);
    toast('次から指紋・顔で開けます');
  } catch (e) {
    if (errText(e) !== 'cancelled') toast(`設定できませんでした（${errText(e)}）`, 5000);
  }
}

async function unlock(file, password, { afterLock }) {
  let vault, header = null, session, legacyKey = null;
  if (file.kind === 'kagi') {
    const r = await X.decryptEnvelope(file.env, password);
    vault = r.vault; header = r.header; session = r.session;
  } else {
    legacyKey = L.legacyKey(password);
    vault = L.legacyXmlToVault(L.decryptLegacy(file.bytes, legacyKey));
    // 端末内の控え用の鍵（以前の控えと同じソルトを使う）
    const known = await store.getKnown(store.knownKeyFor({ kind: 'legacy', fileName: file.name }));
    let kdf = null;
    if (known?.snapshots?.[0]) { try { kdf = X.parseEnvelope(known.snapshots[0].fileText).kdf; } catch { kdf = null; } }
    session = await X.deriveSession(password, kdf);
  }
  normalizeVault(vault);
  Object.assign(S, { file, kind: file.kind, vault, header, session, legacyKey, dirty: false, sel: null, search: '', reveal: new Set(), banner: null, mobileDetail: false, expiryShown: false });
  S.knownKey = store.knownKeyFor({ kind: file.kind, header, fileName: file.name });
  await restoreSelection();
  await afterOpen({ afterLock, password });
}

function normalizeVault(v) {
  v.tombstones ||= [];
  v.defaults ||= { accountName: 'Account ID', passwordName: 'Password', item1Name: '', item2Name: '' };
  v.profile ||= {};
  v.children ||= [];
  for (const { node } of M.walk(v.children)) {
    if (!node.id) node.id = M.uuid();
    if (node.type === 'item') {
      node.extra ||= [];
      node.passwordHistory ||= [];
      node.maskFields ||= [];
      node.autoType ??= '';
    } else node.children ||= [];
  }
}

// スナップショット（端末内の控え）を作る
async function makeSnapshot() {
  const hash = await M.contentHash(S.vault);
  if (S.kind === 'kagi' && S.file?.env) {
    return { revId: S.header.revId, revision: S.header.revision, savedAt: S.header.savedAt, device: S.header.device, lineage: S.header.lineage, contentHash: hash, fileText: new TextDecoder().decode(S.file.bytes) };
  }
  const known = await store.getKnown(S.knownKey);
  const prev = known?.snapshots?.[0] ? safeHeader(known.snapshots[0].fileText) : null;
  const r = await X.encryptVault(S.vault, S.session, { prevHeader: prev, device: settings.deviceName });
  return { revId: r.header.revId, revision: r.header.revision, savedAt: S.file?.lastModified ? new Date(S.file.lastModified).toISOString() : r.header.savedAt, device: S.kind === 'legacy' ? `${settings.deviceName}（.idm）` : settings.deviceName, lineage: r.header.lineage, contentHash: hash, fileText: r.text };
}

function safeHeader(text) {
  try { return X.parseEnvelope(text).header; } catch { return null; }
}

async function recordCurrent() {
  if (!S.knownKey) return null;
  try {
    const snap = await makeSnapshot();
    await store.recordHead(S.knownKey, S.file?.name, snap);
    return snap;
  } catch (e) {
    console.warn('snapshot failed', e);
    return null;
  }
}

// ---------------- デグレ検出 ----------------
async function afterOpen({ afterLock, password }) {
  if (S.file.unsavedDraft || S.file.fromSnapshot) {
    // 未保存の下書き・端末内の控えを開いた場合は記録しない（保存時に「名前を付けて保存」）
    if (S.file.fromSnapshot) S.banner = '端末内の控えを開いています。保存するとファイルとして書き出します（クラウドのファイルを置き換える場合はアップロードしてください）。';
    renderMain();
    await offerDraftRestore();
    return;
  }
  // 開いたことを記録（自動入力で最初に選ぶデータを、最後に開いたファイルにする）
  await store.markOpened(S.knownKey).catch(() => {});
  const known = await store.getKnown(S.knownKey);
  const hash = await M.contentHash(S.vault);
  const status = S.kind === 'kagi' ? classifyVault(S.header, known) : classifyLegacy(hash, known);

  if (status === 'same' || status === 'unknown' || status === 'newer') {
    if (status !== 'same') await recordCurrent();
    renderMain();
    if (status === 'newer') toast('他の端末で更新された新しい版を開きました');
    await offerDraftRestore();
    return;
  }

  const devHead = known.head;
  const fileInfo = S.kind === 'kagi'
    ? `第${S.header.revision}版 / ${fmtDateTime(S.header.savedAt)} / ${S.header.device || '不明'}`
    : `ファイル更新日時 ${fmtDateTime(S.file.lastModified)}`;
  const devInfo = `第${devHead.revision}版 / ${fmtDateTime(devHead.savedAt)} / ${devHead.device || ''}`;
  const body = [
    h('p', { class: 'pre' }, STATUS_TEXT[status]),
    h('table', { class: 'kv' },
      h('tr', {}, h('th', {}, '開いたファイル'), h('td', {}, fileInfo)),
      h('tr', {}, h('th', {}, 'この端末の最新'), h('td', {}, devInfo))),
  ];
  let buttons;
  if (status === 'older') {
    body.push(h('p', { class: 'warn' }, 'クラウドへのアップロード漏れや、古いファイルでの上書きが疑われます。この端末に残っている新しい版を使うことをおすすめします。'));
    buttons = [
      { label: '古いファイルのまま開く', value: 'file' },
      { label: '比較して統合', value: 'merge' },
      { label: 'この端末の新しい版を使う', value: 'device', kind: 'primary' },
    ];
  } else {
    body.push(h('p', {}, '両方に別々の変更がある可能性があります。比較して、項目ごとに正しい方を選んで統合できます。'));
    buttons = [
      { label: 'この端末の版を使う', value: 'device' },
      { label: '開いたファイルで続ける', value: 'file' },
      { label: '比較して統合', value: 'merge', kind: 'primary' },
    ];
  }
  const choice = await modal({ title: status === 'older' ? '⚠ 古い版（デグレ）を検出しました' : '⚠ 別々に編集された版です', body, buttons, dismissable: false });

  if (choice === 'file') {
    if (status === 'older') S.banner = 'この端末で扱った版より古いファイルを開いています。保存すると新しい内容が失われる可能性があります。';
    else await recordCurrent();
    renderMain();
  } else {
    const dev = await loadSnapshot(known.snapshots[0], password);
    if (!dev) { renderMain(); return; }
    if (choice === 'device') {
      S.vault = dev.vault;
      normalizeVault(S.vault);
      if (S.kind === 'kagi') S.header = dev.header;
      markDirty();
      S.banner = 'この端末の新しい版に置き換えました。保存して、クラウドのファイルも更新してください。';
      renderMain();
    } else {
      renderMain();
      let base = null;
      if (status === 'older') base = M.cloneVault(S.vault); // 開いたファイル自体が共通の祖先
      else if (S.kind === 'kagi') base = await findAncestorVault(S.header, dev.header);
      await mergeDialog(dev.vault, { labelA: '開いたファイル', labelB: 'この端末の版', newer: status === 'older' ? 'b' : null, base, otherHeader: dev.header });
    }
  }
  await offerDraftRestore();
}

async function loadSnapshot(snap, password = null) {
  try {
    const env = X.parseEnvelope(snap.fileText);
    if (S.session && env.kdf.salt === S.session.kdf.salt) {
      try { return await X.decryptWithSession(env, S.session); } catch { /* パスワード変更前の版など */ }
    }
    if (password) {
      try { return await X.decryptEnvelope(env, password); } catch { /* fallthrough */ }
    }
    let result = null;
    const pw = await passwordPrompt('端末内の版を開く', 'この版を保存したときのパスワードを入力してください。', {
      check: async (p) => { result = await X.decryptEnvelope(env, p); return true; },
    });
    return pw ? result : null;
  } catch (e) {
    toast(`端末内の版を読み込めません: ${e.message}`);
    return null;
  }
}

/** 共通の元の版（3方向比較用）を端末内の控えから探す。見つからなければ null（パスワードは聞かない） */
async function findAncestorVault(hA, hB, key = S.knownKey) {
  if (!hA || !hB || !key) return null;
  const inA = new Set([...(hA.lineage || []), hA.revId]);
  const inB = new Set([...(hB.lineage || []), hB.revId]);
  const k = await store.getKnown(key);
  for (const s of k?.snapshots || []) {
    if (!inA.has(s.revId) || !inB.has(s.revId)) continue;
    try { return (await X.decryptWithSession(X.parseEnvelope(s.fileText), S.session)).vault; } catch { /* 別パスワード */ }
  }
  return null;
}

/** いま開いているファイルの「開いた時点（最後に保存した時点）」の内容 */
async function openedVersion() {
  try {
    if (S.kind === 'kagi' && S.file?.env) return (await X.decryptWithSession(S.file.env, S.session)).vault;
    if (S.kind === 'legacy' && S.file?.bytes && S.legacyKey) return L.legacyXmlToVault(L.decryptLegacy(S.file.bytes, S.legacyKey));
  } catch { /* 取得できなければ2方向比較 */ }
  return null;
}

async function openSnapshotFlow(known, snap) {
  const env = safeHeader(snap.fileText) ? X.parseEnvelope(snap.fileText) : null;
  if (!env) { toast('控えが壊れています'); return; }
  const isLegacy = known.key.startsWith('legacy:');
  const name = isLegacy ? known.name.replace(/\.idm$/i, '') + '（端末内の控え）.kagi' : known.name;
  // 控えは .kagi 形式。保存時は「名前を付けて保存」になる
  beginUnlock({ name, bytes: new TextEncoder().encode(snap.fileText), handle: null, lastModified: Date.parse(snap.savedAt) || Date.now(), fromSnapshot: true });
}

// ---------------- 新規作成 ----------------
async function createFlow() {
  const name = h('input', { type: 'text', value: 'passwords', spellcheck: 'false' });
  const pw = h('input', { type: 'password', autocomplete: 'new-password' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const meter = h('div', { class: 'meter' });
  const err = h('p', { class: 'error' });
  pw.addEventListener('input', () => {
    const bits = estimateBits(pw.value);
    const [label, cls] = strengthLabel(bits);
    meter.className = `meter ${cls}`;
    meter.textContent = pw.value ? `強度: ${label}（約${bits}bit）` : '';
  });
  const ok = await modal({
    title: '新しいデータファイルを作成',
    body: [
      h('label', { class: 'field' }, h('span', {}, 'ファイル名'), h('div', { class: 'row' }, name, h('span', {}, '.kagi'))),
      h('label', { class: 'field' }, h('span', {}, 'マスターパスワード'), pw), capsWarning(pw), meter,
      h('label', { class: 'field' }, h('span', {}, 'マスターパスワード（確認）'), pw2),
      h('p', { class: 'muted small' }, '忘れると誰にも復元できません。長いフレーズ（例: 4単語以上）がおすすめです。'),
      h('p', { class: 'muted small' }, '［作成］のあと、ファイルの保存先を選びます。'), err],
    buttons: [{ label: 'キャンセル', value: false }, { label: '作成', value: true, kind: 'primary', validate: () => {
      err.textContent = '';
      if (!name.value.trim()) { err.textContent = 'ファイル名を入力してください'; return false; }
      if (pw.value.length < 8) { err.textContent = 'パスワードは8文字以上にしてください'; return false; }
      if (pw.value !== pw2.value) { err.textContent = '確認用のパスワードが一致しません'; return false; }
      return true;
    } }],
  });
  if (!ok) return;
  clear($app, h('div', { class: 'center-card' }, h('p', {}, '鍵を生成中…')));
  const session = await X.deriveSession(pw.value);
  const vault = M.newVault();
  const f = M.newFolder('未分類');
  vault.children.push(f);
  Object.assign(S, { file: { name: `${name.value.trim()}.kagi`, bytes: null, handle: null, kind: 'kagi' }, kind: 'kagi', vault, header: null, session, legacyKey: null, knownKey: null, dirty: true, sel: f.id, banner: null, reveal: new Set(), mobileDetail: false });
  renderMain();
  // 作った時点でファイルにする（保存先を選んでもらう）。ファイルになれば、次に起動したとき「前回のファイル」として開ける
  const password = pw.value;
  pw.value = ''; pw2.value = '';
  await save();
  if (!S.file?.bytes) { toast('まだファイルになっていません。［保存］で書き出してください', 6000); await maybeShowTutorial(); return; }
  // Android：その場で「指紋・顔で開けるようにしますか？」を聞く（作るときに入れたパスワードを使う。次に開くときまで待たせない）
  if (host.isAndroid && S.knownKey) await offerBioEnroll(S.knownKey, password);
  await maybeShowTutorial(); // スマホ：はじめての方に1回だけ使い方の案内
}

// ---------------- メイン画面 ----------------
let $tree, $detail, $layout, $mbar;

/** 閲覧のみなら知らせて true を返す（編集系の操作の先頭で使う） */
function editLocked() {
  if (!settings.readOnly) return false;
  toast(isPhone() ? '「閲覧のみ」になっています。書き換えるときは ☰ メニュー →「表示」の「閲覧のみにする」を外してください'
    : '「閲覧のみ」になっています。画面右上の［✏️ 編集］を押すと書き換えられます（Ctrl+E）');
  return true;
}

function toggleReadOnly() {
  settings.readOnly = !settings.readOnly;
  store.setSetting('settings', { ...settings });
  renderMain();
  toast(settings.readOnly ? '閲覧のみにしました（表示・コピー・入力だけ。書き換えはできません）' : '編集できるようにしました');
}

function expiredItems() {
  return M.listItems(S.vault).filter((e) => M.isExpired(e.node));
}

/** 期限切れ＋（設定した日数以内に）期限が来るアイテム */
function expiringItems() {
  return M.listItems(S.vault).filter((e) => M.isExpired(e.node) || M.isExpiringSoon(e.node, settings.expiryWarnDays));
}

function renderMain() {
  S.screen = 'main';
  document.body.classList.toggle('phone', isPhone());
  lastActivity = Date.now();
  const ro = !!settings.readOnly;
  const search = h('input', { type: 'search', class: 'search', placeholder: '検索（タイトル・ID・URL・メモ…）', value: S.search, 'aria-label': '検索',
    oninput: (e) => { S.search = e.target.value; renderTree(); } });
  $tree = h('nav', { class: 'tree', 'aria-label': 'フォルダとアイテム' });
  $detail = h('main', { class: 'detail' });
  $layout = h('div', { class: `layout${S.mobileDetail ? ' show-detail' : ''}${ro ? ' readonly' : ''}` },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'side-tools' },
        h('div', { class: 'row' }, search, isPhone() ? phoneViewToggle() : null, h('button', { class: 'icon-btn', title: '検索条件', 'aria-label': '検索条件', onclick: searchOptionsDialog }, icon('search-options'))),
        isPhone() ? h('div', { class: 'm-crumbs', hidden: true }) : null,
        h('div', { class: 'row wrap tight' },
          ro ? null : ibtn('add-item', '新しいアイテム', addItem, { cls: 'small', title: '新しいアイテムを作る（Ctrl+N。右クリックメニューからも作れます）' }),
          ro ? null : ibtn('add-folder', '新しいフォルダ', () => addFolder(false), { cls: 'small', title: '新しいフォルダを作る（Ctrl+Shift+N）' }),
          ibtn('expand-all', 'ツリーをすべて開く', () => setAllOpen(true), { cls: 'small' }),
          ibtn('collapse-all', 'ツリーをすべて閉じる', () => setAllOpen(false), { cls: 'small' }))),
      $tree,
      splitter()),
    $detail,
    // スマホ：追加の入口はこの［＋］1つ。押すと「アイテム／フォルダ」を選ぶ画面が出る
    isPhone() && !ro ? h('button', { class: 'fab', 'aria-label': '追加（アイテム・フォルダ）', title: '追加（アイテム・フォルダ）', onclick: phoneAddDialog }, '＋') : null);
  $tree.addEventListener('contextmenu', treeContextMenu);
  setupPhoneDrag($tree); // スマホ：長押しのあと指を動かすとドラッグで並べ替え・移動（PC の画面では何もしない）
  setupTreeDnD($tree);
  $tree.addEventListener('keydown', treeArrowKeys);
  $mbar = menuBar();
  clear($app,
    h('header', { class: 'topbar' },
      h('button', { class: 'icon-btn mobile-only back', 'aria-label': '一覧へ戻る', onclick: () => setMobileDetail(false) }, icon('back')),
      brandLogo('bar-logo'),
      $mbar,
      h('div', { class: 'title' },
        h('span', { class: `dirty-dot${S.dirty ? ' on' : ''}`, title: '未保存の変更があります' }),
        // 版数はデグレ（古い版での上書き）を見つけるためのもので、ふだんは見なくてよいので出さない。
        // ファイル名にマウスを乗せると出る（ロック解除の画面と、最初の案内にも出る）
        h('span', { class: 'fname', title: S.kind === 'kagi'
          ? (S.header ? `第${S.header.revision}版（${fmtDateTime(S.header.savedAt)} 保存 / ${S.header.device || '不明'}）` : 'まだ保存していません')
          : '.idm 形式（読み込みのみ）' }, S.file?.name || '無題')),
      // 今の状態の側が光る切り替え（Ctrl+E）。「禁止」という言葉は「禁止されている」と読まれやすいので使わない
      h('div', { class: 'mode-switch', role: 'group', 'aria-label': '編集モード（Ctrl+E で切り替え）' },
        h('button', { class: `seg seg-edit${ro ? '' : ' active'}`, 'aria-pressed': String(!ro), title: '編集：書き換えできます（Ctrl+E で切り替え）', onclick: () => { if (ro) toggleReadOnly(); } }, icon('edit'), h('span', { class: 'seg-text' }, ' 編集')),
        h('button', { class: `seg seg-view${ro ? ' active' : ''}`, 'aria-pressed': String(ro), title: '閲覧のみ：見る・コピー・自動入力だけ。誤って書き換えないように（Ctrl+E で切り替え）', onclick: () => { if (!ro) toggleReadOnly(); } }, icon('view-only'), h('span', { class: 'seg-text' }, ' 閲覧のみ'))),
      ibtn('save', '保存', () => save(), { cls: 'primary', text: '保存', title: '上書き保存（Ctrl+S）' }),
      ibtn('lock', 'ロック', () => lock(), { cls: 'lock-btn', text: 'ロック', title: 'ロック：ファイルを閉じて、マスターパスワードを入れるまで見られなくする（Ctrl+L）' }),
      h('button', { class: 'icon-btn mobile-only', 'aria-label': 'メニュー', title: 'メニュー', onclick: menuDialog }, icon('menu'))),
    S.banner ? h('div', { class: 'banner warn' }, S.banner, h('button', { class: 'icon-btn', 'aria-label': '閉じる', onclick: (e) => { S.banner = null; e.target.closest('.banner').remove(); } }, icon('close'))) : null,
    S.kind === 'legacy' ? h('div', { class: 'banner info' }, '.idm 形式のファイルを開いています（読み込みのみ）。保存すると、暗号の強い .kagi 形式の新しいファイルとして保存されます。') : null,
    ro ? h('div', { class: 'banner info' }, isPhone() ? '👁 閲覧のみモードです。見る・コピーだけができます（書き換えるときは ☰ メニュー → 編集）。' : '👁 閲覧のみモードです。見る・コピー・自動入力だけができます（書き換えるときは右上の［✏️ 編集］）。') : null,
    expiryBanner(),
    $layout);
  applyLayoutSettings();
  // スマホ：検索欄を上の段のすぐ下に固定するため、上の段の高さを覚える
  if (isPhone()) requestAnimationFrame(() => { const tb = document.querySelector('.topbar'); if (tb) document.documentElement.style.setProperty('--m-topbar-h', `${tb.offsetHeight}px`); });
  setMobileDetail(S.mobileDetail && !!S.sel);
  renderTree();
  renderDetail();
  if (settings.expiryNotify === 'dialog' && !S.expiryShown) {
    setTimeout(() => { if (S.screen === 'main' && !document.querySelector('.overlay')) notifyExpiryOnOpen(); }, 150);
  }
  if (pendingHotkey && host.isDesktop) {
    const d = pendingHotkey;
    pendingHotkey = null;
    setTimeout(() => { if (!document.querySelector('.overlay')) hotkeyPicker(d); }, 50);
  }
}

/** Kagibako に戻ってきたとき、自動入力の「入力先」表示を更新する */
async function refreshTargetLabels() {
  const labels = document.querySelectorAll('.target-label');
  if (!labels.length || !host.isDesktop) return;
  try {
    const t = await host.call('getTarget', { which: 'last' });
    for (const el of labels) el.textContent = t.ok ? `入力先: ${t.title || '(タイトルなし)'}` : '入力先: なし（入力したい画面を一度クリックしてください）';
  } catch { /* 無視 */ }
}

// ---- 検索（条件は設定で変更可） ----
const SEARCH_FIELDS = [
  ['name', 'タイトル'], ['account', 'ID'], ['password', 'パスワード'], ['item1', '項目1'], ['item2', '項目2'],
  ['names', '各項目の名前'], ['serialNumber', 'シリアル番号'], ['url', 'URL'], ['email', 'メール'], ['file', 'ファイル'], ['comment', 'メモ'],
];

function itemMatches(it, q) {
  const f = settings.search.fields;
  const parts = [];
  for (const [k] of SEARCH_FIELDS) {
    if (!f[k]) continue;
    if (k === 'names') parts.push(it.accountName, it.passwordName, it.item1Name, it.item2Name);
    else parts.push(it[k]);
  }
  let hay = parts.filter(Boolean).join('\n');
  let words = q.split(/\s+/).filter(Boolean);
  if (!settings.search.caseSensitive) { hay = hay.toLowerCase(); words = words.map((w) => w.toLowerCase()); }
  return words.every((w) => hay.includes(w));
}

async function searchOptionsDialog() {
  const f = { ...settings.search.fields };
  const cs = h('input', { type: 'checkbox', checked: settings.search.caseSensitive });
  const ok = await modal({
    title: '検索条件',
    body: [h('p', { class: 'muted small' }, '検索の対象にする項目'),
      h('div', { class: 'row wrap' }, SEARCH_FIELDS.map(([k, label]) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: f[k], onchange: (e) => { f[k] = e.target.checked; } }), label))),
      h('label', { class: 'check' }, cs, '大文字と小文字を区別する')],
    buttons: [{ label: 'キャンセル', value: false }, { label: 'OK', value: true, kind: 'primary' }],
  });
  if (!ok) return;
  settings.search = { fields: f, caseSensitive: cs.checked };
  await store.setSetting('settings', { ...settings });
  renderTree();
}

function renderTree() {
  if (!$tree) return;
  const q = S.search.trim();
  if (q) {
    const crumbs = document.querySelector('.side-tools .m-crumbs');
    if (crumbs) crumbs.hidden = true;
    const hits = M.listItems(S.vault).filter((e) => itemMatches(e.node, q));
    clear($tree, h('div', { class: 'muted small pad' }, `${hits.length} 件`),
      isPhone() ? h('div', { class: 'm-items' }, hits.map((e) => phoneRow(e.node, e.path.join(' / '))))
        : h('ul', { class: 'flat' }, hits.map((e) => h('li', {}, itemRow(e.node, e.path.join(' / '))))));
    return;
  }
  if (isPhone()) return renderPhoneList();
  // 点線でつながりを示し、フォルダの開け閉めは [＋]／[－] の四角
  const toggle = (n) => { n.open = !n.open; renderTree(); };
  const build = (nodes) => h('ul', { class: 'tl', role: 'group' }, nodes.map((n) => {
    if (n.type === 'item') return h('li', {}, itemRow(n));
    const hasKids = n.children.length > 0;
    const open = n.open && hasKids;
    return h('li', {},
      h('div', { class: `node folder${S.sel === n.id ? ' sel' : ''}`, dataset: { id: n.id }, draggable: treeDraggable() ? 'true' : null },
        hasKids ? h('button', { class: `expander ${open ? 'open' : 'closed'}`, 'aria-label': open ? '閉じる' : '開く', 'aria-expanded': String(open), title: open ? '閉じる' : '開く', onclick: () => toggle(n) }) : null,
        h('button', { class: 'label', onclick: () => select(n.id), ondblclick: () => { if (hasKids) toggle(n); },
          onkeydown: (e) => { if ((e.key === 'ArrowRight' && !open && hasKids) || (e.key === 'ArrowLeft' && open)) { e.preventDefault(); toggle(n); $tree.querySelector(`.node[data-id="${n.id}"] .label`)?.focus(); } } },
          h('span', { class: 'ticon', 'aria-hidden': 'true' }, icon(open ? 'folder-open' : 'folder')), n.name || '(名前なし)')),
      open ? build(n.children) : null);
  }));
  clear($tree, S.vault.children.length ? build(S.vault.children) : h('p', { class: 'muted pad' }, '「＋フォルダ」から始めましょう'));
}

function itemRow(it, sub = null) {
  return h('div', { class: `node item${S.sel === it.id ? ' sel' : ''}`, dataset: { id: it.id }, draggable: treeDraggable() ? 'true' : null },
    h('button', { class: 'label', onclick: () => select(it.id) },
      settings.expiryNotify !== 'off' && M.isExpired(it) ? h('span', { class: 'ticon tstat', title: '有効期限切れ' }, icon('expired'))
        : settings.expiryNotify !== 'off' && M.isExpiringSoon(it, settings.expiryWarnDays) ? h('span', { class: 'ticon tstat', title: `有効期限が近い（${it.expirationDate}）` }, icon('expiring')) : h('span', { class: 'ticon', 'aria-hidden': 'true' }, icon('key')),
      it.name || '(名前なし)',
      sub ? h('span', { class: 'muted small sub' }, sub) : null));
}

function setAllOpen(open) {
  for (const { node } of M.walk(S.vault.children)) if (node.type === 'folder') node.open = open;
  renderTree();
}

/** 選んだフォルダ（未選択・アイテム選択時はその場所）の中を、フォルダ→アイテムの順に名前で並べ替え */
function sortSelected() {
  if (editLocked()) return;
  const e = selected();
  const list = !e ? S.vault.children : e.node.type === 'folder' ? e.node.children : M.containerOf(S.vault, e.parent);
  const coll = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
  list.sort((a, b) => (a.type === b.type ? coll.compare(a.name || '', b.name || '') : a.type === 'folder' ? -1 : 1));
  markDirty();
  renderTree();
  toast('名前の順に並べ替えました');
}

function setMobileDetail(on) {
  S.mobileDetail = on;
  $layout?.classList.toggle('show-detail', on);
  document.body.classList.toggle('detail-open', on);
}

function select(id) {
  // ツリーを操作中（クリック・↑↓）なら、描き直した後も選んだ項目に入力位置を残す（続けて ↑↓ で動けるように）
  const treeHadFocus = !!$tree && $tree.contains(document.activeElement);
  S.sel = id;
  S.reveal = new Set();
  S.mobileEdit = false; // スマホ：アイテムを選んだら、まず「見る」画面
  setMobileDetail(true);
  renderTree();
  renderDetail();
  if (treeHadFocus) $tree.querySelector(`.node[data-id="${id}"] .label`)?.focus({ preventScroll: false });
  rememberSelection(id);
}

/** 最後に選んだアイテムを、ファイルごとに覚える（次に開いたとき同じものを選んだ状態にする） */
async function rememberSelection(id) {
  if (!settings.rememberLast || !S.knownKey) return;
  const map = await store.getSetting('lastSel', {});
  map[S.knownKey] = id;
  await store.setSetting('lastSel', map);
}

async function restoreSelection() {
  if (!settings.rememberLast || !S.knownKey || S.sel) return;
  const id = (await store.getSetting('lastSel', {}))[S.knownKey];
  if (id && M.findById(S.vault, id)) S.sel = id;
}

function selected() {
  return S.sel ? M.findById(S.vault, S.sel) : null;
}

function touch(node) {
  node.modified = Date.now();
  markDirty();
}

function renderDetail() {
  if (!$detail) return;
  const e = selected();
  if (!e) return clear($detail, overview());
  if (e.node.type === 'folder') return clear($detail, folderView(e));
  if (isPhone()) {
    // スマホ：まず「見る」画面（大きな文字と［コピー］）。［編集する］を押したときだけ入力画面
    if (!S.mobileEdit) return clear($detail, phoneItemView(e));
    return clear($detail,
      h('div', { class: 'm-editbar' }, h('span', { class: 'muted small inline-ic' }, icon('edit'), '編集中'),
        h('button', { class: 'btn primary', onclick: () => { S.mobileEdit = false; renderDetail(); } }, '完了')),
      itemView(e));
  }
  return clear($detail, itemView(e));
}

function overview() {
  const c = M.countItems(S.vault);
  const exp = settings.expiryNotify === 'off' ? [] : expiredItems();
  const au = auditItems();
  const auditCard = h('section', { class: `card audit-card small${au.danger.length ? ' is-danger' : au.warn.length ? ' is-warn' : ''}` },
    h('h3', {}, 'URL の点検'),
    h('p', {}, au.danger.length ? `⚠ 偽ドメインに似た URL が ${au.danger.length} 件あります。` : '偽ドメインに似た URL はありません。',
      au.warn.length ? ` 要確認 ${au.warn.length} 件。` : '',
      ` 公式と確認 ${au.ok.length} 件 / URL 未登録 ${au.suggest.length + au.nourl.length} 件（うち公式サイトの候補あり ${au.suggest.length} 件）。`),
    h('button', { class: `btn small${au.danger.length ? ' primary' : ''}`, onclick: urlAuditDialog }, '詳しく点検する'));
  const pwr = HL.analyzePasswords(M.listItems(S.vault));
  const pwWeak = pwr.weak.filter((w) => !w.pin).length;
  const pwCard = h('section', { class: `card audit-card small${pwr.reused.length ? ' is-danger' : pwWeak ? ' is-warn' : ''}` },
    h('h3', {}, 'パスワードの点検'),
    h('p', {}, pwr.reused.length || pwWeak ? `使い回し ${pwr.reusedItems} 件・弱いパスワード ${pwWeak} 件があります。` : '使い回しや弱いパスワードはありません。'),
    h('button', { class: `btn small${pwr.reused.length ? ' primary' : ''}`, onclick: passwordCheckDialog }, '詳しく見る'));
  return h('div', { class: 'pane' },
    h('h2', {}, S.file?.name || '無題'),
    h('table', { class: 'kv' },
      h('tr', {}, h('th', {}, '形式'), h('td', {}, S.kind === 'kagi' ? '.kagi（Argon2id + AES-256-GCM）' : '.idm 形式（Blowfish）')),
      S.header ? h('tr', {}, h('th', {}, '版'), h('td', {}, `第${S.header.revision}版（${fmtDateTime(S.header.savedAt)} / ${S.header.device || '不明'}）`)) : null,
      h('tr', {}, h('th', {}, '件数'), h('td', {}, `フォルダ ${c.folders} / アイテム ${c.items}`)),
      h('tr', {}, h('th', {}, '保存方法'), h('td', {}, S.file?.handle ? 'このファイルに上書き保存' : 'ダウンロード（→クラウドへアップロード）'))),
    auditCard,
    pwCard,
    exp.length ? h('section', {}, h('h3', {}, '有効期限切れ'), h('ul', {}, exp.map((x) => h('li', {}, h('button', { class: 'link', onclick: () => select(x.node.id) }, x.node.name), ` (${x.node.expirationDate})`)))) : null,
    h('section', { class: 'card hint-card small' },
      h('h3', {}, 'はじめに'),
      h('ul', {},
        ...(isPhone() ? [
          h('li', {}, '一覧のアイテムを押すと、ID・パスワードが大きく表示され、［コピー］で貼り付けられます。'),
          h('li', {}, '右下の［＋］でアイテム・フォルダの追加、☰ メニューでそのほかの操作ができます。'),
          h('li', {}, '変更したら［保存］。ファイル名の左の ● は未保存の印です。'),
        ] : [
          h('li', {}, '左のツリーからアイテムを選ぶと、ここに中身が表示されます。'),
          h('li', {}, 'ツリーの上で右クリックすると、新規作成・コピー・削除などのメニューが出ます。'),
          host.isDesktop ? h('li', {}, 'ブラウザのログイン画面で Ctrl + Alt + A（ホットキー）を押すと、アイテムを選んで自動入力できます。') : null,
          h('li', {}, '変更したら［保存］（Ctrl + S）。ファイル名の左の ● は未保存の印です。'),
        ])),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn small ib', onclick: () => helpDialog(HOWTO) }, icon('help'), '使い方'),
        h('button', { class: 'btn small ib', onclick: () => helpDialog(FAQ) }, icon('faq'), 'よくある質問'))));
}

function folderView({ node, parent }) {
  const ro = !!settings.readOnly;
  const name = h('input', { type: 'text', value: node.name, readonly: ro, oninput: (ev) => { node.name = ev.target.value; touch(node); renderTree(); } });
  return h('div', { class: 'pane' },
    h('label', { class: 'field' }, h('span', {}, 'フォルダ名'), name),
    ro ? null : h('div', { class: 'row wrap' },
      // スマホ：アイテムは［＋］と同じくすぐ入力できる画面で開く。フォルダは名前を聞いて作り、この画面のまま（app.js の phoneNewFolder）
      ibtn('add-item', 'このフォルダに新しいアイテム', () => (isPhone() ? phoneNewItem(node.id) : addItem())),
      ibtn('add-folder', 'このフォルダの中にフォルダを作る', () => (isPhone() ? phoneNewFolder(node.id) : addFolder(true))),
      // スマホはこの画面から一覧が見えず、入れ替わったのが分からないので、一覧の長押しメニューの「上へ」「下へ」で動かす
      isPhone() ? null : ibtn('move-up', '上へ移動', () => moveNode(node, parent, -1)),
      isPhone() ? null : ibtn('move-down', '下へ移動', () => moveNode(node, parent, 1)),
      parent ? ibtn('move-top', '最上位へ移動', () => moveFolderToTop(node, parent)) : null,
      ibtn('sort-az', 'このフォルダの中を名前順に並べ替え', sortSelected),
      moveToSelect(node),
      ibtn('delete', 'このフォルダを削除', () => deleteNode(node, parent), { cls: 'danger' })),
    h('p', { class: 'muted small' }, `アイテム ${node.children.filter((c) => c.type === 'item').length} 件`));
}

function moveFolderToTop(node, parent) {
  if (editLocked()) return;
  parent.children.splice(parent.children.indexOf(node), 1);
  S.vault.children.push(node);
  touch(node);
  renderTree(); renderDetail();
  toast('最上位に移動しました');
}

function moveToSelect(node) {
  const opts = [h('option', { value: '' }, '移動先…')];
  if (node.type === 'folder') opts.push(h('option', { value: '#root' }, '（最上位）'));
  for (const { node: f, path } of M.walk(S.vault.children)) {
    if (f.type !== 'folder' || f === node) continue;
    if (node.type === 'folder' && M.findById({ children: node.children }, f.id)) continue; // 自分の子孫には移動不可
    opts.push(h('option', { value: f.id }, [...path, f.name].join(' / ')));
  }
  return h('select', { class: 'move-to', 'aria-label': '別のフォルダへ移動', onchange: (ev) => {
    const target = ev.target.value;
    if (!target || editLocked()) return;
    const loc = M.findById(S.vault, node.id);
    const from = M.containerOf(S.vault, loc.parent);
    from.splice(from.indexOf(node), 1);
    const dest = target === '#root' ? S.vault.children : M.findById(S.vault, target).node.children;
    dest.push(node);
    touch(node);
    renderTree(); renderDetail();
  } }, opts);
}

function itemView({ node: it, parent, path }) {
  const ro = !!settings.readOnly;
  const v = settings.view;
  let refreshFieldBtns = () => {}; // 下で、公式サイト・メール・ファイルのボタンを作ってから中身を入れる
  const set = (k) => (ev) => {
    if (ro) return;
    it[k] = ev.target.value;
    touch(it);
    if (k === 'name') { renderTree(); refreshSitePanel(); }
    if (k === 'url') refreshSitePanel();
    if (k === 'url' || k === 'email' || k === 'file') refreshFieldBtns();
  };
  const textInput = (k, attrs = {}) => h('input', { type: 'text', value: it[k] ?? '', oninput: set(k), readonly: ro, spellcheck: 'false', autocomplete: 'off', ...attrs });
  const copyBtn = (k, label) => ibtn('copy', `${label}をコピー`, () => copyText(it[k], label), { cls: 'small' });
  // PC版：その項目だけを直前のウィンドウへ入力
  const typeBtn = (k, label) => (host.isDesktop ? ibtn('autotype', `${label}を直前のウィンドウに入力`, () => autoTypeItem(it, { useHotkeyTarget: false, template: AT.FIELD_TEMPLATES[k] }), { cls: 'small' }) : null);

  // 伏せ字：設定画面の「マスク表示」（全アイテム共通）か、このアイテムだけの指定（it.maskFields）のどちらかがオンなら伏せる
  const secretRow = (valueKey, nameKey, placeholder, globalMask) => {
    const own = (it.maskFields || []).includes(valueKey);
    const secret = globalMask || own;
    const shown = !secret || S.reveal.has(valueKey);
    // このアイテムだけの伏せ字はチェックボックス1つで切り替える（オフにすればそのまま見える）
    const maskToggle = valueKey === 'password' || globalMask || ro ? null : h('label', {
      class: 'check nowrap mask-check',
      title: 'このアイテムのこの欄を伏せ字（●●●）にする',
    }, h('input', { type: 'checkbox', checked: own, onchange: (e) => {
      const set = new Set(it.maskFields || []);
      if (e.target.checked) set.add(valueKey); else set.delete(valueKey);
      it.maskFields = [...set];
      S.reveal.delete(valueKey);
      touch(it);
      renderDetail();
    } }), '伏字');
    // 一時的に見るボタンは、チェックで切り替えられない欄（パスワード・設定で全体を伏せている欄）だけ
    const revealBtn = secret && !maskToggle ? ibtn(shown ? 'hide' : 'show', shown ? '伏せ字に戻す' : '一時的に表示する', () => { S.reveal.has(valueKey) ? S.reveal.delete(valueKey) : S.reveal.add(valueKey); renderDetail(); }, { cls: 'small' }) : null;
    // 空のときは、何を入れる欄かを薄く出す（項目名の欄と見分けやすくする）
    const val = h('input', { type: shown ? 'text' : 'password', value: it[valueKey] ?? '', oninput: set(valueKey), readonly: ro, spellcheck: 'false', autocomplete: 'off', 'aria-label': it[nameKey] || placeholder,
      placeholder: ro ? null : `ここに${it[nameKey] || placeholder}を入力` });
    // パスワードを表示しているときは、読み間違えないよう文字の種類ごとに色分けした行を添える
    const colored = valueKey === 'password' && secret && shown && settings.colorChars !== false && it.password
      ? h('div', { class: 'pw-colored mono', title: '文字の種類ごとの色分け（設定で変更できます）' }, charSpans(it.password)) : null;
    if (colored) val.addEventListener('input', () => clear(colored, ...charSpans(it.password)));
    if (valueKey === 'password') {
      // 変更前のパスワードを履歴に残す（入力中ではなく、確定したときに1回だけ）
      let before = it.password;
      val.addEventListener('focus', () => { before = it.password; });
      val.addEventListener('change', () => {
        if (before && before !== it.password) { M.pushPasswordHistory(it, before); before = it.password; refreshHistoryBtn(); }
      });
    }
    // 項目名（Account ID など）。PC は見出しのように見せた入力欄（マウスを乗せると点線）。
    // スマホは押すと入力欄になって値の欄と見分けにくいので、ただの見出しにし、書き換えは横の［鉛筆］から
    const nameEl = isPhone()
      ? h('div', { class: 'flabel fname-phone' }, h('span', {}, it[nameKey] || placeholder),
        ro ? null : ibtn('edit', '項目名を変える', () => renameFieldDialog(it, nameKey, placeholder), { cls: 'small fname-edit' }))
      : h('input', { type: 'text', class: 'fname-input', value: it[nameKey] ?? '', placeholder, oninput: set(nameKey), readonly: ro, 'aria-label': `${placeholder}の名前` });
    return [h('div', { class: 'frow' },
      nameEl,
      val,
      h('div', { class: 'fbtns' },
        revealBtn,
        copyBtn(valueKey, it[nameKey] || placeholder),
        typeBtn(valueKey, it[nameKey] || placeholder),
        maskToggle,
        valueKey === 'password' && !ro ? ibtn('generate', 'パスワードを作る', () => generatorDialog(it), { cls: 'small' }) : null,
        valueKey === 'password' ? historyBtn : null)),
    colored];
  };

  const historyBtn = h('button', { class: 'btn small ib icon-only', title: '変更前のパスワード（履歴）', 'aria-label': '変更前のパスワード（履歴）', onclick: () => passwordHistoryDialog(it) });
  const refreshHistoryBtn = () => {
    const n = it.passwordHistory?.length || 0;
    clear(historyBtn, icon('history'), n ? h('span', { class: 'ib-count' }, String(n)) : null);
    historyBtn.disabled = !n;
  };
  refreshHistoryBtn();

  const simpleRow = (k, label, ...extra) => h('div', { class: 'frow' },
    h('span', { class: 'flabel' }, label), textInput(k, { 'aria-label': label, ...asciiInput(k) }), h('div', { class: 'fbtns' }, copyBtn(k, label), typeBtn(k, label), extra));

  const bits = estimateBits(it.password);
  const [slabel, scls] = strengthLabel(bits);

  // ---- 公式サイト（登録ドメイン）パネル ----
  const sitePanel = h('div', { class: 'site-panel' });
  // 主要サービスの公式URLを登録する（タイトルから見分けたサービス）
  const useOfficialUrl = (brand) => {
    if (ro) return;
    it.url = brand.url;
    touch(it);
    renderDetail();
    toast(`「${brand.name}」の公式サイトの URL を登録しました`);
  };
  // タイトルからのサービス判定の切り替え（誤判定したアイテムだけ止められる）
  const setBrandHint = (off) => {
    if (ro) return;
    if (off) it.brandHint = 'none'; else delete it.brandHint;
    touch(it);
    refreshSitePanel();
  };
  const notThisBtn = (brand) => (ro ? null : h('button', { class: 'link small not-this', title: 'タイトルからの判定がまちがっているとき', onclick: () => setBrandHint(true) }, `「${brand.name}」ではない`));
  // 誤って偽物・食い違いと判定された正しいドメインを「本物と確認した」と記録する（このアイテムだけ）
  const verifyBtn = (domain, la, brand) => (ro ? null : h('button', { class: 'btn small', title: '判定がまちがっていて、本物の公式サイトと確かめたとき',
    onclick: async () => { if (await verifyDomainDialog(it, domain, { lookalike: la, brand })) refreshSitePanel(); } }, '本物と確認した…'));
  const hintOffNote = () => (it.brandHint === 'none' && BC.brandOfTitle(it.name)
    ? h('div', { class: 'muted small' }, `タイトルからのサービス判定はオフです（「${BC.brandOfTitle(it.name).name}」とは見なしません）。`, ro ? null : h('button', { class: 'link small', onclick: () => setBrandHint(false) }, '元に戻す'))
    : null);
  const refreshSitePanel = () => {
    if (v.hideUrl) return;
    const hst = D.hostOf(it.url);
    const chk = BC.checkItem(it);
    if (!hst) {
      // タイトルから考えられるほかのサービス（「三井住友」→ 銀行・カード・信託…）。開いて確かめてから選べるように
      const others = chk.titleBrand ? BC.brandCandidates(it.name).filter((b) => b !== chk.titleBrand) : [];
      const openBtn = (b) => h('button', { class: 'btn small', title: b.url, onclick: () => openOfficialSite({ url: b.url }) }, '開く');
      // 候補から選んだら、このアイテムはそのサービスだと覚える（タイトルと違うサービスでも「食い違い」と言わないように）
      const pick = (b) => {
        if (ro) return;
        if (b === BC.brandOfTitle(it.name)) delete it.brandHint; else it.brandHint = b.id;
        useOfficialUrl(b);
      };
      clear(sitePanel,
        chk.suggestUrl && chk.titleBrand
          ? h('div', { class: 'brand-suggest small' }, `「${chk.titleBrand.name}」の公式サイト: `, h('span', { class: 'mono' }, chk.suggestUrl), ' ',
            openBtn(chk.titleBrand), ' ',
            ro ? null : h('button', { class: 'btn small', onclick: () => pick(chk.titleBrand) }, 'この URL を登録'), ' ', notThisBtn(chk.titleBrand),
            others.length ? h('details', { class: 'brand-others' },
              h('summary', {}, `ほかの候補（${others.length}）`),
              others.map((b) => h('div', { class: 'brand-other' },
                h('span', { class: 'brand-other-name' }, b.name), h('span', { class: 'mono muted' }, b.url),
                h('span', { class: 'brand-other-btns' }, openBtn(b), ro ? null : h('button', { class: 'btn small', onclick: () => pick(b) }, '登録'))))) : null,
            // 一覧は作者が確かめた時点のもの。最後に確かめるのは利用者
            h('p', { class: 'muted small brand-note' }, 'ドメインは会社の都合で変わることがあります。登録する前に［開く］で確かめ、最終的な判断はご自身で行ってください。'))
          : h('span', { class: 'muted small' }, 'URL を登録すると、ここから公式サイトを開けます（メールのリンクを踏まずに済みます）。'),
        hintOffNote(),
        chk.badAllowed.map((b) => h('div', { class: 'warn small danger-box' }, icon('warning'), ` 許可したドメイン ${b.domain}: `, BC.lookalikeText(b.lookalike), ' ', verifyBtn(b.domain, b.lookalike))));
      return;
    }
    const [sub, reg] = D.splitHost(hst);
    const warns = chk.warnings;
    // 公式ドメインと分かったサービス（タイトルのサービスを優先して表示）
    const shownBrand = chk.official.find((b) => b === chk.titleBrand) || chk.official.find((b) => b.group === chk.titleBrand?.group) || chk.official[0];
    clear(sitePanel,
      h('div', { class: 'site-domain' }, h('span', { class: 'muted small' }, '登録ドメイン '), h('span', { class: 'muted' }, sub), h('strong', {}, reg),
        shownBrand && chk.level === 'ok' ? h('span', { class: 'chip ok brand-ok', title: 'Kagibako に入っている主要サービスの公式ドメイン一覧と一致しました' }, icon('ok'), ` ${shownBrand.name}の公式ドメイン`)
          : chk.userVerified ? [h('span', { class: 'chip ok brand-ok', title: 'あなたが公式サイトで確かめて「本物と確認した」ドメインです' }, icon('ok'), ' 自分で確認した公式ドメイン'),
            ro ? null : h('button', { class: 'link small not-this', onclick: () => { unverifyDomain(it, chk.domain); refreshSitePanel(); } }, '取り消す')] : null),
      chk.lookalike ? h('div', { class: 'warn small danger-box' }, icon('warning'), ' 偽ドメインの疑い：', BC.lookalikeText(chk.lookalike),
        chk.lookalike.brand.url && !ro ? [' ', h('button', { class: 'btn small', onclick: () => useOfficialUrl(chk.lookalike.brand) }, `${chk.lookalike.brand.name}の公式 URL に直す`), ' ', verifyBtn(chk.domain, chk.lookalike)] : null) : null,
      !chk.lookalike && chk.mismatch ? h('div', { class: 'warn small' }, icon('warning'), ` タイトルは「${chk.titleBrand.name}」ですが、このドメインは${chk.titleBrand.name}の公式ドメインではありません（公式: ${chk.titleBrand.domains.join(' / ')}）。別のサービスなら問題ありません。`,
        !ro ? [' ', h('button', { class: 'btn small', onclick: () => useOfficialUrl(chk.titleBrand) }, '公式 URL に直す'), ' ', verifyBtn(chk.domain, null, chk.titleBrand), ' ', notThisBtn(chk.titleBrand)] : null) : null,
      hintOffNote(),
      chk.badAllowed.map((b) => h('div', { class: 'warn small danger-box' }, icon('warning'), ` 許可したドメイン ${b.domain}: `, BC.lookalikeText(b.lookalike), ' ', verifyBtn(b.domain, b.lookalike))),
      warns.length ? h('div', { class: 'warn small' }, icon('warning'), ' ', warns.join(' / ')) : null,
      (it.allowedDomains || []).length ? h('div', { class: 'muted small' }, '追加で許可したドメイン: ',
        it.allowedDomains.map((d) => h('span', { class: 'chip' }, d, ro ? null : h('button', { class: 'icon-btn small', title: '許可を取り消す', 'aria-label': `${d} の許可を取り消す`, onclick: () => {
          it.allowedDomains = it.allowedDomains.filter((x) => x !== d); touch(it); refreshSitePanel();
        } }, icon('close'))))) : null);
  };
  refreshSitePanel();

  const openSite = () => openOfficialSite(it);

  // ---- 自動入力（PC版） ----
  const targetLabel = h('span', { class: 'muted small target-label' });
  if (host.isDesktop) refreshTargetLabels();

  const autoTypeSection = () => {
    if (!host.isDesktop) return null;
    const presets = [...AT.PRESETS, ...settings.customTemplates.map((c) => [c.template, `★ ${c.name}`])];
    const isPreset = presets.some(([t]) => t === (it.autoType || ''));
    const custom = h('input', { type: 'text', class: 'mono', value: it.autoType || '', placeholder: settings.autoTypeTemplate, readonly: ro, spellcheck: 'false', 'aria-label': '自動入力の手順（カスタム）' });
    const err = h('p', { class: 'error small' });
    const sel = h('select', { 'aria-label': '自動入力の手順', disabled: ro },
      presets.map(([t, label]) => h('option', { value: t, selected: t === (it.autoType || '') }, label)),
      h('option', { value: '#custom', selected: !isPreset }, 'カスタム…'));
    custom.hidden = isPreset;
    sel.addEventListener('change', () => {
      if (sel.value === '#custom') { custom.hidden = false; custom.focus(); return; }
      custom.hidden = true;
      it.autoType = sel.value; custom.value = sel.value; err.textContent = '';
      touch(it);
    });
    custom.addEventListener('input', () => {
      if (ro) return;
      const e = AT.templateError(custom.value);
      err.textContent = e || '';
      if (!e) { it.autoType = custom.value; touch(it); }
    });
    return h('details', { class: 'autotype-box' },
      h('summary', {}, '自動入力の手順: ', AT.describeTemplate(it.autoType || '', settings.customTemplates) || '既定'),
      h('div', { class: 'row' }, sel), custom, err,
      h('p', { class: 'muted small' }, '手順は 設定 →「自動入力」の「名前を付けて登録した手順」で自作できます。記号: {ID} {PASSWORD} {TAB} {ENTER} {DELAY 1000} など'));
  };

  const sendMail = () => sendMailTo(it.email);
  const openFileField = () => openFileOf(it);
  // 欄が空のあいだは押せないボタン。入力に合わせて押せる・押せないを切り替える（set から呼ぶ）
  const siteBtn = h('button', { class: 'btn ib', onclick: openSite, disabled: !D.hostOf(it.url) }, icon('open-site'), '公式サイトを開く');
  const mailBtn = ibtn('mail', 'メールソフトで新規メールを作る', sendMail, { cls: 'small', disabled: !(it.email || '').trim() });
  const fileBtn = host.isDesktop ? ibtn('open-file', 'このファイルを開く', openFileField, { cls: 'small', disabled: !it.file }) : null;
  refreshFieldBtns = () => {
    siteBtn.disabled = !D.hostOf(it.url);
    mailBtn.disabled = !(it.email || '').trim();
    if (fileBtn) fileBtn.disabled = !it.file;
  };

  return h('div', { class: 'pane item-pane' },
    h('div', { class: 'muted small crumbs' }, path.join(' / ') || '最上位'),
    h('div', { class: 'item-actions' },
      siteBtn,
      host.isDesktop ? h('button', { class: 'btn primary ib', onclick: () => autoTypeItem(it, { useHotkeyTarget: false }) }, icon('autotype'), '自動入力') : null,
      host.isDesktop ? targetLabel : null),
    h('div', { class: 'frow title-row' }, h('span', { class: 'flabel' }, 'タイトル'), textInput('name', { class: 'title-input', 'aria-label': 'タイトル' }), h('div', { class: 'fbtns' })),
    secretRow('account', 'accountName', 'ID', !!v.maskAccount),
    secretRow('password', 'passwordName', 'パスワード', v.maskPassword !== false),
    it.password ? h('div', { class: `meter ${scls}` }, `強度: ${slabel}（約${bits}bit）`) : null,
    pwHint(it),
    secretRow('item1', 'item1Name', '項目1', !!v.maskItem1),
    secretRow('item2', 'item2Name', '項目2', !!v.maskItem2),
    v.hideSerial ? null : simpleRow('serialNumber', 'シリアル番号'),
    v.hideUrl ? null : simpleRow('url', 'URL（公式サイト）', ibtn('open-site', '公式サイトを開く', openSite, { cls: 'small' })),
    v.hideUrl ? null : sitePanel,
    v.hideEmail ? null : simpleRow('email', 'メール', mailBtn),
    v.hideFile ? null : simpleRow('file', 'ファイル', fileBtn),
    v.hideDates ? null : h('div', { class: 'frow dates' },
      h('label', {}, h('span', { class: 'flabel' }, '発行日'), h('input', { type: 'date', value: it.issueDate || '', readonly: ro, oninput: set('issueDate') })),
      expiryField(it, ro)),
    autoTypeSection(),
    h('label', { class: 'field' }, h('span', {}, 'メモ'), h('textarea', { rows: settings.density === 'compact' ? 4 : 6, oninput: set('comment'), readonly: ro, spellcheck: 'false' }, it.comment ?? '')),
    ro ? null : h('div', { class: 'row wrap' },
      ibtn('duplicate', 'このアイテムを複製（Ctrl+D）', () => duplicateItem(it, parent)),
      // スマホは一覧の長押しメニューの「上へ」「下へ」で動かす（この画面からは一覧が見えないため）
      isPhone() ? null : ibtn('move-up', '上へ移動', () => moveNode(it, parent, -1)),
      isPhone() ? null : ibtn('move-down', '下へ移動', () => moveNode(it, parent, 1)),
      moveToSelect(it),
      ibtn('delete', 'このアイテムを削除', () => deleteNode(it, parent), { cls: 'danger' })),
    h('p', { class: 'muted small' }, `更新: ${fmtDateTime(it.modified)}`));
}

/** 有効期限の欄（「期限なし」を選べる） */
function expiryField(it, ro) {
  const none = !it.expirationDate;
  const date = h('input', { type: 'date', value: it.expirationDate || '', readonly: ro, disabled: none,
    class: settings.expiryNotify === 'off' ? '' : M.isExpired(it) ? 'expired' : M.isExpiringSoon(it, settings.expiryWarnDays) ? 'soon' : '',
    oninput: (e) => { if (ro) return; it.expirationDate = e.target.value; touch(it); renderTree(); } });
  const noneChk = h('input', { type: 'checkbox', checked: none, disabled: ro, onchange: (e) => {
    if (ro) return;
    it.expirationDate = e.target.checked ? '' : M.addDaysISO(M.todayISO(), settings.validDays || 365);
    touch(it);
    renderTree(); renderDetail();
  } });
  return h('label', {}, h('span', { class: 'flabel' }, '有効期限'),
    h('div', { class: 'row' }, date, h('label', { class: 'check nowrap' }, noneChk, '期限なし')));
}

/** メールソフトで新規メールを作る */
async function sendMailTo(address) {
  const a = (address || '').trim();
  if (!a) return;
  try {
    if (host.isDesktop || host.isAndroid) await host.call('mailto', { address: a });
    else window.open(`mailto:${encodeURIComponent(a).replace('%40', '@')}`, '_self');
  } catch (e) { toast(errText(e), 5000); }
}

/** 「ファイル」欄のファイルを開く（PC版） */
async function openFileOf(it) {
  const p = (it.file || '').trim();
  if (!p || !host.isDesktop) return;
  // ネットワーク上の場所（\\server\… ）は、開こうとしただけで Windows のサインイン情報（の一部）が相手に送られることがある。
  // 実行ファイルは開く＝プログラムの実行になる。どちらも強めに注意する
  const network = /^(\\\\|\/\/)/.test(p) || /^[a-z][a-z0-9+.-]*:\/\//i.test(p) && !/^https?:\/\//i.test(p);
  const runnable = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|scr|pif|cpl|lnk|url|reg|jar|appref-ms|application|library-ms|search-ms)$/i.test(p.replace(/["\s]+$/, ''));
  const warns = [
    network ? '⚠ ネットワーク上の場所です。知らない相手のサーバーを開くと、Windows のサインイン情報が送られるおそれがあります。' : '',
    runnable ? '⚠ プログラム（実行ファイル・ショートカット・スクリプト）です。開くとそのプログラムが実行されます。' : '',
  ].filter(Boolean);
  if (!(await confirmDialog('ファイルを開く', `次のファイルを開きます。\n\n${p}\n\n${warns.length ? `${warns.join('\n')}\n\n` : ''}心当たりのないファイルは開かないでください。取り込んだデータに入っていたファイル名は特に注意してください。`, '開く', warns.length > 0))) return;
  try { await host.call('openPath', { path: p }); } catch (e) { toast(errText(e), 6000); }
}

/** 画面上部の期限のお知らせ（設定で「上部に表示」のとき） */
function expiryBanner() {
  if (settings.expiryNotify !== 'banner') return null;
  const exp = expiredItems().length;
  const soon = expiringItems().length - exp;
  if (!exp && !soon) return null;
  const parts = [];
  if (exp) parts.push(`有効期限が切れたアイテムが ${exp} 件`);
  if (soon) parts.push(`${settings.expiryWarnDays} 日以内に期限が来るアイテムが ${soon} 件`);
  return h('div', { class: 'banner info' }, `${parts.join('、')}あります（一覧で ⏰ ⏳ 表示）。`,
    h('button', { class: 'link', onclick: expiredListDialog }, '一覧を見る'));
}

/** 開いたときのお知らせ（設定で「一覧で知らせる」のとき。開くたびに1回） */
async function notifyExpiryOnOpen() {
  if (settings.expiryNotify !== 'dialog' || S.expiryShown) return;
  S.expiryShown = true;
  if (expiringItems().length) await expiredListDialog();
}

/** 有効期限切れ・期限間近のアイテム一覧（まとめて「期限なし」にもできる） */
async function expiredListDialog() {
  const list = expiringItems();
  const ro = !!settings.readOnly;
  const checks = new Map();
  let picked = null;
  const v = await modal({
    title: `有効期限のお知らせ（${list.length} 件）`,
    wide: true,
    body: [list.length
      ? [h('p', { class: 'muted small' }, settings.expiryWarnDays ? `期限切れ（⏰）と、${settings.expiryWarnDays} 日以内に期限が来るもの（⏳）です。` : '期限切れのアイテムです。'),
        h('ul', { class: 'plain-list' }, list.map((e) => {
          const cb = h('input', { type: 'checkbox', 'aria-label': `${e.node.name} を選ぶ` });
          checks.set(e.node.id, cb);
          return h('li', {},
            ro ? null : cb,
            h('span', { class: 'ticon', title: M.isExpired(e.node) ? '有効期限切れ' : '有効期限が近い' }, icon(M.isExpired(e.node) ? 'expired' : 'expiring')),
            h('button', { class: 'link', onclick: (ev) => { picked = e.node.id; ev.target.closest('.overlay').querySelector('.modal-head .icon-btn').click(); } }, e.node.name || '(名前なし)'),
            h('span', { class: 'muted small' }, `期限 ${e.node.expirationDate}　${e.path.join(' / ')}`));
        })),
        ro ? null : h('p', { class: 'muted small' }, 'カードの更新などで期限が変わったら、アイテムの有効期限を直してください。期限を管理しないアイテムは「期限なし」にできます（パスワードを定期的に変える必要はありません）。')]
      : h('p', {}, '期限切れ・期限が近いアイテムはありません。')],
    buttons: list.length && !ro
      ? [{ label: '選んだものを期限なしにする', value: 'clearSel' }, { label: 'すべて期限なしにする', value: 'clearAll' }, { label: '閉じる', value: null, kind: 'primary' }]
      : [{ label: '閉じる', value: null, kind: 'primary' }],
  });
  if (v === 'clearSel' || v === 'clearAll') {
    const targets = list.filter((e) => v === 'clearAll' || checks.get(e.node.id)?.checked);
    if (!targets.length) { toast('アイテムが選ばれていません'); return; }
    if (!(await confirmDialog('期限なしにする', `${targets.length} 件のアイテムの有効期限をなくします（保存するまでファイルには反映されません）。`, '期限なしにする'))) return;
    for (const e of targets) { e.node.expirationDate = ''; touch(e.node); }
    renderMain();
    toast(`${targets.length} 件を期限なしにしました`);
    return;
  }
  if (picked) select(picked);
}

/** 登録した URL から公式サイトを開く（メールのリンクを使わずに済むように） */
async function openOfficialSite(it) {
  const u = (it.url || '').trim();
  if (!D.hostOf(u)) { toast('URL が登録されていません'); return; }
  const scheme = D.schemeOf(u);
  if (scheme && scheme !== 'https' && scheme !== 'http') { toast('http:// または https:// の URL のみ開けます'); return; }
  const url = scheme ? u : `https://${u}`;
  const warns = D.hostWarnings(url);
  if (warns.length && !(await confirmDialog('このアドレスを開きますか？', `${url}\n\n注意: ${warns.join('\n・')}\n\n登録した URL が本当に公式サイトのものか確認してください。`, '開く'))) return;
  if (host.isDesktop || host.isAndroid) {
    // PC版：設定でブラウザを指定していればそのブラウザで、なければ既定のブラウザで開く
    // Android版：アプリ側からブラウザを開く（確認ダイアログを挟むと window.open は止められるため）
    // PC：browser（設定で指定したブラウザ）／Android：chrome（設定で Chrome を選んでいれば、入っていれば Chrome で開く）
    try { await host.call('openUrl', { url, browser: settings.browserPath || '', chrome: settings.androidBrowser !== 'default' }); } catch (e) { toast(errText(e), 6000); }
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function passwordHistoryDialog(it) {
  const list = it.passwordHistory || [];
  const shown = new Set();
  const ul = h('ul', { class: 'plain-list' });
  const draw = () => clear(ul, list.map((x, i) => h('li', {},
    h('code', { class: 'mono' }, shown.has(i) ? charSpans(x.password) : '••••••••'),
    h('span', { class: 'muted small' }, `${fmtDateTime(x.until)} まで使用`),
    ibtn(shown.has(i) ? 'hide' : 'show', shown.has(i) ? '隠す' : '表示する', () => { shown.has(i) ? shown.delete(i) : shown.add(i); draw(); }, { cls: 'small' }),
    ibtn('copy', 'コピー', () => copyText(x.password, '以前のパスワード'), { cls: 'small' }))));
  draw();
  return modal({
    title: `パスワード履歴 — ${it.name}`,
    body: [h('p', { class: 'muted small' }, `変更前のパスワードを新しい順に最大${M.PASSWORD_HISTORY_MAX}件残しています。`), ul],
    buttons: [
      { label: '履歴を消去', value: 'clear', kind: 'danger' },
      { label: '閉じる', value: null, kind: 'primary' },
    ],
  }).then(async (v) => {
    if (v === 'clear' && await confirmDialog('履歴の消去', `「${it.name}」のパスワード履歴 ${list.length} 件を消去します（保存すると元に戻せません）。`, '消去', true)) {
      it.passwordHistory = [];
      touch(it);
      renderDetail();
    }
  });
}

// ---------------- 編集操作 ----------------
function targetContainerForNew() {
  const e = selected();
  if (!e) return S.vault.children;
  if (e.node.type === 'folder') return e.node.children;
  return M.containerOf(S.vault, e.parent);
}

function addFolder(sub) {
  if (editLocked()) return;
  const f = M.newFolder();
  const e = selected();
  let list;
  if (sub && e?.node.type === 'folder') { list = e.node.children; e.node.open = true; }
  else if (e) {
    const parentOfFolder = e.node.type === 'folder' ? e.parent : e.parent ? M.findById(S.vault, e.parent.id)?.parent : null;
    list = M.containerOf(S.vault, parentOfFolder);
  } else list = S.vault.children;
  f.name = M.uniqueFolderName(list); // 同じ階層に「新しいフォルダ」があれば (2)・(3)… を付ける
  list.push(f);
  markDirty();
  select(f.id);
  $detail.querySelector('input')?.select();
}

function addItem() {
  if (editLocked()) return;
  let container = targetContainerForNew();
  if (container === S.vault.children) {
    // アイテムはフォルダに入れる（一覧を整理しやすいように）
    let f = S.vault.children.find((c) => c.type === 'folder');
    if (!f) { f = M.newFolder('未分類'); S.vault.children.push(f); }
    container = f.children;
  }
  const it = M.newItem(S.vault);
  it.expirationDate = settings.validDays > 0 ? M.addDaysISO(it.issueDate, settings.validDays) : ''; // 0 = 期限なし
  container.push(it);
  for (const { node } of M.walk(S.vault.children)) if (node.type === 'folder' && node.children === container) node.open = true;
  markDirty();
  select(it.id);
  $detail.querySelector('.title-input')?.select();
}

/**
 * スマホ：右下の［＋］。押しただけでは作らず、何を追加するかを選んでもらう（どこにできるかも書く）。
 * 一番上ではアイテムを置けないので、最初のフォルダ（なければ「未分類」を作って）の中に作ると先に伝える
 */
async function phoneAddDialog() {
  if (editLocked()) return;
  const nameOf = (f) => `「${f.name || '(名前なし)'}」`;
  const here = S.phoneFolder ? M.findById(S.vault, S.phoneFolder)?.node : null;
  const first = S.vault.children.find((c) => c.type === 'folder');
  const itemWhere = here ? `${nameOf(here)}の中に作ります`
    : first ? `${nameOf(first)}の中に作ります（一番上にはアイテムを置けないため）`
      : '「未分類」フォルダを作って、その中に作ります（一番上にはアイテムを置けないため）';
  const folderWhere = here ? `${nameOf(here)}の中に作ります` : '一番上（すべて）に作ります';
  const choice = (ic, label, where) => h('button', { class: 'm-add-choice', type: 'button' }, icon(ic), h('span', { class: 'm-add-text' }, h('strong', {}, label), h('span', { class: 'muted small' }, where)));
  const itemBtn = choice('add-item', 'アイテムを追加', itemWhere);
  const folderBtn = choice('add-folder', 'フォルダを追加', folderWhere);
  const v = await modal({
    title: '追加',
    body: [h('div', { class: 'm-add-choices' }, itemBtn, folderBtn)],
    buttons: [{ label: 'キャンセル', value: null }],
    onOpen: (_, close) => { itemBtn.onclick = () => close('item'); folderBtn.onclick = () => close('folder'); },
  });
  if (v === 'item') phoneNewItem(S.phoneFolder);
  else if (v === 'folder') await phoneNewFolder(S.phoneFolder);
}

/**
 * スマホ：そのフォルダ（null なら最上位）の中に、名前を聞いてフォルダを作る。画面は移らない
 * （作ったフォルダの画面に移ると、そこの［フォルダに＋］を続けて押したときに、階層がどんどん深くなっていくため）
 */
async function phoneNewFolder(parentId) {
  if (editLocked()) return;
  const parent = parentId ? M.findById(S.vault, parentId)?.node : null;
  const list = parent ? parent.children : S.vault.children;
  const input = h('input', { type: 'text', value: M.uniqueFolderName(list), 'aria-label': 'フォルダ名', spellcheck: 'false', autocomplete: 'off' });
  const where = parent ? `「${parent.name || '(名前なし)'}」の中` : '一番上（すべて）';
  const v = await modal({
    title: '新しいフォルダ',
    body: [h('p', { class: 'muted small' }, `${where}に作ります。`), h('label', { class: 'field' }, h('span', {}, 'フォルダ名'), input)],
    buttons: [{ label: 'キャンセル', value: null }, { label: '作る', value: 'ok', kind: 'primary' }],
    onOpen: (_, close) => {
      input.select();
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); close('ok'); } });
    },
  });
  if (v !== 'ok') return;
  const f = M.newFolder(input.value.trim() || M.uniqueFolderName(list));
  list.push(f);
  if (parent) parent.open = true;
  markDirty();
  renderTree();
  if (S.sel === parentId) renderDetail(); // フォルダの画面から作ったときは、その画面の件数などを新しくする
  toast(`「${f.name}」を作りました`);
}

/**
 * スマホ：そのフォルダ（null なら最上位＝最初のフォルダ）に新しいアイテムを作り、すぐ入力できる画面で開く。
 * 右下の［＋］の「アイテムを追加」・フォルダの画面・一覧の長押しメニューから使う
 */
function phoneNewItem(folderId) {
  if (editLocked()) return;
  S.sel = folderId || null;
  addItem();
  S.mobileEdit = true;
  renderDetail();
  $detail.querySelector('.title-input')?.select();
  // どこにできたかを知らせる（最上位で押したときは、最初のフォルダに入るため）
  const at = selected()?.parent;
  if (at) toast(`「${at.name || '(名前なし)'}」に新しいアイテムを作りました`);
}

function duplicateItem(it, parent) {
  if (editLocked()) return;
  const c = structuredClone(it);
  c.id = M.uuid();
  c.name = `${it.name} のコピー`;
  c.created = c.modified = Date.now();
  const list = M.containerOf(S.vault, parent);
  list.splice(list.indexOf(it) + 1, 0, c);
  markDirty();
  select(c.id);
}

/**
 * Android：いま開いているファイルの「指紋・顔でのロック解除」の状態と、設定する・取り消すボタン。
 * 設定の画面と、最初の説明（はじめての方へ）で使う
 */
function bioSetupBox({ allowRemove = true } = {}) {
  const box = h('div', { class: 'bio-setup' });
  const draw = async () => {
    const st = await host.call('bioStatus', { key: S.knownKey }).catch(() => null);
    if (!st || st.status === 'unsupported') return clear(box, h('p', { class: 'muted small' }, 'この端末では使えません（Android 11 以降が必要です）。'));
    if (st.status !== 'ok') return clear(box, h('p', { class: 'muted small' }, '端末の設定で指紋や顔を登録すると使えます。'));
    if (st.enrolled) {
      return clear(box, h('p', { class: 'small' }, icon('ok'), ' このファイルは指紋・顔で開けます。'),
        allowRemove ? h('button', { class: 'btn small', onclick: async () => { await host.call('bioRemove', { key: S.knownKey }).catch(() => {}); toast('指紋・顔でのロック解除を取り消しました'); draw(); } }, '取り消す') : null);
    }
    return clear(box, h('p', { class: 'muted small' }, 'このファイルを、マスターパスワードの代わりに指紋や顔で開けるようにします。'),
      h('button', { class: 'btn small', onclick: async () => {
        const p = await passwordPrompt('指紋・顔でのロック解除', '確認のため、今のマスターパスワードを入れてください。', { check: verifyMasterPassword });
        if (!p) return;
        try {
          await host.call('bioEnroll', { key: S.knownKey, password: p }, 0);
          const declined = await store.getSetting('bioDeclined', {}); delete declined[S.knownKey]; await store.setSetting('bioDeclined', declined);
          toast('次から指紋・顔で開けます');
        } catch (e) { if (errText(e) !== 'cancelled') toast(`設定できませんでした（${errText(e)}）`, 5000); }
        draw();
      } }, '指紋・顔で開けるようにする'));
  };
  if (host.isAndroid && S.knownKey) draw();
  else clear(box, h('p', { class: 'muted small' }, 'ファイルを保存すると設定できます（Android 版）。'));
  return box;
}

/** スマホ：アイテムの欄の項目名（Account ID など）を変える窓 */
async function renameFieldDialog(it, nameKey, fallback) {
  if (editLocked()) return;
  const input = h('input', { type: 'text', value: it[nameKey] || fallback, 'aria-label': '項目名', spellcheck: 'false', autocomplete: 'off' });
  const v = await modal({
    title: '項目名を変える',
    body: [h('p', { class: 'muted small' }, '欄の見出しの名前です（例：メールアドレス、会員番号）。中身は変わりません。'), h('label', { class: 'field' }, h('span', {}, '項目名'), input)],
    buttons: [{ label: 'キャンセル', value: null }, { label: '変える', value: 'ok', kind: 'primary' }],
    onOpen: (_, close) => {
      input.select();
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); close('ok'); } });
    },
  });
  if (v !== 'ok') return;
  it[nameKey] = input.value.trim();
  touch(it);
  renderDetail();
}

/** 名前を変える：そのフォルダ・アイテムを選んで名前の欄に入る（スマホの長押しメニューから。アイテムは編集の画面にする） */
function startRename(id) {
  if (editLocked()) return;
  select(id);
  const e = selected();
  if (!e) return;
  if (isPhone() && e.node.type === 'item') { S.mobileEdit = true; renderDetail(); }
  const t = $detail.querySelector(e.node.type === 'item' ? '.title-input' : 'input');
  t?.focus();
  t?.select();
}

/** 上へ・下へで入れ替える相手の位置（ない場合は -1）。
 * スマホの一覧はフォルダを先・アイテムを後に並べるので、スマホでは同じ種類どうしだけで入れ替える（見た目の順と合わせる） */
function moveTarget(node, parent, dir) {
  const list = M.containerOf(S.vault, parent);
  let j = list.indexOf(node) + dir;
  if (isPhone()) while (j >= 0 && j < list.length && list[j].type !== node.type) j += dir;
  return j >= 0 && j < list.length ? j : -1;
}

function moveNode(node, parent, dir) {
  if (editLocked()) return;
  const list = M.containerOf(S.vault, parent);
  const i = list.indexOf(node), j = moveTarget(node, parent, dir);
  if (i < 0 || j < 0) return;
  [list[i], list[j]] = [list[j], list[i]];
  touch(node);
  renderTree();
}

async function deleteNode(node, parent) {
  if (editLocked()) return;
  const n = node.type === 'folder' ? M.countItems({ children: node.children }).items : 0;
  const msg = node.type === 'folder' ? `フォルダ「${node.name}」と中のアイテム ${n} 件を削除します。` : `「${node.name}」を削除します。`;
  if (!(await confirmDialog('削除の確認', `${msg}\n（保存するまではファイルに反映されません）`, '削除', true))) return;
  removeNode(node, parent);
}

/** 確認なしで消す（削除の記録も残す）。確認は呼ぶ側で済ませる */
function removeNode(node, parent) {
  const list = M.containerOf(S.vault, parent);
  list.splice(list.indexOf(node), 1);
  const now = Date.now();
  for (const { node: x } of M.walk([node])) S.vault.tombstones.push({ id: x.id, deletedAt: now });
  S.vault.tombstones = S.vault.tombstones.slice(-2000);
  S.sel = parent?.id ?? null;
  markDirty();
  renderTree(); renderDetail();
}

/** 日本語を打たない欄（URL・メール・郵便番号・電話）：スマホは英字・数字のキーボードを出し、PC は欄に入ったら日本語入力を切る（入力欄の focusin で見る） */
const ASCII_INPUT = { url: 'url', email: 'email', 'e-mail1': 'email', 'e-mail2': 'email', 'e-mail3': 'email', zip1: 'tel', zip2: 'tel', tel1: 'tel', tel2: 'tel' };
function asciiInput(k) {
  const mode = ASCII_INPUT[k];
  return mode ? { inputmode: mode, autocapitalize: 'off', spellcheck: 'false', dataset: { ascii: '1' } } : {};
}

// ---------------- クリップボード ----------------
let clipTimer = null;
async function copyText(value, label) {
  if (!value) { toast(`${label} は空です`); return; }
  if (host.isAndroid || host.isDesktop) {
    // アプリ版：Android は「機密」扱い、PC は Windows のクリップボード履歴・クラウド同期に残さない形でコピーし、指定秒数後に消去
    try {
      await host.call('copy', { text: value, label, clearAfterSec: settings.clipSec });
      toast(settings.clipSec ? `${label}をコピーしました（${settings.clipSec}秒後に消去）` : `${label}をコピーしました`);
    } catch (e) { toast(`コピーできませんでした: ${e.message}`); }
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    const sec = settings.clipSec;
    toast(sec ? `${label}をコピーしました（${sec}秒後に消去）` : `${label}をコピーしました`);
    clearTimeout(clipTimer);
    if (sec) clipTimer = setTimeout(() => { navigator.clipboard.writeText('').catch(() => {}); }, sec * 1000);
  } catch {
    toast('コピーできませんでした（ブラウザの許可を確認してください）');
  }
}

// ---------------- 保存 ----------------
function baseName(name) {
  return (name || 'passwords').replace(/\.(kagi|idm)$/i, '');
}

async function save({ as = null } = {}) {
  if (!S.vault) return;
  // 変更がないのに上書きすると版数だけが増えていくので、何もしない（「名前を付けて保存」は別）
  if (!as && !S.dirty && S.file && !S.file.fromSnapshot && !S.file.unsavedDraft && S.kind === 'kagi' && S.header) {
    toast(S.kind === 'kagi' ? `変更はありません（第${S.header.revision}版のまま）` : '変更はありません');
    return;
  }
  // .idm は読み込みだけ。開いた .idm を保存するときは、新しい .kagi ファイルとして保存する
  const migrating = S.kind === 'legacy';
  try {
    return await saveVaultFile({ forceAs: migrating || (as === 'kagi' && S.kind === 'kagi') });
  } catch (e) {
    console.error(e);
    toast(`保存できませんでした: ${e.message}`, 5000);
  }
}

/** 上書き前に、保存先が開いた後に更新されていないか確認（デグレ防止） */
async function checkBeforeOverwrite() {
  if (!S.file?.handle || !S.file.bytes) return true;
  const now = await fio.rereadHandle(S.file.handle);
  if (!now) return true;
  let changed = false, info = '';
  if (S.kind === 'kagi') {
    try {
      const env = X.parseEnvelope(new TextDecoder().decode(now.bytes));
      // 開いた時点の版のままなら、保存先は変わっていない（「この端末の版を使う」を選んだ後なども含む）
      const opened = S.file.env?.header;
      const rel = opened && env.header.revId === opened.revId ? 'same' : compareHeaders(S.header, env.header);
      changed = rel === 'b' || rel === 'diverged' || rel === 'different-vault';
      info = `保存先: 第${env.header.revision}版 / ${fmtDateTime(env.header.savedAt)} / ${env.header.device || '不明'}`;
      if (changed) S._diskEnv = { env, bytes: now.bytes };
    } catch { changed = true; info = '保存先のファイルを読み取れません'; }
  } else {
    changed = now.bytes.length !== S.file.bytes.length || now.bytes.some((b, i) => b !== S.file.bytes[i]);
    info = `保存先の更新日時: ${fmtDateTime(now.lastModified)}`;
    if (changed) S._diskEnv = { bytes: now.bytes };
  }
  if (!changed) return true;
  const v = await modal({
    title: '⚠ 保存先のファイルが更新されています',
    body: [h('p', { class: 'pre' }, `このファイルは、開いた後に別の端末やアプリで更新されています。\n${info}\n\nこのまま上書きすると、その変更が失われます（デグレ）。`)],
    buttons: [{ label: 'キャンセル', value: null }, { label: 'それでも上書き', value: 'overwrite', kind: 'danger' }, { label: '比較して統合', value: 'merge', kind: 'primary' }],
  });
  if (v === 'overwrite') return true;
  if (v === 'merge') {
    const other = await unlockOther({ name: S.file.name, bytes: S._diskEnv.bytes, lastModified: now.lastModified });
    if (other) {
      normalizeVault(other.vault);
      const base = await openedVersion();
      // 統合すると、保存先の版の系譜も取り込む（保存すると、両方の版の続きになる）
      const merged = await mergeDialog(other.vault, { labelA: '編集中の内容', labelB: '保存先の最新', newer: 'b', base, otherHeader: other.header });
      if (merged) {
        S.file.bytes = S._diskEnv.bytes;
        if (S._diskEnv.env) S.file.env = S._diskEnv.env; // 次の保存では、この版を「開いた時点の版」とみなす
        toast('統合しました。もう一度「保存」を押してください');
      }
    }
  }
  return false;
}

/**
 * 保存する内容に、この端末で扱った最新の版の変更が入っているか確認（デグレ防止）。
 * 「古いファイルのまま開く」で開いたあと・統合を途中でやめたあと などに保存すると、
 * この端末の新しい版の変更が消えてしまうので、止めて統合を勧める。
 */
async function checkDeviceHead() {
  if (S.kind !== 'kagi' || !S.header || !S.knownKey) return true;
  const known = await store.getKnown(S.knownKey);
  const head = known?.head;
  if (!head || includesRev(S.header, head.revId)) return true;
  const v = await modal({
    title: '⚠ この端末に、より新しい版があります',
    body: [h('p', { class: 'pre' }, `この端末では 第${head.revision}版（${fmtDateTime(head.savedAt)} / ${head.device || '不明'}）まで扱っています。
いま保存しようとしている内容には、その版の変更が入っていない可能性があります。
このまま保存すると、その変更が失われることがあります（デグレ）。`)],
    buttons: [{ label: 'キャンセル', value: null }, { label: 'それでも保存', value: 'save', kind: 'danger' }, { label: '比較して統合', value: 'merge', kind: 'primary' }],
  });
  if (v === 'save') return true;
  if (v === 'merge') {
    const dev = await loadSnapshot(known.snapshots[0]);
    if (dev) {
      normalizeVault(dev.vault);
      const base = await findAncestorVault(S.header, dev.header);
      const merged = await mergeDialog(dev.vault, { labelA: '編集中の内容', labelB: 'この端末の版', newer: 'b', base, otherHeader: dev.header });
      if (merged) toast('統合しました。もう一度「保存」を押してください');
    }
  }
  return false;
}

async function saveVaultFile({ forceAs }) {
  if (!(await checkDeviceHead())) return;
  if (!forceAs && S.kind === 'kagi' && !(await checkBeforeOverwrite())) return;
  const prevHeader = S.kind === 'kagi' ? S.header : null;
  const { text, header } = await X.encryptVault(S.vault, S.session, { prevHeader, device: settings.deviceName });
  const data = new TextEncoder().encode(text);
  await verifyEncrypted(text);
  const name = `${baseName(S.file?.name)}.kagi`;
  let handle = S.kind === 'kagi' && !forceAs ? S.file?.handle : null;
  let finalName = name;
  if (handle) { await fio.writeHandle(handle, data); await verifyWritten(handle, data); }
  else {
    const r = await fio.saveAs(name, data);
    if (r.cancelled) return;
    handle = r.handle; finalName = r.name;
  }
  const wasLegacy = S.kind === 'legacy';
  S.kind = 'kagi';
  S.header = header;
  S.file = { name: finalName, bytes: data, handle, lastModified: Date.now(), kind: 'kagi', env: X.parseEnvelope(text) };
  S.knownKey = store.knownKeyFor({ kind: 'kagi', header });
  S.legacyKey?.fill(0);
  S.legacyKey = null;
  S.dirty = false;
  S.banner = null;
  await backupAfterSave(await recordCurrent());
  await store.del('drafts', S.knownKey).catch(() => {});
  renderMain();
  toast(handle ? `保存しました（第${header.revision}版）` : `第${header.revision}版をダウンロードしました。クラウドへアップロードしてください`, 4500);
  if (wasLegacy) toast('.kagi 形式で保存しました。元の .idm ファイルは不要になったら削除してください', 6000);
}

// ---------------- 保存の確認（ベリファイ） ----------------
async function verifyEncrypted(text) {
  try {
    const r = await X.decryptWithSession(X.parseEnvelope(text), S.session);
    if (await M.contentHash(r.vault) !== await M.contentHash(S.vault)) throw new Error('内容が一致しません');
  } catch (e) {
    throw new Error(`暗号化した内容を確認できませんでした（保存は中止しました）: ${errText(e)}`);
  }
}

async function verifyWritten(handle, data) {
  const back = await fio.rereadHandle(handle);
  const same = back && back.bytes.length === data.length && back.bytes.every((b, i) => b === data[i]);
  if (same) return;
  await modal({
    title: '⚠ 保存の確認に失敗しました',
    body: [h('p', { class: 'pre' }, `ファイルに書き込んだ内容を読み直したところ、一致しませんでした。
保存先（クラウドの同期中・容量不足・別のアプリによる書き換えなど）を確認してください。

編集中の内容は消えていません。「メニュー → 名前を付けて保存」で別の場所にも保存してください。`)],
  });
  throw new Error('保存の確認に失敗しました');
}

// ---------------- ロック ----------------
function wipeSession() {
  S.legacyKey?.fill(0);
  Object.assign(S, { vault: null, session: null, legacyKey: null, header: S.header, sel: null, reveal: new Set(), dirty: false, search: '', mobileDetail: false, phoneFolder: null });
  abandonAllModals(); // 開いていたダイアログは、続きの処理ごと捨てる
  closeDropdown();
  document.body.classList.remove('detail-open');
  $tree = $detail = $layout = null;
}

async function lock() {
  if (S.screen !== 'main') return;
  let file = S.file;
  if (S.dirty) {
    // 未保存の変更は暗号化して端末内に一時保存（ロック解除後に復元できる）
    try {
      const { text } = await X.encryptVault(S.vault, S.session, { prevHeader: S.header, device: settings.deviceName, vaultId: S.header?.vaultId });
      const key = S.knownKey || `draft:${file?.name}`;
      await store.put('drafts', key, { text, savedAt: new Date().toISOString(), name: file?.name, kind: S.kind });
      if (!file?.bytes) file = { name: file?.name || '無題.kagi', bytes: new TextEncoder().encode(text), handle: null, unsavedDraft: true };
      S.pendingDraftKey = key;
    } catch (e) {
      console.error(e);
    }
  }
  wipeSession();
  if (file?.bytes) beginUnlock(file, { afterLock: true });
  else renderStart();
}

async function offerDraftRestore() {
  const key = S.pendingDraftKey || S.knownKey;
  if (!key) return;
  const d = await store.get('drafts', key).catch(() => null);
  if (!d) return;
  if (S.file?.unsavedDraft) {
    // 一度も保存していない新規データ：そのまま下書きを使う
    markDirty();
    S.file = { name: d.name || '無題.kagi', bytes: null, handle: null, kind: 'kagi' };
    S.header = null;
    S.knownKey = null;
    await store.del('drafts', key);
    S.pendingDraftKey = null;
    renderMain();
    return;
  }
  let draft;
  try {
    draft = await X.decryptWithSession(X.parseEnvelope(d.text), S.session);
    normalizeVault(draft.vault);
  } catch {
    // パスワードを変えた後など。消さずに残しておく（消すと変更が失われる）
    toast('ロック前の未保存の変更を読み込めませんでした（別のパスワードの可能性があります）', 5000);
    return;
  }
  // ロックした時点で開いていた版（下書きの元）。いま開いた版と違えば、その後ファイルが更新されている
  const draftBase = draft.header?.lineage?.at(-1) || null;
  const sameBase = S.kind !== 'kagi' || !S.header || !draftBase || draftBase === S.header.revId;
  const v = await modal({
    title: '未保存の変更があります',
    body: [h('p', { class: 'pre' }, sameBase
      ? `ロック前（${fmtDateTime(d.savedAt)}）の、保存していない変更があります。復元しますか？`
      : `ロック前（${fmtDateTime(d.savedAt)}）の、保存していない変更があります。
その後ファイルが更新されているため、そのまま戻すと新しい変更が消えます。比較して統合してください。`),
    h('p', { class: 'muted small' }, '保存しないままロックされたので、入れた内容が消えないよう、暗号化してこの端末に取っておいたものです（詳しくは よくある質問 →「表示・操作」）。')],
    buttons: [{ label: '破棄する', value: 'discard', kind: 'danger' }, { label: 'あとで', value: null }, { label: sameBase ? '復元する' : '比較して統合', value: 'restore', kind: 'primary' }],
  });
  if (!v) return; // 「あとで」：次に開いたときにまた聞く
  if (v === 'restore') {
    if (sameBase) {
      S.vault = draft.vault;
      markDirty();
      renderMain();
    } else {
      const snap = (await store.getKnown(S.knownKey))?.snapshots?.find((x) => x.revId === draftBase);
      let base = null;
      if (snap) { try { base = (await X.decryptWithSession(X.parseEnvelope(snap.fileText), S.session)).vault; } catch { base = null; } }
      const merged = await mergeDialog(draft.vault, { labelA: '開いたファイル', labelB: 'ロック前の未保存の変更', newer: 'b', base });
      if (!merged) return; // 統合をやめた：下書きは残す
    }
  }
  await store.del('drafts', key);
  S.pendingDraftKey = null;
}

// ---------------- 比較・統合 ----------------
async function unlockOther(file) {
  const kind = detectKind(file.bytes);
  if (!kind) { toast('対応していないファイルです'); return null; }
  try {
    if (kind === 'kagi') {
      const env = X.parseEnvelope(new TextDecoder().decode(file.bytes));
      if (S.session && env.kdf.salt === S.session.kdf.salt) {
        try { const r = await X.decryptWithSession(env, S.session); return { ...r, kind }; } catch { /* 別パスワード */ }
      }
      let out = null;
      const pw = await passwordPrompt('比較するファイルのパスワード', file.name, { check: async (p) => { out = await X.decryptEnvelope(env, p); return true; } });
      return pw ? { ...out, kind } : null;
    }
    if (S.legacyKey) {
      try { return { vault: L.legacyXmlToVault(L.decryptLegacy(file.bytes, S.legacyKey)), header: null, kind }; } catch { /* 別パスワード */ }
    }
    let out = null;
    const pw = await passwordPrompt('比較するファイルのパスワード', file.name, { check: (p) => { out = L.openLegacy(file.bytes, p); return true; } });
    return pw ? { vault: out, header: null, kind } : null;
  } catch (e) {
    toast(e.message);
    return null;
  }
}

async function compareWithFileFlow() {
  const f = await fio.pickFile();
  if (!f) return;
  const other = await unlockOther(f);
  if (!other) return;
  normalizeVault(other.vault);
  let newer = null;
  if (S.header && other.header) {
    const rel = compareHeaders(S.header, other.header);
    newer = rel === 'a' || rel === 'b' ? rel : null;
  } else if (S.file?.lastModified && f.lastModified) {
    newer = f.lastModified > S.file.lastModified ? 'b' : 'a';
  }
  let base = null;
  if (S.header && other.header) {
    if (newer === 'a') base = other.vault;      // B は A の祖先
    else if (newer === 'b') base = await openedVersion(); // A(開いた版)は B の祖先
    else base = await findAncestorVault(S.header, other.header);
  }
  await mergeDialog(other.vault, { labelA: `いま開いている版（${S.file?.name}）`, labelB: `比較するファイル（${f.name}）`, newer, base, otherHeader: other.header });
}

/** 比較・統合ダイアログ。統合を適用したら true。base = 共通の元の版（分かる場合） */
async function mergeDialog(B, { labelA, labelB, newer = null, base = null, otherHeader = null }) {
  const res = diffVaults(S.vault, B, newer === 'b' ? 'b' : 'a', base);
  if (!res.diffs.length && !res.profile.length) {
    await modal({ title: '比較結果', body: [h('p', {}, '内容に違いはありません。')] });
    return false;
  }
  const show = new Set();
  const masked = (k, v, id) => (k === 'password' && !show.has(id) ? (v ? '••••••••' : '（空）') : v || '（空）');
  const allChoosers = [];
  // obj.choice を A/B ラジオで切り替える部品
  const chooser = (obj, onChange = null) => {
    const name = `c${allChoosers.length}`;
    const rA = h('input', { type: 'radio', name, checked: obj.choice === 'a', 'aria-label': 'A を採用', onchange: () => { obj.choice = 'a'; onChange?.(); } });
    const rB = h('input', { type: 'radio', name, checked: obj.choice === 'b', 'aria-label': 'B を採用', onchange: () => { obj.choice = 'b'; onChange?.(); } });
    allChoosers.push({ obj, rA, rB });
    return [rA, rB];
  };
  const kindLabel = { modified: '変更', onlyA: 'Aのみ', onlyB: 'Bのみ' };
  const rows = res.diffs.map((d, i) => {
    const e = d.a || d.b;
    const path = [...e.path, e.node.name].join(' / ');
    let body;
    if (d.kind === 'modified') {
      const tbl = h('table', { class: 'difftable' });
      const draw = () => clear(tbl,
        h('tr', {}, h('th', {}, '項目'), h('th', {}, 'A'), h('th', {}, 'B')),
        d.fields.map((f) => {
          const [rA, rB] = chooser(f);
          return h('tr', { class: f.auto ? 'auto' : 'conflict' },
            h('td', {}, f.label, f.auto ? h('span', { class: 'badge' }, '自動') : null),
            h('td', { class: 'pre' }, h('label', { class: 'pick' }, rA, ' ', masked(f.key, d.a.node[f.key], i))),
            h('td', { class: 'pre' }, h('label', { class: 'pick' }, rB, ' ', masked(f.key, d.b.node[f.key], i))));
        }),
        d.moved ? (() => { const [rA, rB] = chooser(d); return h('tr', {}, h('td', {}, '場所'), h('td', {}, h('label', { class: 'pick' }, rA, ' ', d.a.path.join(' / '))), h('td', {}, h('label', { class: 'pick' }, rB, ' ', d.b.path.join(' / ')))); })() : null);
      draw();
      body = [tbl, d.fields.some((f) => f.key === 'password') ? h('button', { class: 'link small', onclick: () => { show.has(i) ? show.delete(i) : show.add(i); draw(); } }, 'パスワードを表示/隠す') : null];
    } else {
      const [rA, rB] = chooser(d);
      const [la, lb] = d.kind === 'onlyA' ? ['残す', '削除する'] : ['追加しない', '追加する'];
      body = [h('p', { class: 'small' }, d.kind === 'onlyA' ? (d.reason === 'B で削除済み' ? 'B で削除されています。' : 'A にだけあります。') : (d.reason === 'A で削除済み' ? 'A で削除されています。' : 'B にだけあります。')),
        h('div', { class: 'choice' }, h('label', {}, rA, ` ${la}（A）`), h('label', {}, rB, ` ${lb}（B）`))];
    }
    return h('div', { class: 'diff' },
      h('div', { class: 'diff-head' }, h('span', { class: `badge ${d.kind}` }, kindLabel[d.kind]), h('strong', {}, path), h('span', { class: 'muted small' }, `　${d.reason}`)),
      body);
  });
  const prow = res.profile.map((p) => {
    const [rA, rB] = chooser(p);
    return h('div', { class: 'diff' }, h('div', { class: 'diff-head' }, h('span', { class: 'badge modified' }, '個人情報'), h('strong', {}, p.label)),
      h('table', { class: 'difftable' }, h('tr', {}, h('td', {}, h('label', { class: 'pick' }, rA, ' A: ', p.a || '（空）'))), h('tr', {}, h('td', {}, h('label', { class: 'pick' }, rB, ' B: ', p.b || '（空）')))));
  });
  const setAll = (c) => { for (const { obj, rA, rB } of allChoosers) { obj.choice = c; (c === 'a' ? rA : rB).checked = true; } };
  const v = await modal({
    title: '比較・統合',
    wide: true,
    body: [
      h('table', { class: 'kv' },
        h('tr', {}, h('th', {}, 'A'), h('td', {}, labelA, newer === 'a' ? h('span', { class: 'badge newer' }, '新しい') : null)),
        h('tr', {}, h('th', {}, 'B'), h('td', {}, labelB, newer === 'b' ? h('span', { class: 'badge newer' }, '新しい') : null))),
      h('p', { class: 'muted small' }, base
        ? `違い ${res.diffs.length + res.profile.length} 件。共通の元の版と比べて、片方だけが変えた項目は「自動」で反映済みです。両方が変えた項目だけ確認してください。`
        : `違い ${res.diffs.length + res.profile.length} 件。項目ごとに採用する方を選んでください（初期値は更新日時が新しい方）。`),
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => setAll('a') }, 'すべて A'), h('button', { class: 'btn small', onclick: () => setAll('b') }, 'すべて B')),
      h('div', { class: 'diffs' }, rows, prow)],
    buttons: [{ label: 'キャンセル', value: false }, { label: '統合を適用', value: true, kind: 'primary' }],
  });
  if (!v) return false;
  if (editLocked()) return false;
  S.vault = mergeVaults(S.vault, B, res);
  normalizeVault(S.vault);
  if (S.kind === 'kagi' && otherHeader) S.header = absorbHeader(S.header, otherHeader);
  markDirty();
  S.sel = null;
  renderMain();
  toast('統合しました。内容を確認して保存してください', 4000);
  return true;
}

// ---------------- 端末内の履歴 ----------------
async function historyDialog() {
  const k = S.knownKey ? await store.getKnown(S.knownKey) : null;
  if (!k?.snapshots?.length) { await modal({ title: 'この端末の履歴', body: [h('p', {}, 'まだ履歴がありません。保存またはファイルを開くと記録されます。')] }); return; }
  let action = null;
  const list = h('ul', { class: 'plain-list' }, k.snapshots.map((s, i) => h('li', {},
    h('span', {}, `第${s.revision}版`, i === 0 ? h('span', { class: 'badge newer' }, '最新') : null),
    h('span', { class: 'muted small' }, `${fmtDateTime(s.savedAt)} / ${s.device || ''}`),
    h('button', { class: 'btn small', onclick: () => { action = ['compare', s]; document.querySelector('.overlay .modal-head .icon-btn').click(); } }, '比較'),
    h('button', { class: 'btn small', onclick: () => { action = ['restore', s]; document.querySelector('.overlay .modal-head .icon-btn').click(); } }, 'この版に戻す'))));
  await modal({ title: 'この端末の履歴（暗号化済みの控え）', body: [h('p', { class: 'muted small' }, '保存や読み込みのたびに最大30版を端末内に残しています。デグレ時の復旧に使えます。'), list], buttons: [] });
  if (!action) return;
  const snap = await loadSnapshot(action[1]);
  if (!snap) return;
  normalizeVault(snap.vault);
  if (action[0] === 'compare') {
    let newer = null, base = null;
    if (S.header && snap.header) {
      const rel = compareHeaders(S.header, snap.header);
      newer = rel === 'a' || rel === 'b' ? rel : null;
      if (rel === 'a') base = snap.vault;                  // 控えは、いま開いている版の祖先
      else if (rel === 'b') base = await openedVersion();  // いま開いている版は、控えの祖先
      else if (rel === 'diverged') base = await findAncestorVault(S.header, snap.header);
    }
    await mergeDialog(snap.vault, { labelA: 'いま開いている版', labelB: `端末内の第${action[1].revision}版`, newer, base, otherHeader: snap.header });
  } else if (await confirmDialog('この版に戻す', `端末内の第${action[1].revision}版（${fmtDateTime(action[1].savedAt)}）の内容に置き換えます。保存するまでファイルには反映されません。`, '戻す')) {
    S.vault = snap.vault;
    markDirty();
    S.sel = null;
    renderMain();
  }
}

// ---------------- その他のダイアログ ----------------
// ================= メニュー（PC はメニューバー、スマホは ☰ の一覧） =================
/** メニューの中身。'-' は区切り線。[キー, 表示名, { key: ショートカット表示, checked, disabled }] */
function menuGroups() {
  const e = selected();
  const isItem = e?.node.type === 'item';
  const isFolder = e?.node.type === 'folder';
  const ro = !!settings.readOnly;
  const pw = settings.paneWidth || 'normal';
  const groups = [
    ['file', 'ファイル', 'F', [
      ['save', '上書き保存', { key: 'Ctrl+S' }],
      ['saveAs', '名前を付けて保存（.kagi）', { key: 'Ctrl+Shift+S' }],
      '-',
      ['appendFile', '別のファイルから追加で読み込む（.kagi / .idm / .xml）'],
      ['compare', '別のファイルと比較・統合'],
      ['history', 'この端末の履歴（デグレからの復旧）'],
      '-',
      ['csvImport', 'CSV から取り込む（Chrome・Bitwarden・KeePass など）'],
      ['csvExport', 'CSV に書き出す'],
      ['xmlImport', 'XML から読み込む'],
      '-',
      ['print', '印刷', { pc: true, key: 'Ctrl+P' }],
      '-',
      ['lock', 'ロック', { key: 'Ctrl+L' }],
      ['close', 'ファイルを閉じる'],
      ...(host.isDesktop ? [['quit', 'Kagibako を終了']] : []),
    ]],
    ['edit', '編集', 'E', [
      ['newItem', '新しいアイテム', { disabled: ro, key: 'Ctrl+N' }],
      ['newFolder', '新しいフォルダ', { disabled: ro, key: 'Ctrl+Shift+N' }],
      ['newSub', '選んだフォルダの中にフォルダを作る', { disabled: ro || !isFolder }],
      ['duplicate', '選んだアイテムを複製', { disabled: ro || !isItem, key: 'Ctrl+D' }],
      ['delete', '選んだものを削除', { disabled: ro || !e, key: 'Delete' }],
      ['rename', '名前を変える', { pc: true, disabled: ro || !e, key: 'F2' }],
      '-',
      ['copyId', 'ID をコピー', { pc: true, disabled: !isItem, key: 'Ctrl+B' }],
      ['copyPw', 'パスワードをコピー', { pc: true, disabled: !isItem, key: 'Ctrl+C' }],
      ['openSite', '公式サイトを開く', { pc: true, disabled: !isItem, key: 'Ctrl+U' }],
      '-',
      ['find', '検索', { pc: true, key: 'Ctrl+F' }],
      ['sort', '名前順に並べ替え（選んだフォルダの中）', { disabled: ro }],
      '-',
      ['readOnly', '閲覧のみにする（誤って書き換えないように）', { checked: ro, key: 'Ctrl+E' }],
    ]],
    ['tools', 'ツール', 'T', [
      ['urlAudit', 'URL の点検（公式ドメインか確かめる）'],
      ['pwCheck', 'パスワードの点検（使い回し・弱いもの）'],
      ...(host.isDesktop ? [['typeSelected', '選んだアイテムを自動入力', { disabled: !isItem, key: 'Ctrl+T' }], ['autotype', '自動入力するアイテムを選ぶ（ホットキーと同じ）'], ['probe', 'ブラウザの読み取りテスト']] : []),
      ['gen', 'パスワード生成（生成だけ）', { key: 'Ctrl+G' }],
      ['expired', '有効期限切れのアイテム一覧'],
      ['profile', '個人情報・既定の項目名'],
      '-',
      ['changePw', 'マスターパスワードの変更'],
      ['settings', '設定'],
    ]],
    ['view', '表示', 'V', [
      ['expandAll', 'ツリーをすべて開く', { pc: true }],
      ['collapseAll', 'ツリーをすべて閉じる', { pc: true }],
      '-',
      ['pane:normal', '入力欄の幅：標準', { pc: true, checked: pw === 'normal' }],
      ['pane:wide', '入力欄の幅：広い', { pc: true, checked: pw === 'wide' }],
      ['pane:full', '入力欄の幅：ウィンドウいっぱい', { pc: true, checked: pw === 'full' }],
      ['sideReset', 'ツリーの幅を元に戻す', { pc: true, disabled: !settings.sideWidth }],
      '-',
      ['theme:auto', '画面の色：自動（端末に合わせる）', { checked: (settings.theme || 'auto') === 'auto' }],
      ['theme:light', '画面の色：ライト', { checked: settings.theme === 'light' }],
      ['theme:dark', '画面の色：ダーク', { checked: settings.theme === 'dark' }],
      '-',
      ['colorChars', 'パスワードを文字の種類で色分け', { checked: settings.colorChars !== false }],
      ...(host.isDesktop ? [['topMost', '常に手前に表示', { checked: !!settings.topMost }]] : []),
    ]],
    ['help', 'ヘルプ', 'H', [
      ['howto', '使い方', { key: 'F1' }],
      ...(isPhone() ? [['tutorial', 'はじめての方へ（かんたんな案内）'], ['practice', 'ログインの練習（自動入力を試す）', { disabled: !!settings.readOnly }]] : []),
      ['faq', 'よくある質問'],
      ['shortcuts', 'キー操作の一覧', { pc: true }],
      '-',
      ['officialList', `主要サービスの公式ドメイン一覧（${BRANDS.length} 件）`],
      ['guide', '安全ガイド（よくある手口と対策）'],
      ['disclaimer', '免責事項'],
      // スマホ版だけ：紹介・レビュー（作業の邪魔をする割り込み表示はせず、ここに置くだけ）
      ...(host.isAndroid ? ['-', ['shareApp', 'このアプリを友達に紹介する'], ...(PLAY_STORE_LISTED ? [['reviewApp', 'このアプリをレビューする']] : [])] : []),
      ['about', 'Kagibako について'],
    ]],
  ];
  if (!isPhone()) return groups;
  // スマホ：キーボード・マウス・広い画面のための項目（キー操作・幅・ツリーの開け閉め・印刷など）は出さない。
  // コピー・公式サイト・名前の変更は、アイテムの画面に大きなボタンがある
  return groups.map(([id, title, acc, items]) => {
    const kept = items.filter((x) => x === '-' || !x[2]?.pc);
    return [id, title, acc, kept.filter((x, i) => x !== '-' || (i > 0 && i < kept.length - 1 && kept[i - 1] !== '-'))];
  });
}

async function runMenu(k) {
  const e = selected();
  if (k.startsWith('theme:')) {
    settings.theme = k.slice(6);
    await store.setSetting('settings', { ...settings });
    return applyFontScale();
  }
  if (k.startsWith('pane:')) {
    settings.paneWidth = k.slice(5);
    await store.setSetting('settings', { ...settings });
    return applyLayoutSettings();
  }
  switch (k) {
    case 'save': return save();
    case 'saveAs': return save({ as: 'kagi' });
    case 'appendFile': return appendFromFileFlow();
    case 'compare': return compareWithFileFlow();
    case 'history': return historyDialog();
    case 'print': return printDialog();
    case 'xmlImport': return xmlImportFlow();
    case 'csvImport': return csvImportFlow();
    case 'csvExport': return csvExportFlow();
    case 'lock': return lock();
    case 'rename': { const t = $detail.querySelector(e?.node.type === 'item' ? '.title-input' : 'input'); t?.focus(); t?.select(); return undefined; }
    case 'copyId': return e?.node.type === 'item' ? copyText(e.node.account, e.node.accountName || 'ID') : undefined;
    case 'copyPw': return e?.node.type === 'item' ? copyText(e.node.password, e.node.passwordName || 'パスワード') : undefined;
    case 'openSite': return e?.node.type === 'item' ? openOfficialSite(e.node) : undefined;
    case 'typeSelected': return e?.node.type === 'item' ? autoTypeItem(e.node, { useHotkeyTarget: false }) : undefined;
    case 'quit': return host.call('quit').catch((e) => toast(errText(e)));
    case 'newItem': return isPhone() ? phoneNewItem(S.phoneFolder) : addItem();
    // スマホは「今開いているフォルダの中」に作る
    case 'newFolder': return isPhone() ? phoneNewFolder(S.phoneFolder) : addFolder(false);
    case 'newSub': return addFolder(true);
    case 'duplicate': return e?.node.type === 'item' ? duplicateItem(e.node, e.parent) : undefined;
    case 'delete': return e ? deleteNode(e.node, e.parent) : undefined;
    case 'find': return document.querySelector('.search')?.focus();
    case 'readOnly': return toggleReadOnly();
    case 'sort': return sortSelected();
    case 'expandAll': return setAllOpen(true);
    case 'collapseAll': return setAllOpen(false);
    case 'sideReset':
      settings.sideWidth = 0;
      await store.setSetting('settings', { ...settings });
      return applyLayoutSettings();
    case 'colorChars':
      settings.colorChars = settings.colorChars === false;
      await store.setSetting('settings', { ...settings });
      renderDetail();
      return toast(settings.colorChars ? 'パスワードを文字の種類で色分けします' : '色分けをやめました');
    case 'profile': return profileDialog();
    case 'gen': return generatorDialog(); // メニューからは「生成だけ」（選んでいるアイテムには触れない）
    case 'expired': return expiredListDialog();
    case 'changePw': return changePasswordDialog();
    case 'settings': return settingsDialog();
    case 'probe': return browserProbeDialog();
    case 'urlAudit': return urlAuditDialog();
    case 'pwCheck': return passwordCheckDialog();
    case 'officialList': return officialListDialog();
    case 'howto': return helpDialog(HOWTO);
    case 'faq': return helpDialog(FAQ);
    case 'shortcuts': return isPhone() ? undefined : shortcutsDialog();
    case 'guide': return guideDialog();
    case 'disclaimer': return disclaimerDialog(false);
    case 'tutorial': return tutorialDialog();
    case 'practice': return startPractice();
    case 'about': return aboutDialog();
    case 'shareApp':
      return host.call('share', {
        title: 'Kagibako（鍵箱）',
        text: `パスワード管理アプリ「Kagibako（鍵箱）」を紹介します。データは暗号化して手元に保存、偽サイトでは自動入力しません。無料・広告なしです。\n${PLAY_STORE_LISTED ? PLAY_STORE_URL : INTRO_URL}`,
      }).catch((e) => toast(`共有の画面を開けませんでした（${errText(e)}）`, 5000));
    case 'reviewApp':
      return host.call('openStore', {}).catch((e) => toast(`ストアを開けませんでした（${errText(e)}）`, 5000));
    case 'topMost':
      settings.topMost = !settings.topMost;
      await store.setSetting('settings', { ...settings });
      await host.call('topMost', { on: settings.topMost }).catch((err) => toast(errText(err)));
      return toast(settings.topMost ? '常に手前に表示します' : '常に手前に表示をやめました');
    case 'autotype': {
      const t = await host.call('getTarget', { which: 'last' }).catch(() => ({ ok: false }));
      if (!t.ok) { toast('入力先のウィンドウがありません。入力したい画面を一度クリックしてください'); return; }
      return hotkeyPicker(t, 'last');
    }
    case 'close':
      if (S.dirty && !(await confirmDialog('閉じる', '未保存の変更があります。破棄して閉じますか？', '破棄して閉じる', true))) return;
      wipeSession(); S.file = null; renderStart();
  }
}

// ================= 印刷 =================
async function printDialog() {
  const withPw = h('input', { type: 'checkbox' });
  const withMemo = h('input', { type: 'checkbox', checked: true });
  const onlySel = h('input', { type: 'checkbox' });
  const sel = selected();
  const scopeFolder = sel ? (sel.node.type === 'folder' ? sel.node : sel.parent) : null;
  const ok = await modal({
    title: '印刷',
    body: [
      h('label', { class: 'check' }, withMemo, 'メモも印刷する'),
      scopeFolder ? h('label', { class: 'check' }, onlySel, `「${scopeFolder.name}」フォルダだけ印刷する`) : null,
      h('label', { class: 'check' }, withPw, 'パスワードも印刷する'),
      h('p', { class: 'warn small' }, 'パスワードを印刷した紙は、金庫など人目に触れない場所で保管してください。不要になったらシュレッダーで処分しましょう。'),
    ],
    buttons: [{ label: 'キャンセル', value: false }, { label: '印刷する', value: true, kind: 'primary' }],
  });
  if (!ok) return;
  if (withPw.checked && !(await passwordPrompt('本人確認', 'パスワードを印刷するには、マスターパスワードを入力してください。', { check: verifyMasterPassword }))) return;
  const roots = onlySel.checked && scopeFolder ? [scopeFolder] : S.vault.children;
  const rows = [];
  for (const { node, path } of M.walk(roots)) {
    if (node.type !== 'item') continue;
    rows.push(h('tr', {},
      h('td', {}, [...path, ''].join(' / ').replace(/ \/ $/, '')),
      h('td', {}, node.name),
      h('td', {}, node.account),
      h('td', {}, withPw.checked ? node.password : '••••••'),
      h('td', {}, [node.item1 ? `${node.item1Name || '項目1'}: ${node.item1}` : '', node.item2 ? `${node.item2Name || '項目2'}: ${node.item2}` : '', node.serialNumber ? `シリアル: ${node.serialNumber}` : ''].filter(Boolean).join('\n')),
      h('td', {}, node.url),
      h('td', {}, node.expirationDate || ''),
      withMemo.checked ? h('td', {}, node.comment) : null));
  }
  const root = h('div', { id: 'print-root' },
    h('h1', {}, `${S.file?.name || 'Kagibako'}（${new Date().toLocaleDateString('ja-JP')} 印刷）`),
    h('table', { class: 'print-table' },
      h('thead', {}, h('tr', {}, ['フォルダ', 'タイトル', 'ID', 'パスワード', 'その他', 'URL', '有効期限', withMemo.checked ? 'メモ' : null].filter(Boolean).map((t) => h('th', {}, t)))),
      h('tbody', {}, rows)));
  document.body.append(root);
  try { window.print(); } finally { setTimeout(() => root.remove(), 1000); }
}

// ================= XML の読み込み =================
function decodeXmlBytes(bytes) {
  const head = new TextDecoder('ascii').decode(bytes.subarray(0, 200));
  const enc = (head.match(/encoding="([^"]+)"/i)?.[1] || '').toLowerCase();
  if (enc.includes('shift') || enc.includes('sjis') || enc.includes('windows-31j')) return new TextDecoder('shift_jis').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); } catch { return new TextDecoder('shift_jis').decode(bytes); }
}

/** 取り込んだデータに新しい ID を振り直す（同じファイルを2回取り込んでも ID が重ならないように） */
function freshIds(nodes) {
  for (const { node } of M.walk(nodes)) node.id = M.uuid();
  return nodes;
}

function appendAsFolder(vault, name) {
  normalizeVault(vault);
  const f = M.newFolder(name);
  f.children = freshIds(vault.children);
  S.vault.children.push(f);
  markDirty();
  S.sel = f.id;
  renderMain();
  const n = M.countItems({ children: f.children }).items;
  toast(`「${name}」フォルダに ${n} 件を追加しました。保存をお忘れなく`, 5000);
}

async function xmlImportFlow() {
  if (editLocked()) return;
  const f = await fio.pickFile().catch((e) => { toast(errText(e)); return null; });
  if (!f) return;
  let v;
  try { v = L.legacyXmlToVault(decodeXmlBytes(f.bytes)); } catch (e) { toast(`読み込めませんでした: ${errText(e)}`, 6000); return; }
  const n = M.countItems(v).items;
  const mode = M.countItems(S.vault).items ? await modal({
    title: 'XML から読み込む',
    body: [h('p', {}, `${f.name}：アイテム ${n} 件`), h('p', {}, '今のデータに追加しますか？ それとも置き換えますか？')],
    buttons: [{ label: 'キャンセル', value: null }, { label: '置き換える', value: 'replace', kind: 'danger' }, { label: '追加する', value: 'append', kind: 'primary' }],
  }) : 'replace';
  if (!mode) return;
  if (mode === 'append') return appendAsFolder(v, f.name.replace(/\.xml$/i, ''));
  if (M.countItems(S.vault).items && !(await confirmDialog('置き換えの確認', `今のデータ（アイテム ${M.countItems(S.vault).items} 件）を、XML の内容で置き換えます。保存するまではファイルに反映されません。`, '置き換える', true))) return;
  normalizeVault(v);
  const now = Date.now();
  for (const { node } of M.walk(S.vault.children)) S.vault.tombstones.push({ id: node.id, deletedAt: now });
  S.vault.children = v.children;
  S.vault.profile = v.profile;
  S.vault.defaults = v.defaults;
  S.vault.pasteTypeListXml = v.pasteTypeListXml;
  markDirty();
  S.sel = null;
  renderMain();
  toast(`XML の内容（${n} 件）に置き換えました。保存をお忘れなく`, 5000);
}

async function appendFromFileFlow() {
  if (editLocked()) return;
  const f = await fio.pickFile().catch((e) => { toast(errText(e)); return null; });
  if (!f) return;
  if (/\.xml$/i.test(f.name)) {
    try { return appendAsFolder(L.legacyXmlToVault(decodeXmlBytes(f.bytes)), f.name.replace(/\.xml$/i, '')); }
    catch (e) { toast(`読み込めませんでした: ${errText(e)}`, 6000); return; }
  }
  const other = await unlockOther(f);
  if (!other) return;
  appendAsFolder(other.vault, baseName(f.name));
}

async function profileDialog() {
  const p = S.vault.profile;
  const ro = !!settings.readOnly;
  const row = (k, label, obj, typable = false) => h('div', { class: 'frow' }, h('span', { class: 'flabel' }, label),
    h('input', { type: 'text', value: obj[k] ?? '', readonly: ro, ...asciiInput(k), oninput: (e) => { if (ro) return; obj[k] = e.target.value; markDirty(); } }),
    h('div', { class: 'fbtns' }, ibtn('copy', `${label}をコピー`, () => copyText(obj[k], label), { cls: 'small' }),
      typable && host.isDesktop ? ibtn('autotype', `${label}を直前のウィンドウに入力`, () => autoTypeText(obj[k], label), { cls: 'small' }) : null));
  await modal({
    title: '個人情報',
    wide: true,
    body: [host.isDesktop ? h('p', { class: 'muted small' }, 'キーボードの絵のボタンで、その項目を直前のウィンドウ（申し込みフォームなど）に入力できます。') : null,
      M.PROFILE_FIELDS.map(([k, label]) => row(k, label, p, true)),
      h('h3', {}, '新規アイテムの既定の項目名'),
      row('accountName', 'ID欄', S.vault.defaults), row('passwordName', 'パスワード欄', S.vault.defaults),
      row('item1Name', '項目1', S.vault.defaults), row('item2Name', '項目2', S.vault.defaults)],
  });
}

/** 文字の種類（大文字・小文字・数字・記号）ごとに色を付けた表示。設定で色分けをやめられる */
function charSpans(text) {
  const s = String(text ?? '');
  if (settings.colorChars === false) return [s];
  const kind = (ch) => (/[A-Z]/.test(ch) ? 'c-up' : /[a-z]/.test(ch) ? 'c-lo' : /[0-9]/.test(ch) ? 'c-dg' : 'c-sy');
  const out = [];
  let cur = '', cls = '';
  for (const ch of s) {
    const k = kind(ch);
    if (k !== cls && cur) { out.push(h('span', { class: cls }, cur)); cur = ''; }
    cls = k; cur += ch;
  }
  if (cur) out.push(h('span', { class: cls }, cur));
  return out;
}

const charLegend = () => h('span', { class: 'char-legend small' },
  h('span', { class: 'c-up' }, 'ABC'), ' 大文字 ', h('span', { class: 'c-lo' }, 'abc'), ' 小文字 ',
  h('span', { class: 'c-dg' }, '123'), ' 数字 ', h('span', { class: 'c-sy' }, '#$%'), ' 記号');

/** 押している間くり返すボタン（▲▼ など） */
function repeatButton(label, title, fn) {
  let timer = null;
  const stop = () => { clearTimeout(timer); timer = null; };
  const start = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    fn();
    const tick = (ms) => { timer = setTimeout(() => { fn(); tick(Math.max(40, ms * 0.8)); }, ms); };
    tick(400);
  };
  const b = h('button', { class: 'btn small spin', type: 'button', title, 'aria-label': title }, label);
  b.addEventListener('pointerdown', start);
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) b.addEventListener(ev, stop);
  b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
  return b;
}

const GEN_MIN = 4, GEN_MAX = 128;

/**
 * パスワード生成。
 * ・item を渡したとき（アイテムのパスワード欄の［生成］）だけ、そのアイテムのパスワードを置き換えられる
 * ・メニューやショートカットから開いたときは「生成だけ」。今選んでいるアイテムには触れない
 *   （新しいアカウントを登録中に、開いていた別のアイテムのパスワードを誤って変えないように）
 */
async function generatorDialog(item = null) {
  // 条件：アイテムの［生成］からなら、そのアイテムで前回使った条件（サイトごとに使える記号が違うため）を使う
  const fromItem = item?.genRule && typeof item.genRule === 'object' ? item.genRule : null;
  const opt = { length: 20, upper: true, lower: true, digit: true, symbol: true, excludeSimilar: true, symbols: ALL_SYMBOLS, ...(await store.getSetting('gen', {})), ...(fromItem || {}) };
  opt.length = Math.max(GEN_MIN, Math.min(GEN_MAX, opt.length | 0 || 20));
  opt.symbols = normalizeSymbols(opt.symbols ?? ALL_SYMBOLS);
  const ruleOf = (o) => ({ length: o.length, upper: !!o.upper, lower: !!o.lower, digit: !!o.digit, symbol: !!o.symbol, excludeSimilar: !!o.excludeSimilar, symbols: o.symbols });
  let value = '';
  const out = h('div', { class: 'gen-out', 'aria-live': 'polite', 'aria-label': '生成したパスワード' });
  const meter = h('div', { class: 'meter' });
  const legend = charLegend();
  const regen = () => {
    try { value = generatePassword(opt); } catch (e) { value = ''; toast(e.message); }
    clear(out, ...charSpans(value));
    legend.style.visibility = settings.colorChars === false ? 'hidden' : ''; // 消しても場所は残す（画面の大きさを変えない）
    const bits = estimateBits(value); const [l, c] = strengthLabel(bits);
    meter.className = `meter ${c}`; meter.textContent = `強度: ${l}（約${bits}bit）・${[...value].length} 文字`;
    if (!item) store.setSetting('gen', ruleOf(opt)); // アイテムの［生成］で変えた条件はそのアイテムにだけ覚え、ふだん（メニュー）の条件は変えない
  };
  // 文字数：▲▼（押し続けると連続）・直接入力・よく使う長さ
  const lenInput = h('input', { type: 'number', class: 'len-input', min: GEN_MIN, max: GEN_MAX, step: 1, value: opt.length, 'aria-label': '文字数' });
  const setLen = (n) => {
    const v = Math.max(GEN_MIN, Math.min(GEN_MAX, Math.round(n)));
    if (!Number.isFinite(v)) return;
    lenInput.value = v;
    if (v !== opt.length) { opt.length = v; regen(); }
  };
  lenInput.addEventListener('input', () => { const n = +lenInput.value; if (lenInput.value !== '' && n >= GEN_MIN && n <= GEN_MAX) setLen(n); });
  lenInput.addEventListener('change', () => setLen(+lenInput.value || opt.length));
  lenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); setLen(+lenInput.value || opt.length); } });
  const presets = [12, 16, 20, 32].map((n) => h('button', { class: 'btn small', type: 'button', onclick: () => setLen(n) }, String(n)));
  const cb = (k, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: opt[k], onchange: (e) => { opt[k] = e.target.checked; if (k === 'symbol') drawSyms(); regen(); } }), label);
  // 使う記号：1つずつ切り替えられるボタンと、よく使う組み合わせ（サイトによって使えない記号があるため）
  const symRow = h('div', { class: 'sym-row', role: 'group', 'aria-label': '使う記号' });
  const symCount = h('span', { class: 'muted small' });
  const presetSel = h('select', { class: 'sym-preset', 'aria-label': '記号の組み合わせ' },
    SYMBOL_PRESETS.map(([k, label]) => h('option', { value: k }, label)), h('option', { value: 'custom' }, '自分で選ぶ（下のボタン）'));
  const drawSyms = () => {
    clear(symRow, [...ALL_SYMBOLS].map((ch) => {
      const on = opt.symbols.includes(ch);
      return h('button', { type: 'button', class: `sym-chip${on ? ' on' : ''}`, disabled: !opt.symbol, 'aria-pressed': String(on), title: on ? `「${ch}」を使わない` : `「${ch}」を使う`,
        onclick: () => { opt.symbols = normalizeSymbols(on ? opt.symbols.replace(ch, '') : opt.symbols + ch); drawSyms(); regen(); } }, ch);
    }));
    const p = SYMBOL_PRESETS.find(([, , s]) => s === opt.symbols);
    presetSel.value = p ? p[0] : 'custom';
    presetSel.disabled = !opt.symbol;
    symCount.textContent = opt.symbol ? (opt.symbols ? `${opt.symbols.length} 種類` : '記号なし') : '（記号を使わない）';
  };
  presetSel.addEventListener('change', () => { const p = SYMBOL_PRESETS.find(([k]) => k === presetSel.value); if (p) { opt.symbols = p[2]; drawSyms(); regen(); } });
  drawSyms();
  const colorCb = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: settings.colorChars !== false, onchange: async (e) => {
    settings.colorChars = e.target.checked; await store.setSetting('settings', { ...settings }); clear(out, ...charSpans(value)); legend.style.visibility = e.target.checked ? '' : 'hidden';
  } }), '文字の種類で色分けする');
  regen();
  const v = await modal({
    title: 'パスワード生成',
    body: [out, meter, h('div', { class: 'gen-legend' }, legend),
      h('div', { class: 'field' }, h('span', {}, '文字数'),
        h('div', { class: 'row tight len-row' },
          repeatButton('▼', '1文字減らす', () => setLen(opt.length - 1)),
          lenInput,
          repeatButton('▲', '1文字増やす', () => setLen(opt.length + 1)),
          h('span', { class: 'muted small' }, `文字（${GEN_MIN}〜${GEN_MAX}）`),
          h('span', { class: 'presets' }, presets))),
      h('div', { class: 'row wrap' }, cb('upper', '大文字'), cb('lower', '小文字'), cb('digit', '数字'), cb('symbol', '記号'), cb('excludeSimilar', '紛らわしい文字（I l 1 O 0 o |）を除く')),
      h('div', { class: 'sym-box' }, h('div', { class: 'row tight' }, h('span', { class: 'muted small' }, '使う記号'), presetSel, symCount), symRow),
      h('div', { class: 'row wrap' }, ibtn('regenerate', '作り直す', regen, { text: '作り直す' }), ibtn('copy', 'コピー', () => copyText(value, 'パスワード'), { text: 'コピー' }), colorCb),
      item ? h('p', { class: 'muted small' }, `「${item.name || '名前なし'}」のパスワード欄から開いています。${fromItem ? '前回このアイテムで使った条件（文字数・記号）で作っています。' : ''}置き換えると、今のパスワードは「履歴」に残り、この条件をアイテムに覚えます。`)
        : null],
    buttons: item
      ? [{ label: '閉じる', value: null }, { label: `「${item.name || '名前なし'}」のパスワードを置き換える`, value: 'apply', kind: 'primary' }]
      : [{ label: '閉じる', value: null }, ...(settings.readOnly || !S.vault ? [] : [{ label: '新しいアイテムを作ってこのパスワードを入れる', value: 'new', kind: 'primary' }])],
  });
  if (v === 'new' && !item) {
    if (editLocked()) return;
    addItem(); // 選んでいる場所に新しいアイテムを作り、タイトルの欄を選んだ状態にする
    const created = selected()?.node;
    if (created?.type !== 'item') return;
    created.password = value;
    created.genRule = ruleOf(opt); // 次にこのアイテムで生成するときも同じ条件
    touch(created);
    renderDetail();
    $detail.querySelector('.title-input')?.select();
    toast('新しいアイテムにパスワードを入れました。タイトルと ID を入れて保存してください', 5000);
    return;
  }
  if (v === 'apply' && item) {
    if (editLocked()) return;
    M.pushPasswordHistory(item, item.password);
    item.password = value;
    item.genRule = ruleOf(opt); // このサイトで使える条件として覚える（次にパスワードを変えるときに使う）
    item.issueDate = M.todayISO(); // パスワードを変えたら発行日も更新する
    touch(item);
    renderDetail();
    toast('パスワードを設定しました（保存をお忘れなく）');
  }
}

async function changePasswordDialog() {
  const cur = await passwordPrompt('マスターパスワードの変更', '現在のパスワードを入力してください。', {
    check: async (p) => {
      if (S.kind === 'kagi' && S.file?.env) { await X.decryptEnvelope(S.file.env, p); return true; }
      if (S.kind === 'legacy' && S.file?.bytes) { L.decryptLegacy(S.file.bytes, L.legacyKey(p)); return true; }
      return true;
    },
  });
  if (!cur) return;
  const next = await passwordPrompt('新しいマスターパスワード', S.kind === 'legacy' ? '8文字以上。保存すると .kagi 形式のファイルになります。' : '8文字以上。長いフレーズがおすすめです。', {
    confirm: true,
    check: (p) => (p.length < 8 ? '8文字以上にしてください' : true),
  });
  if (!next) return;
  S.session = await X.deriveSession(next);
  markDirty();
  toast('パスワードを変更しました。保存すると反映されます', 4000);
  // 指紋・顔で開く設定は古いパスワードを持っているので取り消す（新しいパスワードで開いた後に設定し直せる）
  if (host.isAndroid && S.knownKey) host.call('bioRemove', { key: S.knownKey }).catch(() => {});
}

let lastSettingsTab = 'lock'; // 設定で最後に開いていたタブ

async function settingsDialog() {
  const num = (v, min, max, step = 1) => h('input', { type: 'number', min, max, step, value: v });
  // 数字を打たせず、よく使う値から選ぶ（今の値が選択肢に無ければ、それも残す）
  const choice = (cur, opts) => {
    const list = opts.some(([v]) => v === +cur) ? opts : [...opts, [+cur, `${cur}（今の設定）`]];
    return h('select', {}, list.map(([v, l]) => h('option', { value: String(v), selected: v === +cur }, l)));
  };
  const chk = (v) => h('input', { type: 'checkbox', checked: !!v });
  const err = h('p', { class: 'error' });

  // ---- 一般 ----
  const dev = h('input', { type: 'text', value: settings.deviceName });
  const auto = choice(settings.autoLockMin, [[1, '1分'], [3, '3分'], [5, '5分'], [10, '10分'], [30, '30分'], [60, '1時間'], [0, 'ロックしない']]);
  const hide = chk(settings.lockOnHide);
  const clip = choice(settings.clipSec, [[15, '15秒'], [30, '30秒'], [60, '1分'], [120, '2分'], [0, '消さない']]);
  const rememberLast = chk(settings.rememberLast);
  const density = h('select', {},
    [['compact', 'せまい（たくさん並べる・PC 向け）'], ['comfortable', '広い（指で押しやすい）']].map(([v, l]) => h('option', { value: v, selected: v === settings.density }, l)));
  // ---- 表示 ----
  const font = h('select', {}, [[90, '小'], [100, '標準'], [115, '大'], [130, '特大']].map(([v, l]) => h('option', { value: String(v), selected: v === settings.fontScale }, l)));
  const paneWidth = h('select', {}, [['normal', '標準'], ['wide', '広い'], ['full', 'ウィンドウいっぱい']].map(([v, l]) => h('option', { value: v, selected: v === (settings.paneWidth || 'normal') }, l)));
  const colorChars = chk(settings.colorChars !== false);
  const phoneShowId = chk(!!settings.phoneShowId);
  const autofillBox = host.isAndroid ? await autofillCard() : null;
  const theme = h('select', {}, [['auto', '自動（端末の設定に合わせる）'], ['light', 'ライト（明るい）'], ['dark', 'ダーク（暗い）']].map(([v, l]) => h('option', { value: v, selected: v === (settings.theme || 'auto') }, l)));
  const vw = { ...settings.view };
  const viewChk = (k, label, onChange = null) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!vw[k], onchange: (e) => { vw[k] = e.target.checked; onChange?.(e.target.checked); } }), label);
  // URL を隠すときだけ出す注意（URL は偽サイト対策に使うため）
  const hideUrlNote = h('p', { class: 'warn small', hidden: !vw.hideUrl }, '⚠ URL を出さないと、アイテムに公式サイトの URL を登録・確認できなくなります。URL は偽サイト対策（自動入力の前の照合・URL の点検）に使うので、出しておくのがおすすめです。');
  const validDays = choice(settings.validDays, [[0, '期限なし'], [30, '1か月後'], [90, '3か月後'], [180, '半年後'], [365, '1年後'], [730, '2年後'], [1095, '3年後'], [1825, '5年後']]);
  const expiryNotify = h('select', {},
    [['off', '知らせない'], ['banner', '画面の上に表示する'], ['dialog', 'ファイルを開いたときに一覧で知らせる']].map(([v, l]) => h('option', { value: v, selected: v === settings.expiryNotify }, l)));
  const warnDays = choice(settings.expiryWarnDays, [[7, '7日前'], [14, '2週間前'], [30, '30日前'], [60, '60日前'], [90, '90日前']]);
  // ---- 保存 ----
  const autoSave = chk(settings.autoSaveOnClose);
  const openLast = chk(settings.openLastOnStart !== false);
  // ---- PC版 ----
  const HOTKEYS = [['ctrl+alt+a', 'Ctrl + Alt + A'], ['ctrl+alt+k', 'Ctrl + Alt + K'], ['ctrl+shift+space', 'Ctrl + Shift + Space'], ['ctrl+alt+p', 'Ctrl + Alt + P'], ['', '使わない']];
  const hotkey = h('select', {}, HOTKEYS.map(([v, l]) => h('option', { value: v, selected: v === settings.hotkey }, l)));
  const tray = chk(settings.closeToTray);
  const toTray = chk(settings.minimizeToTray !== false);
  const tmpl = h('input', { type: 'text', class: 'mono', value: settings.autoTypeTemplate, spellcheck: 'false' });
  const startDelay = num(settings.autoStartDelay, 50, 5000, 50);
  const keyDelay = num(settings.keyDelay, 0, 200);
  const minimize = chk(settings.minimizeAfterType);
  const via = h('select', {},
    h('option', { value: 'type', selected: settings.autoTypeVia !== 'clipboard' }, 'キー入力で入力する（ふつうはこちら）'),
    h('option', { value: 'clipboard', selected: settings.autoTypeVia === 'clipboard' }, 'クリップボード経由で貼り付ける（キー入力を受け付けないアプリ用）'));
  const topMost = chk(settings.topMost);
  const browserPath = h('input', { type: 'text', value: settings.browserPath, placeholder: '空欄なら既定のブラウザ（例: C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe）', spellcheck: 'false' });
  const bkOn = chk(settings.backupEnabled);
  const bkDir = h('input', { type: 'text', value: settings.backupDir, placeholder: hostInfo.defaultBackupDir || '（既定のフォルダ）' });
  const bkKeep = num(settings.backupKeep, 1, 1000);

  // 自作の入力手順
  const customs = settings.customTemplates.map((c) => ({ ...c }));
  const customList = h('div', { class: 'custom-templates' });
  const drawCustoms = () => clear(customList,
    customs.length ? customs.map((c, i) => h('div', { class: 'frow' },
      h('span', {}, h('strong', {}, c.name), h('br'), h('code', { class: 'mono small' }, c.template)),
      h('span'),
      h('div', { class: 'fbtns' },
        h('button', { class: 'btn small', onclick: async () => { const r = await templateEditor(c); if (r) { customs[i] = r; drawCustoms(); } } }, '編集'),
        ibtn('delete', '削除', () => { customs.splice(i, 1); drawCustoms(); }, { cls: 'small danger' }))))
      : h('p', { class: 'muted small' }, 'まだありません。'),
    h('button', { class: 'btn small', onclick: async () => { const r = await templateEditor(null); if (r) { customs.push(r); drawCustoms(); } } }, '＋ 手順を追加'));
  drawCustoms();

  const section = (title, ...children) => h('section', { class: 'settings-sec' }, h('h3', {}, title), children);
  // ---- Android：指紋・顔でのロック解除（いま開いているファイル） ----
  const bioBox = host.isAndroid && S.screen === 'main' && S.knownKey ? bioSetupBox() : h('div');
  const field = (label, input, note = null) => h('label', { class: 'field' }, h('span', {}, label), input, note ? h('span', { class: 'muted small field-note' }, note) : null);
  const checkRow = (input, label, note = null) => h('label', { class: 'check' }, input, h('span', {}, label, note ? h('span', { class: 'muted small field-note' }, note) : null));
  // Android：［公式サイトを開く］のブラウザ（選択肢と説明は ui-phone.js の BROWSER_CHOICES。最初の説明・練習と同じ）
  const andBrowser = BROWSER_CHOICES.map(([v, label, note]) => {
    const r = h('input', { type: 'radio', name: 'and-browser', value: v, checked: (settings.androidBrowser || 'chrome') === v });
    return { r, row: checkRow(r, label, note) };
  });

  // 設定を目的ごとのタブに分ける（1画面に全部並べると、どこに何があるか分かりにくいため）
  const tabs = [
    ['lock', '安全', [
      section('自動でロックする',
        field('しばらく操作しなかったらロックする', auto),
        checkRow(hide, host.isDesktop ? 'ウィンドウを最小化したら、すぐにロックする' : 'ほかのアプリに切り替えたら、すぐにロックする')),
      section('コピーしたパスワード',
        field('コピーした ID・パスワードを消すまでの時間', clip, '貼り付けたあと、クリップボードに残さないための設定です')),
      host.isAndroid && S.screen === 'main' && S.knownKey ? section('指紋・顔でのロック解除（このファイル）', bioBox) : null,
    ]],
    ['view', '表示', [
      section('見た目',
        h('div', { class: 'row wrap' }, field('文字の大きさ', font), field('画面の色', theme)),
        field('ボタンや行の間隔', density),
        isPhone() ? null : field('右側（アイテムの中身）の幅', paneWidth, 'ツリーの幅は、ツリーと右側の境目をドラッグして変えられます（ダブルクリックで元に戻ります）')),
      section('一覧とアイテムの表示',
        checkRow(colorChars, 'パスワードを文字の種類ごとに色分けする', '大文字・小文字・数字・記号を色で見分けられます'),
        isPhone() ? checkRow(phoneShowId, '一覧で、名前の下に ID も表示する', '人に画面を見られる場所では外しておくのがおすすめです') : null,
        h('div', { class: 'field' }, h('span', {}, '最初から ●●● で隠しておく欄'),
          h('div', { class: 'row wrap' }, viewChk('maskAccount', 'ID'), viewChk('maskPassword', 'パスワード'), viewChk('maskItem1', '項目1'), viewChk('maskItem2', '項目2'))),
        h('div', { class: 'field' }, h('span', {}, 'アイテムの画面（見る画面・編集の画面）に出さない欄'),
          h('span', { class: 'muted small field-note' }, '使わない欄を隠して、画面をすっきりさせます。入っている中身は消えません。'),
          h('div', { class: 'row wrap' }, viewChk('hideSerial', 'シリアル番号'), viewChk('hideUrl', 'URL', (on) => { hideUrlNote.hidden = !on; }), viewChk('hideEmail', 'メール'), viewChk('hideFile', 'ファイル'), viewChk('hideDates', '日付')),
          hideUrlNote)),
    ]],
    ['autofill', '自動入力', [
      autofillBox,
      host.isAndroid ? section('公式サイトを開くブラウザ', andBrowser.map((x) => x.row)) : null,
      host.isDesktop ? [
        section('自動入力（ブラウザなどへの入力）',
          field('ホットキー', hotkey, '入力したい画面でこのキーを押すと、アイテムを選んで入力できます'),
          field('入力のしかた', via),
          checkRow(minimize, '入力するときに Kagibako を最小化する', 'オフなら、ブラウザの後ろに回るだけです')),
        section('入力の手順',
          field('いつもの入力手順', tmpl, '例: {USER}{TAB}{PASS}{ENTER}（各アイテムで変えることもできます）'),
          h('div', { class: 'row wrap' },
            field('入力を始めるまでの待ち時間（ミリ秒）', startDelay),
            field('1文字ごとの間隔（ミリ秒）', keyDelay)),
          h('p', { class: 'muted small' }, '文字が欠けるときは「1文字ごとの間隔」を増やしてください。'),
          h('div', { class: 'field' }, h('span', {}, '名前を付けて登録した手順'), customList)),
      ] : null,
    ]],
    ['file', '保存', [
      section('保存',
        checkRow(autoSave, '閉じるときに、保存していない変更を自動で保存する', '上書き保存できるファイルだけです'),
        checkRow(openLast, '起動したら、前回開いたファイルのパスワード入力画面を出す', '別のファイルは、その画面の下の「別のファイルを開く」から開けます'),
        checkRow(rememberLast, '次に開いたとき、最後に見ていたアイテムを選んでおく'),
        h('p', { class: 'muted small' }, '保存のたびに、書き込んだファイルを読み直して、正しく保存できたかを確かめています。')),
      section('この端末',
        field('この端末の名前', dev, 'どの端末で保存したかを、ファイルの版の記録に残すために使います')),
      section('アプリの設定などの初期化',
        h('p', { class: 'muted small' }, `${MEMO_WHAT}を空にして、最初からやり直します。調子がおかしいときに使います。${KAGI_SAFE}${KAGI_UNTOUCHED}。`),
        h('button', { class: 'btn small', onclick: () => resetMemoFlow() }, 'アプリの設定などを初期化…')),
      host.isDesktop ? section('自動バックアップ',
        checkRow(bkOn, '保存するたびに、暗号化したままのバックアップを残す'),
        field('バックアップ先', h('div', { class: 'row' }, bkDir,
          h('button', { class: 'btn small', onclick: async () => { const r = await host.call('pickFolder', { initial: bkDir.value || hostInfo.defaultBackupDir }, 0).catch(() => null); if (r?.path) bkDir.value = r.path; } }, '選ぶ…'),
          h('button', { class: 'btn small', onclick: () => host.call('openFolder', { dir: bkDir.value }).catch((e) => toast(errText(e))) }, '開く')),
        'OneDrive などの同期フォルダにすると、PC が壊れても安心です'),
        field('ファイルごとに残す数', bkKeep)) : null,
    ]],
    ['expiry', '期限', [
      section('有効期限（カード・ライセンスなど）',
        h('p', { class: 'muted small' }, 'パスワードを定期的に変える必要はありません（漏えいの疑いがあるときに変えます）。有効期限は、クレジットカード・ソフトのライセンス・資格など、本当に期限があるものに使ってください。'),
        field('新しく作るアイテムの有効期限', validDays),
        h('div', { class: 'row wrap' }, field('期限が近づいたら', expiryNotify), field('何日前から知らせるか', warnDays))),
    ]],
    host.isDesktop ? ['window', 'ウィンドウ', [
      section('ウィンドウ',
        checkRow(topMost, '常に手前に表示する'),
        checkRow(toTray, '最小化したらタスクトレイ（時計の横）にしまう', 'タスクバーには出さず、トレイのアイコンのクリックで戻ります'),
        checkRow(tray, '× で閉じたらタスクトレイにしまう', '終了は、トレイのアイコンを右クリック →「終了」か、メニューの「ファイル → Kagibako を終了」')),
      section('ブラウザ',
        field('「公式サイトを開く」で使うブラウザ', browserPath, '空欄なら、いつものブラウザで開きます')),
    ]] : null,
  ].filter((t) => t && t[2].flat(Infinity).some(Boolean));
  if (!tabs.some(([k]) => k === lastSettingsTab)) lastSettingsTab = tabs[0][0];
  const panels = h('div', { class: 'settings-panels' });
  const tabBar = h('div', { class: 'settings-tabs', role: 'tablist' });
  const showTab = (k) => {
    lastSettingsTab = k;
    for (const b of tabBar.children) { const on = b.dataset.k === k; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    for (const p of panels.children) p.hidden = p.dataset.k !== k;
  };
  for (const [k, label, content] of tabs) {
    tabBar.append(h('button', { class: 'settings-tab', type: 'button', role: 'tab', dataset: { k }, onclick: () => showTab(k) }, label));
    panels.append(h('div', { class: 'settings-panel', role: 'tabpanel', dataset: { k } }, content));
  }
  showTab(lastSettingsTab);

  const ok = await modal({
    title: '設定',
    wide: true,
    cls: 'settings-modal', // タブを切り替えても窓の大きさが変わらないよう、高さを固定する（app.css）
    body: [
      tabBar,
      panels,
      err,
      h('p', { class: 'muted small' }, 'データはこの端末とあなたが選んだ保存先にだけ置かれ、外部へ送信されることはありません。')],
    buttons: [{ label: 'キャンセル', value: false }, { label: '保存', value: true, kind: 'primary', validate: () => {
      const e = host.isDesktop ? AT.templateError(tmpl.value) : null;
      err.textContent = e || '';
      return !e;
    } }],
  });
  if (!ok) return;
  settings.deviceName = dev.value.trim() || guessDevice();
  settings.autoLockMin = Math.max(0, Math.min(120, +auto.value || 0));
  settings.lockOnHide = hide.checked;
  settings.clipSec = Math.max(0, Math.min(600, +clip.value || 0));
  settings.rememberLast = rememberLast.checked;
  settings.fontScale = +font.value || 100;
  settings.density = density.value;
  settings.paneWidth = paneWidth.value;
  settings.theme = theme.value;
  settings.colorChars = colorChars.checked;
  settings.phoneShowId = phoneShowId.checked;
  if (host.isAndroid) settings.androidBrowser = andBrowser.find((x) => x.r.checked)?.r.value || 'chrome';
  settings.view = vw;
  settings.validDays = Math.max(0, Math.min(3650, Number.isFinite(+validDays.value) ? +validDays.value : 365));
  settings.expiryNotify = expiryNotify.value;
  settings.expiryWarnDays = Math.max(0, Math.min(365, +warnDays.value || 0));
  settings.autoSaveOnClose = autoSave.checked;
  settings.openLastOnStart = openLast.checked;
  if (host.isDesktop) {
    settings.hotkey = hotkey.value;
    settings.closeToTray = tray.checked;
    settings.minimizeToTray = toTray.checked;
    settings.autoTypeTemplate = tmpl.value.trim() || AT.DEFAULT_TEMPLATE;
    settings.autoTypeVia = via.value;
    settings.autoStartDelay = Math.max(50, Math.min(5000, +startDelay.value || 400));
    settings.keyDelay = Math.max(0, Math.min(200, +keyDelay.value || 0));
    settings.minimizeAfterType = minimize.checked;
    settings.customTemplates = customs;
    settings.topMost = topMost.checked;
    settings.browserPath = browserPath.value.trim().replace(/^"|"$/g, '');
    settings.backupEnabled = bkOn.checked;
    settings.backupDir = bkDir.value.trim();
    settings.backupKeep = Math.max(1, Math.min(1000, +bkKeep.value || 30));
  }
  await store.setSetting('settings', { ...settings });
  applyFontScale();
  if (S.screen === 'main') renderMain();
  try {
    await applyHostConfig(false);
    toast('設定を保存しました');
  } catch (e) {
    toast(errText(e), 6000);
  }
}

/** 入力手順を作る・直す画面。記号のボタンを押すとカーソル位置に入る。戻り値 {name, template} | null */
async function templateEditor(cur) {
  const name = h('input', { type: 'text', value: cur?.name || '', placeholder: '例: 銀行（ID・Tab・Tab・パスワード）' });
  const tmpl = h('input', { type: 'text', class: 'mono', value: cur?.template || '', placeholder: '{ID}{TAB}{PASSWORD}{ENTER}', spellcheck: 'false' });
  const err = h('p', { class: 'error' });
  const insert = (tok) => {
    const s = tmpl.selectionStart ?? tmpl.value.length, e = tmpl.selectionEnd ?? s;
    tmpl.value = tmpl.value.slice(0, s) + tok + tmpl.value.slice(e);
    tmpl.focus();
    tmpl.setSelectionRange(s + tok.length, s + tok.length);
  };
  let result = null;
  const v = await modal({
    title: cur ? '入力手順の編集' : '入力手順の追加',
    wide: true,
    body: [
      h('label', { class: 'field' }, h('span', {}, '名前'), name),
      h('label', { class: 'field' }, h('span', {}, '手順'), tmpl),
      h('p', { class: 'muted small' }, '押すとカーソルの位置に入ります。それ以外の文字はそのまま入力されます。'),
      h('div', { class: 'token-palette' }, AT.TOKEN_HELP.map(([tok, label]) => h('button', { class: 'btn small', title: tok, onclick: () => insert(tok) }, label))),
      err],
    buttons: [{ label: 'キャンセル', value: false }, { label: 'OK', value: true, kind: 'primary', validate: () => {
      err.textContent = '';
      if (!name.value.trim()) { err.textContent = '名前を入力してください'; return false; }
      if (!tmpl.value.trim()) { err.textContent = '手順を入力してください'; return false; }
      const e = AT.templateError(tmpl.value);
      if (e) { err.textContent = e; return false; }
      result = { name: name.value.trim(), template: tmpl.value.trim() };
      return true;
    } }],
  });
  return v ? result : null;
}

// ================= 自動入力（PC版） =================
function errText(e) {
  return String(e?.message || e || '');
}

/**
 * 「本物と確認した」：誤って偽ドメイン・食い違いと判定された正しいドメインを、このアイテムだけで信用する。
 * 偽サイトが一番してほしいのは「これは本物」と利用者に言わせることなので、確かめ方を示して慎重に確認する。
 */
async function verifyDomainDialog(it, domain, { lookalike = null, brand = null } = {}) {
  if (editLocked()) return false;
  const reg = BC.registrable(domain);
  if (!reg) return false;
  const similarTo = lookalike?.brand || brand;
  const official = lookalike?.official || brand?.domains || [];
  const ok = await modal({
    title: 'このドメインを本物と確認しますか？',
    body: [
      h('table', { class: 'kv' },
        h('tr', {}, h('th', {}, '確認するドメイン'), h('td', {}, h('strong', { class: 'danger-text' }, reg))),
        similarTo ? h('tr', {}, h('th', {}, `「${similarTo.name}」の公式`), h('td', {}, official.map((d) => h('strong', { class: 'chip ok' }, d)))) : null),
      h('p', {}, lookalike
        ? `Kagibako は、このドメインを「${similarTo.name}」に似せた偽ドメインかもしれないと判断しました。名前が似ているだけの別の会社（例：北海道電力の hepco と東京電力の tepco）なら問題ありません。`
        : `タイトルのサービス（${similarTo?.name || ''}）の公式ドメイン一覧にないドメインです。同じ会社が別のドメインを使っていることもあります。`),
      h('div', { class: 'warn small' }, h('strong', {}, '確認のしかた'),
        h('ul', {},
          h('li', {}, 'メールや SMS のリンクではなく、検索・紙の書類・会員カードに書かれたアドレスから公式サイトを開く'),
          h('li', {}, 'そのサイトの会社名・運営会社が、使っているサービスと同じか確かめる'),
          h('li', {}, '少しでも迷ったら確認しない（偽サイトは本物そっくりです）'))),
      h('p', { class: 'muted small' }, `確認すると、このアイテム（${it.name || '名前なし'}）では ${reg} を警告せず、自動入力も止めません。あとで「取り消す」で元に戻せます。`),
    ],
    buttons: [{ label: 'キャンセル', value: false, kind: 'primary' }, { label: '公式サイトで確かめたので本物と確認する', value: true, kind: 'danger' }],
  });
  if (ok !== true) return false;
  it.verifiedDomains = [...new Set([...(it.verifiedDomains || []), reg])];
  touch(it);
  toast(`${reg} を、このアイテムの本物のドメインとして記録しました（保存をお忘れなく）`);
  return true;
}

function unverifyDomain(it, domain) {
  if (editLocked()) return;
  const reg = BC.registrable(domain);
  it.verifiedDomains = (it.verifiedDomains || []).filter((d) => BC.registrable(d) !== reg);
  if (!it.verifiedDomains.length) delete it.verifiedDomains;
  touch(it);
  toast(`${reg} の「本物と確認」を取り消しました`);
}

/** 偽サイトの疑いで止めたときの画面。戻り値 'open' | 'trust' | null */
async function phishingDialog(it, targetHost, allowed) {
  const [sub, reg] = D.splitHost(targetHost);
  // 主要サービスの公式ドメイン一覧で、いま開いているページを確かめる（このアイテムで本物と確認したドメインは除く）
  const la = BC.verifiedSet(it).has(BC.registrable(targetHost)) ? null : BC.lookalike(targetHost);
  const officials = BC.officialFor(targetHost);
  const chk = BC.checkItem(it);
  const itemBrand = chk.official.find((b) => b === chk.titleBrand) || chk.official.find((b) => b.group === chk.titleBrand?.group) || chk.official[0] || chk.titleBrand;
  const sameService = !la && itemBrand && BC.isGroupDomain(itemBrand, targetHost);
  let note = null;
  if (la) note = h('p', { class: 'warn danger-box' }, icon('warning'), ' ', BC.lookalikeText(la), ' 偽サイトの可能性が高いため、このドメインは許可できません。');
  else if (sameService) note = h('p', { class: 'info-box small' }, `このページは「${itemBrand.name}」の公式ドメインです（Kagibako の主要サービス一覧と一致）。ログインに別のドメインを使うサービスなので、許可して問題ありません。`);
  else if (officials.length) note = h('p', { class: 'info-box small' }, `このページは「${officials[0].name}」の公式ドメインです。「${it.name}」とは別のサービスです。`);
  return modal({
    title: '⚠ 偽サイトの可能性があります — 入力を止めました',
    body: [
      h('table', { class: 'kv' },
        h('tr', {}, h('th', {}, 'いま開いているページ'), h('td', { class: 'danger-text' }, h('span', {}, sub), h('strong', {}, reg))),
        h('tr', {}, h('th', {}, `「${it.name}」の公式サイト`), h('td', {}, allowed.map((d) => h('strong', { class: 'chip ok' }, d))))),
      h('p', {}, 'ページのドメインが、このアイテムに登録した公式サイトと一致しません。見た目が本物そっくりでも、別の人が作った偽サイトの可能性があります。'),
      note,
      h('p', { class: 'warn small' }, 'メールや SMS のリンクから開いたページなら特に危険です。「公式サイトを開く」から開き直してください。'),
    ],
    buttons: [
      ...(la ? [] : [{ label: 'このドメインも正しいので許可する', value: 'trust' }]),
      { label: '中止', value: null },
      { label: '公式サイトを開く（推奨）', value: 'open', kind: 'primary' },
    ],
  });
}

/** 自動入力の前に：登録した URL・許可ドメインそのものが偽ドメインに似ていないか */
async function confirmRegisteredDomains(it) {
  const chk = BC.checkItem(it);
  if (chk.level !== 'danger') return true;
  const lines = [];
  if (chk.lookalike) lines.push(`登録した URL（${chk.domain}）：${BC.lookalikeText(chk.lookalike)}`);
  for (const b of chk.badAllowed) lines.push(`許可したドメイン（${b.domain}）：${BC.lookalikeText(b.lookalike)}`);
  return confirmDialog('⚠ 登録した URL が偽ドメインに似ています',
    `${lines.join('\n\n')}\n\n偽サイトを開いているときに URL を登録すると、こうなることがあります。このまま入力すると、そのサイトにパスワードを渡すことになります。\n\n入力をやめて、アイテムの URL を公式のものに直すことをおすすめします。`,
    'それでも入力する', true);
}

/** 暗号化されていない（http）ページへの自動入力を止めたときの説明 */
function insecureHttpDialog(it, targetHost) {
  return modal({
    title: '⚠ 暗号化されていないページのため入力を止めました',
    body: [h('p', { class: 'pre' }, `入力先のページ（http://${targetHost || '?'}）は暗号化されていません。
「${it.name}」は https（暗号化あり）で登録されているため、入力しません。

本物のサイトでも、通信の途中で書き換えられていると ID・パスワードを盗まれます。Kagibako の「公式サイトを開く」から開き直してください。`)],
    buttons: [{ label: '閉じる', value: null, kind: 'primary' }],
  });
}

async function autoTypeItem(it, { useHotkeyTarget, template = null }) {
  if (!host.isDesktop) return;
  let steps;
  try { steps = AT.compileTemplate(template || it.autoType || settings.autoTypeTemplate, it, S.vault.profile); }
  catch (e) { toast(errText(e), 5000); return; }
  if (!(await confirmRegisteredDomains(it))) return;
  let allowed = D.allowedDomainsOf(it);
  const which = useHotkeyTarget ? 'hotkey' : 'last';
  let info;
  try { info = await host.call('targetUrl', { which }); } catch (e) { toast(errText(e), 5000); return; }
  if (!info.ok) { toast('入力先のウィンドウがありません。入力したい画面（ログイン欄など）を一度クリックしてから押してください。', 6000); return; }

  // 偽サイト対策：ブラウザなら、ページのドメインを登録ドメインと照合する
  let allowUnverified = false;
  // https で登録したアイテム（スキームを省いて登録したものも https とみなす）は、http のページには入力しない
  const requireHttps = D.requiresHttps(it.url);
  if (info.isBrowser && D.insecureTarget(it.url, info.url)) {
    await insecureHttpDialog(it, D.hostOf(info.url));
    return;
  }
  if (info.isBrowser) {
    const targetHost = info.url && !/\s/.test(info.url.trim()) ? D.hostOf(info.url) : '';
    if (!allowed.length) {
      const ok = await confirmDialog('URL が登録されていません',
        `「${it.name}」には公式サイトの URL が登録されていないため、偽サイトかどうかを確認できません。\n\n入力先: ${targetHost || info.title}\n\nこのまま入力しますか？（URL を登録しておくと、次回から自動で照合します）`, '入力する');
      if (!ok) return;
    } else if (!targetHost && info.fullscreen) {
      // 全画面表示のページは、本物そっくりの「偽のアドレスバー」を画面に描けるので、目視確認にも頼らない
      await modal({
        title: '全画面表示のため入力を止めました',
        body: [h('p', { class: 'pre' }, `${info.browser} が全画面表示になっていて、本物のアドレスバーを確認できません。\n全画面のページは、偽のアドレスバーや偽のログイン画面を描くことができます。\n\nEsc または F11 で全画面を解除してから、もう一度入力してください。`)],
      });
      return;
    } else if (!targetHost) {
      const ok = await confirmDialog('ページのアドレスを読み取れませんでした',
        `${info.browser} のアドレスバーを読み取れなかったため、ドメインを照合できません。\n\n入力先: ${info.title}\n\nブラウザ上部の本物のアドレスバーを自分の目で確認してから入力してください（ページの中に描かれたアドレス欄は偽物の可能性があります）。`, '確認したので入力する');
      if (!ok) return;
      allowUnverified = true;
    } else if (!D.hostAllowed(targetHost, allowed)) {
      const v = await phishingDialog(it, targetHost, allowed);
      if (v === 'open') { openOfficialSite(it); return; }
      if (v !== 'trust') return;
      const reg = D.registrableDomain(targetHost);
      const sure = await confirmDialog('本当に許可しますか？',
        `「${reg}」を「${it.name}」の正しいドメインとして登録し、今後は自動入力を許可します。\n\n公式サイトで、このドメインが本当にそのサービスのものか確かめましたか？ 偽サイトだった場合、パスワードを盗まれます。`, '許可して入力', true);
      if (!sure) return;
      it.allowedDomains = [...new Set([...(it.allowedDomains || []), reg])];
      touch(it);
      allowed = D.allowedDomainsOf(it);
      renderDetail();
    }
  }

  try {
    const r = await host.call('autotype', {
      steps, useHotkeyTarget,
      startDelay: settings.autoStartDelay, keyDelay: settings.keyDelay, minimize: settings.minimizeAfterType,
      viaClipboard: settings.autoTypeVia === 'clipboard',
      allowedDomains: info.isBrowser ? D.allowedForHost(allowed) : [], allowUnverified, requireHttps,
    });
    toast(`「${r.title || '入力先'}」に入力しました`);
  } catch (e) {
    const msg = errText(e);
    // 2段階のログイン画面の1画面目：エラーではなく案内。Kagibako は最小化しているので、ブラウザの上に吹き出しで出す
    if (msg.startsWith('ID_ONLY_PAGE:')) {
      const text = 'Kagibako：ID を入力しました。「次へ」などで進み、パスワードの画面でもう一度「自動入力」（またはホットキー）を押してください。';
      host.call('notice', { text, which, ms: 9000 }).catch(() => {});
      toast(text, 8000);
      return;
    }
    // それ以外は入力を止めた理由を読んでもらう必要があるので、最小化した Kagibako を前に出してから表示する
    if (host.isDesktop) {
      host.call('notice', { text: 'Kagibako：自動入力を止めました。理由は Kagibako の画面に表示しています。', which, ms: 5000, warn: true }).catch(() => {});
      await host.call('show').catch(() => {});
    }
    if (msg.startsWith('INSECURE_HTTP:')) {
      await insecureHttpDialog(it, msg.slice('INSECURE_HTTP:'.length));
    } else if (msg.startsWith('DOMAIN_MISMATCH:')) {
      await phishingDialog(it, msg.slice('DOMAIN_MISMATCH:'.length), allowed).then((v) => { if (v === 'open') openOfficialSite(it); });
    } else if (msg.startsWith('PASSFIELD_NOT_FOUND:')) {
      await modal({
        title: 'パスワード欄が見つかりませんでした',
        body: [h('p', { class: 'pre' }, '安全のため、パスワードは入力せずに止めました（ID まで入力済みの場合があります）。\n\n次のどれかを試してください。\n・ブラウザでパスワード欄をクリックしてから、パスワード欄の ⌨ を押す\n・ホットキーの選択画面で Shift+Enter（パスワードだけ入力）\n・このアイテムの「自動入力の手順」を「ID → Tab → パスワード → Enter」などに変える')],
      });
    } else if (msg.startsWith('USERFIELD_NOT_FOUND:')) {
      await modal({
        title: 'ID 欄が見つかりませんでした',
        body: [h('p', { class: 'pre' }, 'どこにも入力せずに止めました（パスワードも入力していません）。\n\n次のどれかを試してください。\n・ブラウザで ID 欄を一度クリックしてから、もう一度「自動入力」を押す\n・ページの読み込みが終わってから、もう一度押す\n・このアイテムの「自動入力の手順」を「ID → Tab → パスワード → Enter」に変える')],
      });
    } else if (msg.startsWith('ID_NOT_TYPED:')) {
      await modal({
        title: 'ID が入力されなかったため止めました',
        body: [h('p', { class: 'pre' }, 'ID 欄に ID を入力しましたが、欄が空のままでした（ページの読み込み中に入力位置がずれた・ページが文字を消した など）。\n\nパスワードは入力していません。ページの読み込みが終わってから、もう一度「自動入力」を押してください。\n\n何度も起きる場合は、このアイテムの「自動入力の手順」を「ID → Tab → パスワード → Enter」に変えるか、設定の「1文字ごとの間隔」を増やしてください。')],
      });
    } else if (msg.startsWith('URL_UNKNOWN:')) {
      toast('ページのアドレスを読み取れなかったため、入力を止めました', 6000);
    } else {
      toast(msg, 6000);
    }
  }
}

/** 個人情報など、秘密ではない文字列を直前のウィンドウに入力する（ドメイン照合なし） */
async function autoTypeText(text, label) {
  if (!host.isDesktop) return;
  if (!text) { toast(`${label} は空です`); return; }
  try {
    const r = await host.call('autotype', {
      steps: [{ t: 'text', v: text }], useHotkeyTarget: false,
      startDelay: settings.autoStartDelay, keyDelay: settings.keyDelay, minimize: settings.minimizeAfterType,
      viaClipboard: settings.autoTypeVia === 'clipboard', allowedDomains: [],
    });
    toast(`「${r.title || '入力先'}」に${label}を入力しました`);
  } catch (e) { toast(errText(e), 6000); }
}

async function onHotkey(data) {
  lastActivity = Date.now();
  if (S.screen !== 'main' || !S.vault) {
    pendingHotkey = data;
    toast('ロックを解除すると、自動入力の画面を開きます');
    return;
  }
  abandonAllModals();
  await hotkeyPicker(data);
}

/** ホットキーで開く「どのアイテムを入力するか」の選択画面 */
async function hotkeyPicker(data, which = 'hotkey') {
  let info = { ok: !!data?.ok, title: data?.title || '', isBrowser: false, url: null };
  try { info = await host.call('targetUrl', { which }); } catch { /* タイトルだけで推定 */ }
  if (!info.ok) { toast('入力先のウィンドウが見つかりません'); return; }
  const targetHost = info.isBrowser && info.url && !/\s/.test(info.url.trim()) ? D.hostOf(info.url) : '';
  const items = M.listItems(S.vault).map((e) => {
    const allowed = D.allowedDomainsOf(e.node);
    const domainMatch = !!targetHost && D.hostAllowed(targetHost, allowed);
    return { e, domainMatch, score: (domainMatch ? 1000 : 0) + AT.matchScore(e.node, info.title) };
  });
  const anyDomainMatch = items.some((x) => x.domainMatch);
  const titleOnlyMatches = items.filter((x) => !x.domainMatch && x.score > 0);

  const search = h('input', { type: 'search', placeholder: '検索（タイトル・ID・URL）', 'aria-label': 'アイテムを検索' });
  const list = h('ul', { class: 'picker-list', role: 'listbox' });
  let shown = [], cursor = 0, chosen = null, passwordOnly = false;
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    shown = items
      .filter((x) => !q || itemMatches(x.e.node, q))
      .sort((a, b) => b.score - a.score || (a.e.node.name || '').localeCompare(b.e.node.name || '', 'ja'))
      .slice(0, 60);
    cursor = Math.min(cursor, Math.max(0, shown.length - 1));
    clear(list, shown.map((x, i) => h('li', {
      class: `picker-row${i === cursor ? ' active' : ''}`, role: 'option', 'aria-selected': String(i === cursor),
      onclick: () => { chosen = x.e.node; document.querySelector('.overlay .modal-head .icon-btn')?.click(); },
    },
    h('span', { class: 'picker-name' }, x.domainMatch ? h('span', { class: 'chip ok' }, 'このサイト') : null, x.e.node.name || '(名前なし)'),
    h('span', { class: 'muted small' }, [x.e.node.account, D.hostOf(x.e.node.url), x.e.path.join(' / ')].filter(Boolean).join('　')))));
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  search.addEventListener('input', () => { cursor = 0; draw(); });
  draw();
  await modal({
    title: '⌨ 自動入力するアイテムを選ぶ',
    wide: true,
    body: [
      h('p', { class: 'small' }, '入力先: ', h('strong', {}, info.title || '(タイトルなし)'),
        targetHost ? h('span', { class: 'muted' }, `　（${targetHost}）`) : null),
      targetHost && !anyDomainMatch ? h('p', { class: 'warn small' },
        `⚠ このページのドメイン（${D.registrableDomain(targetHost)}）は、登録しているどのアイテムの公式サイトとも一致しません。`,
        titleOnlyMatches.length ? ' ページの見た目やタイトルが本物に似ていても、偽サイトの可能性があります。' : '') : null,
      search, list,
      h('p', { class: 'muted small' }, '↑↓ で選んで Enter で入力。Shift+Enter ならパスワードだけを、いまカーソルのある欄に入力。Esc で閉じる。'),
    ],
    buttons: [],
    onOpen: (dlg, close) => {
      search.focus();
      dlg.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowDown') { cursor = Math.min(cursor + 1, shown.length - 1); draw(); ev.preventDefault(); }
        else if (ev.key === 'ArrowUp') { cursor = Math.max(cursor - 1, 0); draw(); ev.preventDefault(); }
        else if (ev.key === 'Enter' && shown[cursor]) { chosen = shown[cursor].e.node; passwordOnly = ev.shiftKey; ev.preventDefault(); close(null); }
      });
    },
  });
  if (chosen) await autoTypeItem(chosen, { useHotkeyTarget: which === 'hotkey', template: passwordOnly ? '{PASSWORD}' : null });
}

// ================= 自動バックアップ（PC版） =================
async function backupAfterSave(snap) {
  if (!host.isDesktop || !settings.backupEnabled || !snap?.fileText) return;
  try {
    await host.call('backup', { name: baseName(S.file?.name), text: snap.fileText, revision: snap.revision || 0, dir: settings.backupDir, keep: settings.backupKeep });
  } catch (e) {
    toast(`バックアップを保存できませんでした: ${errText(e)}`, 6000);
  }
}

// ================= CSV =================
async function csvImportFlow() {
  if (editLocked()) return;
  const f = await fio.pickFile().catch((e) => { toast(errText(e)); return null; });
  if (!f) return;
  const rows = CSV.parseCsv(CSV.decodeCsvBytes(f.bytes));
  if (rows.length < 2) { toast('CSV に取り込めるデータがありません'); return; }
  const [headers, ...data] = rows;
  const mapping = CSV.detectMapping(headers);
  const format = CSV.detectFormat(headers);
  const preview = h('div', { class: 'csv-preview' });
  const folderName = h('input', { type: 'text', value: `取り込み ${M.todayISO()}` });
  const useFolders = h('input', { type: 'checkbox', checked: true });
  const skipDup = h('input', { type: 'checkbox', checked: true });
  const drawPreview = () => {
    const entries = CSV.rowsToItems(S.vault, data.slice(0, 5), mapping, { useFolders: useFolders.checked });
    clear(preview, h('table', { class: 'difftable' },
      h('tr', {}, h('th', {}, 'タイトル'), h('th', {}, 'ID'), h('th', {}, 'パスワード'), h('th', {}, 'URL'), h('th', {}, 'フォルダ')),
      entries.map(({ item, path }) => h('tr', {}, h('td', {}, item.name), h('td', {}, item.account), h('td', {}, item.password ? '••••••' : ''), h('td', {}, item.url), h('td', {}, path.join('/'))))));
  };
  const mapRows = CSV.TARGETS.map(([k, label]) => h('div', { class: 'frow' }, h('span', { class: 'flabel' }, label),
    h('select', { onchange: (e) => { if (e.target.value === '') delete mapping[k]; else mapping[k] = +e.target.value; drawPreview(); } },
      h('option', { value: '' }, '（使わない）'),
      headers.map((hd, i) => h('option', { value: String(i), selected: mapping[k] === i }, hd || `列${i + 1}`))), h('span')));
  useFolders.addEventListener('change', drawPreview);
  drawPreview();
  const ok = await modal({
    title: 'CSV から取り込む',
    wide: true,
    body: [
      h('p', {}, `${f.name}：${data.length} 件（判定: ${format}）`),
      h('details', {}, h('summary', {}, '列の割り当て（自動で判定済み。違っていれば直してください）'), mapRows),
      h('h3', {}, 'プレビュー（先頭5件）'), preview,
      h('label', { class: 'field' }, h('span', {}, '取り込み先のフォルダ名'), folderName),
      h('label', { class: 'check' }, useFolders, 'CSV のフォルダ／グループでサブフォルダを作る'),
      h('label', { class: 'check' }, skipDup, '同じ URL・ID・パスワードのものはスキップ'),
      h('p', { class: 'warn small' }, '取り込みが終わったら、元の CSV ファイル（パスワードが暗号化されずに入っています）は削除してください。ゴミ箱も空にしましょう。'),
    ],
    buttons: [{ label: 'キャンセル', value: false }, { label: '取り込む', value: true, kind: 'primary' }],
  });
  if (!ok) return;
  if (mapping.password === undefined) { toast('パスワードの列が割り当てられていません'); return; }
  const entries = CSV.rowsToItems(S.vault, data, mapping, { useFolders: useFolders.checked });
  const r = CSV.importInto(S.vault, entries, { folderName: folderName.value.trim() || '取り込み', skipDuplicates: skipDup.checked });
  if (r.added) { markDirty(); S.sel = r.folder.id; }
  renderMain();
  toast(`${r.added} 件を取り込みました${r.skipped ? `（重複 ${r.skipped} 件はスキップ）` : ''}。保存をお忘れなく`, 5000);
}

async function csvExportFlow() {
  const fmt = h('select', {}, CSV.EXPORT_FORMATS.map(([v, label]) => h('option', { value: v }, label)));
  const ok = await modal({
    title: 'CSV に書き出す',
    body: [
      h('p', { class: 'warn' }, icon('warning'), ' CSV にはすべてのパスワードが暗号化されずに書き出されます。他のパスワード管理アプリへの移行など、必要なときだけ使い、取り込みが終わったらすぐに削除してください。クラウドやメールには置かないでください。'),
      h('p', { class: 'muted small' }, 'Excel などの表計算ソフトでは開かないでください。「=」で始まる値が数式として動いたり、パスワードの先頭の 0 や記号が変わったりします。'),
      h('label', { class: 'field' }, h('span', {}, '形式'), fmt),
    ],
    buttons: [{ label: 'キャンセル', value: false }, { label: '次へ', value: true, kind: 'danger' }],
  });
  if (!ok) return;
  const pw = await passwordPrompt('本人確認', '書き出すには、マスターパスワードを入力してください。', { check: verifyMasterPassword });
  if (!pw) return;
  const text = CSV.exportCsv(S.vault, fmt.value);
  const r = await fio.saveAs(`${baseName(S.file?.name)}_export.csv`, new TextEncoder().encode(text));
  if (!r.cancelled) toast('CSV に書き出しました。使い終わったら必ず削除してください', 6000);
}

/** いま開いているデータのパスワードか確認（書き出しなど重要な操作の前に） */
async function verifyMasterPassword(p) {
  if (S.kind === 'kagi' && S.file?.env) { await X.decryptEnvelope(S.file.env, p); return true; }
  if (S.kind === 'legacy' && S.file?.bytes) { L.decryptLegacy(S.file.bytes, L.legacyKey(p)); return true; }
  // まだ一度も保存していない新規データは、同じ鍵になるかで確認
  const s = await X.deriveSession(p, S.session.kdf);
  const probe = await X.encryptVault({ probe: true }, s, {});
  await X.decryptWithSession(X.parseEnvelope(probe.text), S.session).catch(() => { throw new Error('パスワードが違います'); });
  return true;
}

// ================= 安全ガイド・免責事項 =================
function guideBody(doc) {
  return [
    doc.intro ? h('p', { class: 'lead' }, doc.intro) : null,
    doc.sections.map((s) => h('section', { class: 'guide-sec' },
      h('h3', {}, s.h),
      s.p ? s.p.map((t) => h('p', {}, t)) : null,
      s.list ? h('ul', {}, s.list.map((t) => h('li', {}, t))) : null,
      s.items ? h('dl', {}, s.items.map(([t, d]) => [h('dt', {}, t), h('dd', {}, d)])) : null)),
  ];
}

function guideDialog() {
  return modal({ title: GUIDE.title, wide: true, body: guideBody(GUIDE), buttons: [{ label: '閉じる', value: null, kind: 'primary' }] });
}

// ================= 使い方・よくある質問・キー操作 =================
const ALL_HELP_TABS = [['howto', '使い方'], ['faq', 'よくある質問'], ['shortcuts', 'キー操作']];
const helpTabs = () => (isPhone() ? ALL_HELP_TABS.filter(([k]) => k !== 'shortcuts') : ALL_HELP_TABS);

async function helpDialog(doc) {
  const which = doc === FAQ ? 'faq' : 'howto';
  const v = await modal({
    title: doc.title,
    wide: true,
    body: guideBody(forHost(doc, { isDesktop: host.isDesktop, isAndroid: host.isAndroid, isPhone: isPhone() })),
    buttons: [...helpTabs().filter(([k]) => k !== which).map(([k, label]) => ({ label, value: k })), { label: '閉じる', value: null, kind: 'primary' }],
  });
  return openHelpTab(v);
}

function openHelpTab(v) {
  if (v === 'howto') return helpDialog(HOWTO);
  if (v === 'faq') return helpDialog(FAQ);
  if (v === 'shortcuts' && !isPhone()) return shortcutsDialog();
  return undefined;
}

/** PC版：直前に使ったウィンドウ（ブラウザ）のアドレスバーを読み取れるか試す */
async function browserProbeDialog() {
  const out = h('div', { class: 'probe-out' }, h('p', { class: 'muted small' }, '［テストする］を押してください。'));
  let report = '';
  const run = async () => {
    clear(out, h('p', { class: 'muted small' }, '調べています…'));
    let r;
    try { r = await host.call('probeBrowser', {}, 20000); } catch (e) { clear(out, h('p', { class: 'error' }, errText(e))); return; }
    if (!r.ok) { clear(out, h('p', { class: 'warn' }, 'テストするウィンドウがありません。ブラウザの画面を一度クリックしてから、Kagibako に戻って押してください。')); return; }
    const verdict = !r.isBrowser ? ['ok-none', 'ブラウザではないと判定しました（照合せずに入力します）']
      : r.url ? ['ok', '✔ アドレスバーを読み取れました（ドメインを照合して入力します）']
        : ['ng', '✖ ブラウザですが、アドレスバーを読み取れませんでした（入力の前に確認画面が出ます）'];
    report = ['Kagibako ブラウザ読み取りテスト v' + APP_VERSION,
      '判定: ' + verdict[1], 'ブラウザ: ' + (r.browser || '-'), '製品名: ' + (r.product || '-'), 'プロセス: ' + r.process,
      'ウィンドウクラス: ' + r.windowClass, '全画面: ' + (r.fullscreen ? 'はい' : 'いいえ'), 'ドメイン: ' + (D.hostOf(r.url) || '-'),
      'ページ領域の数: ' + r.documents, 'ページの外の入力欄:',
      ...(r.edits.length ? r.edits.map((e) => `  ${e.type} class=[${e.cls}] id=[${e.aid}] name=[${e.name}] fw=[${e.fw}] depth=${e.depth}`) : ['  （なし）'])].join('\n');
    clear(out,
      h('p', { class: `probe-verdict ${verdict[0]}` }, verdict[1]),
      h('table', { class: 'kv' },
        h('tr', {}, h('th', {}, 'ブラウザ'), h('td', {}, r.browser || r.product || r.process || '-')),
        h('tr', {}, h('th', {}, '読み取ったドメイン'), h('td', {}, D.hostOf(r.url) || '-')),
        h('tr', {}, h('th', {}, '全画面'), h('td', {}, r.fullscreen ? 'はい（全画面では入力しません）' : 'いいえ'))),
      h('details', {}, h('summary', { class: 'small' }, '詳しい情報（うまくいかないときは、これをコピーして知らせてください）'),
        h('pre', { class: 'probe-report mono small' }, report),
        h('p', { class: 'muted small' }, '入力欄に入っている文字（検索語など）は含みません。')));
  };
  await modal({
    title: 'ブラウザの読み取りテスト',
    wide: true,
    body: [h('ol', { class: 'small' },
      h('li', {}, '調べたいブラウザで、どこかのページ（例: https://example.com）を開きます。'),
      h('li', {}, 'そのブラウザの画面を一度クリックしてから、Kagibako に戻ります。'),
      h('li', {}, '［テストする］を押すと、自動入力のときと同じ方法でアドレスバーを読み取れるか調べます。')),
      out,
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', onclick: run }, 'テストする'),
        h('button', { class: 'btn', onclick: async () => { if (!report) return; try { await navigator.clipboard.writeText(report); toast('結果をコピーしました'); } catch { toast('コピーできませんでした'); } } }, '結果をコピー'))],
    buttons: [{ label: '閉じる', value: null, kind: 'primary' }],
  });
}

/** 全アイテムの URL 点検の集計 */
function auditItems() {
  const res = { danger: [], warn: [], suggest: [], nourl: [], ok: [], unknown: [] };
  for (const e of M.listItems(S.vault)) {
    const chk = BC.checkItem(e.node);
    const row = { it: e.node, path: e.path.join(' / '), chk };
    if (chk.level === 'danger') res.danger.push(row);
    else if (chk.level === 'warn') res.warn.push(row);
    else if (chk.level === 'none') (chk.suggestUrl ? res.suggest : res.nourl).push(row);
    else if (chk.level === 'ok') res.ok.push(row);
    else res.unknown.push(row);
  }
  return res;
}

/** ツール → URL の点検：主要サービスの公式ドメイン一覧と照らし合わせる */
async function urlAuditDialog() {
  const ro = !!settings.readOnly;
  const body = h('div', { class: 'audit' });
  let closeFn = null;
  const jump = (it) => { closeFn?.(null); select(it.id); };
  const nameBtn = (r) => h('button', { class: 'link', onclick: () => jump(r.it) }, r.it.name || '(名前なし)');
  // タイトルからの判定がまちがっているアイテムは、判定を止める
  const notThis = (r) => (ro || !r.chk.titleBrand ? null : h('button', { class: 'link small not-this', onclick: () => { r.it.brandHint = 'none'; touch(r.it); draw(); renderDetail(); } }, `「${r.chk.titleBrand.name}」ではない`));
  const draw = () => {
    const a = auditItems();
    const picked = new Set(a.suggest.map((r) => r.it.id));
    const section = (cls, title, desc, rows, render) => (rows.length ? h('section', { class: `audit-sec ${cls}` },
      h('h3', {}, `${title}（${rows.length}件）`), desc ? h('p', { class: 'muted small' }, desc) : null,
      h('ul', { class: 'plain-list' }, rows.map((r) => h('li', {}, render(r))))) : null);
    clear(body,
      h('p', { class: 'small' }, `Kagibako に入っている主要サービス（${BC.BRAND_COUNT} 件）の公式ドメインと照らし合わせました。一覧に無いサービスは「分からない」として扱います。データは外部へ送っていません。`, ' ', h('button', { class: 'link small', onclick: officialListDialog }, '一覧を見る')),
      h('div', { class: 'audit-summary' },
        h('span', { class: 'chip danger-chip' }, `危険 ${a.danger.length}`), h('span', { class: 'chip warn-chip' }, `要確認 ${a.warn.length}`),
        h('span', { class: 'chip' }, `URL 未登録 ${a.suggest.length + a.nourl.length}`), h('span', { class: 'chip ok' }, `公式と確認 ${a.ok.length}`),
        h('span', { class: 'chip' }, `一覧に無いサービス ${a.unknown.length}`)),
      !a.danger.length && !a.warn.length ? h('p', { class: 'info-box small' }, icon('ok'), ' 偽ドメインに似た URL は見つかりませんでした。') : null,
      section('danger', '⚠ 危険：偽ドメインに似ている', '有名サービスに似せた別のドメインです。偽サイトを開いているときに登録した可能性があります。公式の URL に直してください。', a.danger, (r) => [
        nameBtn(r), h('span', { class: 'muted small' }, r.chk.domain || ''),
        h('div', { class: 'small audit-why' }, r.chk.lookalike ? BC.lookalikeText(r.chk.lookalike) : '', ...r.chk.badAllowed.map((b) => `許可したドメイン ${b.domain}: ${BC.lookalikeText(b.lookalike)}`)),
        !ro && r.chk.lookalike ? h('button', { class: 'btn small', onclick: () => { r.it.url = r.chk.lookalike.brand.url; touch(r.it); draw(); renderDetail(); } }, `${r.chk.lookalike.brand.name}の公式 URL に直す`) : null,
        // 誤判定のとき：本物と確認した（URL のドメイン、または許可したドメイン）
        !ro && (r.chk.lookalike || r.chk.badAllowed.length) ? h('button', { class: 'btn small', onclick: async () => {
          const b = r.chk.lookalike ? { domain: r.chk.domain, lookalike: r.chk.lookalike } : r.chk.badAllowed[0];
          if (await verifyDomainDialog(r.it, b.domain, { lookalike: b.lookalike })) { draw(); renderDetail(); }
        } }, '本物と確認した…') : null]),
      section('warn', '要確認', 'タイトルのサービスと登録ドメインが食い違う・暗号化されていない http など。別のサービスなら問題ありません。', a.warn, (r) => [
        nameBtn(r), h('span', { class: 'muted small' }, r.chk.domain),
        h('div', { class: 'small audit-why' }, r.chk.mismatch ? `タイトルは「${r.chk.titleBrand.name}」ですが、${r.chk.titleBrand.name}の公式ドメイン（${r.chk.titleBrand.domains.join(' / ')}）ではありません。` : '', r.chk.warnings.join(' / ')),
        !ro && r.chk.mismatch ? h('button', { class: 'btn small', onclick: () => { r.it.url = r.chk.titleBrand.url; touch(r.it); draw(); renderDetail(); } }, '公式 URL に直す') : null,
        !ro && r.chk.mismatch ? h('button', { class: 'btn small', onclick: async () => { if (await verifyDomainDialog(r.it, r.chk.domain, { brand: r.chk.titleBrand })) { draw(); renderDetail(); } } }, '本物と確認した…') : null,
        r.chk.mismatch ? notThis(r) : null]),
      a.suggest.length ? h('section', { class: 'audit-sec' },
        h('h3', {}, `URL 未登録・公式サイトの候補あり（${a.suggest.length}件）`),
        h('p', { class: 'muted small' }, 'タイトルから主要サービスと分かったアイテムです。チェックしたものに公式サイトの URL を登録します（登録後は自動入力の照合が効きます）。'),
        h('ul', { class: 'plain-list' }, a.suggest.map((r) => h('li', {},
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, disabled: ro, onchange: (e) => { if (e.target.checked) picked.add(r.it.id); else picked.delete(r.it.id); } }), r.it.name || '(名前なし)'),
          h('span', { class: 'muted small' }, `→ ${r.chk.titleBrand.name}: `, h('span', { class: 'mono' }, r.chk.suggestUrl)), notThis(r)))),
        ro ? null : h('button', { class: 'btn primary', onclick: () => {
          let n = 0;
          for (const r of a.suggest) if (picked.has(r.it.id)) { r.it.url = r.chk.suggestUrl; touch(r.it); n++; }
          toast(`${n} 件に公式サイトの URL を登録しました（保存をお忘れなく）`);
          draw(); renderDetail();
        } }, 'チェックしたものに公式 URL を登録')) : null,
      section('', 'URL 未登録（候補なし）', '自動入力のときに偽サイトかどうかを照合できません。公式サイトを自分で確かめて URL を登録してください。', a.nourl, (r) => [nameBtn(r), h('span', { class: 'muted small' }, r.path)]));
  };
  draw();
  await modal({
    title: 'URL の点検（公式ドメインか確かめる）',
    wide: true,
    body: [body],
    buttons: [{ label: '閉じる', value: null, kind: 'primary' }],
    onOpen: (_dlg, close) => { closeFn = close; },
  });
}

/** アイテムのパスワードの一言の注意（使い回し・弱い）。問題が無ければ null */
function pwHint(it) {
  if (!it?.password) return null;
  const n = HL.reuseCount(M.listItems(S.vault), it);
  const w = HL.checkPassword(it.password, { account: it.account });
  const pin = w && HL.looksLikePin(it.password, { name: it.name, fieldName: it.passwordName });
  if (!n && (!w || pin)) return null;
  return h('div', { class: `warn small pw-hint${n ? ' danger-box' : ''}` }, icon('warning'), ' ',
    n ? `ほかの ${n} 件と同じパスワードです（使い回し）。` : '', w && !pin ? `弱いパスワード：${w.reasons.join('・')}。` : '',
    ' ', h('button', { class: 'link small', onclick: passwordCheckDialog }, 'パスワードの点検'));
}

/** ツール → パスワードの点検：使い回し・弱いパスワードを一覧にする（この端末の中だけで調べる） */
async function passwordCheckDialog() {
  const body = h('div', { class: 'audit pwcheck' });
  let closeFn = null;
  const jump = (it) => { closeFn?.(null); select(it.id); };
  const row = (e, extra = null) => h('li', {},
    h('button', { class: 'link', onclick: () => jump(e.node) }, e.node.name || '(名前なし)'),
    h('span', { class: 'muted small' }, [e.path.join(' / '), D.hostOf(e.node.url) ? D.registrableDomain(D.hostOf(e.node.url)) : ''].filter(Boolean).join('　')),
    extra);
  const draw = () => {
    const r = HL.analyzePasswords(M.listItems(S.vault));
    const weak = r.weak.filter((w) => !w.pin);
    const pins = r.weak.filter((w) => w.pin);
    clear(body,
      h('p', { class: 'small' }, `パスワードが入っているアイテム ${r.checked} 件を点検しました。点検はこの端末の中だけで行い、パスワードを外部へ送ることはありません。`),
      h('div', { class: 'audit-summary' },
        h('span', { class: `chip${r.reused.length ? ' danger-chip' : ''}` }, `使い回し ${r.reusedItems} 件`),
        h('span', { class: `chip${weak.length ? ' warn-chip' : ''}` }, `弱い ${weak.length} 件`),
        h('span', { class: 'chip ok' }, `問題なし ${r.okCount} 件`)),
      !r.reused.length && !weak.length ? h('p', { class: 'info-box small' }, icon('ok'), ' 使い回しや弱いパスワードは見つかりませんでした。') : null,
      r.reused.length || weak.length ? h('div', { class: 'info-box small' },
        h('strong', {}, '直し方：'), 'そのサイトにログインして「パスワードの変更」を開き、Kagibako のアイテムのパスワード欄の［さいころの絵］で新しいパスワードを作って入れます。',
        h('br'), 'メール・銀行・カード・通販など、乗っ取られると困るものから先に直してください。') : null,
      r.reused.length ? h('section', { class: 'audit-sec danger' },
        h('h3', {}, icon('warning'), ` 使い回し（${r.reused.length} 組・${r.reusedItems} 件）`),
        h('p', { class: 'muted small' }, '同じパスワードを複数のサービスで使っていると、どれか1つから漏れたときに、ほかのサービスにも次々とログインされてしまいます。'),
        r.reused.map((g, i) => h('div', { class: 'pw-group' },
          h('div', { class: 'small pw-group-head' }, `同じパスワード（${i + 1}）：${g.length} 件`),
          h('ul', { class: 'plain-list' }, g.map((e) => row(e)))))) : null,
      weak.length ? h('section', { class: 'audit-sec warn' },
        h('h3', {}, `弱いパスワード（${weak.length} 件）`),
        h('p', { class: 'muted small' }, '短い・よく使われる・並んだ文字などは、総当たりや「よく使われるパスワードの一覧」で当てられやすくなります。'),
        h('ul', { class: 'plain-list' }, weak.map((w) => row(w, h('div', { class: 'small audit-why' }, w.reasons.join('・')))))) : null,
      pins.length ? h('section', { class: 'audit-sec' },
        h('h3', {}, `暗証番号らしいもの（${pins.length} 件）`),
        h('p', { class: 'muted small' }, 'カードや口座の暗証番号など、決まった桁数の数字しか使えないものは、弱く見えても気にしなくて大丈夫です（誕生日や 1234 などは避けてください）。'),
        h('ul', { class: 'plain-list' }, pins.map((w) => row(w)))) : null);
  };
  draw();
  await modal({
    title: 'パスワードの点検（使い回し・弱いもの）',
    wide: true,
    body: [body],
    buttons: [{ label: '閉じる', value: null, kind: 'primary' }],
    onOpen: (_dlg, close) => { closeFn = close; },
  });
}

/** ヘルプ → 主要サービスの公式ドメイン一覧（URL の点検で照らし合わせている中身） */
async function officialListDialog() {
  const norm = (s) => String(s || '').normalize('NFKC').toLowerCase();
  const search = h('input', { type: 'search', placeholder: 'サービス名・呼び名・ドメインで探す（例：楽天、hepco、銀行）', 'aria-label': '一覧を検索' });
  const list = h('div', { class: 'official-list' });
  const count = h('span', { class: 'muted small' });
  // 開いている項目を一度に閉じる（大項目・中項目・サービスの中身のすべて）
  const closeAll = h('button', { class: 'btn small', type: 'button', onclick: () => list.querySelectorAll('details[open]').forEach((d) => { d.open = false; }) }, 'すべて閉じる');
  const draw = () => {
    const q = norm(search.value).trim();
    const tops = new Map(CATEGORIES.flatMap(([top, mids]) => mids.map((m) => [m, top])));
    const hit = (b) => !q || norm([b.name, b.cat, tops.get(b.cat), ...b.aliases, ...b.domains].join(' ')).includes(q);
    const shown = BRANDS.filter(hit);
    count.textContent = q ? `${shown.length} 件 見つかりました（全 ${BRANDS.length} 件）` : `全 ${BRANDS.length} 件`;
    const openBtn = (b) => h('button', { class: 'btn small', title: b.url, onclick: () => openOfficialSite({ url: b.url }) }, '開く');
    // スマホ：サービス名だけを並べ、名前を押すとすぐ下に呼び名・ドメイン・［開く］を出す（縦に長くなりすぎないように）
    // PC：今までどおりの表
    const rowsOf = (rows) => (isPhone()
      ? h('div', { class: 'official-names' }, rows.map((b) => h('details', { class: 'official-item' },
        h('summary', {}, b.name),
        h('div', { class: 'official-detail' },
          b.aliases.some((a) => a !== b.name) ? h('p', { class: 'muted small' }, b.aliases.filter((a) => a !== b.name).join('・')) : null,
          h('div', { class: 'official-domains' }, b.domains.map((d) => h('span', { class: 'chip ok mono' }, d))),
          openBtn(b)))))
      : h('table', { class: 'official-table' }, rows.map((b) => h('tr', {},
        h('th', {}, b.name, h('div', { class: 'muted small' }, b.aliases.filter((a) => a !== b.name).slice(0, 6).join('・'))),
        h('td', {}, b.domains.map((d) => h('span', { class: 'chip ok mono' }, d))),
        h('td', { class: 'official-open' }, openBtn(b))))));
    // 大項目 → 中項目 → サービス。スマホは閉じて始め、PC は開いて始める。探したときは当たったところを開く
    const startOpen = !!q || !isPhone();
    clear(list, CATEGORIES.map(([top, mids]) => {
      const groups = mids.map((mid) => [mid, shown.filter((b) => b.cat === mid)]).filter(([, rows]) => rows.length);
      if (!groups.length) return null;
      const n = groups.reduce((s, [, rows]) => s + rows.length, 0);
      return h('details', { class: 'official-cat', open: startOpen },
        h('summary', {}, `${top}（${n}）`),
        groups.map(([mid, rows]) => h('details', { class: 'official-sub', open: startOpen },
          h('summary', {}, `${mid}（${rows.length}）`),
          rowsOf(rows))));
    }), shown.length ? null : h('p', { class: 'muted' }, '見つかりません。一覧に無いサービスは、URL の点検では「分からない」として扱います。'));
  };
  search.addEventListener('input', draw);
  draw();
  await modal({
    title: '主要サービスの公式ドメイン一覧',
    wide: true,
    body: [
      h('p', { class: 'small' }, '「URL の点検」や自動入力の前の確認で、登録した URL と照らし合わせている一覧です。どのドメインも実在することを確かめてから入れています。データはアプリの中にあり、外部へは送りません。'),
      h('p', { class: 'warn small' }, '⚠ ドメインは、会社の都合（社名の変更・統合・サービスの終了など）で変わることがあります。この一覧は作者が確かめた時点のもので、正しさを保証するものではありません。URL を登録する前に［開く］で公式サイトか確かめ、最終的な判断はご自身で行ってください。'),
      // 検索欄・件数・［すべて閉じる］は、スクロールしても上に残す
      h('div', { class: 'official-search' }, search, h('div', { class: 'official-search-row' }, count, closeAll)), list,
      h('p', { class: 'muted small' }, 'ここに無いサービスは、点検で警告も「公式」の表示も出ません。この一覧は、作者がアプリの更新のときに追加・修正します（ご自分では追加できません）。一覧に無いサービスでも、アイテムに公式サイトの URL を登録しておけば、自動入力の前のドメインの照合はそのまま働きます。')],
    buttons: [{ label: '閉じる', value: null, kind: 'primary' }],
  });
}

function aboutDialog() {
  return modal({
    title: 'Kagibako について',
    body: [h('div', { class: 'about-band' }, brandLogo('about-logo')),
      h('p', {}, h('strong', {}, 'Kagibako（鍵箱）'), ` バージョン ${APP_VERSION}`),
      h('p', { class: 'small' }, '自分専用のパスワード管理です。データは .kagi ファイル（Argon2id + AES-256-GCM）に暗号化して保存し、外部へ送信しません。'),
      h('p', { class: 'muted small' }, '.idm 形式のファイルは、読み込んで .kagi 形式に移すことができます。'),
      h('p', { class: 'muted small' }, `この端末の名前: ${settings.deviceName}`),
      h('p', { class: 'small' }, '© 2026 ayamuo　Kagibako ライセンス（無料で使用・改変・再配布できます。販売・有料での配布は禁止です。無保証で、作者はサポートや損害の責任を負いません）'),
      h('p', { class: 'muted small' }, `同梱しているソフトウェア・データ：hash-wasm（MIT）、Public Suffix List（MPL 2.0）、SecLists のよく使われるパスワードの一覧（MIT）、${host.isAndroid ? 'AndroidX Webkit・Kotlin 標準ライブラリ・Material Icons の通知の絵（Apache 2.0）' : 'Microsoft WebView2 SDK（BSD 3-Clause）、.NET ランタイム（MIT）'}`)],
    buttons: [{ label: 'ライセンスの全文', value: 'licenses' }, { label: '閉じる', value: null, kind: 'primary' }],
  }).then((v) => (v === 'licenses' ? licensesDialog() : undefined));
}

/** ライセンスの全文（Kagibako 本体と、同梱しているソフトウェア） */
async function licensesDialog() {
  const LIST = [
    ['Kagibako-LICENSE.txt', 'Kagibako（Kagibako ライセンス）'],
    ['hash-wasm-MIT.txt', 'hash-wasm（MIT）'],
    ['MPL-2.0.txt', 'Public Suffix List（MPL 2.0）'],
    ['SecLists-MIT.txt', 'SecLists のよく使われるパスワードの一覧（MIT）'],
    // PC版とスマホ版で、同梱しているものだけを出す
    host.isAndroid ? ['Apache-2.0.txt', 'AndroidX Webkit・Kotlin 標準ライブラリ・Material Icons（Apache 2.0）'] : ['WebView2-SDK-BSD-3-Clause.txt', 'Microsoft WebView2 SDK（BSD 3-Clause）'],
  ];
  const text = h('pre', { class: 'license-text' }, '読み込み中…');
  const show = async (file) => {
    try { text.textContent = await (await fetch(`licenses/${file}`)).text(); }
    catch { text.textContent = 'ライセンスの文を読み込めませんでした。'; }
  };
  const pick = h('select', { onchange: (e) => show(e.target.value) }, LIST.map(([f, l]) => h('option', { value: f }, l)));
  show(LIST[0][0]);
  await modal({ title: 'ライセンスの全文', wide: true, body: [pick, text], buttons: [{ label: '閉じる', value: null, kind: 'primary' }] });
}

async function disclaimerDialog(requireAgree) {
  const v = await modal({
    title: DISCLAIMER.title,
    wide: true,
    dismissable: !requireAgree,
    body: guideBody(DISCLAIMER),
    buttons: requireAgree
      ? [{ label: '安全ガイドを読む', value: 'guide' }, { label: '同意して使い始める', value: 'agree', kind: 'primary' }]
      : [{ label: '閉じる', value: null, kind: 'primary' }],
  });
  if (!requireAgree) return;
  if (v === 'guide') { await guideDialog(); return disclaimerDialog(true); }
  await store.setSetting('disclaimerAccepted', DISCLAIMER_VERSION);
}

// デスクトップ版（WebView2）がウィンドウを閉じる前に未保存の変更を確認するため
window.__kagibakoIsDirty = () => !!S.dirty;

// PC版：閉じるときの自動保存。保存を始めたら true を返し、終わったら closeReady で結果を知らせる
window.__kagibakoAutoSaveOnClose = () => {
  if (!settings.autoSaveOnClose || !S.dirty || S.screen !== 'main' || !S.file?.handle) return false;
  (async () => {
    try { await save(); } catch { /* save 内で表示済み */ }
    host.call('closeReady', { status: S.dirty ? 'dirty' : 'saved' }).catch(() => {});
  })();
  return true;
};

// PC版：Windows のシャットダウン時。未保存の変更は暗号化して一時保存（次回ロック解除後に復元を案内）
window.__kagibakoEmergencyLock = () => { if (S.screen === 'main') lock(); return true; };

// Android版の「戻る」ボタン：ダイアログを閉じる → 詳細から一覧へ戻る。処理したら true
window.__kagibakoBack = () => {
  const closeBtn = document.querySelector('.overlay .modal-head .icon-btn');
  if (closeBtn) { closeBtn.click(); return true; }
  if (document.querySelector('.overlay')) return true; // 閉じられないダイアログ（同意待ちなど）
  if (S.screen === 'main' && S.mobileDetail) { setMobileDetail(false); return true; }
  if (S.screen === 'main' && isPhone() && !S.search.trim() && phoneUp()) return true;
  return false;
};

/**
 * Android版：自動入力サービスの案内。
 * 最初の画面（start）では、まだ設定していないときだけ出す（「今後表示しない」で消せる）。設定画面では常に出す
 */
async function autofillCard({ where = 'settings' } = {}) {
  let st = { supported: false, enabled: false };
  try { st = await host.call('autofillStatus'); } catch { /* 無視 */ }
  if (!st.supported) return null;
  if (where === 'start' && (st.enabled || (await store.getSetting('autofillCardHidden', false)))) return null;
  const autoPick = h('input', { type: 'checkbox', checked: (await store.getSetting('autofillAutoPick', true)) !== false,
    onchange: (e) => store.setSetting('autofillAutoPick', e.target.checked) });
  const card = h('section', { class: `card${st.enabled ? '' : ' safety-card'}` },
    h('h2', { class: 'inline-ic' }, icon('key'), '他のアプリへの自動入力'),
    st.enabled
      ? h('p', { class: 'small' }, '有効です。ログイン欄をタップすると「Kagibako で入力」が表示されます。ブラウザは Chrome をおすすめします。Chrome では、Chrome 側の設定で「他のサービスを使用して自動入力」を選ぶ必要があります（使い方 →「ブラウザやアプリでログインする」）。ほかのブラウザでは、正しく動かないことがあります。')
      : [h('p', { class: 'small' }, 'Kagibako を「自動入力サービス」に設定すると、ヤフーなどのアプリやブラウザのログイン欄に、ボタン一つで ID・パスワードを入力できます。'),
        h('button', { class: 'btn primary', onclick: () => host.call('enableAutofill').catch((e) => toast(e.message)) }, '自動入力サービスに設定する')],
    where === 'settings' ? h('label', { class: 'check' }, autoPick, 'そのサイト（アプリ）に合うアイテムが1つだけなら、選ぶ画面を出さずにすぐ入力する（この端末にファイルが2つ以上あるときは、取り違えを防ぐため、いつも選ぶ画面を出します）') : null,
    h('p', { class: 'muted small' }, '自動入力には、この端末で最後に開いた（保存した）版のデータを使います。'),
    where === 'start' ? h('button', { class: 'link small', onclick: async () => { await store.setSetting('autofillCardHidden', true); card.remove(); } }, '今後この案内を表示しない（設定からいつでも設定できます）') : null);
  return card;
}

// 開発時（localhost）の動作確認用フック：ファイル選択ダイアログを使わずにバイト列を開く
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  window.__kagibakoTest = { open: (name, bytes, handle = null) => beginUnlock({ name, bytes, handle, lastModified: Date.now() }), quickUnlock: (entry) => quickUnlock(entry), openLastFile: () => openLastFile() };
}

// スマホの画面（ui-phone.js）・PC の画面（ui-pc.js）から使う
export {
  pwHint, ibtn, $detail, $layout, $mbar, $tree, S, addFolder, addItem, autoTypeItem, charSpans, copyText, deleteNode, duplicateItem, editLocked, generatorDialog, helpDialog, helpTabs, lock, menuGroups, moveNode, moveTarget, openHelpTab, openOfficialSite, passwordHistoryDialog, printDialog, renderDetail, renderMain, renderTree, runMenu, save, select, selected, settings, sortSelected, startRename, phoneNewItem, toggleReadOnly, touch, removeNode, setMobileDetail, bioSetupBox,
};

boot();

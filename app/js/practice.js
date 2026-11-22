// Kagibako — ログインの練習（スマホ）
// 押すボタンを光らせて順に案内し、練習用のアイテムを作って、練習用のログインページで「Kagibako で入力」まで体験してもらう。
// ・練習用のページは公式サイトにある（どこにも送信しない作り）。Kagibako 自身の画面には自動入力が出ないため、ブラウザで開く
// ・いつでも［練習をやめる］で抜けられる。ほかの操作も止めない（光らせて案内するだけ）
import { h, clear, toast } from './ui.js';
import { icon } from './icons.js';
import * as M from './model.js';
import * as host from './host.js';
import { S, selected, renderDetail, renderTree, save, openOfficialSite, removeNode, setMobileDetail, settings } from './app.js';
import { browserChoiceBox } from './ui-phone.js';

const PRACTICE_URL = 'https://ayamuo.github.io/kagibako_official/practice-login.html';
const PRACTICE_NAME = 'ログインの練習';

let P = null; // 練習中の状態 { step, itemId, known:Set, timer, box, left }

const q = (sel) => document.querySelector(sel);
const practiceItem = () => (P?.itemId ? M.findById(S.vault, P.itemId) : null);
/** 編集の画面の値の欄（0：ID、1：パスワード） */
const valueInput = (n) => document.querySelectorAll('.detail .fname-phone + input')[n] || null;

/** 案内の順番。target：光らせるもの（なければ真ん中に出す）／done：次へ進む条件 */
const STEPS = [
  { text: '右下の［＋］を押してください。', target: () => q('.fab'), done: () => !!q('.m-add-choice') || !!P.itemId },
  { text: '「アイテムを追加」を押してください。', target: () => q('.m-add-choice'), done: () => !!P.itemId },
  // 入れ終わったか：中身があり、その欄から入力位置が離れたとき（1文字目で次の案内に変わらないように）
  { text: '練習用のアイテムができました。ID の欄に、好きな文字を入れてください（練習用です。本物の ID は入れないでください）。入れたら、パスワードの欄を押してください。', target: () => valueInput(0), done: () => !!practiceItem()?.node.account && document.activeElement !== valueInput(0) },
  { text: 'パスワードの欄にも、好きな文字を入れてください。入れたら、上の［完了］を押してください。', target: () => valueInput(1), done: () => !!practiceItem()?.node.password && document.activeElement !== valueInput(1) },
  { text: '入れたら、上の［完了］を押してください。', target: () => q('.m-editbar .btn.primary'), done: () => !S.mobileEdit },
  { text: '［保存］を押して、ファイルに保存してください。', target: () => q('.topbar button[aria-label="保存"]'), done: () => !S.dirty },
  { id: 'autofill' },
  { id: 'browser' },
  { key: 'open', text: '［公式サイトを開く］を押すと、ブラウザで練習用のログインページが開きます。ページの ID の欄を押して、「Kagibako で入力」を選んでください。', target: () => q('.m-open'), done: () => P.left },
  { id: 'back' },
];

/** 練習を始める（最初の説明の最後・☰ →「ヘルプ」から） */
function startPractice() {
  if (!S.vault) return;
  if (settings.readOnly) { toast('「閲覧のみ」を外してから始めてください（☰ →「表示」）'); return; }
  stopPractice();
  P = { step: 0, itemId: null, known: new Set([...M.walk(S.vault.children)].map((e) => e.node.id)), left: false };
  S.mobileEdit = false;
  setMobileDetail(false);
  P.box = h('div', { class: 'coach', role: 'dialog', 'aria-live': 'polite' });
  document.body.append(P.box);
  document.addEventListener('visibilitychange', onVisibility);
  P.timer = setInterval(tick, 300);
  tick();
}

function stopPractice() {
  if (!P) return;
  clearInterval(P.timer);
  document.removeEventListener('visibilitychange', onVisibility);
  P.box?.remove();
  P.cur?.classList.remove('coach-target');
  P = null;
}

function onVisibility() {
  if (!P) return;
  // ページを開く段でブラウザへ移った（Kagibako が裏に回った）＝練習ページを開いた
  if (document.visibilityState === 'hidden' && STEPS[P.step]?.key === 'open') P.left = true;
  if (document.visibilityState === 'visible') tick();
}

/** 新しくできたアイテムを練習用にする（名前と練習ページの URL を入れておく） */
function adoptNewItem() {
  if (P.itemId) return;
  const e = selected();
  if (e?.node.type !== 'item' || P.known.has(e.node.id)) return;
  P.itemId = e.node.id;
  if (!e.node.name || e.node.name === '新しいアイテム') e.node.name = PRACTICE_NAME;
  if (!e.node.url) e.node.url = PRACTICE_URL;
  renderTree();
  renderDetail();
  valueInput(0)?.focus(); // そのまま ID を入れられるように
}

/** 光らせるものを付け替える（同じものなら触らない。光る動きが毎回最初からにならないように） */
function highlight(target) {
  if (P.cur === target && target?.isConnected) return;
  P.cur?.classList.remove('coach-target');
  P.cur = target || null;
  P.cur?.classList.add('coach-target');
}

function tick() {
  if (!P) return;
  if (!S.vault || S.screen !== 'main') { stopPractice(); return; } // ロック・ファイルを閉じたときはやめる
  adoptNewItem();
  // 進める（条件を満たしている段は続けて飛ばす）
  while (P.step < STEPS.length && STEPS[P.step].done?.()) P.step++;
  const step = STEPS[P.step];
  if (step.id) { highlight(null); showCard(step.id); return; }
  const target = step.target?.() || null;
  highlight(target);
  showBubble(step.text, target);
}

const quitBtn = () => h('button', { class: 'link small coach-quit', type: 'button', onclick: stopPractice }, '練習をやめる');

/** 光らせたものの近く（下、入らなければ上）に吹き出しを出す */
function showBubble(text, target) {
  if (P.box.dataset.kind !== 'bubble' || P.box.dataset.text !== text) {
    P.box.dataset.kind = 'bubble';
    P.box.dataset.text = text;
    P.box.dataset.card = '';
    clear(P.box, h('p', {}, text), quitBtn());
  }
  P.box.classList.remove('coach-card');
  const r = target?.getBoundingClientRect();
  const bh = P.box.offsetHeight;
  let top;
  if (!r || r.width === 0) top = innerHeight - bh - 90;
  else if (r.bottom + 12 + bh < innerHeight - 8) top = r.bottom + 12;
  else top = Math.max(8, r.top - 12 - bh);
  P.box.style.top = `${Math.round(top)}px`;
}

/** 光らせるものがない段：真ん中に説明とボタンを出す */
function showCard(id) {
  if (P.box.dataset.card === id) return;
  P.box.dataset.card = id;
  P.box.dataset.kind = 'card';
  P.box.dataset.text = '';
  P.box.classList.add('coach-card');
  P.box.style.top = '';
  const next = () => { P.step++; P.box.dataset.card = ''; tick(); };
  if (id === 'autofill') {
    if (!host.isAndroid) { clear(P.box, h('p', {}, 'ここから先（ほかのアプリへの自動入力）は、Android 版で試せます。'), h('div', { class: 'coach-row' }, h('button', { class: 'btn primary', type: 'button', onclick: stopPractice }, '練習を終える'))); return; }
    const status = h('p', { class: 'muted small' });
    const refresh = async () => {
      const st = await host.call('autofillStatus').catch(() => null);
      if (st?.enabled) { if (P?.box.dataset.card === 'autofill') next(); return true; }
      status.textContent = 'まだ設定されていません。';
      return false;
    };
    clear(P.box,
      h('p', {}, '次は、ほかのアプリやブラウザに入力できるように、Kagibako を「自動入力サービス」に設定します。'),
      status,
      h('div', { class: 'coach-row' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => host.call('enableAutofill').catch((e) => toast(e.message)) }, '設定を開く'),
        h('button', { class: 'btn', type: 'button', onclick: refresh }, '設定した')),
      quitBtn());
    refresh();
    return;
  }
  if (id === 'browser') {
    clear(P.box,
      h('p', {}, '練習用のページ（と、ふだんの［公式サイトを開く］）を開くブラウザを選んでください。あとで 設定 →「自動入力」でも変えられます。'),
      browserChoiceBox(),
      h('div', { class: 'coach-row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => { const e = practiceItem(); if (e) { S.sel = e.node.id; setMobileDetail(true); renderTree(); renderDetail(); } next(); } }, '次へ')),
      quitBtn());
    return;
  }
  if (id === 'back') {
    const e = practiceItem();
    const finish = async (removeItem) => {
      const it = practiceItem();
      stopPractice();
      if (removeItem && it) {
        removeNode(it.node, it.parent);
        await save(); // 保存の知らせのあとに、消したことを知らせる
      }
      toast(removeItem ? '練習は終わりです。練習用のアイテムを消しました' : '練習は終わりです。練習用のアイテムは残しました（あとで消せます）');
    };
    const askRemove = () => clear(P.box,
      h('p', {}, 'これで練習はおしまいです。練習用のアイテム「' + (e?.node.name || PRACTICE_NAME) + '」は消しますか？'),
      h('div', { class: 'coach-row' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => finish(true) }, '消す'),
        h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, '残す')));
    const trouble = () => clear(P.box,
      h('p', {}, '「Kagibako で入力」が出ないときは、次を確かめてください。'),
      h('ul', { class: 'small coach-list' },
        h('li', {}, 'Chrome で開いているか（ほかのブラウザでは正しく動かないことがあります。設定 →「自動入力」の「公式サイトを開くブラウザ」で Chrome を選べます）'),
        h('li', {}, 'Chrome の 設定 →「自動入力サービス」→「他のサービスを使用して自動入力」＋ Chrome の再起動'),
        h('li', {}, 'ID の欄をもう一度押す')),
      h('div', { class: 'coach-row' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => {
          const it = practiceItem();
          if (!it) return;
          // 「ページを開く」段に戻してから開く（ブラウザへ移ると、戻ってきたときにまたこの確認を出す）
          P.left = false;
          P.step = STEPS.findIndex((s) => s.key === 'open');
          P.box.dataset.card = '';
          openOfficialSite(it.node);
        } }, 'もう一度ページを開く'),
        h('button', { class: 'btn', type: 'button', onclick: askRemove }, '練習を終える')));
    clear(P.box,
      h('div', { class: 'coach-ic' }, icon('ok')),
      h('p', {}, 'おかえりなさい。練習用のページで「入力できました！」と出ましたか？'),
      h('div', { class: 'coach-row' },
        h('button', { class: 'btn primary', type: 'button', onclick: askRemove }, 'できた'),
        h('button', { class: 'btn', type: 'button', onclick: trouble }, 'うまくいかなかった')));
  }
}

export { startPractice, stopPractice, PRACTICE_URL };

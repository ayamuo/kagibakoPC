// 自動入力（PC版）: 手順テンプレート → 打鍵ステップ列への変換と、入力先ウィンドウに合うアイテムの推定
//
// テンプレート例: {ID}{TAB}{PASSWORD}{ENTER}
//   アイテムの値 : {ID} {PASSWORD} {ITEM1} {ITEM2} {URL} {EMAIL} {SERIAL} {SERIALTAB} {FILE} {TITLE}
//                  {SERIALTAB} はシリアル番号のハイフンを Tab として入力（分割された入力欄用）
//   個人情報     : {FAMILY} {GIVEN} {FAMILYKANA} {GIVENKANA} {MAIL1} {ZIP1} {PREF1} {ADDR1} {TEL1} {COMPANY} など
//   キー         : {TAB} {SHIFT+TAB} {ENTER} {SPACE} {UP} {DOWN} {LEFT} {RIGHT} {HOME} {END}
//                  {SHIFT+HOME} {SHIFT+END} {BACKSPACE} {DELETE} {ESC}
//   入力欄の移動 : {USERFIELD}（ID欄へ）{PASSFIELD}（パスワード欄へ）… スマート入力。Tab を使わず欄を探して移動する
//   待機         : {DELAY 500}（ミリ秒）
//   文字の { } は {{ }} と書く。それ以外の文字はそのまま入力する

/** 以前の既定の手順（Tab で移動） */
export const CLASSIC_TEMPLATE = '{ID}{TAB}{PASSWORD}{ENTER}';
/** 既定の手順：ID欄・パスワード欄を探して入力（間にチェックボックスやリンクがあっても大丈夫） */
export const DEFAULT_TEMPLATE = '{USERFIELD}{ID}{PASSFIELD}{PASSWORD}{ENTER}';

export const PRESETS = [
  ['', '既定（設定の手順を使う）'],
  ['{USERFIELD}{ID}{PASSFIELD}{PASSWORD}{ENTER}', 'おまかせ：ID欄・パスワード欄を探して入力 → Enter（推奨）'],
  ['{USERFIELD}{ID}{PASSFIELD}{PASSWORD}', 'おまかせ：ID欄・パスワード欄を探して入力（Enter なし）'],
  ['{USERFIELD}{ID}{ENTER}{PASSFIELD}{PASSWORD}{ENTER}', 'おまかせ：ID → Enter → パスワード欄が出たら入力（2段階の画面）'],
  ['{PASSFIELD}{PASSWORD}{ENTER}', 'おまかせ：パスワード欄を探してパスワードのみ → Enter'],
  ['{ID}{TAB}{PASSWORD}{ENTER}', 'ID → Tab → パスワード → Enter'],
  ['{ID}{TAB}{PASSWORD}', 'ID → Tab → パスワード（Enter なし）'],
  ['{ID}{ENTER}{DELAY 1500}{PASSWORD}{ENTER}', 'ID → Enter → 1.5秒待つ → パスワード → Enter（2段階の画面）'],
  ['{PASSWORD}{ENTER}', 'パスワード → Enter'],
  ['{PASSWORD}', 'パスワードのみ'],
  ['{ID}', 'ID のみ'],
];

const VALUE_KEYS = {
  ID: 'account', PASSWORD: 'password', ITEM1: 'item1', ITEM2: 'item2',
  URL: 'url', EMAIL: 'email', SERIAL: 'serialNumber', FILE: 'file', TITLE: 'name',
};
export const PROFILE_KEYS = {
  FAMILY: 'familyName', GIVEN: 'givenName', FAMILYKANA: 'familyNamePhonetic', GIVENKANA: 'givenNamePhonetic',
  FAMILYKANA2: 'familyNamePhonetic2', GIVENKANA2: 'givenNamePhonetic2',
  MAIL1: 'e-mail1', MAIL2: 'e-mail2', MAIL3: 'e-mail3',
  ZIP1: 'zip1', PREF1: 'prefecture1', ADDR1: 'address1', ZIP2: 'zip2', PREF2: 'prefecture2', ADDR2: 'address2',
  TEL1: 'tel1', TEL2: 'tel2', HANDLE1: 'handlename1', HANDLE2: 'handlename2', COMPANY: 'company',
};
export const SPECIAL_KEYS = ['TAB', 'SHIFT+TAB', 'ENTER', 'SPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END',
  'SHIFT+HOME', 'SHIFT+END', 'BACKSPACE', 'DELETE', 'ESC'];

/** 手順の編集画面で使う記号の一覧 [記号, 説明] */
export const TOKEN_HELP = [
  ['{USERFIELD}', 'ID欄へ移動'], ['{PASSFIELD}', 'パスワード欄へ移動'],
  ['{ID}', 'ID'], ['{PASSWORD}', 'パスワード'], ['{ITEM1}', '項目1'], ['{ITEM2}', '項目2'],
  ['{SERIAL}', 'シリアル'], ['{SERIALTAB}', 'シリアル（-をTab）'], ['{URL}', 'URL'], ['{EMAIL}', 'メール'], ['{FILE}', 'ファイル'],
  ['{TAB}', 'Tab'], ['{SHIFT+TAB}', 'Shift+Tab'], ['{ENTER}', 'Enter'], ['{SPACE}', 'Space'],
  ['{HOME}', 'Home'], ['{END}', 'End'], ['{SHIFT+HOME}', 'Shift+Home'], ['{SHIFT+END}', 'Shift+End'], ['{DELETE}', 'Delete'],
  ['{UP}', '↑'], ['{DOWN}', '↓'], ['{LEFT}', '←'], ['{RIGHT}', '→'], ['{DELAY 1000}', '1秒待つ'],
  ['{FAMILY}', '姓'], ['{GIVEN}', '名'], ['{FAMILYKANA}', '姓ふりがな'], ['{GIVENKANA}', '名ふりがな'],
  ['{MAIL1}', 'メール1'], ['{ZIP1}', '郵便番号1'], ['{PREF1}', '都道府県1'], ['{ADDR1}', '住所1'], ['{TEL1}', '電話1'], ['{COMPANY}', '勤務先'],
];

/** 項目ごとの「直前のウィンドウへ入力」に使う手順 */
export const FIELD_TEMPLATES = {
  account: '{ID}', password: '{PASSWORD}', item1: '{ITEM1}', item2: '{ITEM2}',
  serialNumber: '{SERIALTAB}', url: '{URL}', email: '{EMAIL}', file: '{FILE}',
};

/**
 * テンプレートを打鍵ステップへ。
 * 戻り値: [{t:'text', v}, {t:'key', v:'TAB'}, {t:'delay', ms}]
 */
export function compileTemplate(template, item, profile = {}) {
  const steps = [];
  const pushText = (s) => {
    if (!s) return;
    const last = steps[steps.length - 1];
    if (last?.t === 'text') last.v += s; else steps.push({ t: 'text', v: s });
  };
  let i = 0;
  const src = template || DEFAULT_TEMPLATE;
  while (i < src.length) {
    if (src.startsWith('{{', i)) { pushText('{'); i += 2; continue; }
    if (src.startsWith('}}', i)) { pushText('}'); i += 2; continue; }
    if (src[i] === '{') {
      const end = src.indexOf('}', i);
      if (end < 0) throw new Error(`自動入力の手順の書き方が正しくありません（「}」がありません）: ${src.slice(i)}`);
      const token = src.slice(i + 1, end).trim().toUpperCase().replace(/\s*\+\s*/g, '+');
      i = end + 1;
      const delay = token.match(/^DELAY\s+(\d{1,5})$/);
      if (delay) { steps.push({ t: 'delay', ms: Math.min(10000, +delay[1]) }); continue; }
      if (token === 'USERFIELD') { steps.push({ t: 'focus', v: 'user' }); continue; }
      if (token === 'PASSFIELD') { steps.push({ t: 'focus', v: 'password' }); continue; }
      if (token === 'SERIALTAB') {
        oneLine(item?.serialNumber).split('-').forEach((part, n) => { if (n) steps.push({ t: 'key', v: 'TAB' }); pushText(part); });
        continue;
      }
      if (VALUE_KEYS[token]) { pushText(oneLine(item?.[VALUE_KEYS[token]])); continue; }
      if (PROFILE_KEYS[token]) { pushText(profile?.[PROFILE_KEYS[token]] ?? ''); continue; }
      if (SPECIAL_KEYS.includes(token)) { steps.push({ t: 'key', v: token }); continue; }
      throw new Error(`自動入力の手順に知らない記号があります: {${token}}`);
    }
    pushText(src[i]);
    i++;
  }
  return steps;
}

/**
 * アイテムの値に含まれる改行・Tab などの制御文字は入力しない。
 * 取り込んだデータに改行が混ざっていると、入力先で Enter として働き、意図しない送信やコマンド実行につながるため。
 */
export function oneLine(v) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, '');
}

/** テンプレートの検証（UI 用）。問題なければ null */
export function templateError(template) {
  try { compileTemplate(template, {}, {}); return null; } catch (e) { return e.message; }
}

/** 表示用の説明（custom: 利用者が登録した手順 [{name, template}]） */
export function describeTemplate(template, custom = []) {
  const p = PRESETS.find(([t]) => t === template);
  if (p) return p[1];
  const c = custom.find((x) => x.template === template);
  return c ? c.name : template;
}

function hostOf(url) {
  try { return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/**
 * 入力先ウィンドウのタイトルとアイテムの一致度（大きいほど有力）。
 * ブラウザのタイトルは「ページ名 - サイト名 - ブラウザ名」なので、タイトルや URL の語を探す。
 */
export function matchScore(item, windowTitle) {
  const title = (windowTitle || '').toLowerCase();
  if (!title) return 0;
  let score = 0;
  const name = (item.name || '').toLowerCase().trim();
  if (name && name.length >= 2 && title.includes(name)) score += 10 + name.length;
  const host = hostOf(item.url || '');
  if (host) {
    const parts = host.split('.').filter((p) => p.length >= 3 && !['com', 'net', 'org', 'www', 'co', 'jp', 'ne', 'or', 'ac', 'go'].includes(p));
    for (const p of parts) if (title.includes(p)) score += 8 + p.length;
  }
  for (const w of name.split(/[\s　・\-_/()（）]+/).filter((x) => x.length >= 2)) if (title.includes(w)) score += 3;
  return score;
}

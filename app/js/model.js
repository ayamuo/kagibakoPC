// 共通データモデル（.kagi と、読み込んだ .idm の両方をこの形で扱う）

export const PROFILE_FIELDS = [
  ['familyName', '姓'],
  ['givenName', '名'],
  ['familyNamePhonetic', '姓（フリガナ）'],
  ['givenNamePhonetic', '名（フリガナ）'],
  ['familyNamePhonetic2', '姓（カタカナ）'],
  ['givenNamePhonetic2', '名（カタカナ）'],
  ['e-mail1', 'メール1'],
  ['e-mail2', 'メール2'],
  ['e-mail3', 'メール3'],
  ['zip1', '郵便番号1'],
  ['prefecture1', '都道府県1'],
  ['address1', '住所1'],
  ['zip2', '郵便番号2'],
  ['prefecture2', '都道府県2'],
  ['address2', '住所2'],
  ['tel1', '電話1'],
  ['tel2', '電話2'],
  ['handlename1', 'ハンドル名1'],
  ['handlename2', 'ハンドル名2'],
  ['company', '勤務先'],
];

// アイテムの比較・表示に使う項目（ラベル, キー）
export const ITEM_FIELDS = [
  ['name', 'タイトル'],
  ['accountName', 'ID欄の名前'],
  ['account', 'ID'],
  ['passwordName', 'パスワード欄の名前'],
  ['password', 'パスワード'],
  ['item1Name', '項目1の名前'],
  ['item1', '項目1'],
  ['item2Name', '項目2の名前'],
  ['item2', '項目2'],
  ['serialNumber', 'シリアル番号'],
  ['url', 'URL'],
  ['email', 'メール'],
  ['file', 'ファイル'],
  ['issueDate', '発行日'],
  ['expirationDate', '有効期限'],
  ['autoType', '自動入力の手順'],
  ['comment', 'メモ'],
];

export const PASSWORD_HISTORY_MAX = 20;

/** パスワード変更時に、変更前の値を履歴に残す */
export function pushPasswordHistory(item, oldPassword, at = Date.now()) {
  if (!oldPassword || oldPassword === item.password) return;
  item.passwordHistory ||= [];
  if (item.passwordHistory[0]?.password === oldPassword) return;
  item.passwordHistory.unshift({ password: oldPassword, until: at });
  item.passwordHistory = item.passwordHistory.slice(0, PASSWORD_HISTORY_MAX);
}

/** 2つの履歴を合わせる（統合時用） */
export function mergePasswordHistory(a = [], b = [], currentPassword = '') {
  const seen = new Set();
  return [...a, ...b]
    .sort((x, y) => (y.until || 0) - (x.until || 0))
    .filter((h) => {
      const k = `${h.password}\u0000${h.until}`;
      if (seen.has(k) || !h.password) return false;
      seen.add(k);
      return true;
    })
    .slice(0, PASSWORD_HISTORY_MAX);
}

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDaysISO(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return todayISO(dt);
}

export function newVault() {
  const profile = {};
  for (const [k] of PROFILE_FIELDS) profile[k] = '';
  return {
    profile,
    defaults: { accountName: 'Account ID', passwordName: 'Password', item1Name: '', item2Name: '' },
    pasteTypeListXml: '',
    children: [],
    tombstones: [], // {id, deletedAt} 削除の記録（統合時に「削除」を正しく反映するため）
  };
}

export function newFolder(name = '新しいフォルダ') {
  const now = Date.now();
  return { type: 'folder', id: uuid(), name, open: true, selected: false, children: [], created: now, modified: now };
}

export function newItem(vault, name = '新しいアイテム') {
  const now = Date.now();
  const today = todayISO();
  return {
    type: 'item',
    id: uuid(),
    name,
    selected: false,
    accountName: vault?.defaults?.accountName ?? 'Account ID',
    account: '',
    passwordName: vault?.defaults?.passwordName ?? 'Password',
    password: '',
    item1Name: vault?.defaults?.item1Name ?? '',
    item1: '',
    item2Name: vault?.defaults?.item2Name ?? '',
    item2: '',
    serialNumber: '',
    comment: '',
    url: '',
    email: '',
    file: '',
    issueDate: today,
    expirationDate: addDaysISO(today, 365),
    pasteType: '0',
    autoType: '',
    passwordHistory: [],
    extra: [],
    created: now,
    modified: now,
  };
}

/** 木を走査して {node, parent, path} を列挙 */
export function* walk(children, parent = null, path = []) {
  for (const node of children) {
    yield { node, parent, path };
    if (node.type === 'folder') yield* walk(node.children, node, [...path, node.name]);
  }
}

export function findById(vault, id) {
  for (const e of walk(vault.children)) if (e.node.id === id) return e;
  return null;
}

export function listItems(vault) {
  const out = [];
  for (const e of walk(vault.children)) if (e.node.type === 'item') out.push(e);
  return out;
}

export function containerOf(vault, parent) {
  return parent ? parent.children : vault.children;
}

export function cloneVault(v) {
  return structuredClone(v);
}

/** 内容比較用の正規化（ID・時刻・選択状態など表示に関係ない情報を除く） */
export function canonicalContent(vault) {
  const strip = (nodes) => nodes.map((n) => {
    if (n.type === 'folder') return { f: n.name, c: strip(n.children) };
    const o = {};
    for (const [k] of ITEM_FIELDS) o[k] = n[k] ?? '';
    return o;
  });
  return JSON.stringify({ p: vault.profile, d: vault.defaults, t: vault.pasteTypeListXml || '', c: strip(vault.children) });
}

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function contentHash(vault) {
  return sha256Hex(canonicalContent(vault));
}

export function countItems(vault) {
  let folders = 0, items = 0;
  for (const { node } of walk(vault.children)) node.type === 'folder' ? folders++ : items++;
  return { folders, items };
}

export function isExpired(item, today = todayISO()) {
  return !!item.expirationDate && item.expirationDate < today;
}

/** まだ期限切れではないが、days 日以内に期限が来る（days が 0 なら常に false） */
export function isExpiringSoon(item, days, today = todayISO()) {
  if (!days || !item.expirationDate || isExpired(item, today)) return false;
  return item.expirationDate <= addDaysISO(today, days);
}

/**
 * ドラッグでの移動。position: 'before' | 'after'（target の前後）| 'inside'（フォルダ target の中の最後）
 * targetId が null なら最上位の最後。移動できないときは false（何も変えない）。
 * 決まり：アイテムは最上位に置けない（必ずフォルダの中）。フォルダは自分の中へは移せない。
 */
export function canMoveNode(vault, nodeId, targetId, position) {
  const src = findById(vault, nodeId);
  if (!src) return false;
  if (targetId === null) return src.node.type === 'folder';
  if (targetId === nodeId) return false;
  const dst = findById(vault, targetId);
  if (!dst) return false;
  // 自分自身・自分の子孫の中（や前後）へは移せない
  if (src.node.type === 'folder' && findById({ children: src.node.children }, targetId)) return false;
  if (position === 'inside') return dst.node.type === 'folder';
  if (position !== 'before' && position !== 'after') return false;
  if (!dst.parent && src.node.type === 'item') return false; // 前後に入れると最上位になる
  return true;
}

export function moveNodeTo(vault, nodeId, targetId, position) {
  if (!canMoveNode(vault, nodeId, targetId, position)) return false;
  const src = findById(vault, nodeId);
  const from = containerOf(vault, src.parent);
  from.splice(from.indexOf(src.node), 1);
  if (targetId === null) { vault.children.push(src.node); return true; }
  const dst = findById(vault, targetId);
  if (position === 'inside') { dst.node.children.push(src.node); dst.node.open = true; return true; }
  const list = containerOf(vault, dst.parent);
  const i = list.indexOf(dst.node);
  list.splice(position === 'before' ? i : i + 1, 0, src.node);
  return true;
}

// .idm ファイルの読み込み（手持ちのデータを取り込むため。書き込みはしない）。
//
// 形式:
//   鍵     : パスワード(Shift_JIS)を 56 バイトまでゼロ埋めしたものをそのまま Blowfish 鍵にする（KDFなし）
//   0-63   : 固定文字列 MAGIC(64文字) を Blowfish-ECB で暗号化した「パスワード検証子」
//   64-    : Shift_JIS の XML（<idmData>…）を 8 バイト境界までゼロ埋めし Blowfish-ECB で暗号化
//   ブロック: 8バイトを「リトルエンディアンの32bit語×2」として処理
//   改ざん検知(MAC)やソルトは無い。読み込んだ後は .kagi 形式で保存する。
import { Blowfish } from './blowfish.js';
import { encodeSjis, decodeSjis } from './sjis.js';
import { parseXml } from './xmlmini.js';
import { PROFILE_FIELDS, newVault, uuid } from './model.js';

export const LEGACY_MAGIC = 'GNjGBErFn25jEQFPaaWHvVjHY5HkYXJKHo02gQVIbiLitprF8uQOVxEFr1MvODk7';
export const LEGACY_MAX_PASSWORD_BYTES = 56;
/** .idm で「期限なし」を表す日付 */
export const NO_EXPIRY = '2099-12-31';

export class WrongPasswordError extends Error {
  constructor(msg = 'パスワードが違います') { super(msg); this.name = 'WrongPasswordError'; }
}

export function looksLikeLegacy(bytes) {
  return bytes.length >= 64 && bytes.length % 8 === 0 && !(bytes[0] === 0x7b /* { */);
}

/** パスワード → 56バイト鍵 */
export function legacyKey(password) {
  const { bytes, unmappable } = encodeSjis(password);
  if (unmappable.length) throw new Error(`.idm のパスワードに使えない文字があります: ${unmappable.join(' ')}`);
  if (bytes.length > LEGACY_MAX_PASSWORD_BYTES) throw new Error(`.idm のパスワードは Shift_JIS で ${LEGACY_MAX_PASSWORD_BYTES} バイト以内にしてください`);
  const key = new Uint8Array(56);
  key.set(bytes);
  return key;
}

function cipherFor(key) {
  return new Blowfish(key);
}

/** .idm を復号して XML 文字列を返す */
export function decryptLegacy(bytes, key) {
  if (bytes.length < 64 || bytes.length % 8 !== 0) throw new Error('.idm 形式のファイルではないようです（サイズ不正）');
  const bf = cipherFor(key);
  try {
    const header = decodeSjis(bf.decryptECB(bytes.subarray(0, 64)));
    if (header !== LEGACY_MAGIC) {
      throw new WrongPasswordError('パスワードが違うか、対応していない形式です');
    }
    let body = bf.decryptECB(bytes.subarray(64));
    let end = body.length;
    while (end > 0 && body[end - 1] === 0) end--;
    body = body.subarray(0, end);
    return decodeSjis(body);
  } finally {
    bf.wipe();
  }
}

// ---------- 日付 ----------
// ファイル内は mm/dd/yyyy（言語設定によっては yyyy/mm/dd の可能性もあるので両方読む）
export function legacyDateToISO(s) {
  if (!s) return '';
  const m = s.trim().match(/^(\d{1,4})\/(\d{1,2})\/(\d{1,4})$/);
  if (!m) return '';
  let y, mo, d;
  if (m[1].length === 4) [y, mo, d] = [m[1], m[2], m[3]];
  else [mo, d, y] = [m[1], m[2], m[3]];
  return `${y.padStart(4, '0')}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function isoToMs(iso) {
  const m = (iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : 0;
}

// ---------- XML ⇔ モデル ----------
const ITEM_TAGS = {
  account: ['account', 'accountName'],
  password: ['password', 'passwordName'],
  item1: ['item1', 'item1Name'],
  item2: ['item2', 'item2Name'],
};
const ITEM_SIMPLE = { serialNumber: 'serialNumber', comment: 'comment', url: 'url', 'e-mail': 'email', file: 'file', pasteType: 'pasteType' };

function convertItem(node) {
  const it = {
    type: 'item', id: uuid(), name: node.attrs.name ?? '', selected: node.attrs.selected === 'true',
    accountName: '', account: '', passwordName: '', password: '', item1Name: '', item1: '', item2Name: '', item2: '',
    serialNumber: '', comment: '', url: '', email: '', file: '', issueDate: '', expirationDate: '', pasteType: '0', autoType: '', passwordHistory: [], extra: [],
  };
  for (const c of node.children) {
    if (ITEM_TAGS[c.name]) {
      const [vk, nk] = ITEM_TAGS[c.name];
      it[vk] = c.text;
      it[nk] = c.attrs.name ?? '';
    } else if (ITEM_SIMPLE[c.name]) {
      it[ITEM_SIMPLE[c.name]] = c.text;
    } else if (c.name === 'issueDate') {
      it.issueDate = legacyDateToISO(c.text);
    } else if (c.name === 'expirationDate') {
      it.expirationDate = legacyDateToISO(c.text);
      if (it.expirationDate === NO_EXPIRY) it.expirationDate = ''; // 期限なし
    } else {
      it.extra.push(c.raw ?? ''); // 未知の要素は原文のまま保持して書き戻す
    }
  }
  // .idm には更新日時が無いので、発行日（パスワード変更時に更新される）を目安にする
  const t = isoToMs(it.issueDate);
  it.created = t;
  it.modified = t;
  return it;
}

function convertFolder(node) {
  const f = { type: 'folder', id: uuid(), name: node.attrs.name ?? '', open: node.attrs.open !== 'false', selected: node.attrs.selected === 'true', children: [], created: 0, modified: 0 };
  for (const c of node.children) {
    if (c.name === 'folder') f.children.push(convertFolder(c));
    else if (c.name === 'item') f.children.push(convertItem(c));
  }
  return f;
}

export function legacyXmlToVault(xml) {
  const doc = parseXml(xml);
  const root = doc.children.find((c) => c.name === 'idmData');
  if (!root) throw new Error('.idm のデータが見つかりません');
  const v = newVault();
  const profileKeys = new Set(PROFILE_FIELDS.map(([k]) => k));
  v.extraTopXml = [];
  for (const c of root.children) {
    if (profileKeys.has(c.name)) v.profile[c.name] = c.text;
    else if (c.name === 'defaultAccountName') v.defaults.accountName = c.text;
    else if (c.name === 'defaultPasswordName') v.defaults.passwordName = c.text;
    else if (c.name === 'defaultItem1Name') v.defaults.item1Name = c.text;
    else if (c.name === 'defaultItem2Name') v.defaults.item2Name = c.text;
    else if (c.name === 'pasteTypeList') {
      const raw = c.raw ?? '';
      v.pasteTypeListXml = raw.replace(/^<pasteTypeList[^>]*>/, '').replace(/<\/pasteTypeList>$/, '');
    } else if (c.name === 'folder') v.children.push(convertFolder(c));
    else if (c.name === 'item') v.children.push(convertItem(c));
    else v.extraTopXml.push(c.raw ?? '');
  }
  return v;
}

// ---------- 高水準 API ----------
export function openLegacy(bytes, password) {
  const key = legacyKey(password);
  try {
    return legacyXmlToVault(decryptLegacy(bytes, key));
  } finally {
    key.fill(0);
  }
}

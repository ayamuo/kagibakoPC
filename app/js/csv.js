// CSV の取り込み・書き出し（Chrome / Edge / Bitwarden / KeePass / KeePassXC / 1Password など）
import { newFolder, newItem, listItems } from './model.js';

/** バイト列 → 文字列（UTF-8 を優先、失敗したら Shift_JIS） */
export function decodeCsvBytes(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { text = new TextDecoder('shift_jis').decode(bytes); }
  return text.replace(/^﻿/, '');
}

/** RFC 4180 準拠の CSV パーサ（引用符内の改行・カンマ・"" に対応）。区切り文字は自動判定（, / ; / タブ） */
export function parseCsv(text) {
  const nl = text.search(/\r?\n/);
  const firstLine = nl < 0 ? text : text.slice(0, nl);
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]);
  const delim = counts.sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ---------- 列の自動判定 ----------
export const TARGETS = [
  ['name', 'タイトル'],
  ['account', 'ID（ユーザー名）'],
  ['password', 'パスワード'],
  ['url', 'URL'],
  ['email', 'メール'],
  ['comment', 'メモ'],
  ['folder', 'フォルダ'],
  ['totp', '2段階認証の鍵（TOTP）'],
  ['fields', '追加項目'],
];

const SYNONYMS = {
  name: ['name', 'title', 'account', 'タイトル', '名前', 'サービス', 'サイト名'],
  account: ['username', 'login_username', 'login name', 'user name', 'user', 'login', 'userid', 'user id', 'id', 'ユーザー名', 'ユーザーid', 'ログインid'],
  password: ['password', 'login_password', 'pass', 'pwd', 'パスワード'],
  url: ['url', 'login_uri', 'web site', 'website', 'uri', 'address', 'サイト', 'url/アドレス'],
  email: ['email', 'e-mail', 'mail', 'メール', 'メールアドレス'],
  comment: ['note', 'notes', 'comment', 'comments', 'extra', 'memo', 'メモ', '備考'],
  folder: ['folder', 'group', 'grouping', 'category', 'フォルダ', 'グループ', 'カテゴリ'],
  totp: ['login_totp', 'totp', 'otp', 'otpauth', 'one-time password'],
  fields: ['fields', 'custom fields'],
};

export function detectMapping(headers) {
  const norm = headers.map((h) => h.trim().toLowerCase());
  const mapping = {};
  const used = new Set();
  for (const [target] of TARGETS) {
    const idx = norm.findIndex((h, i) => !used.has(i) && SYNONYMS[target].includes(h));
    if (idx >= 0) { mapping[target] = idx; used.add(idx); }
  }
  // Bitwarden の "name" はタイトル、KeePass 1.x の "Account" もタイトル
  return mapping;
}

export function detectFormat(headers) {
  const h = headers.map((x) => x.trim().toLowerCase()).join(',');
  if (h.includes('login_uri') && h.includes('login_password')) return 'Bitwarden';
  if (h === 'name,url,username,password,note' || h === 'name,url,username,password') return 'Chrome / Edge';
  if (h.includes('login name') && h.includes('web site')) return 'KeePass';
  if (h.startsWith('group,title,username,password,url,notes')) return 'KeePassXC';
  if (h.includes('otpauth') || (h.includes('title') && h.includes('url') && h.includes('username'))) return '1Password など';
  return '汎用 CSV';
}

/**
 * CSV の行を取り込み用アイテムに変換する。
 * 戻り値: [{ path: ['フォルダ', ...], item }]
 */
export function rowsToItems(vault, rows, mapping, { useFolders = true } = {}) {
  const out = [];
  const get = (r, k) => (mapping[k] !== undefined && mapping[k] !== null && mapping[k] !== '' ? (r[mapping[k]] ?? '').trim() : '');
  for (const r of rows) {
    const it = newItem(vault, '');
    it.account = get(r, 'account');
    it.password = r[mapping.password] ?? ''; // パスワードは前後の空白も保持
    it.url = get(r, 'url');
    it.email = get(r, 'email');
    const notes = [];
    const comment = mapping.comment !== undefined ? (r[mapping.comment] ?? '') : '';
    if (comment) notes.push(comment);
    const fields = get(r, 'fields');
    if (fields) notes.push(fields);
    it.comment = notes.join('\n');
    const totp = get(r, 'totp');
    if (totp) { it.item1Name = 'TOTP'; it.item1 = totp; }
    let name = get(r, 'name');
    if (!name && it.url) { try { name = new URL(/^[a-z]+:/i.test(it.url) ? it.url : `https://${it.url}`).hostname; } catch { name = it.url; } }
    it.name = name || it.account || '(名前なし)';
    if (!it.account && !it.password && !it.url && !it.comment) continue; // 空行
    const folder = useFolders ? get(r, 'folder') : '';
    out.push({ path: folder ? folder.split(/[/\\]/).map((s) => s.trim()).filter(Boolean) : [], item: it });
  }
  return out;
}

/** 既存と「URL・ID・パスワード」がすべて同じものを重複とみなす */
export function isDuplicate(vault, item) {
  return listItems(vault).some(({ node }) => node.url === item.url && node.account === item.account && node.password === item.password && (node.url || node.account));
}

/** 取り込み実行。追加件数とスキップ件数を返す */
export function importInto(vault, entries, { folderName, skipDuplicates = true }) {
  const root = newFolder(folderName);
  let added = 0, skipped = 0;
  for (const { path, item } of entries) {
    if (skipDuplicates && isDuplicate(vault, item)) { skipped++; continue; }
    let container = root.children;
    for (const p of path) {
      let f = container.find((c) => c.type === 'folder' && c.name === p);
      if (!f) { f = newFolder(p); container.push(f); }
      container = f.children;
    }
    container.push(item);
    added++;
  }
  if (added) vault.children.push(root);
  return { added, skipped, folder: root };
}

// ---------- 書き出し ----------
export const EXPORT_FORMATS = [
  ['chrome', 'Chrome / Edge 形式（name,url,username,password,note）'],
  ['bitwarden', 'Bitwarden 形式（フォルダ付き）'],
  ['keepassxc', 'KeePassXC 形式（グループ付き）'],
];

function extraLines(it) {
  const lines = [];
  if (it.item1) lines.push(`${it.item1Name || '項目1'}: ${it.item1}`);
  if (it.item2) lines.push(`${it.item2Name || '項目2'}: ${it.item2}`);
  if (it.serialNumber) lines.push(`シリアル番号: ${it.serialNumber}`);
  if (it.email) lines.push(`メール: ${it.email}`);
  if (it.file) lines.push(`ファイル: ${it.file}`);
  if (it.expirationDate) lines.push(`有効期限: ${it.expirationDate}`);
  return lines;
}

export function exportCsv(vault, format) {
  const items = listItems(vault);
  if (format === 'bitwarden') {
    const rows = [['folder', 'favorite', 'type', 'name', 'notes', 'fields', 'reprompt', 'login_uri', 'login_username', 'login_password', 'login_totp']];
    for (const { node: it, path } of items) {
      rows.push([path.join('/'), '', 'login', it.name, it.comment, extraLines(it).join('\n'), '0', it.url, it.account, it.password, '']);
    }
    return toCsv(rows);
  }
  if (format === 'keepassxc') {
    const rows = [['Group', 'Title', 'Username', 'Password', 'URL', 'Notes']];
    for (const { node: it, path } of items) {
      rows.push([['Root', ...path].join('/'), it.name, it.account, it.password, it.url, [it.comment, ...extraLines(it)].filter(Boolean).join('\n')]);
    }
    return toCsv(rows);
  }
  const rows = [['name', 'url', 'username', 'password', 'note']];
  for (const { node: it } of items) {
    rows.push([it.name, it.url, it.account, it.password, [it.comment, ...extraLines(it)].filter(Boolean).join('\n')]);
  }
  return toCsv(rows);
}

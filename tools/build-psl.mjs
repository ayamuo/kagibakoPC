// 公開サフィックス一覧（Public Suffix List）を、アプリで使う app/js/psl-data.js に変換する
// 実行: node tools/build-psl.mjs
//
// 元のデータ: tools/psl/public_suffix_list.dat（https://publicsuffix.org/list/public_suffix_list.dat から取得）
// ライセンス: Mozilla Public License 2.0（https://mozilla.org/MPL/2.0/）。データは改変せず、形だけ変えて同梱する
// 更新するとき: 上の URL から取り直して tools/psl に置き、このスクリプトを実行する
import fs from 'node:fs';
import path from 'node:path';
import { domainToASCII } from 'node:url';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'tools', 'psl', 'public_suffix_list.dat');
const out = path.join(root, 'app', 'js', 'psl-data.js');

const text = fs.readFileSync(src, 'utf8');
const version = (text.match(/^\/\/ VERSION: (.+)$/m) || [])[1] || '不明';
const rules = new Set();
for (const raw of text.split('\n')) {
  const line = raw.trim().split(/\s/)[0];
  if (!line || line.startsWith('//')) continue;
  const prefix = line.startsWith('!') ? '!' : '';
  const body = prefix ? line.slice(1) : line;
  // 国際化ドメインは、ブラウザが使う形（xn--…）にそろえる
  const ascii = body.split('.').map((l) => (l === '*' ? '*' : domainToASCII(l) || l)).join('.').toLowerCase();
  if (!ascii || /[^a-z0-9.*-]/.test(ascii)) throw new Error(`変換できない規則: ${line}`);
  rules.add(prefix + ascii);
}
const list = [...rules].sort();
fs.writeFileSync(out, `// 公開サフィックス一覧（自動生成：node tools/build-psl.mjs。直接は編集しない）
// 出典: Public Suffix List https://publicsuffix.org/ （版: ${version}）
// ライセンス: Mozilla Public License 2.0 — https://mozilla.org/MPL/2.0/
// 形式: 1行に1規則。"*." はその下のどの名前も公開サフィックス、"!" は例外

export const PSL_VERSION = ${JSON.stringify(version)};
export const PSL_RULES = ${JSON.stringify(list.join('\n'))};
`);
console.log(`psl-data.js: ${list.length} 規則（版 ${version}）`);

// よく使われるパスワードの一覧を、アプリで使う app/js/common-passwords.js に変換する
// 実行: node tools/build-common-passwords.mjs
//
// 元のデータ: tools/common-passwords/10k-most-common.txt
//   SecLists（https://github.com/danielmiessler/SecLists）の Passwords/Common-Credentials/10k-most-common.txt
// ライセンス: MIT（Copyright (c) 2018 Daniel Miessler）。全文は tools/common-passwords/SecLists-LICENSE と app/licenses/SecLists-MIT.txt
// 形だけ変える（小文字にそろえて、重なりと空行を除く）。中身は足さない
// 更新するとき: 上の場所から取り直して tools/common-passwords に置き、このスクリプトを実行する
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'tools', 'common-passwords', '10k-most-common.txt');
const out = path.join(root, 'app', 'js', 'common-passwords.js');

const words = new Set();
for (const raw of fs.readFileSync(src, 'utf8').split('\n')) {
  const w = raw.trim().toLowerCase();
  if (!w) continue;
  // 1行に1つ。改行や制御文字が入っていたら、元のデータがおかしいので止める
  if (/[\x00-\x1f\x7f]/.test(w)) throw new Error(`変換できない行: ${JSON.stringify(raw)}`);
  words.add(w);
}
const list = [...words]; // 元の並び（多い順）のまま
fs.writeFileSync(out, `// よく使われるパスワードの一覧（自動生成：node tools/build-common-passwords.mjs。直接は編集しない）
// 出典: SecLists — Passwords/Common-Credentials/10k-most-common.txt https://github.com/danielmiessler/SecLists
// ライセンス: MIT（Copyright (c) 2018 Daniel Miessler）— 全文は licenses/SecLists-MIT.txt
// 形式: 1行に1つ、小文字。多く使われている順。パスワードの点検で「よく使われるパスワード」を見つけるためだけに使う（端末の中だけで照らし合わせる）

export const COMMON_PASSWORDS = ${JSON.stringify(list.join('\n'))};
`);
console.log(`common-passwords.js: ${list.length} 件`);

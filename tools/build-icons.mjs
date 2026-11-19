// ボタン・ツリーのアイコン（tools/icons/*.svg）を、アプリで使う app/js/icons.js に変換する
// 実行: node tools/build-icons.mjs
//
// ・色は SVG に直接書かず、CSS の変数（--ic-blue など）に置き換える。
//   ライト／ダークの画面で、背景との差が足りるように色を変えるため（app.css の --ic-* を参照）
// ・安全のため、使ってよい要素と属性だけを通す（文字・スクリプト・外部参照などがあれば止める）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'tools', 'icons');
const outFile = path.join(root, 'app', 'js', 'icons.js');

const COLORS = {
  '#3984DB': 'var(--ic-blue)', '#179C91': 'var(--ic-teal)', '#C58A22': 'var(--ic-amber)',
  '#9470DB': 'var(--ic-violet)', '#DE616C': 'var(--ic-red)', '#7B8EA5': 'var(--ic-slate)',
  '#DCEEFF': 'var(--ic-blue-soft)', '#CFF5EC': 'var(--ic-teal-soft)', '#FFE3A0': 'var(--ic-amber-soft)',
  '#EDE2FF': 'var(--ic-violet-soft)', '#FFE0E4': 'var(--ic-red-soft)', '#E5EDF5': 'var(--ic-slate-soft)',
  '#F7FBFF': 'var(--ic-paper)', '#F6F1FF': 'var(--ic-paper)', '#FFF2CE': 'var(--ic-amber-paper)',
  '#9A5C19': 'var(--ic-amber-deep)',
  // パスワード生成のさいころ（白い3面と赤い「1」。ライト・ダークとも同じ色）
  '#596573': 'var(--ic-dice-edge)', '#FFFFFF': 'var(--ic-dice-top)', '#F4F4F1': 'var(--ic-dice-front)',
  '#C6CED6': 'var(--ic-dice-side)', '#303842': 'var(--ic-dice-dot)', '#D83939': 'var(--ic-dice-one)',
};
const ELEMENTS = new Set(['svg', 'path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse']);
const ATTRS = new Set(['xmlns', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'd', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'points']);

const icons = {};
for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.svg')).sort()) {
  const name = file.slice(0, -4);
  let svg = fs.readFileSync(path.join(srcDir, file), 'utf8').replace(/\s*\n\s*/g, '').trim();
  for (const m of svg.matchAll(/<\/?([a-zA-Z]+)([^>]*)>/g)) {
    if (!ELEMENTS.has(m[1])) throw new Error(`${file}: <${m[1]}> は使えません`);
    for (const a of m[2].matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)) {
      if (!ATTRS.has(a[1])) throw new Error(`${file}: 属性 ${a[1]} は使えません`);
      if (/url\(|javascript:|&/i.test(a[2])) throw new Error(`${file}: 値 ${a[2]} は使えません`);
    }
  }
  svg = svg.replace(/#[0-9A-Fa-f]{6}\b/g, (c) => {
    const v = COLORS[c.toUpperCase()];
    if (!v) throw new Error(`${file}: 色 ${c} の置き換え先がありません（COLORS に足してください）`);
    return v;
  });
  // 一番外の <svg> に、画面用の印を付ける（読み上げでは読まない）
  svg = svg.replace(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /, '<svg class="ic" aria-hidden="true" focusable="false" ');
  if (!svg.startsWith('<svg class="ic"')) throw new Error(`${file}: <svg> の形が想定と違います`);
  icons[name] = svg;
}

const body = Object.entries(icons).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n');
fs.writeFileSync(outFile, `// ボタン・ツリーのアイコン（自動生成：node tools/build-icons.mjs。直接は編集しない）
// 元の絵: tools/icons/*.svg。色は app.css の --ic-* で、ライト／ダークごとに決める

export const ICONS = {
${body}
};

/** アイコンの要素を作る（中身はこのファイルの決まった文字列だけ。利用者の入力は入らない） */
export function icon(name) {
  const svg = ICONS[name];
  if (!svg) throw new Error(\`アイコンがありません: \${name}\`);
  const t = document.createElement('template');
  t.innerHTML = svg;
  return t.content.firstChild;
}
`);
console.log(`icons.js: ${Object.keys(icons).length} 個`);

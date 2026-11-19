// .idm ファイルの中身の XML を読むための小さなパーサ／エスケープ関数。
// DOMParser と違い、テキスト中の改行(CR/LF)をそのまま保持する（メモ欄は CRLF/LF が混在するため）。

const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED, ent) ? NAMED[ent] : m;
  });
}

/** & < > " ' をすべて実体参照にする */
export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * XML文字列を {name, attrs, children, text, raw} の木に変換する。
 * raw は要素全体の元テキスト（未知要素をそのまま書き戻すために使う）。
 */
export function parseXml(src) {
  let i = 0;
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const startOf = new Map();

  const err = (msg) => { throw new Error(`XML解析エラー (${i}文字目付近): ${msg}`); };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      stack[stack.length - 1].text += unescapeXml(src.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += unescapeXml(src.slice(i, lt));
    i = lt;
    if (src.startsWith('<?', i)) {
      const e = src.indexOf('?>', i);
      if (e < 0) err('処理命令が閉じていません');
      i = e + 2;
    } else if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i);
      if (e < 0) err('コメントが閉じていません');
      i = e + 3;
    } else if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i);
      if (e < 0) err('CDATAが閉じていません');
      stack[stack.length - 1].text += src.slice(i + 9, e);
      i = e + 3;
    } else if (src.startsWith('<!', i)) {
      const e = src.indexOf('>', i);
      if (e < 0) err('宣言が閉じていません');
      i = e + 1;
    } else if (src[i + 1] === '/') {
      const e = src.indexOf('>', i);
      if (e < 0) err('終了タグが閉じていません');
      const name = src.slice(i + 2, e).trim();
      const node = stack.pop();
      if (!node || node.name !== name) err(`終了タグ </${name}> が開始タグと一致しません`);
      node.raw = src.slice(startOf.get(node), e + 1);
      i = e + 1;
    } else {
      // 開始タグ（属性値中の > に注意して読む）
      let j = i + 1;
      let quote = null;
      while (j < src.length) {
        const c = src[j];
        if (quote) { if (c === quote) quote = null; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        j++;
      }
      if (j >= src.length) err('開始タグが閉じていません');
      let body = src.slice(i + 1, j);
      const selfClose = body.endsWith('/');
      if (selfClose) body = body.slice(0, -1);
      const m = body.match(/^\s*([^\s/>]+)/);
      if (!m) err('タグ名がありません');
      const node = { name: m[1], attrs: {}, children: [], text: '' };
      const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a;
      const rest = body.slice(m[0].length);
      while ((a = attrRe.exec(rest))) node.attrs[a[1]] = unescapeXml(a[3] ?? a[4] ?? '');
      stack[stack.length - 1].children.push(node);
      startOf.set(node, i);
      if (selfClose) node.raw = src.slice(i, j + 1);
      else stack.push(node);
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new Error(`XML解析エラー: <${stack[stack.length - 1].name}> が閉じられていません`);
  return root;
}

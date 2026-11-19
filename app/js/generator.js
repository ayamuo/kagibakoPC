// パスワード生成（crypto.getRandomValues + 棄却サンプリングで偏りなし）
const SETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digit: '0123456789',
  symbol: '!#$%&()*+,-./:;<=>?@[]^_{|}~',
};
const SIMILAR = /[Il1O0o|]/g;

/** 使える記号のすべて（サイトによって使えない記号があるので、この中から選べる） */
export const ALL_SYMBOLS = SETS.symbol;
/** よく使う組み合わせ */
export const SYMBOL_PRESETS = [
  ['all', 'すべての記号', ALL_SYMBOLS],
  ['common', 'よく使われる記号だけ', '!#$%&*+-=?@_'],
  ['few', '少なめ（! # $ % & * @）', '!#$%&*@'],
];
/** 記号の指定を、使える記号だけ・重複なし・元の並び順にそろえる */
export function normalizeSymbols(s) {
  const want = new Set([...String(s ?? '')]);
  return [...ALL_SYMBOLS].filter((ch) => want.has(ch)).join('');
}

function randInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

export function generatePassword({ length = 20, upper = true, lower = true, digit = true, symbol = true, excludeSimilar = true, symbols = null } = {}) {
  const sets = { ...SETS, symbol: symbols == null ? SETS.symbol : normalizeSymbols(symbols) };
  const groups = Object.entries({ upper, lower, digit, symbol })
    .filter(([, on]) => on)
    .map(([k]) => (excludeSimilar ? sets[k].replace(SIMILAR, '') : sets[k]))
    .filter((g) => g.length > 0); // 記号を1つも選んでいなければ、記号は使わない
  if (!groups.length) throw new Error('文字の種類を1つ以上選んでください');
  length = Math.max(groups.length, Math.min(256, length | 0));
  const all = groups.join('');
  const chars = groups.map((g) => g[randInt(g.length)]); // 各種類を最低1文字
  while (chars.length < length) chars.push(all[randInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** おおよその強度（ビット）。文字種の広さ × 長さの単純推定 */
export function estimateBits(pw) {
  if (!pw) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 32;
  if (/[^\x00-\x7f]/.test(pw)) pool += 100;
  const uniq = new Set(pw).size;
  const effLen = Math.min(pw.length, uniq * 2);
  return Math.round(effLen * Math.log2(Math.max(pool, 2)));
}

export function strengthLabel(bits) {
  if (bits < 40) return ['弱い', 'weak'];
  if (bits < 60) return ['普通', 'fair'];
  if (bits < 80) return ['強い', 'good'];
  return ['とても強い', 'strong'];
}

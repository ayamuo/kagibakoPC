// パスワードの点検（使い回し・弱いもの）
// すべてこの端末の中で調べる。パスワードを外部へ送ったり、ネットの流出リストと照らし合わせたりはしない
import { estimateBits } from './generator.js';

// よく使われるパスワード（流出した一覧の上位によく出てくるもの）。小文字で比べる
const COMMON = new Set([
  'password', 'passw0rd', 'pass', 'pass1234', 'password1', 'password123', 'p@ssw0rd', 'p@ssword',
  '123456', '1234567', '12345678', '123456789', '1234567890', '12345', '1234', '123123', '654321', '112233', '121212',
  '111111', '000000', '666666', '888888', '777777', '7777777', '11111111', '00000000', '987654321',
  'qwerty', 'qwerty123', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbnm', '1q2w3e4r', '1q2w3e', '1qaz2wsx', 'zaq12wsx', 'q1w2e3r4',
  'abc123', 'abcd1234', 'aaaaaa', 'iloveyou', 'admin', 'administrator', 'root', 'guest', 'test', 'login', 'letmein', 'welcome',
  'monkey', 'dragon', 'baseball', 'football', 'soccer', 'master', 'hello', 'freedom', 'whatever', 'trustno1', 'sunshine',
  'princess', 'shadow', 'superman', 'michael', 'secret', 'starwars', 'pokemon', 'naruto', 'sakura', 'tokyo', 'japan',
]);

// 並んだ文字（1234・abcd・qwer など）
const SEQUENCES = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
function isSequence(s) {
  if (s.length < 4) return false;
  return SEQUENCES.some((q) => q.includes(s) || [...q].reverse().join('').includes(s));
}

/** 暗証番号らしいか（決まった桁数の数字しか使えないもの。弱く見えても仕方がない） */
export function looksLikePin(pw, { name = '', fieldName = '' } = {}) {
  return /^\d{4,8}$/.test(pw) && /暗証|pin|ＰＩＮ|カード|キャッシュ|口座/i.test(`${name} ${fieldName}`);
}

/**
 * 1つのパスワードの弱いところ。問題が無ければ null
 * 戻り値 { reasons: [理由の文字列], bits: 推定の強さ }
 */
export function checkPassword(pw, { account = '' } = {}) {
  if (!pw) return null;
  const lower = pw.toLowerCase();
  const reasons = [];
  // 末尾に数字や記号を足しただけのもの（password123・qwerty! など）も「よく使われる」とみなす
  const stem = lower.replace(/[0-9!@#$%^&*._\-?]+$/, '');
  if (COMMON.has(lower) || (stem.length >= 4 && COMMON.has(stem))) reasons.push('よく使われるパスワード');
  if (/^(.)\1+$/.test(pw)) reasons.push('同じ文字のくり返し');
  else if (isSequence(lower)) reasons.push('並んだ文字（1234・abcd など）');
  if (pw.length < 8) reasons.push(`短い（${pw.length}文字）`);
  if (/^\d+$/.test(pw)) reasons.push('数字だけ');
  else if (/^[a-z]+$/i.test(pw) && pw.length < 12) reasons.push('英字だけ');
  const user = String(account || '').toLowerCase().split('@')[0];
  if (user.length >= 3 && lower.includes(user)) reasons.push('ID と同じ文字を含む');
  const bits = estimateBits(pw);
  if (!reasons.length && bits < 40) reasons.push('推測されやすい（強さ：弱い）');
  return reasons.length ? { reasons, bits } : null;
}

/**
 * アイテムの一覧（{ node, path } の配列）をまとめて点検する
 *   reused : 同じパスワードを使っているアイテムの組（多い順）
 *   weak   : 弱いパスワードのアイテム（pin: 暗証番号らしいもの）
 *   checked: パスワードが入っていて点検したアイテムの数
 */
export function analyzePasswords(entries) {
  const byPw = new Map();
  const weak = [];
  let checked = 0;
  for (const e of entries) {
    const it = e.node;
    const pw = it.password || '';
    if (!pw) continue;
    checked++;
    const key = pw.normalize('NFC');
    if (!byPw.has(key)) byPw.set(key, []);
    byPw.get(key).push(e);
    const w = checkPassword(pw, { account: it.account });
    if (w) weak.push({ ...e, ...w, pin: looksLikePin(pw, { name: it.name, fieldName: it.passwordName }) });
  }
  const reused = [...byPw.values()].filter((g) => g.length >= 2).sort((a, b) => b.length - a.length);
  weak.sort((a, b) => Number(a.pin) - Number(b.pin) || a.bits - b.bits);
  const reusedIds = new Set(reused.flat().map((e) => e.node.id));
  const weakIds = new Set(weak.filter((w) => !w.pin).map((w) => w.node.id));
  const okCount = entries.filter((e) => e.node.password && !reusedIds.has(e.node.id) && !weakIds.has(e.node.id)).length;
  return { reused, weak, checked, okCount, reusedItems: reusedIds.size };
}

/** このパスワードを使っているほかのアイテムの数（アイテムの画面に「使い回し」と出すため） */
export function reuseCount(entries, it) {
  if (!it?.password) return 0;
  const key = it.password.normalize('NFC');
  return entries.filter((e) => e.node.id !== it.id && (e.node.password || '').normalize('NFC') === key).length;
}

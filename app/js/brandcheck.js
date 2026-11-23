// 登録した URL が「本当にそのサービスの公式ドメインか」を点検する
//
//  ・officialFor(domain)   … 一覧にある公式ドメインなら、そのサービス
//  ・lookalike(domain)     … 有名サービスに似せた別のドメインか（amaz0n.co.jp / rakuten-card-login.com など）
//  ・brandOfTitle(title)   … アイテムのタイトルから、どのサービスか
//  ・checkItem(item)       … 上をまとめたアイテムの点検結果
//
// 一覧に無いサービスは「分からない」として扱い、警告も「確認済み」も出さない。
import { BRANDS } from './brands.js';
import { hostOf, registrableDomain, isIpAddress, hostWarnings } from './domain.js';

const reg = (d) => registrableDomain(String(d || '').toLowerCase());

// 公式ドメイン → サービス（複数のサービスで共有するドメインもある）
const OFFICIAL = new Map();
for (const b of BRANDS) {
  b.domains = [...new Set(b.domains.map(reg))];
  for (const d of b.domains) {
    if (!OFFICIAL.has(d)) OFFICIAL.set(d, []);
    OFFICIAL.get(d).push(b);
  }
}
// 共有するドメインでは、そのドメインを「いちばん目の公式ドメイン」にしているサービスを先にする
// （yahoo.co.jp → Yahoo! JAPAN、rakuten.co.jp → 楽天。一覧のファイルの並び順に左右されないように）
for (const [d, list] of OFFICIAL) OFFICIAL.set(d, [...list.filter((b) => b.domains[0] === d), ...list.filter((b) => b.domains[0] !== d)]);
const BRAND_BY_ID = new Map(BRANDS.map((b) => [b.id, b]));
const GROUP_DOMAINS = new Map();
for (const b of BRANDS) {
  if (!GROUP_DOMAINS.has(b.group)) GROUP_DOMAINS.set(b.group, new Set());
  for (const d of b.domains) GROUP_DOMAINS.get(b.group).add(d);
}

/** ドメインの「名前」部分（rakuten-card.co.jp → rakuten-card） */
const labelOf = (domain) => String(domain).split('.')[0];

// 似せたドメインの判定に使う名前（4文字以上）。短すぎる名前（au・ana・jal など）は誤検知が多いので使わない
const KNOWN_LABELS = new Map(); // ラベル → サービス
// その名前を「いちばん目の公式ドメイン」にしているサービスを優先する（yahoo → Yahoo! JAPAN、smbc-card → 三井住友カード）
// lycorp（LINEヤフー）は LINE と Yahoo! JAPAN の両方の2つ目のドメインなので、LINE に決めておく（並べ替えの前と同じ）
const PREFER = { yahoo: 'yahoo-jp', lycorp: 'line' };
for (const pass of [0, 1]) {
  for (const b of BRANDS) {
    for (const d of pass === 0 ? b.domains.slice(0, 1) : b.domains) {
      const l = labelOf(d);
      if (l.length < 4) continue;
      if (!KNOWN_LABELS.has(l) || PREFER[l] === b.id) KNOWN_LABELS.set(l, b);
    }
  }
}
// 偽サイトがサービス名に付け足しがちな言葉（appleid-support.com・amazon-jp-login.com など）
const PHISH_WORDS = new Set(['id', 'support', 'secure', 'security', 'login', 'signin', 'sign', 'in', 'account', 'accounts', 'verify',
  'verification', 'update', 'service', 'services', 'jp', 'japan', 'co', 'info', 'help', 'center', 'centre', 'auth', 'member', 'members',
  'my', 'mypage', 'official', 'card', 'pay', 'bank', 'direct', 'net', 'online', 'web', 'app', 'apps', 'check', 'confirm', 'notice',
  'alert', 'system', 'safe', 'user', 'users', 'mail', 'point', 'points', 'shop', 'store', 'cs', 'desk', 'portal', 'access', 'billing', 'payment']);
/** 名前を取り除いた残りが、偽サイトによくある言葉だけでできているか */
function onlyPhishWords(rest) {
  const s = rest.replace(/-/g, '');
  if (!s) return false;
  // 単語に区切れるか（短い文字列なので素朴な分割で十分）
  const can = (i) => i === s.length || [...PHISH_WORDS].some((w) => s.startsWith(w, i) && can(i + w.length));
  return can(0);
}
/** 名前の前後が、偽サイトによくある言葉だけか（myapple-id・appleid-support・secure-amazon など） */
function wrappedByPhishWords(label, k) {
  for (let i = label.indexOf(k); i >= 0; i = label.indexOf(k, i + 1)) {
    const pre = label.slice(0, i), post = label.slice(i + k.length);
    if ((pre || post) && (!pre.replace(/-/g, '') || onlyPhishWords(pre)) && (!post.replace(/-/g, '') || onlyPhishWords(post))) return true;
  }
  return false;
}
// ふつうの単語・人名としてもよく使われる名前。「名前を含む」だけでは警告しない（同じ名前・打ち間違いは警告する）
const GENERIC = new Set(['line', 'note', 'zoom', 'visa', 'uber', 'slack', 'steam', 'live', 'office', 'booking', 'trip',
  'nomura', 'matsui', 'daiwa', 'yamato', 'aeon', 'sagawa', 'saison', 'proton', 'threads', 'canva', 'notion', 'mercury',
  'chuden', 'recruit', 'shein', 'temu', 'ponta', 'hatena', 'nifty', 'muji', 'askul', 'orico', 'epos', 'sony',
  'jalan', 'agoda', 'unext', 'kyash', 'gnavi', 'freee', 'konami',
  'wise', 'medium', 'hands', 'nojima', 'peach', 'battle', 'blizzard', 'asana', 'backlog', 'sakura', 'perplexity',
  'honto', 'docker', 'times-info', 'dinos', 'miro', 'zenn', 'etsy', 'costco', 'ikea',
  // 2026-11-23 追加分（英単語・人名・ファンサイトでよく使われる名前：pretty→retty、doctor→doutor などを誤検知しない）
  'retty', 'homes', 'athome', 'doutor', 'kojima', 'gungho', 'gamecity', 'pokemon', 'tsukumo', 'jasso', 'skylark', 'family', 'shimamura']);

/** 見た目が似た文字をそろえる（0→o, 1→l, rn→m など） */
function unconfuse(s) {
  return s.toLowerCase()
    .replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd')
    .replace(/0/g, 'o').replace(/[1|]/g, 'l').replace(/3/g, 'e').replace(/5/g, 's').replace(/4/g, 'a').replace(/7/g, 't')
    .replace(/_/g, '-');
}

// 見た目が似ていて、打ち間違い・なりすましに使われる文字の組（0→o などは unconfuse で先にそろえてある）
const SIMILAR = new Set(['il', 'ij', 'jl', 'mn', 'nh', 'uv', 'ce', 'co', 'eo', 'ao', 'ae', 'gq', 'bd', 'pq', 'bh', 'ft', 'rn', 'vw', 'kx', 'sz']);
const similar = (x, y) => SIMILAR.has(x < y ? x + y : y + x);

/**
 * 打ち間違い・なりすましの「近さ」。文字の追加・抜け・隣どうしの入れ替えは 1、
 * 見た目の似た文字への置き換え（n→m、l→i など）は 1、形の違う文字への置き換え（h→t など）は 2 と数える。
 * 例：hepco（北海道電力）と tepco（東京電力）は 2 なので、別の会社として扱う。amazom → amazon は 1。
 */
function typoDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const sub = a[i - 1] === b[j - 1] ? 0 : similar(a[i - 1], b[j - 1]) ? 1 : 2;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + sub);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // 入れ替え
    }
  }
  return d[a.length][b.length];
}

/** 一覧にある公式ドメインなら、そのサービスの一覧（無ければ空） */
export function officialFor(domainOrUrl) {
  const host = domainOrUrl.includes('/') || domainOrUrl.includes(':') ? hostOf(domainOrUrl) : domainOrUrl;
  return OFFICIAL.get(reg(host)) || [];
}

/**
 * 有名サービスに似せた別のドメインか。似ていなければ null。
 * 戻り値 { brand, official, reason: 'same-name' | 'contains' | 'typo' }
 */
// 同じドメイン・タイトルは何度も点検するので、結果を覚えておく（一覧は固定なので結果は変わらない）
const CACHE_MAX = 5000;
const cached = (map, key, fn) => {
  if (map.has(key)) return map.get(key);
  const v = fn();
  if (map.size >= CACHE_MAX) map.clear();
  map.set(key, v);
  return v;
};
const LOOKALIKE_CACHE = new Map();
const TITLE_CACHE = new Map();

export function lookalike(domainOrUrl) {
  const host = domainOrUrl.includes('/') || domainOrUrl.includes(':') ? hostOf(domainOrUrl) : String(domainOrUrl || '').toLowerCase();
  if (!host || isIpAddress(host)) return null;
  return cached(LOOKALIKE_CACHE, host, () => lookalikeHost(host));
}

function lookalikeHost(host) {
  const d = reg(host);
  if (OFFICIAL.has(d)) return null;
  // github.io などの上に作られたサイトは、いちばん左の名前で比べる（rakuten-login.github.io）
  const label = unconfuse(d.includes('.') ? labelOf(d) : d);
  const hostLabels = host.split('.').map(unconfuse);
  const tokens = label.split('-').filter(Boolean);
  let best = null;
  for (const [k0, brand] of KNOWN_LABELS) {
    // 比べる側（label・hostLabels）は見た目の似た文字をそろえてあるので、公式の名前も同じようにそろえて比べる
    // （そろえないと、77bank・82bank・0101 など数字の入った名前の偽ドメインを見逃す）。ふつうの単語かどうかは元の名前で見る
    const k = unconfuse(k0);
    let reason = null;
    if (label === k) reason = 'same-name';
    else if (GENERIC.has(k0)) continue; // ふつうの単語は「同じ名前」だけ見る（steam → stream、canva → canvas などを誤検知しない）
    else if (tokens.includes(k) || (k.length >= 6 && label.includes(k))) reason = 'contains';
    else if (k.length >= 5 && wrappedByPhishWords(label, k)) reason = 'contains';
    else if (k.length >= 5 && Math.abs(label.length - k.length) <= 2 && typoDistance(label, k) <= (k.length >= 8 ? 2 : 1)) reason = 'typo';
    else if (k.length >= 5 && hostLabels.slice(0, -2).some((l) => l === k)) reason = 'contains'; // rakuten.co.jp.example.com
    if (reason && (!best || k.length > best.k.length)) best = { k, brand, reason };
  }
  if (!best) return null;
  return { brand: best.brand, official: best.brand.domains, reason: best.reason, domain: d };
}

/** 文字列のそろえ方（全角英数→半角・小文字） */
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase();
const isAsciiWord = (s) => /^[a-z0-9]/.test(s) && /[a-z0-9]$/.test(s);
const KATAKANA = /[ァ-ヺー]/; // カタカナと長音（NFKC で半角カナも全角になる）

// 呼び名は前もってそろえておく（毎回 NFKC で変換すると、件数が増えたとき重くなる）
const ALIASES = BRANDS.flatMap((b) => b.aliases.map((a0) => {
  const a = norm(a0);
  return { a, brand: b, ascii: isAsciiWord(a), kata: KATAKANA.test(a[0]) };
}));

/** タイトルからサービスを見分ける。いちばん長く一致した呼び名のサービス。無ければ null */
export function brandOfTitle(title) {
  const t = norm(title);
  if (!t) return null;
  return cached(TITLE_CACHE, t, () => brandOfNormTitle(t));
}

/** 呼び名がタイトルの中に「言葉として」入っているか */
function aliasIn(t, { a, ascii, kata }) {
  for (let i = t.indexOf(a); i >= 0; i = t.indexOf(a, i + 1)) {
    const before = t[i - 1] || ' ', after = t[i + a.length] || ' ';
    // 英字の呼び名は単語として一致したときだけ（"online" の中の "line" などを拾わない）
    // カタカナの呼び名は、長いカタカナ語の後ろ半分では一致させない（オン「ライン」→ LINE などを拾わない）
    if (ascii ? !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after) : !(kata && KATAKANA.test(before))) return true;
  }
  return false;
}

function brandOfNormTitle(t) {
  let best = null;
  for (const e of ALIASES) {
    if (best && e.a.length <= best.len) continue;
    if (aliasIn(t, e)) best = { brand: e.brand, len: e.a.length };
  }
  return best?.brand || null;
}

/**
 * タイトルから考えられるサービスの候補（いちばん合うものが先頭。brandOfTitle と同じもの）。
 * タイトルに呼び名が入っているほかのサービスと、いちばん合うサービスと同じグループのサービスも、合う順に並べる。
 * 例：「三井住友」→ 三井住友銀行・三井住友カード・三井住友信託銀行・三井住友海上 …
 */
export function brandCandidates(title, { max = 8 } = {}) {
  const t = norm(title);
  if (!t) return [];
  const best = brandOfTitle(title);
  const score = new Map(); // サービス → いちばん長く一致した呼び名の長さ
  for (const e of ALIASES) if (aliasIn(t, e) && (score.get(e.brand) || 0) < e.a.length) score.set(e.brand, e.a.length);
  // タイトルが呼び名の頭と同じもの（「三井住友」→ 三井住友信託銀行・三井住友海上）。いちばん合うものがあるときだけ、低い順位で足す
  const tt = t.trim();
  if (best && tt.length >= 2) for (const e of ALIASES) if (e.a.length > tt.length && e.a.startsWith(tt) && !score.has(e.brand)) score.set(e.brand, 0);
  const list = [...score.entries()].sort((x, y) => y[1] - x[1]).map(([b]) => b);
  if (best) for (const b of BRANDS) if (b.group === best.group && !score.has(b)) list.push(b);
  // 同じ公式 URL のものは1つにまとめる（ゆうちょ銀行と日本郵便 など）
  const seen = new Set(best ? [best.url] : []);
  const out = best ? [best] : [];
  for (const b of list) {
    if (b === best || seen.has(b.url)) continue;
    seen.add(b.url);
    out.push(b);
  }
  return out.slice(0, max);
}

/** そのサービス（同じグループ）の公式ドメインか */
export function isGroupDomain(brand, domain) {
  return !!brand && GROUP_DOMAINS.get(brand.group)?.has(reg(domain));
}

/**
 * アイテムの点検。
 * 戻り値 {
 *   level: 'danger' | 'warn' | 'ok' | 'none' | 'unknown',
 *   domain, official: [サービス], lookalike, titleBrand, mismatch, suggestUrl, warnings: [], badAllowed: [{domain, lookalike}]
 * }
 */
export function checkItem(item) {
  const host = hostOf(item?.url);
  // 「このサービスではない」と指定したアイテムは、タイトルからの判定をしない（偽ドメインの点検は続ける）
  // 候補から選んだアイテム（brandHint にサービスの id）は、タイトルより選んだサービスを優先する
  const titleBrand = item?.brandHint === 'none' ? null : (BRAND_BY_ID.get(item?.brandHint) || brandOfTitle(item?.name));
  // 利用者が「本物と確認した」ドメイン（このアイテムだけに効く）。誤って偽物と判定されたときの逃げ道
  const verified = verifiedSet(item);
  const out = { level: 'unknown', domain: '', official: [], lookalike: null, titleBrand, mismatch: false, userVerified: false, suggestUrl: '', warnings: [], badAllowed: [] };
  for (const a of item?.allowedDomains || []) {
    if (verified.has(reg(a))) continue;
    const la = lookalike(a);
    if (la) out.badAllowed.push({ domain: a, lookalike: la });
  }
  if (!host) {
    out.level = out.badAllowed.length ? 'danger' : 'none';
    if (titleBrand) out.suggestUrl = titleBrand.url;
    return out;
  }
  out.domain = reg(host);
  out.official = officialFor(host);
  out.userVerified = verified.has(out.domain);
  out.lookalike = out.userVerified ? null : lookalike(host);
  out.warnings = hostWarnings(item.url);
  if (titleBrand && !isGroupDomain(titleBrand, out.domain) && !out.userVerified) out.mismatch = true;
  if (out.lookalike || out.badAllowed.length) out.level = 'danger';
  else if (out.mismatch || out.warnings.length) out.level = 'warn';
  else if (out.official.length || out.userVerified) out.level = 'ok';
  return out;
}

/** アイテムで「本物と確認した」登録ドメインの集合 */
export function verifiedSet(item) {
  return new Set((item?.verifiedDomains || []).map((d) => reg(d)).filter(Boolean));
}

/** 登録ドメインにそろえる（表示・記録用） */
export const registrable = (domainOrUrl) => reg(String(domainOrUrl || '').includes('/') ? hostOf(domainOrUrl) : domainOrUrl);

/** 表示用：見分けた理由 */
export function lookalikeText(la) {
  const why = { 'same-name': '名前が同じで、末尾（.com / .jp など）だけが違う', contains: '名前の一部に入れている', typo: '1〜2文字だけ違う（打ち間違い・似た文字）' }[la.reason] || '';
  return `「${la.brand.name}」の公式ドメインではありませんが、名前が似ています（${why}）。${la.brand.name}の公式ドメインは ${la.official.join(' / ')} です。`;
}

/** 一覧に入っているサービスの数（表示用） */
export const BRAND_COUNT = BRANDS.length;

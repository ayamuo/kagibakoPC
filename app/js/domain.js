// ドメインの判定（偽サイト対策）
//
// 「登録ドメイン」= 誰かが取得した単位のドメイン（例: login.yahoo.co.jp → yahoo.co.jp）。
// 入力先ページの登録ドメインが、アイテムに登録した URL の登録ドメインと一致しなければ別サイトとみなす。
//   yahoo.co.jp.example-login.com → 登録ドメインは example-login.com なので「別サイト」
//
// 「どこまでが誰でも取れる部分（公開サフィックス）か」は、公式の Public Suffix List（psl-data.js）で決める。
// 一覧で境界が決められないドメイン（一覧に無いトップレベル）は広げず、そのホストとの完全一致だけを許す。
import { PSL_RULES } from './psl-data.js';

// Public Suffix List に加えて、公開サフィックスとして扱うもの（利用者ごとにサブドメインが割り当てられるサービスなど）。
// 一覧に既に入っているものも含む（重なっても問題ない）
const MULTI_SUFFIXES = new Set([
  // 日本
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'ad.jp', 'ed.jp', 'go.jp', 'gr.jp', 'lg.jp',
  'hokkaido.jp', 'aomori.jp', 'iwate.jp', 'miyagi.jp', 'akita.jp', 'yamagata.jp', 'fukushima.jp', 'ibaraki.jp',
  'tochigi.jp', 'gunma.jp', 'saitama.jp', 'chiba.jp', 'tokyo.jp', 'kanagawa.jp', 'niigata.jp', 'toyama.jp',
  'ishikawa.jp', 'fukui.jp', 'yamanashi.jp', 'nagano.jp', 'gifu.jp', 'shizuoka.jp', 'aichi.jp', 'mie.jp',
  'shiga.jp', 'kyoto.jp', 'osaka.jp', 'hyogo.jp', 'nara.jp', 'wakayama.jp', 'tottori.jp', 'shimane.jp',
  'okayama.jp', 'hiroshima.jp', 'yamaguchi.jp', 'tokushima.jp', 'kagawa.jp', 'ehime.jp', 'kochi.jp',
  'fukuoka.jp', 'saga.jp', 'nagasaki.jp', 'kumamoto.jp', 'oita.jp', 'miyazaki.jp', 'kagoshima.jp', 'okinawa.jp',
  // 海外
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.kr', 'or.kr', 'com.cn', 'com.tw',
  'com.hk', 'com.sg', 'co.in', 'com.br', 'co.za',
  // 誰でもサブドメインを作れるサービス（サブドメインごとに別の持ち主）
  'github.io', 'netlify.app', 'vercel.app', 'pages.dev', 'web.app', 'firebaseapp.com', 'herokuapp.com',
  'blogspot.com', 'azurewebsites.net', 'cloudfront.net', 'appspot.com', 'workers.dev', 'glitch.me',
  'gitlab.io', 'bitbucket.io', 'codeberg.page', 'readthedocs.io', 'surge.sh', 'r2.dev', 'run.app', 'cloudfunctions.net',
  'onrender.com', 'fly.dev', 'railway.app', 'replit.app', 'repl.co', 'ngrok.io', 'ngrok-free.app', 'ngrok.app',
  'trycloudflare.com', 'webflow.io', 'framer.website', 'framer.app', 'notion.site', 'carrd.co', 'square.site',
  'wixsite.com', 'wixstudio.io', 'weebly.com', 'godaddysites.com', 'strikingly.com', 'mybluehost.me', '000webhostapp.com',
  'myshopify.com', 'wordpress.com', 'jimdofree.com', 'jimdo.com', 'jimdosite.com', 'sharepoint.com', 'translate.goog',
  'googleusercontent.com', 'storage.googleapis.com', 'amazonaws.com', 's3.amazonaws.com', 'elasticbeanstalk.com',
  'azurestaticapps.net', 'azureedge.net', 'blob.core.windows.net', 'web.core.windows.net', 'cloudapp.net',
  'zendesk.com', 'freshdesk.com', 'firebaseio.com', 'web.fc2.com', 'blog.fc2.com', 'fc2.net',
  // 日本のレンタルサーバー・ブログ・ネットショップ（利用者ごとにサブドメインが割り当てられる）
  'sakura.ne.jp', 'xsrv.jp', 'xii.jp', 'lolipop.jp', 'heteml.jp', 'heteml.net', 'chicappa.jp', 'coreserver.jp',
  'xdomain.jp', 'hatenablog.com', 'hatenablog.jp', 'hateblo.jp', 'hatenadiary.com', 'hatenadiary.jp', 'livedoor.blog',
  'blog.jp', 'shopinfo.jp', 'base.shop', 'thebase.in', 'stores.jp', 'theshop.jp', 'buyshop.jp', 'official.ec', 'jp.net',
]);

// 規則を読み込む：通常の規則・ワイルドカード（*.ck → "ck"）・例外（!www.ck → "www.ck"）
const RULES = new Set(MULTI_SUFFIXES);
const WILDCARDS = new Set();
const EXCEPTIONS = new Set();
for (const r of PSL_RULES.split('\n')) {
  if (r.startsWith('!')) EXCEPTIONS.add(r.slice(1));
  else if (r.startsWith('*.')) WILDCARDS.add(r.slice(2));
  else if (r) RULES.add(r);
}

/**
 * ホストの公開サフィックスのラベル数（例: www.example.co.id → 2）。
 * 一覧のどの規則にも当たらない（トップレベルが一覧に無い）ときは 0
 */
export function publicSuffixLength(host) {
  const labels = String(host || '').toLowerCase().split('.');
  let best = 0;
  for (let i = 0; i < labels.length; i++) {
    const n = labels.length - i;
    const s = labels.slice(i).join('.');
    if (EXCEPTIONS.has(s)) return n - 1; // 例外が最優先（その1つ上が公開サフィックス）
    if (n > best && RULES.has(s)) best = n;
    if (n > best && i + 1 < labels.length && WILDCARDS.has(labels.slice(i + 1).join('.'))) best = n;
  }
  return best;
}

/** 公開サフィックス（誰でもその下にサイトを作れる部分）か。ここに当たるドメインは、サブドメインを同じサイトとみなさない */
export function isPublicSuffix(d) {
  if (!d) return false;
  if (!d.includes('.')) return true;
  return d.split('.').length <= publicSuffixLength(d);
}

/** 許可ドメインとして使うとき、サブドメインまで広げず完全一致だけにするべきか（公開サフィックス・境界の決まらないドメイン） */
export function exactOnly(d) {
  if (!d) return true;
  if (isIpAddress(d) || d === 'localhost') return true;
  return isPublicSuffix(d) || publicSuffixLength(d) === 0;
}

/** URL（スキーム省略可）→ ホスト名（小文字・punycode）。解釈できなければ '' */
export function hostOf(url) {
  // ブラウザのアドレス欄に出る blob:https://… / view-source:https://… は中の URL で判定する
  const s = (url || '').trim().replace(/^(?:view-source:|blob:|filesystem:)+/i, '');
  if (!s) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    return u.hostname.replace(/\.$/, '').toLowerCase();
  } catch {
    return '';
  }
}

export function schemeOf(url) {
  const m = (url || '').trim().match(/^([a-z][a-z0-9+.-]*):\/\//i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * https で登録したアイテムか（スキームを省いて登録したものも https とみなす）。
 * そういうアイテムは、暗号化されていない http のページには自動入力しない
 */
export function requiresHttps(registeredUrl) {
  return schemeOf(registeredUrl) !== 'http';
}

/** アドレスバーなどの文字列が、暗号化されていない http:// のページか（view-source: などの前置きも見る） */
export function isPlainHttp(pageUrl) {
  return schemeOf(String(pageUrl || '').trim().replace(/^(?:view-source:|blob:|filesystem:)+/i, '')) === 'http';
}

/** 登録 URL と入力先（URL かスキーム名）から、暗号化の点で入力してはいけないか */
export function insecureTarget(registeredUrl, pageUrlOrScheme) {
  const p = String(pageUrlOrScheme || '').toLowerCase();
  return requiresHttps(registeredUrl) && (p === 'http' || isPlainHttp(p));
}

export function isIpAddress(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
}

/**
 * 登録ドメイン（誰かが取得した単位）。例: login.yahoo.co.jp → yahoo.co.jp、a.user.github.io → user.github.io
 * 公開サフィックスそのもの・境界が決まらないホストは、そのホストをそのまま返す（広げない）
 */
export function registrableDomain(host) {
  if (!host || isIpAddress(host) || host === 'localhost') return host;
  const labels = host.split('.');
  const n = publicSuffixLength(host);
  if (n === 0 || labels.length <= n) return host;
  return labels.slice(-(n + 1)).join('.');
}

/** アイテムが許可するドメイン（URL の登録ドメイン＋ユーザーが追加した許可ドメイン） */
export function allowedDomainsOf(item) {
  const set = new Set();
  const h = hostOf(item?.url);
  if (h) set.add(registrableDomain(h));
  for (const d of item?.allowedDomains || []) if (d) set.add(d.toLowerCase());
  return [...set];
}

/** 入力先ホストが許可ドメインに含まれるか（公開サフィックス・境界の決まらないドメインは完全一致のみ） */
export function hostAllowed(host, allowed) {
  if (!host) return false;
  return allowed.some((d) => host === d || (!exactOnly(d) && host.endsWith(`.${d}`)));
}

/** PC版のドメイン照合（C#）に渡す形。完全一致だけを許すものは先頭に = を付ける */
export function allowedForHost(allowed) {
  return allowed.map((d) => (exactOnly(d) ? `=${d}` : d));
}

/**
 * 見た目で騙されやすいホストの警告（空配列なら問題なし）
 *   国際化ドメイン（ｇｏｏｇｌｅ のような似た文字）・IP アドレス直打ち・暗号化なし など
 */
export function hostWarnings(url) {
  const out = [];
  const host = hostOf(url);
  if (!host) return out;
  if (host.split('.').some((l) => l.startsWith('xn--'))) out.push('国際化ドメイン（見た目が似た別の文字を使った偽ドメインの可能性）');
  if (isIpAddress(host)) out.push('数字だけのアドレス（正規のサービスではまず使われません）');
  if (schemeOf(url) === 'http') out.push('暗号化されていない http:// のページ');
  if ((host.replace(/(^|\.)xn--/g, '$1').match(/-/g) || []).length >= 3) out.push('ハイフンが多いドメイン（偽サイトによくある形）');
  return out;
}

/** 表示用：ホストのうち登録ドメイン部分を強調するための分割 [前半, 登録ドメイン] */
export function splitHost(host) {
  const reg = registrableDomain(host);
  return host.endsWith(reg) ? [host.slice(0, host.length - reg.length), reg] : ['', host];
}

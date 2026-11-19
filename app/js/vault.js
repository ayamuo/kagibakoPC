// Kagibako のファイル形式 .kagi
//   鍵導出 : Argon2id（既定 64MiB / 3回 / 並列1, RFC 9106 推奨値）→ 256bit 鍵
//   暗号化 : AES-256-GCM（改ざん検知付き）。IV は保存のたびに乱数 96bit
//   ヘッダ : 版番号・保存日時・端末名・系譜(lineage) を平文で持ち、AAD として認証する
//            → パスワードなしでも「どの版か」は分かるが、書き換えると復号に失敗する
import { uuid } from './model.js';

export const VAULT_FORMAT = 'KAGI';
export const VAULT_VERSION = 1;
export const DEFAULT_KDF = { alg: 'argon2id', memKiB: 65536, iterations: 3, parallelism: 1 };
const LINEAGE_MAX = 200;

export class WrongMasterPasswordError extends Error {
  constructor(msg = 'パスワードが違うか、ファイルが改ざん・破損しています') { super(msg); this.name = 'WrongPasswordError'; }
}

// ---------- base64 ----------
export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** キー順を固定した JSON（AAD 用） */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// ---------- Argon2id ----------
async function getArgon2id() {
  if (globalThis.hashwasm?.argon2id) return globalThis.hashwasm.argon2id;
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    return require('../vendor/argon2.umd.min.js').argon2id;
  }
  throw new Error('Argon2 ライブラリが読み込まれていません');
}

/** パスワード → AES-GCM 鍵（取り出し不可の CryptoKey） */
export async function deriveSession(password, kdf = null) {
  const params = kdf ? { ...kdf } : { ...DEFAULT_KDF, salt: b64(crypto.getRandomValues(new Uint8Array(16))) };
  if (params.alg !== 'argon2id') throw new Error(`未対応の鍵導出方式: ${params.alg}`);
  const argon2id = await getArgon2id();
  const raw = await argon2id({
    password: new TextEncoder().encode(password.normalize('NFC')),
    salt: unb64(params.salt),
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memKiB,
    hashLength: 32,
    outputType: 'binary',
  });
  try {
    const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return { key, kdf: params };
  } finally {
    raw.fill(0);
  }
}

export function isVaultText(text) {
  return /^\s*\{/.test(text) && text.includes('"KAGI"');
}

export function parseEnvelope(text) {
  let env;
  try { env = JSON.parse(text); } catch { throw new Error('.kagi ファイルを読み込めません（JSONではありません）'); }
  if (env?.format !== VAULT_FORMAT) throw new Error('.kagi ファイルではありません');
  if (env.version > VAULT_VERSION) throw new Error('このファイルは新しいバージョンのアプリで作成されています。アプリを更新してください');
  if (!env.header?.vaultId || !env.kdf || !env.cipher?.iv || typeof env.data !== 'string') throw new Error('.kagi ファイルの構造が不正です');
  checkParams(env);
  return env;
}

// ファイルに書かれた鍵導出・暗号の設定を、そのまま信用しない。
// 極端な値（何GBものメモリ・何億回の反復）で固まらせる攻撃や、弱い設定・短いソルト・不正な IV を拒否する。
export const KDF_LIMITS = { memKiB: [19456, 1048576], iterations: [2, 16], parallelism: [1, 8], saltBytes: [16, 64] };
function checkParams(env) {
  const k = env.kdf;
  const inRange = (v, [lo, hi]) => Number.isInteger(v) && v >= lo && v <= hi;
  const bad = () => { throw new Error('.kagi ファイルの暗号設定が不正です（改ざんされている可能性があります）'); };
  if (k.alg !== 'argon2id') throw new Error(`未対応の鍵導出方式: ${k.alg}`);
  if (!inRange(k.memKiB, KDF_LIMITS.memKiB) || !inRange(k.iterations, KDF_LIMITS.iterations) || !inRange(k.parallelism, KDF_LIMITS.parallelism)) bad();
  let salt, iv;
  try { salt = unb64(k.salt); iv = unb64(env.cipher.iv); } catch { bad(); }
  if (salt.length < KDF_LIMITS.saltBytes[0] || salt.length > KDF_LIMITS.saltBytes[1] || iv.length !== 12) bad();
  if (env.cipher.alg && env.cipher.alg !== 'AES-256-GCM') bad();
}

function aadOf(env) {
  return new TextEncoder().encode(canonicalJson({ format: env.format, version: env.version, header: env.header, kdf: env.kdf, cipher: env.cipher }));
}

/** 復号。session を渡すとその鍵を使う（同じソルトの場合のみ） */
export async function decryptEnvelope(env, password, session = null) {
  if (!session || session.kdf.salt !== env.kdf.salt) session = await deriveSession(password, env.kdf);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.cipher.iv), additionalData: aadOf(env) }, session.key, unb64(env.data));
  } catch {
    throw new WrongMasterPasswordError();
  }
  const payload = JSON.parse(new TextDecoder().decode(plain));
  if (!payload?.vault) throw new Error('.kagi の中身が不正です');
  return { vault: payload.vault, header: env.header, session };
}

export async function decryptWithSession(env, session) {
  return decryptEnvelope(env, null, session);
}

/**
 * 暗号化して .kagi テキストを返す。
 * prevHeader があれば版番号を +1 し、系譜に前の版IDを追加する。
 */
export async function encryptVault(vault, session, { prevHeader = null, device = '', vaultId = null } = {}) {
  const lineage = prevHeader ? [...(prevHeader.lineage || []), prevHeader.revId].slice(-LINEAGE_MAX) : [];
  const header = {
    vaultId: prevHeader?.vaultId || vaultId || uuid(),
    revision: (prevHeader?.revision || 0) + 1,
    revId: uuid(),
    savedAt: new Date().toISOString(),
    device: device || '',
    lineage,
  };
  const env = {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    header,
    kdf: session.kdf,
    cipher: { alg: 'AES-256-GCM', iv: b64(crypto.getRandomValues(new Uint8Array(12))) },
  };
  const plain = new TextEncoder().encode(JSON.stringify({ schema: 1, vault }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: unb64(env.cipher.iv), additionalData: aadOf(env) }, session.key, plain));
  plain.fill(0);
  env.data = b64(ct);
  return { text: JSON.stringify(env, null, 1), header };
}

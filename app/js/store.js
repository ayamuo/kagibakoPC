// 端末内ストレージ。保存するのはすべて暗号化済みデータのみ。
//   PC版     : Kagibako 本体が、Kagibako のフォルダの中（data フォルダの store）に普通のファイルとして保存する
//   Android版: Kagibako 本体が、アプリ専用の場所（files/store）に普通のファイルとして保存する
//              （WebView の保存場所は、WebView の更新などで消えることがあり、利用者の管理も届かないため使わない）
//   ブラウザ : IndexedDB
//   known   : 金庫ごとの「この端末が最後に扱った版」と暗号化スナップショット（デグレ検出・復旧用）
//   handles : 最近使ったファイル（PC版・Android版はファイルの場所、ブラウザはファイルのハンドル）
//   drafts  : 自動ロック時の未保存変更（暗号化済み）
//   settings: 設定
import * as host from './host.js';

const DB_NAME = 'kagibako';
const DB_VER = 1;
const SNAPSHOT_MAX = 30; // 統合のときの「共通の元の版」をなるべく長く残すため

let dbp = null;
const mem = { known: new Map(), handles: new Map(), drafts: new Map(), settings: new Map() };
const hasIDB = () => typeof indexedDB !== 'undefined';
const useHost = host.isDesktop || host.isAndroid;
// 本体への頼みは、ふつうは一瞬で返る（端末の中のファイル）。返事が無いときに長く待たせない
const hostOp = (op, store, key, value) => host.call('store', { op, store, key, value }, 10_000);

// 端末内のメモは「無くても動く」もの。読めない・書けないときは、エラーを返さずに先へ進める
// （.kagi ファイルの開く・見る・保存を、メモの不具合で止めないため）。起きたことは onMemoProblem で画面に知らせる
let problemHandler = null;
export function onMemoProblem(fn) { problemHandler = fn; }
function memoProblem(kind, store, e) {
  console.error(`memo ${kind} failed (${store})`, e);
  try { problemHandler?.(kind, e); } catch { /* 知らせる側のエラーは無視 */ }
}

/** 本体が、壊れて読めないメモのファイルを broken へ移したとき（無いものとして続ける）。知らせる */
function reportBroken(store, r) {
  if (r?.broken?.length) memoProblem('broken', store, new Error(r.broken.join(' / ')));
}

/**
 * アプリの設定など（設定・最近使ったファイルの一覧・端末内の控え・ロック中の下書き）を初期化する。
 * PC版・Android版は保存場所をまるごと退けて空から始める（消さないので戻せる）。退けた先を返す。
 * ID・パスワードの入った .kagi ファイルと、自動バックアップには触らない。
 */
export async function resetMemo() {
  if (useHost) {
    const movedTo = (await host.call('store', { op: 'reset' }, 30_000))?.movedTo || null;
    // WebView の保存場所に残っている 0.9.3 までの古いメモを、次の起動でまた引き継がないよう、引き継ぎ済みにしておく
    await hostOp('put', 'settings', 'migratedFromBrowserAt', `reset ${new Date().toISOString()}`).catch(() => {});
    return movedTo;
  }
  if (!hasIDB()) { for (const m of Object.values(mem)) m.clear(); return null; }
  for (const name of ['known', 'handles', 'drafts', 'settings']) await op(name, 'readwrite', (s) => s.clear());
  return null;
}

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of ['known', 'handles', 'drafts', 'settings']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => { dbp = null; }); // 開けなかったら覚えず、次の読み書きで開き直す（一時的な不具合なら直る）
  }
  return dbp;
}

async function op(store, mode, fn) {
  if (!hasIDB()) return fn(null, mem[store]);
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store), null);
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** 読めなければ undefined（無いものとして扱う） */
export async function get(store, key) {
  try {
    return await getStrict(store, key);
  } catch (e) { memoProblem('read', store, e); return undefined; }
}
/** 「無い」と「読めない」を区別する（読めないときはエラー）。引き継ぎのように、取り違えると上書きしてしまう所で使う */
async function getStrict(store, key) {
  if (useHost) { const r = await hostOp('get', store, key); reportBroken(store, r); return r?.found ? r.value : undefined; }
  return op(store, 'readonly', (s, m) => (m ? m.get(key) : s.get(key)));
}
/** 書けなければ書かずに進む */
export async function put(store, key, val) {
  try {
    if (useHost) { await hostOp('put', store, key, val); return; }
    await op(store, 'readwrite', (s, m) => (m ? m.set(key, val) : s.put(val, key)));
  } catch (e) { memoProblem('write', store, e); }
}
export async function del(store, key) {
  try {
    if (useHost) { await hostOp('del', store, key); return; }
    await op(store, 'readwrite', (s, m) => (m ? m.delete(key) : s.delete(key)));
  } catch (e) { memoProblem('write', store, e); }
}
/** 読めなければ空の一覧 */
export async function all(store) {
  try {
    return await allRaw(store);
  } catch (e) { memoProblem('read', store, e); return []; }
}
async function allRaw(store) {
  if (useHost) {
    const r = await hostOp('all', store);
    if (Array.isArray(r)) return r; // 前の版の本体
    reportBroken(store, r);
    return r?.items || [];
  }
  if (!hasIDB()) return [...mem[store].entries()].map(([key, value]) => ({ key, value }));
  const d = await db();
  return new Promise((resolve, reject) => {
    const out = [];
    const tx = d.transaction(store, 'readonly');
    const req = tx.objectStore(store).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) { out.push({ key: c.key, value: c.value }); c.continue(); }
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- known（デグレ検出用の端末内記録） ----------
export function knownKeyFor({ kind, header, fileName }) {
  return kind === 'kagi' ? `kagi:${header.vaultId}` : `legacy:${(fileName || '').toLowerCase()}`;
}

export const getKnown = (key) => get('known', key);

/**
 * 版を「この端末の最新」として記録し、暗号化スナップショットを残す。
 * snap: { revId, revision, savedAt, device, contentHash, fileText(.kagi 暗号文), lineage }
 */
export async function recordHead(key, name, snap) {
  const rec = (await getKnown(key)) || { key, name, snapshots: [] };
  rec.name = name || rec.name;
  rec.head = { revId: snap.revId, revision: snap.revision, savedAt: snap.savedAt, device: snap.device, contentHash: snap.contentHash, lineage: snap.lineage || [] };
  rec.snapshots = [snap, ...rec.snapshots.filter((s) => s.revId !== snap.revId)].slice(0, SNAPSHOT_MAX);
  rec.updatedAt = new Date().toISOString();
  await put('known', key, rec);
  return rec;
}

/**
 * アプリで開いたことを記録する（中身が前と同じで recordHead しないときも）。
 * 自動入力で最初に選ぶデータを「最後に開いたファイル」にするため
 */
export async function markOpened(key) {
  const rec = await getKnown(key);
  if (!rec) return;
  rec.openedAt = new Date().toISOString();
  await put('known', key, rec);
}

/** 新しい順（最後に記録した・開いたうちの新しいほう） */
export async function listKnown() {
  const t = (k) => ((k.openedAt || '') > (k.updatedAt || '') ? k.openedAt : k.updatedAt || '');
  return (await all('known')).map((e) => e.value).sort((a, b) => t(b).localeCompare(t(a)));
}

export const deleteKnown = (key) => del('known', key);

export async function getSetting(k, def) {
  const v = await get('settings', k);
  return v === undefined ? def : v;
}
export const setSetting = (k, v) => put('settings', k, v);

/**
 * PC版・Android版：0.9.3 まで WebView の保存場所（IndexedDB）に置いていたものを、一度だけ本体のファイルへ写す。
 * 「最近使ったファイル」は、Android版はファイルの場所なので写す。PC版はブラウザのファイルの権限なので写せない（開き直せば、また一覧に入る）。
 * ブラウザの保存場所が応えないときは待ち続けず（起動を止めない）、次の起動でもう一度試す。
 */
export async function migrateFromBrowserStorage({ timeoutMs = 5000 } = {}) {
  if (!useHost || !hasIDB()) return 'none';
  // 本体のメモが読めないときは、引き継いだかどうか分からない。古いもので上書きしないよう、今回はやめる
  let done;
  try { done = await getStrict('settings', 'migratedFromBrowserAt'); } catch (e) { console.warn('memo not readable; migration skipped', e); return 'failed'; }
  if (done !== undefined) return 'done';
  const readAll = async () => {
    const names = (await indexedDB.databases?.())?.map((d) => d.name) || [DB_NAME];
    if (!names.includes(DB_NAME)) return null; // 前のデータが無い
    const d = await db();
    const read = (name) => new Promise((resolve, reject) => {
      const out = [];
      const tx = d.transaction(name, 'readonly');
      const req = tx.objectStore(name).openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { out.push({ key: c.key, value: c.value }); c.continue(); } };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
    });
    return { known: await read('known'), drafts: await read('drafts'), settings: await read('settings'), handles: host.isAndroid ? await read('handles') : [] };
  };
  let old;
  try {
    old = await Promise.race([readAll(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))]);
  } catch (e) {
    console.warn('browser storage not readable', e);
    return 'failed';
  }
  // 読み書きのどこかで失敗したら、引き継ぎ済みの印を付けずにやめる（次の起動でもう一度。すでに写したものは「本体の側にある」として飛ばす）
  let n = 0;
  try {
    for (const name of ['known', 'drafts', 'settings', 'handles']) {
      for (const { key, value } of old?.[name] || []) {
        if ((await getStrict(name, key)) !== undefined) continue; // 本体の側にもうあれば、そちらを使う
        await hostOp('put', name, key, value);
        n++;
      }
    }
    await hostOp('put', 'settings', 'migratedFromBrowserAt', new Date().toISOString());
  } catch (e) {
    console.warn('migration not finished', e);
    return 'failed';
  }
  return n ? 'migrated' : 'none';
}

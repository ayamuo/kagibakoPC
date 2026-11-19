// 端末内ストレージ（IndexedDB）。保存するのはすべて暗号化済みデータのみ。
//   known   : 金庫ごとの「この端末が最後に扱った版」と暗号化スナップショット（デグレ検出・復旧用）
//   handles : 最近使ったファイル（PCのChrome/Edgeでファイルを上書き保存するためのハンドル）
//   drafts  : 自動ロック時の未保存変更（暗号化済み）
//   settings: 設定
const DB_NAME = 'kagibako';
const DB_VER = 1;
const SNAPSHOT_MAX = 30; // 統合のときの「共通の元の版」をなるべく長く残すため

let dbp = null;
const mem = { known: new Map(), handles: new Map(), drafts: new Map(), settings: new Map() };
const hasIDB = () => typeof indexedDB !== 'undefined';

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

export const get = (store, key) => op(store, 'readonly', (s, m) => (m ? m.get(key) : s.get(key)));
export const put = (store, key, val) => op(store, 'readwrite', (s, m) => (m ? m.set(key, val) : s.put(val, key)));
export const del = (store, key) => op(store, 'readwrite', (s, m) => (m ? m.delete(key) : s.delete(key)));
export async function all(store) {
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

export async function listKnown() {
  return (await all('known')).map((e) => e.value).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export const deleteKnown = (key) => del('known', key);

export async function getSetting(k, def) {
  const v = await get('settings', k);
  return v === undefined ? def : v;
}
export const setSetting = (k, v) => put('settings', k, v);

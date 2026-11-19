// ファイルの読み書き
//   PC（アプリ版・Chrome / Edge）: 開いたファイルにそのまま上書き保存できる（File System Access API）
//   Android版                   : システムのファイル選択画面で開き（Google ドライブ等も可）、そのまま上書き保存できる
//   その他のブラウザ            : ファイル選択で開き、保存はダウンロード（→クラウドへアップロード）
import { put, all, del } from './store.js';
import * as host from './host.js';

export const canHandleFiles = host.isAndroid || (typeof window !== 'undefined' && 'showOpenFilePicker' in window);

const PICK_TYPES = [{ description: 'Kagibako データ', accept: { 'application/octet-stream': ['.kagi', '.idm'] } }];
const NO_TIMEOUT = 0;

function readAsBytes(file) {
  return file.arrayBuffer().then((b) => new Uint8Array(b));
}

// Android版のハンドルは { android: true, uri, name } というただのオブジェクト
const isAndroidHandle = (h) => !!h?.android;

/**
 * 受け渡しの途中で付いてしまった「.txt」を除いた名前（x.kagi.txt → x.kagi）。
 * .kagi の中身は文字なので、メールやチャット・ブラウザでのダウンロードで .txt を付けられることがある
 */
export function cleanFileName(name) {
  return String(name || '').replace(/.(kagi|idm).txt$/i, '.$1');
}

/** 本当のファイル名に余計な .txt が付いているか */
export const hasExtraTxt = (name) => cleanFileName(name) !== String(name || '');

function fromAndroid(r) {
  // 画面に出す名前は .txt を除いたもの。ハンドルには本当のファイル名を持つ（名前の直しに使う）
  return { name: cleanFileName(r.name), bytes: host.fromB64(r.base64), lastModified: r.lastModified || Date.now(), handle: { android: true, uri: r.uri, name: r.name, canRename: !!r.canRename } };
}

/**
 * Android版：本当のファイル名から余計な .txt を除く（x.kagi.txt → x.kagi）。
 * 名前を変えると URI も変わるので、新しいハンドルを返す（最近使ったファイルも差し替える）
 */
export async function renameAndroidFile(handle, newName) {
  const r = await host.call('renameFile', { uri: handle.uri, name: newName });
  for (const { key, value } of await all('handles')) if (value.handle?.uri === handle.uri) await del('handles', key);
  const next = { android: true, uri: r.uri, name: r.name, canRename: true };
  await rememberHandle(next);
  return next;
}

async function fromHandle(handle) {
  if (isAndroidHandle(handle)) return fromAndroid(await host.call('readUri', { uri: handle.uri }));
  const file = await handle.getFile();
  return { name: file.name, bytes: await readAsBytes(file), lastModified: file.lastModified, handle };
}

/** ファイルを開く。キャンセル時は null */
export async function pickFile() {
  if (host.isAndroid) {
    const r = await host.call('openFile', {}, NO_TIMEOUT);
    if (r?.cancelled) return null;
    const f = fromAndroid(r);
    await rememberHandle(f.handle);
    return f;
  }
  if (canHandleFiles) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: PICK_TYPES, excludeAcceptAllOption: false, multiple: false });
      const f = await fromHandle(handle);
      await rememberHandle(handle);
      return f;
    } catch (e) {
      if (e?.name === 'AbortError') return null;
      throw e;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // スマホでは拡張子指定するとクラウド上のファイルが選べないことがあるため指定しない
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ name: file.name, bytes: await readAsBytes(file), lastModified: file.lastModified, handle: null });
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** 上書き保存前の確認用に、ハンドルから現在の内容を読み直す */
export async function rereadHandle(handle) {
  try {
    if (!isAndroidHandle(handle) && (await handle.queryPermission?.({ mode: 'read' })) === 'denied') return null;
    return await fromHandle(handle);
  } catch {
    return null;
  }
}

async function ensureWritable(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission?.(opts)) === 'granted') return true;
  return (await handle.requestPermission?.(opts)) === 'granted';
}

export async function writeHandle(handle, data) {
  if (isAndroidHandle(handle)) {
    await host.call('writeUri', { uri: handle.uri, base64: host.toB64(data) });
    return;
  }
  if (!(await ensureWritable(handle))) throw new Error('ファイルへの書き込みが許可されませんでした');
  const w = await handle.createWritable();
  await w.write(data);
  await w.close();
}

export function download(name, data) {
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 名前を付けて保存。アプリ版・PC では保存先を選ぶ画面、それ以外はダウンロード */
export async function saveAs(name, data) {
  if (host.isAndroid) {
    const r = await host.call('createFile', { name, base64: host.toB64(data) }, NO_TIMEOUT);
    if (r?.cancelled) return { cancelled: true };
    const handle = { android: true, uri: r.uri, name: r.name };
    await rememberHandle(handle);
    return { handle, name: r.name };
  }
  if ('showSaveFilePicker' in window) {
    try {
      const ext = name.slice(name.lastIndexOf('.'));
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Kagibako データ', accept: { 'application/octet-stream': [ext] } }] });
      await writeHandle(handle, data);
      await rememberHandle(handle);
      return { handle, name: handle.name };
    } catch (e) {
      if (e?.name === 'AbortError') return { cancelled: true };
      throw e;
    }
  }
  download(name, data);
  return { handle: null, name };
}

// ---------- 最近使ったファイル（PC・Android版） ----------
export async function rememberHandle(handle) {
  try { await rememberHandleInner(handle); } catch (e) { console.warn('recent file not stored', e); }
}

async function rememberHandleInner(handle) {
  if (!handle) return;
  const items = await all('handles');
  for (const { key, value } of items) {
    const same = isAndroidHandle(handle) ? value.handle?.uri === handle.uri : await value.handle.isSameEntry?.(handle);
    if (same) await del('handles', key);
  }
  await put('handles', `h-${Date.now()}`, { handle, name: handle.name, at: Date.now() });
  const rest = (await all('handles')).sort((a, b) => b.value.at - a.value.at);
  for (const { key } of rest.slice(8)) await del('handles', key);
}

export async function recentHandles() {
  if (!canHandleFiles) return [];
  return (await all('handles')).map((e) => ({ key: e.key, ...e.value, name: cleanFileName(e.value.name) })).sort((a, b) => b.at - a.at);
}

export async function openRecent(entry) {
  if (isAndroidHandle(entry.handle)) return fromHandle(entry.handle);
  const ok = (await entry.handle.queryPermission({ mode: 'read' })) === 'granted' || (await entry.handle.requestPermission({ mode: 'read' })) === 'granted';
  if (!ok) throw new Error('ファイルへのアクセスが許可されませんでした');
  return fromHandle(entry.handle);
}

export const forgetRecent = (key) => del('handles', key);

/** 確認の画面を出さずに読めるか（Android は常に読める。PC 版などは、許可が残っているときだけ） */
export async function canReadWithoutAsking(entry) {
  if (isAndroidHandle(entry.handle)) return true;
  try { return (await entry.handle.queryPermission?.({ mode: 'read' })) === 'granted'; } catch { return false; }
}

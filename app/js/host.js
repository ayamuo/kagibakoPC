// アプリ本体（PC版 = WebView2 / Android版 = WebView）との通信。ブラウザで開いたときは何もしない。
const wv = globalThis.chrome?.webview;       // PC版
const android = globalThis.KagibakoAndroid;  // Android版

export const platform = wv ? 'desktop' : android ? 'android' : 'web';
export const isDesktop = platform === 'desktop';
export const isAndroid = platform === 'android';

let seq = 0;
const pending = new Map();
const listeners = new Map();

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.replyTo !== undefined) {
    const p = pending.get(msg.replyTo);
    if (!p) return;
    pending.delete(msg.replyTo);
    if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'エラー'));
    return;
  }
  if (msg.event) for (const fn of listeners.get(msg.event) || []) fn(msg.data || {});
}

if (wv) wv.addEventListener('message', (ev) => onMessage(ev.data));
if (android) {
  window.__kagibakoHostMsg = (json) => {
    try { onMessage(JSON.parse(json)); } catch { /* 不正な応答は無視 */ }
  };
}

/** アプリ本体の機能を呼ぶ。戻り値は Promise（ファイル選択など人の操作を待つものはタイムアウトなし） */
export function call(type, payload = {}, timeoutMs = 60_000) {
  if (platform === 'web') return Promise.reject(new Error('アプリ版でのみ使える機能です'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    if (timeoutMs) {
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error('応答がありません'));
      }, timeoutMs);
    }
    const msg = { id, type, ...payload };
    if (wv) wv.postMessage(msg);
    else android.postMessage(JSON.stringify(msg));
  });
}

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(fn);
}

// ---- base64（Android とのファイル受け渡し用） ----
export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

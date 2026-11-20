// 小さなDOMヘルパー（ユーザーデータは必ず textContent / value で入れる。innerHTML は使わない）

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Caps Lock がオンのときに表示する注意書き（パスワード入力欄に付ける） */
export function capsWarning(input) {
  // Caps Lock と、日本語入力（変換中）の注意。パスワードに変換後の文字が入らないように
  const el = h('p', { class: 'caps-warn', role: 'status', hidden: true });
  let caps = false, ime = false;
  const draw = () => {
    el.textContent = ime ? '⚠ 日本語入力がオンです。「半角/全角」キーでオフにしてから入力してください'
      : caps ? '⚠ Caps Lock がオンです（大文字になります）' : '';
    el.hidden = !ime && !caps;
  };
  const upd = (e) => {
    if (e.getModifierState) caps = e.getModifierState('CapsLock');
    if (e.isComposing || e.key === 'Process') ime = true; // 'Process' は日本語入力が受け取ったキー
    draw();
  };
  input.addEventListener('keydown', upd);
  input.addEventListener('keyup', upd);
  input.addEventListener('compositionstart', () => { ime = true; draw(); });
  input.addEventListener('blur', () => { caps = false; ime = false; draw(); });
  return el;
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

let toastTimer = null;
export function toast(msg, ms = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

const openModals = new Set();

/**
 * 開いているダイアログを全部閉じて捨てる（ロック用）。
 * 待っている処理には結果を返さないので、その続き（秘密の表示や保存など）は二度と動かない
 */
export function abandonAllModals() {
  for (const abandon of [...openModals]) abandon();
  document.getElementById('modal-root')?.replaceChildren();
}

/**
 * モーダル。buttons: [{label, value, kind:'primary'|'danger'|'', close:true}]
 * 戻り値: 押されたボタンの value（Esc/背景クリックは null）
 */
export function modal({ title, body = [], buttons = [{ label: '閉じる', value: null }], wide = false, cls = '', onOpen = null, dismissable = true }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const prevFocus = document.activeElement;
    let done = false;
    const detach = () => {
      done = true;
      openModals.delete(abandon);
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
    };
    // ロックしたときは、結果を返さずに捨てる（ダイアログの続きの処理が、ロックの後で動き出さないように）
    const abandon = () => { if (!done) detach(); };
    const close = (v) => {
      if (done) return;
      detach();
      prevFocus?.focus?.();
      resolve(v);
    };
    openModals.add(abandon);
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(null); }
    };
    const dialog = h('div', { class: `modal${wide ? ' wide' : ''}${cls ? ` ${cls}` : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', {}, title), dismissable ? h('button', { class: 'icon-btn', 'aria-label': '閉じる', onclick: () => close(null) }, '✕') : null),
      h('div', { class: 'modal-body' }, body),
      buttons.length ? h('div', { class: 'modal-foot' }, buttons.map((b) => h('button', {
        class: `btn ${b.kind || ''}`,
        onclick: async () => {
          if (b.validate) { const ok = await b.validate(); if (!ok) return; }
          close(b.value);
        },
      }, b.label))) : null);
    const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay && dismissable) close(null); } }, dialog);
    root.append(overlay);
    document.addEventListener('keydown', onKey, true);
    const first = dialog.querySelector('input, textarea, select') || dialog.querySelector('.modal-foot .btn.primary') || dialog.querySelector('button');
    first?.focus();
    onOpen?.(dialog, close);
  });
}

export async function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  const v = await modal({ title, body: [h('p', { class: 'pre' }, message)], buttons: [{ label: 'キャンセル', value: false }, { label: okLabel, value: true, kind: danger ? 'danger' : 'primary' }] });
  return v === true;
}

/** パスワード入力ダイアログ。戻り値: 文字列 or null */
export async function passwordPrompt(title, message, { confirm = false, check = null } = {}) {
  const pw = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false' });
  const pw2 = confirm ? h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false' }) : null;
  const err = h('p', { class: 'error' });
  const submit = async () => {
    err.textContent = '';
    if (!pw.value) { err.textContent = 'パスワードを入力してください'; return false; }
    if (confirm && pw.value !== pw2.value) { err.textContent = '確認用のパスワードが一致しません'; return false; }
    if (check) {
      try { const r = await check(pw.value); if (r !== true) { err.textContent = r || 'パスワードが違います'; return false; } }
      catch (e) { err.textContent = e.message; return false; }
    }
    return true;
  };
  let value = null;
  const res = await modal({
    title,
    body: [message ? h('p', { class: 'pre' }, message) : null,
      h('label', { class: 'field' }, h('span', {}, 'パスワード'), pw), capsWarning(pw),
      confirm ? h('label', { class: 'field' }, h('span', {}, 'パスワード（確認）'), pw2) : null, err],
    buttons: [{ label: 'キャンセル', value: false }, { label: 'OK', value: true, kind: 'primary', validate: async () => { const ok = await submit(); if (ok) value = pw.value; return ok; } }],
    onOpen: (dlg, close) => {
      for (const inp of [pw, pw2].filter(Boolean)) {
        inp.addEventListener('keydown', async (e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (await submit()) { value = pw.value; close(true); } }
        });
      }
    },
  });
  return res === true ? value : null;
}

export function fmtDateTime(isoOrMs) {
  if (!isoOrMs) return '—';
  const d = new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

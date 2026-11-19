// Local, synthetic-data security probes. No external target requests.
// Run: node tests/security-audit.mjs
// Browser: Edge on Windows, or set AUDIT_BROWSER to a Chromium executable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as D from '../app/js/domain.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
for (const suffix of ['co.id', 'com.mx']) {
  const allowed = D.allowedDomainsOf({ url: `https://audit-victim.${suffix}/` });
  results.push({ test: 'cross-owner-domain', suffix, allowed, desktopAllowed: D.allowedForHost(allowed), incorrectlyAccepted: D.hostAllowed(`audit-attacker.${suffix}`, allowed) });
}
// ドメインは同じでも、https で登録したアイテムを http のページへは入力しない（判定は insecureTarget。PC・Android の入力直前で使う）
results.push({ test: 'https-to-http', registered: 'https://login.example.com/', destination: 'http://login.example.com/', acceptedByDomainCheck: D.hostAllowed(D.hostOf('http://login.example.com/'), D.allowedDomainsOf({ url: 'https://login.example.com/' })), blockedAsInsecure: D.insecureTarget('https://login.example.com/', 'http://login.example.com/'), androidSchemeBlocked: D.insecureTarget('https://login.example.com/', 'http') });
results.push({ test: 'unrelated-domain-control', rejected: !D.hostAllowed('attacker.invalid', D.allowedDomainsOf({ url: 'https://example.com/' })) });

const runner = `
window.auditDone = (async () => {
  const timers = [];
  const interval = window.setInterval;
  window.setInterval = (fn, ms, ...args) => { timers.push({ fn, ms }); return interval(fn, ms, ...args); };
  const store = await import('/js/store.js');
  await store.setSetting('disclaimerAccepted', 999);
  const A = await import('/js/app.js');
  const X = await import('/js/vault.js');
  const M = await import('/js/model.js');
  const U = await import('/js/ui.js');
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(150);
  const vault = M.newVault();
  const item = M.newItem(vault, '<img src=x onerror="window.auditXss=true">');
  item.password = 'SYNTHETIC-AUDIT-SECRET';
  vault.children.push(item);
  const session = await X.deriveSession('audit-only-master-password');
  const encrypted = await X.encryptVault(vault, session);
  await window.__kagibakoTest.open('audit-only.kagi', new TextEncoder().encode(encrypted.text));
  const pw = document.querySelector('input[type=password]');
  pw.value = 'audit-only-master-password';
  document.querySelector('form').requestSubmit();
  for (let i = 0; i < 200 && A.S.screen !== 'main'; i++) await wait(25);
  if (A.S.screen !== 'main') throw new Error('Synthetic vault did not unlock');
  const output = [{ test: 'stored-html-in-item-name', scriptExecuted: !!window.auditXss, injectedImage: !!document.querySelector('#app img[src=x]') }];
  const tick = timers.find(t => t.fn.name === 'checkAutoLock');
  if (!tick) throw new Error('Auto-lock callback not found');
  A.settings.autoLockMin = 5;
  // A normal application modal, with no user input afterwards.
  let modalResolved = false;
  U.modal({ title: 'Audit: unattended dialog', body: ['Synthetic data only'] }).then(() => { modalResolved = true; });
  const now = Date.now;
  Date.now = () => now() + 60 * 60 * 1000;
  tick.fn();
  for (let i = 0; i < 100 && A.S.screen === 'main'; i++) await wait(20);
  output.push({ test: 'auto-lock-with-modal-after-one-hour', screen: A.S.screen, secretStillAvailable: A.S.vault?.children[0]?.password === item.password, dialogLeftOpen: !!document.querySelector('.overlay') });
  // ロックで捨てたダイアログが、あとから Esc で「閉じた」ことになって続きの処理が動かないか
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(50);
  output.push({ test: 'abandoned-dialog-not-resumed-after-lock', resumed: modalResolved });
  document.querySelector('.overlay .modal-head button')?.click();
  // Closing normally updates lastActivity, so advance time again for the control.
  Date.now = () => now() + 2 * 60 * 60 * 1000;
  tick.fn();
  for (let i = 0; i < 100 && A.S.screen !== 'unlock'; i++) await wait(20);
  output.push({ test: 'auto-lock-without-modal-control', screen: A.S.screen, vaultCleared: A.S.vault === null });
  Date.now = now;
  return output;
})();
`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__audit.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(runner); return; }
  if (url.pathname === '/__audit.html') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8"><div id="app"></div><div id="modal-root"></div><div id="toast"></div><script src="/vendor/argon2.umd.min.js"></script><script type="module" src="/__audit.js"></script>'); return;
  }
  const base = path.join(root, 'app');
  const file = path.resolve(base, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kagibako-audit-'));
const browser = spawn(process.env.AUDIT_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let ws;
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 30000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
  await call('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/__audit.html' });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    const r = await call('Runtime.evaluate', { expression: '!!window.auditDone', returnByValue: true });
    if (r.result.value) { ready = true; break; }
    await sleep(100);
  }
  if (!ready) throw new Error('Browser audit did not initialize');
  const r = await call('Runtime.evaluate', { expression: 'window.auditDone', awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  results.push(...r.result.value);
  const outputDir = path.join(root, 'docs', 'security-audit');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
  await call('Browser.close').catch(() => {});
} finally {
  ws?.close();
  browser.kill();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  await sleep(500);
  // Only delete this run's freshly created temporary browser profile.
  if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('kagibako-audit-')) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}

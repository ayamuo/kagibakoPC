// 自動入力を試すためのテスト用ログインページ（このPCの中だけで動く。入力内容はどこにも送られない）
// 実行: node tools/test-login-server.mjs → ブラウザで http://localhost:8090/ を開く
import http from 'node:http';
const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kagibako Test Login</title></head>
<body style="font:20px sans-serif;padding:24px"><h1>Test Login</h1>
<form onsubmit="document.getElementById('r').textContent='RESULT ID=['+this.u.value+'] PW=['+this.p.value+']';return false">
<p><input name="u" type="email" autocomplete="username" placeholder="メールアドレス" autofocus style="font-size:22px;width:80%"></p>
<p><input name="p" type="password" autocomplete="current-password" placeholder="パスワード" style="font-size:22px;width:80%"></p>
<p><button style="font-size:22px">ログイン</button></p></form><p id="r" style="font-size:26px;color:#060"></p></body></html>`;
http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); s.end(page); }).listen(8090, '127.0.0.1', () => console.log('login test server :8090'));

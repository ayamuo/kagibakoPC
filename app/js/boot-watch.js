// 起動の見張り（モジュールではない、小さな独立したスクリプト）
// app.js が読み込めない・起動の途中で返事を待ったまま進まない、といったときも「読み込み中…」のままにしない。
// 15 秒たっても最初の画面が出ていなければ、そのとき何をしていたか（app.js が window.__kagibakoBootStep に書く）と［もう一度読み込む］を出す。
// 起動があとで終われば、app.js が画面を描き直すので、この知らせは消える。
(function () {
  var LIMIT_MS = 15000;
  setTimeout(function () {
    var app = document.getElementById('app');
    var boot = app && app.querySelector('.boot');
    if (!boot || document.getElementById('boot-watch')) return;
    var step = window.__kagibakoBootStep || 'アプリの読み込み（プログラムを読み込めていない可能性があります）';
    var box = document.createElement('div');
    box.id = 'boot-watch';
    box.className = 'center-card boot-error';
    var h1 = document.createElement('h1');
    h1.textContent = '起動に時間がかかっています';
    var safe = document.createElement('p');
    safe.className = 'info-box';
    safe.textContent = 'ID・パスワードなどのアカウント情報は、あなたの .kagi ファイルに入っていて、無事です。';
    var p1 = document.createElement('p');
    p1.textContent = 'いま「' + step + '」のところで止まっています。';
    var btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.type = 'button';
    btn.textContent = 'もう一度読み込む';
    btn.addEventListener('click', function () { location.reload(); });
    var row = document.createElement('div');
    row.className = 'row';
    row.appendChild(btn);
    var p2 = document.createElement('p');
    p2.className = 'muted small';
    p2.textContent = '何度も止まる場合は、Kagibako を終了してから起動し直してください。直らないときは、この画面の文を作者に知らせてください。';
    box.appendChild(h1);
    box.appendChild(safe);
    box.appendChild(p1);
    box.appendChild(row);
    box.appendChild(p2);
    app.appendChild(box);
  }, LIMIT_MS);
})();

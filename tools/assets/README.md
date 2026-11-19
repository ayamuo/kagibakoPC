# アプリアイコンの原本

`kagibako-master.png` は、タグ付きの異なる3本の鍵と、解錠した片開き箱の承認済み原画像（v9）です。
再生成した拡大案ではなく、この画像から直接リサイズします。

Windowsで `node tools/make-icons.mjs` を実行すると、PowerShell / System.Drawingで各サイズを生成します。

- PC用ICO：16 / 24 / 32 / 48 / 64 / 128 / 256px。原画像を中央基準で1.2倍にし、角を丸めます。
- 画面用（app/icons）：32 / 180 / 192 / 512px。通常版は1.2倍、maskable版は安全域のため1.0倍です。

各出力は必ず原画像から直接生成し、縮小済みファイルの再拡大を避けています。

ビルド：`tools/build-desktop.cmd`。

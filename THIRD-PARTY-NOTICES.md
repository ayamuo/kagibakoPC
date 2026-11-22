# 同梱しているほかのソフトウェア（Third-Party Notices）

Kagibako 本体は「Kagibako ライセンス」です（[LICENSE](LICENSE)。無料での利用・改変・再配布は自由、販売・有料での配布は禁止）。
次のソフトウェアやデータを、それぞれのライセンスに従って同梱しています。ライセンスの全文は [app/licenses](app/licenses) フォルダにあります。
Kagibako を再配布するときは、このファイルと `app/licenses` フォルダも一緒に配布してください。

| 名前 | 使っているところ | ライセンス | 著作権者 | 全文 |
| --- | --- | --- | --- | --- |
| [hash-wasm](https://github.com/Daninet/hash-wasm) 4.12.0 | 鍵の生成（Argon2id）。`app/vendor/argon2.umd.min.js` | MIT | Copyright (c) 2020 Dani Biró | [app/licenses/hash-wasm-MIT.txt](app/licenses/hash-wasm-MIT.txt) |
| [Public Suffix List](https://publicsuffix.org/) | 偽サイト対策のドメインの境界の判定。`app/js/psl-data.js`（元データ `tools/psl/public_suffix_list.dat`） | Mozilla Public License 2.0 | Mozilla Foundation と寄稿者 | [app/licenses/MPL-2.0.txt](app/licenses/MPL-2.0.txt) |
| [SecLists](https://github.com/danielmiessler/SecLists) の `Passwords/Common-Credentials/10k-most-common.txt` | パスワードの点検の「よく使われるパスワード」の判定。`app/js/common-passwords.js`（元データ `tools/common-passwords/10k-most-common.txt`） | MIT | Copyright (c) 2018 Daniel Miessler | [app/licenses/SecLists-MIT.txt](app/licenses/SecLists-MIT.txt) |
| [Microsoft WebView2 SDK](https://www.nuget.org/packages/Microsoft.Web.WebView2) 1.0.3179.45 | 画面の表示（`Kagibako.exe` に組み込み） | BSD 3-Clause | Copyright (C) Microsoft Corporation | [app/licenses/WebView2-SDK-BSD-3-Clause.txt](app/licenses/WebView2-SDK-BSD-3-Clause.txt) |

## 補足
- **Public Suffix List（MPL 2.0）**：`app/js/psl-data.js` は元のデータの形を変えただけのものです。このファイル（とその元データ）を改変して配布する場合は、MPL 2.0 に従い、改変したファイルのソースも同じライセンスで公開してください。それ以外の Kagibako のファイルには影響しません。
- **.NET ランタイム**（MIT）：Releases の zip の `Kagibako.exe` には .NET ランタイムが組み込まれています（著作権 .NET Foundation と寄稿者。ライセンスは https://github.com/dotnet/runtime/blob/main/LICENSE.TXT ）。
- **Microsoft Edge WebView2 ランタイム**は同梱していません。Windows に入っているもの、またはマイクロソフトの配布物を使います。
- `app/licenses/Apache-2.0.txt` は、同じ画面を使うスマホ版のためのものです（PC版には Apache 2.0 のソフトウェアは入っていません）。
- **主要サービスの公式ドメイン一覧**（`app/js/brands.js`）：サービス名と公開されているドメイン名の一覧です（事実の情報）。ロゴなどの画像は含みません。サービス名はそれぞれの会社の商標または登録商標です。

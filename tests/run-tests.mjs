// 実行: node tests/run-tests.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const appJs = (f) => import(pathToFileURL(path.join(here, '..', 'app', 'js', f)));
const fixture = (f) => new Uint8Array(fs.readFileSync(path.join(here, 'fixtures', f)));

const { Blowfish } = await appJs('blowfish.js');
const { encodeSjis, decodeSjis } = await appJs('sjis.js');
const L = await appJs('legacy.js');
const X = await appJs('vault.js');
const H = await appJs('history.js');
const M = await appJs('merge.js');
const Mo = await appJs('model.js');
const G = await appJs('generator.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.stack?.split('\n').slice(0, 3).join('\n       ')}`); }
}
const hex = (u8) => Buffer.from(u8).toString('hex');

console.log('Blowfish');
await test('公式テストベクタ（鍵0 / 平文0）', () => {
  // 標準ベクタはビッグエンディアン表記なので、LE語処理に合わせて語ごとに反転して与える
  const bf = new Blowfish(new Uint8Array(8));
  const out = bf.encryptECB(new Uint8Array(8));
  const be = Buffer.from(out); be.swap32();
  assert.equal(be.toString('hex'), '4ef997456198dd78');
});
await test('公式テストベクタ（FEDCBA9876543210）', () => {
  const bf = new Blowfish(Uint8Array.from(Buffer.from('FEDCBA9876543210', 'hex')));
  const pt = Buffer.from('0123456789ABCDEF', 'hex'); pt.swap32();
  const out = Buffer.from(bf.encryptECB(new Uint8Array(pt))); out.swap32();
  assert.equal(out.toString('hex'), '0aceab0fc6a0a28d');
  const back = Buffer.from(bf.decryptECB(bf.encryptECB(new Uint8Array(pt))));
  assert.equal(hex(back), hex(pt));
});

console.log('Shift_JIS');
await test('日本語・機種依存文字の往復', () => {
  const s = 'ｱｲｳ 日本語テスト① ～－∥ ￥\\ ㈱ 髙';
  const { bytes, unmappable } = encodeSjis(s);
  assert.deepEqual(unmappable, []);
  assert.equal(decodeSjis(bytes), s);
});
await test('変換できない文字の検出（絵文字）', () => {
  assert.deepEqual(encodeSjis('a😀b').unmappable, ['😀']);
  // 半角の円記号 U+00A5 は CP932 に無い（勝手に \ へ置き換えるとパスワードが変わるので不可扱い）
  assert.deepEqual(encodeSjis('¥').unmappable, ['¥']);
});

console.log('.idm ファイルの読み込み（実物のファイルで検証）');
const sample = fixture('sample_abc123.idm');
await test('復号して内容を読める', () => {
  const v = L.openLegacy(sample, 'abc123');
  const it = v.children[0].children[0];
  assert.equal(v.children[0].name, 'Group0');
  assert.equal(it.name, 'Item0');
  assert.equal(it.account, 'user@example.com');
  assert.equal(it.password, `p<a>&ss"w'd`);
  assert.equal(it.item2Name, '秘密の質問');
  assert.equal(it.item2, '日本語テスト①');
  assert.equal(it.comment, 'memo line1\nmemo 行2 </item>\r\nline3');
  assert.equal(it.url, 'https://example.com/login?a=1&b=2');
  assert.equal(it.issueDate, '2026-11-11');
  assert.equal(it.expirationDate, '2027-11-11');
});
await test('間違ったパスワードを検出', () => {
  assert.throws(() => L.openLegacy(sample, 'abc124'), { name: 'WrongPasswordError' });
});
await test('56バイトを超えるパスワードは拒否', () => {
  assert.throws(() => L.legacyKey('x'.repeat(57)));
  L.legacyKey('x'.repeat(56));
});

console.log('.kagi（Argon2id + AES-256-GCM）');
const v0 = L.openLegacy(sample, 'abc123');
const s1 = await X.deriveSession('correct horse');
const r1 = await X.encryptVault(v0, s1, { device: 'PC' });
await test('暗号化→復号', async () => {
  const env = X.parseEnvelope(r1.text);
  const out = await X.decryptEnvelope(env, 'correct horse');
  assert.equal(out.vault.children[0].children[0].password, `p<a>&ss"w'd`);
  assert.equal(out.header.revision, 1);
  assert.ok(!r1.text.includes('example.com'), '平文が漏れていない');
});
await test('間違ったパスワードを検出', async () => {
  await assert.rejects(X.decryptEnvelope(X.parseEnvelope(r1.text), 'wrong'), { name: 'WrongPasswordError' });
});
await test('ヘッダ（版番号）の改ざんを検出', async () => {
  const env = X.parseEnvelope(r1.text); env.header.revision = 99;
  await assert.rejects(X.decryptEnvelope(env, 'correct horse'));
});
await test('本文の改ざんを検出', async () => {
  const env = X.parseEnvelope(r1.text);
  const d = X.unb64(env.data); d[5] ^= 1; env.data = X.b64(d);
  await assert.rejects(X.decryptEnvelope(env, 'correct horse'));
});

console.log('デグレ検出');
const r2 = await X.encryptVault(v0, s1, { prevHeader: r1.header, device: 'PC' });
const r3 = await X.encryptVault(v0, s1, { prevHeader: r2.header, device: 'スマホ' });
const r2b = await X.encryptVault(v0, s1, { prevHeader: r2.header, device: 'PC' }); // r2 から分岐
const known = (head) => ({ head, snapshots: [head] });
await test('同じ版', () => assert.equal(H.classifyVault(r2.header, known(r2.header)), 'same'));
await test('新しい版（他端末で更新）', () => assert.equal(H.classifyVault(r3.header, known(r2.header)), 'newer'));
await test('古い版（デグレ）', () => assert.equal(H.classifyVault(r1.header, known(r3.header)), 'older'));
await test('分岐', () => assert.equal(H.classifyVault(r2b.header, known(r3.header)), 'diverged'));
await test('この端末で見たことがあっても、最新の祖先でない版は「分岐」（古い版扱いで変更を消さない）', () => {
  // r2b（PC の枝）を見たあと、「開いたファイルで続ける」で r3（スマホの枝）を最新にした端末
  const k = { head: r3.header, snapshots: [r3.header, r2b.header, r2.header] };
  assert.equal(H.classifyVault(r2b.header, k), 'diverged');
  assert.equal(H.classifyVault(r1.header, k), 'older'); // 本当の祖先は古い版
});
await test('統合した版は両方の版の続きになる（系譜の取り込み）', async () => {
  const merged = H.absorbHeader(r3.header, r2b.header);
  assert.ok(H.includesRev(merged, r2b.header.revId) && H.includesRev(merged, r3.header.revId));
  assert.equal(merged.revision, Math.max(r3.header.revision, r2b.header.revision));
  const r4 = await X.encryptVault(v0, s1, { prevHeader: merged, device: 'PC' });
  assert.equal(H.compareHeaders(r4.header, r3.header), 'a');
  assert.equal(H.compareHeaders(r4.header, r2b.header), 'a');
  // 統合済みの版を最新に持つ端末で、統合前の枝を開くと「古い版」
  assert.equal(H.classifyVault(r2b.header, { head: r4.header, snapshots: [r4.header] }), 'older');
  // 別の鍵箱の系譜は取り込まない
  assert.equal(H.absorbHeader(r3.header, { ...r2b.header, vaultId: 'other' }), r3.header);
});
await test('ヘッダ比較', () => {
  assert.equal(H.compareHeaders(r3.header, r1.header), 'a');
  assert.equal(H.compareHeaders(r1.header, r3.header), 'b');
  assert.equal(H.compareHeaders(r3.header, r2b.header), 'diverged');
});
await test('.idm: 内容ハッシュで古い版を検出', () => {
  const k = { head: { contentHash: 'new' }, snapshots: [{ contentHash: 'new' }, { contentHash: 'old' }] };
  assert.equal(H.classifyLegacy('old', k), 'older');
  assert.equal(H.classifyLegacy('new', k), 'same');
  assert.equal(H.classifyLegacy('zzz', k), 'changed');
});

console.log('比較・統合');
await test('スマホ（B 変更・D 削除）と PC（A 変更・F 追加）を共通の元の版で統合', () => {
  const base = Mo.newVault();
  for (const n of ['A', 'B', 'C', 'D', 'E']) { const it = Mo.newItem(base, n); it.password = n + '0'; it.modified = 1000; base.children.push(it); }
  const phone = Mo.cloneVault(base), pc = Mo.cloneVault(base);
  const g = (v, n) => v.children.find((x) => x.name === n);
  Object.assign(g(phone, 'B'), { password: 'B-phone', modified: 2000 });
  const d = g(phone, 'D'); phone.children.splice(phone.children.indexOf(d), 1); phone.tombstones.push({ id: d.id, deletedAt: 2100 });
  Object.assign(g(pc, 'A'), { password: 'A-pc', modified: 2200 });
  const fItem = Mo.newItem(pc, 'F'); fItem.password = 'F-pc'; pc.children.push(fItem);
  for (const [A, B] of [[pc, phone], [phone, pc]]) { // どちらの端末で統合しても同じ結果
    const out = M.mergeVaults(A, B, M.diffVaults(A, B, 'b', base));
    const got = Object.fromEntries(out.children.map((x) => [x.name, x.password]));
    assert.deepEqual(got, { A: 'A-pc', B: 'B-phone', C: 'C0', E: 'E0', F: 'F-pc' });
  }
});
await test('相手の版でフォルダ名を変えた → 空の古いフォルダを残さず、ID も引き継ぐ', () => {
  const base = Mo.newVault();
  const fo = Mo.newFolder('仕事'); base.children.push(fo);
  fo.children.push(Mo.newItem(base, 'x'), Mo.newItem(base, 'y'));
  const A = Mo.cloneVault(base), B = Mo.cloneVault(base);
  B.children[0].name = '会社';
  const out = M.mergeVaults(A, B, M.diffVaults(A, B, 'a', base));
  assert.deepEqual(out.children.map((x) => [x.name, x.children.map((c) => c.name)]), [['会社', ['x', 'y']]]);
  assert.equal(out.children[0].id, fo.id);
});
await test('相手の版でフォルダごと削除 → 空のフォルダも消える。こちらで追加したアイテムがあれば残す', () => {
  const base = Mo.newVault();
  const f1 = Mo.newFolder('古い'); base.children.push(f1); f1.children.push(Mo.newItem(base, 'old'));
  const f2 = Mo.newFolder('空'); base.children.push(f2);
  const f3 = Mo.newFolder('追加あり'); base.children.push(f3); f3.children.push(Mo.newItem(base, 'z'));
  const A = Mo.cloneVault(base), B = Mo.cloneVault(base);
  A.children[2].children.push(Mo.newItem(A, 'Aで追加'));
  for (const fo of B.children.splice(0, 3)) for (const { node } of Mo.walk([fo])) B.tombstones.push({ id: node.id, deletedAt: 5000 });
  const out = M.mergeVaults(A, B, M.diffVaults(A, B, 'a', base));
  assert.deepEqual(out.children.map((x) => [x.name, x.children.map((c) => c.name)]), [['追加あり', ['Aで追加']]]);
});
await test('相手の版で作った空のフォルダを足す（こちらで削除したものは足さない）', () => {
  const base = Mo.newVault();
  const gone = Mo.newFolder('こちらで削除'); base.children.push(gone);
  const A = Mo.cloneVault(base), B = Mo.cloneVault(base);
  A.children.splice(0, 1); A.tombstones.push({ id: gone.id, deletedAt: 5000 });
  const nf = Mo.newFolder('新しい'); B.children.push(nf);
  const out = M.mergeVaults(A, B, M.diffVaults(A, B, 'a', base));
  assert.deepEqual(out.children.map((x) => x.name), ['新しい']);
  assert.equal(out.children[0].id, nf.id);
});
await test('更新・追加・削除を正しく統合', () => {
  const base = Mo.newVault();
  const f = Mo.newFolder('F'); base.children.push(f);
  const i1 = Mo.newItem(base, 'one'); i1.modified = 1000;
  const i2 = Mo.newItem(base, 'two'); i2.modified = 1000;
  const i3 = Mo.newItem(base, 'three'); i3.modified = 1000;
  f.children.push(i1, i2, i3);
  const A = Mo.cloneVault(base), B = Mo.cloneVault(base);
  // A: one を更新 / B: two を更新、three を削除、four を追加
  A.children[0].children[0].password = 'A-new'; A.children[0].children[0].modified = 2000;
  B.children[0].children[1].password = 'B-new'; B.children[0].children[1].modified = 3000;
  const removed = B.children[0].children.splice(2, 1)[0];
  B.tombstones.push({ id: removed.id, deletedAt: 4000 });
  const i4 = Mo.newItem(B, 'four'); B.children[0].children.push(i4);
  const res = M.diffVaults(A, B, 'a');
  const out = M.mergeVaults(A, B, res);
  const names = out.children[0].children.map((x) => `${x.name}:${x.password}`);
  assert.deepEqual(names, ['one:A-new', 'two:B-new', 'four:']);
});
await test('共通の元の版があれば、同じアイテムの別々の項目変更を両方反映（3方向統合）', () => {
  const base = Mo.newVault();
  const f = Mo.newFolder('F'); base.children.push(f);
  const it = Mo.newItem(base, 'site'); it.item1 = '1234'; it.comment = 'old'; it.password = 'p0'; it.modified = 1000;
  f.children.push(it);
  const A = Mo.cloneVault(base), B = Mo.cloneVault(base);
  Object.assign(A.children[0].children[0], { item1: '9999', password: 'pA', modified: 2000 }); // PC: PIN と パスワード
  Object.assign(B.children[0].children[0], { comment: 'スマホで編集', password: 'pB', modified: 3000 }); // スマホ: メモ と パスワード
  const res = M.diffVaults(A, B, 'a', base);
  assert.equal(res.diffs[0].conflicts, 1); // 衝突はパスワードだけ
  const out = M.mergeVaults(A, B, res).children[0].children[0];
  assert.equal(out.item1, '9999');
  assert.equal(out.comment, 'スマホで編集');
  assert.equal(out.password, 'pB'); // 衝突は後で更新された方
});
await test('共通の元の版があれば、片方での削除を反映', () => {
  const base = Mo.newVault();
  const f = Mo.newFolder('F'); base.children.push(f);
  f.children.push(Mo.newItem(base, 'keep'), Mo.newItem(base, 'gone'));
  const A = Mo.cloneVault(base), B = Mo.cloneVault(base);
  B.children[0].children.pop(); // tombstone なし（.idm など）でも base から削除と判断
  const res = M.diffVaults(A, B, 'a', base);
  const out = M.mergeVaults(A, B, res);
  assert.deepEqual(out.children[0].children.map((x) => x.name), ['keep']);
});
await test('ID が無い .idm どうしでも「フォルダ＋タイトル」で対応付け', () => {
  const A = L.openLegacy(sample, 'abc123');
  const B = L.openLegacy(sample, 'abc123'); // ID は毎回別
  B.children[0].children[0].password = 'changed';
  const res = M.diffVaults(A, B, 'b');
  assert.equal(res.diffs.length, 1);
  assert.equal(res.diffs[0].kind, 'modified');
  assert.deepEqual(res.diffs[0].fields.map((f) => f.key), ['password']);
});

console.log('パスワード生成');
await test('長さ・文字種', () => {
  const pw = G.generatePassword({ length: 32 });
  assert.equal(pw.length, 32);
  assert.match(pw, /[A-Z]/); assert.match(pw, /[a-z]/); assert.match(pw, /[0-9]/); assert.match(pw, /[^A-Za-z0-9]/);
  assert.doesNotMatch(pw, /[Il1O0o|]/);
});

const Dm = await appJs('domain.js');
const AT = await appJs('autotype.js');
const CSV = await appJs('csv.js');

console.log('偽サイト対策（ドメイン判定）');
await test('登録ドメインの判定', () => {
  assert.equal(Dm.registrableDomain('login.yahoo.co.jp'), 'yahoo.co.jp');
  assert.equal(Dm.registrableDomain('yahoo.co.jp.secure-login.com'), 'secure-login.com');
  assert.equal(Dm.registrableDomain('www.amazon.co.jp'), 'amazon.co.jp');
  assert.equal(Dm.registrableDomain('accounts.google.com'), 'google.com');
  assert.equal(Dm.registrableDomain('evil.github.io'), 'evil.github.io');
  // 公式の Public Suffix List では shibuya.tokyo.jp も公開サフィックス（区の下は別の持ち主）
  assert.equal(Dm.registrableDomain('www.city.shibuya.tokyo.jp'), 'city.shibuya.tokyo.jp');
});
await test('公開サフィックス一覧（PSL）：別の持ち主のドメインを同じサイトとみなさない', () => {
  // KAGI-01：一覧に無かった co.id・com.mx などで、別のサイトを許可していた
  for (const [victim, attacker] of [['audit-victim.co.id', 'audit-attacker.co.id'], ['audit-victim.com.mx', 'audit-attacker.com.mx'],
    ['shop.example.com.br', 'evil.com.br'], ['victim.blogspot.com', 'evil.blogspot.com']]) {
    const allowed = Dm.allowedDomainsOf({ url: `https://${victim}/` });
    assert.ok(Dm.hostAllowed(victim, allowed), victim);
    assert.ok(!Dm.hostAllowed(attacker, allowed), `${attacker} を許可してしまう`);
    assert.ok(!Dm.allowedForHost(allowed).some((d) => d === 'co.id' || d === 'com.mx' || d === 'com.br'), 'PC版に公開サフィックスを渡さない');
  }
  // ワイルドカードと例外の規則（*.ck / !www.ck）
  assert.equal(Dm.registrableDomain('a.b.foo.ck'), 'b.foo.ck');
  assert.equal(Dm.registrableDomain('x.www.ck'), 'www.ck');
  // KAGI-03：https で登録したアイテムは、同じドメインでも http のページには入力しない
  assert.ok(Dm.insecureTarget('https://login.example.com/', 'http://login.example.com/'));
  assert.ok(Dm.insecureTarget('login.example.com', 'http://login.example.com/login'), 'スキームを省いた登録は https とみなす');
  assert.ok(Dm.insecureTarget('https://login.example.com/', 'http'), 'Android はスキーム名だけが届く');
  assert.ok(Dm.insecureTarget('https://login.example.com/', 'view-source:http://login.example.com/'));
  assert.ok(!Dm.insecureTarget('https://login.example.com/', 'https://login.example.com/'));
  assert.ok(!Dm.insecureTarget('https://login.example.com/', 'login.example.com/'), 'スキームを省いた表示（Chrome など）は http と決めつけない');
  assert.ok(!Dm.insecureTarget('http://intranet.example.com/', 'http://intranet.example.com/'), 'http で登録したものは http で入力できる');
  // 一覧に無いトップレベル：境界が決まらないので広げず、完全一致だけ
  const unknown = Dm.allowedDomainsOf({ url: 'https://login.example.unknowntld/' });
  assert.ok(Dm.hostAllowed('login.example.unknowntld', unknown));
  assert.ok(!Dm.hostAllowed('evil.login.example.unknowntld', unknown));
  assert.deepEqual(Dm.allowedForHost(unknown), ['=login.example.unknowntld']);
  // 公開サフィックスそのものを許可ドメインに足しても、その下の全部を許すことはない
  assert.ok(!Dm.hostAllowed('anyone.co.id', ['co.id']));
});
await test('本物は通し、偽ドメインは止める', () => {
  const item = { url: 'https://login.yahoo.co.jp/config/login' };
  const allowed = Dm.allowedDomainsOf(item);
  assert.ok(Dm.hostAllowed('login.yahoo.co.jp', allowed));
  assert.ok(Dm.hostAllowed('accounts.yahoo.co.jp', allowed));
  assert.ok(!Dm.hostAllowed('yahoo.co.jp.secure-login.com', allowed));
  assert.ok(!Dm.hostAllowed('yahoo-co-jp.com', allowed));
  assert.ok(!Dm.hostAllowed('xn--yahoo-cua.co.jp', allowed));
  assert.ok(!Dm.hostAllowed('notyahoo.co.jp', allowed), '末尾一致でも別ドメインは不可');
});
await test('アドレスバー表記（スキーム省略）から判定', () => {
  assert.equal(Dm.hostOf('yahoo.co.jp/mail'), 'yahoo.co.jp');
  assert.equal(Dm.hostOf('ｙａｈｏｏ.co.jp'), 'yahoo.co.jp'); // 全角は正規化される
});
await test('怪しいドメインの警告', () => {
  assert.ok(Dm.hostWarnings('https://xn--pple-43d.com/').length);   // 国際化ドメイン（キリル文字 а）
  assert.ok(Dm.hostWarnings('http://192.168.0.10/login').length);
  assert.equal(Dm.hostWarnings('https://www.amazon.co.jp/').length, 0);
});

console.log('自動入力の手順');
await test('既定の手順', () => {
  const steps = AT.compileTemplate('{ID}{TAB}{PASSWORD}{ENTER}', { account: 'me@example.com', password: 'p{a}ss' });
  assert.deepEqual(steps, [{ t: 'text', v: 'me@example.com' }, { t: 'key', v: 'TAB' }, { t: 'text', v: 'p{a}ss' }, { t: 'key', v: 'ENTER' }]);
});
await test('待機・リテラル・エラー', () => {
  const steps = AT.compileTemplate('{ID}{ENTER}{DELAY 1500}x{{y}}{PASSWORD}', { account: 'a', password: 'b' });
  assert.deepEqual(steps, [{ t: 'text', v: 'a' }, { t: 'key', v: 'ENTER' }, { t: 'delay', ms: 1500 }, { t: 'text', v: 'x{y}b' }]);
  assert.ok(AT.templateError('{NOPE}'));
  assert.ok(AT.templateError('{ID'));
  assert.equal(AT.templateError('{ID}{TAB}{PASSWORD}'), null);
});
await test('Shift 系のキー・シリアル（ハイフンを Tab）・個人情報', () => {
  const steps = AT.compileTemplate('{SERIALTAB}{SHIFT+TAB}{shift + home}{FAMILY}{GIVEN}{ZIP1}', { serialNumber: 'AAAA-BBBB-CC' }, { familyName: '山田', givenName: '太郎', zip1: '100-0001' });
  assert.deepEqual(steps, [
    { t: 'text', v: 'AAAA' }, { t: 'key', v: 'TAB' }, { t: 'text', v: 'BBBB' }, { t: 'key', v: 'TAB' }, { t: 'text', v: 'CC' },
    { t: 'key', v: 'SHIFT+TAB' }, { t: 'key', v: 'SHIFT+HOME' }, { t: 'text', v: '山田太郎100-0001' },
  ]);
  for (const [tok] of AT.TOKEN_HELP) assert.equal(AT.templateError(tok), null, tok);
  assert.equal(AT.describeTemplate('{ID}{TAB}{TAB}{PASSWORD}', [{ name: '銀行用', template: '{ID}{TAB}{TAB}{PASSWORD}' }]), '銀行用');
});
await test('スマート入力：ID欄・パスワード欄への移動', () => {
  const steps = AT.compileTemplate(AT.DEFAULT_TEMPLATE, { account: 'me', password: 'pw' });
  assert.deepEqual(steps, [{ t: 'focus', v: 'user' }, { t: 'text', v: 'me' }, { t: 'focus', v: 'password' }, { t: 'text', v: 'pw' }, { t: 'key', v: 'ENTER' }]);
  for (const [tpl] of AT.PRESETS) assert.equal(AT.templateError(tpl), null, tpl);
});
await test('入力先タイトルとの一致度', () => {
  const yahoo = { name: 'Yahoo! JAPAN', url: 'https://login.yahoo.co.jp/' };
  const bank = { name: '〇〇銀行', url: 'https://bank.example.co.jp/' };
  const title = 'ログイン - Yahoo! JAPAN - Google Chrome';
  assert.ok(AT.matchScore(yahoo, title) > AT.matchScore(bank, title));
});

console.log('CSV');
await test('引用符・改行・カンマを含む CSV', () => {
  const rows = CSV.parseCsv('name,url,username,password,note\r\n"A, Inc","https://a.example/","u1","p""1","line1\nline2"\r\nB,https://b.example,u2,p2,\r\n');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ['A, Inc', 'https://a.example/', 'u1', 'p"1', 'line1\nline2']);
});
await test('Chrome 形式を自動判定して取り込み', () => {
  const v = Mo.newVault();
  const [hd, ...data] = CSV.parseCsv('name,url,username,password,note\nYahoo,https://login.yahoo.co.jp/,taro,pw1,memo\n');
  assert.equal(CSV.detectFormat(hd), 'Chrome / Edge');
  const m = CSV.detectMapping(hd);
  const r = CSV.importInto(v, CSV.rowsToItems(v, data, m), { folderName: 'imp' });
  assert.equal(r.added, 1);
  const it = v.children[0].children[0];
  assert.deepEqual([it.name, it.url, it.account, it.password, it.comment], ['Yahoo', 'https://login.yahoo.co.jp/', 'taro', 'pw1', 'memo']);
});
await test('Bitwarden 形式（フォルダ・TOTP）と重複スキップ', () => {
  const v = Mo.newVault();
  const csv = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n' +
    '銀行,,login,ネット銀行,,PIN: 1234,0,https://bank.example.jp,taro,pw,JBSWY3DPEHPK3PXP\n';
  const [hd, ...data] = CSV.parseCsv(csv);
  assert.equal(CSV.detectFormat(hd), 'Bitwarden');
  const m = CSV.detectMapping(hd);
  CSV.importInto(v, CSV.rowsToItems(v, data, m), { folderName: 'imp' });
  const it = v.children[0].children[0].children[0];
  assert.equal(v.children[0].children[0].name, '銀行');
  assert.equal(it.item1, 'JBSWY3DPEHPK3PXP');
  assert.match(it.comment, /PIN: 1234/);
  const again = CSV.importInto(v, CSV.rowsToItems(v, data, m), { folderName: 'imp2' });
  assert.deepEqual([again.added, again.skipped], [0, 1]);
});
await test('書き出し→取り込みで内容が戻る', () => {
  const v = L.openLegacy(sample, 'abc123');
  for (const [fmt] of CSV.EXPORT_FORMATS) {
    const [hd, ...data] = CSV.parseCsv(CSV.exportCsv(v, fmt));
    const v2 = Mo.newVault();
    CSV.importInto(v2, CSV.rowsToItems(v2, data, CSV.detectMapping(hd)), { folderName: 'x', skipDuplicates: false });
    const it = Mo.listItems(v2)[0].node;
    assert.equal(it.password, `p<a>&ss"w'd`, fmt);
    assert.equal(it.account, 'user@example.com', fmt);
    assert.match(it.comment, /PIN: 1234/, fmt);
  }
});
await test('Shift_JIS の CSV も読める', () => {
  const { bytes } = encodeSjis('name,url,username,password\nテスト,https://x.example,ユーザー,パス\n');
  assert.match(CSV.decodeCsvBytes(bytes), /テスト/);
});

console.log('有効期限');
await test('期限切れ・期限間近・期限なし', () => {
  const today = '2026-11-12';
  assert.equal(Mo.isExpired({ expirationDate: '2026-11-11' }, today), true);
  assert.equal(Mo.isExpired({ expirationDate: '' }, today), false);
  assert.equal(Mo.isExpiringSoon({ expirationDate: '2026-11-30' }, 30, today), true);
  assert.equal(Mo.isExpiringSoon({ expirationDate: '2027-01-30' }, 30, today), false);
  assert.equal(Mo.isExpiringSoon({ expirationDate: '2026-11-30' }, 0, today), false);
  assert.equal(Mo.isExpiringSoon({ expirationDate: '2026-11-01' }, 30, today), false, '期限切れは「間近」には数えない');
});

console.log('パスワード履歴');
await test('変更前の値を新しい順に残し、統合時は両方を合わせる', () => {
  const it = Mo.newItem(null, 'x'); it.password = 'p1';
  Mo.pushPasswordHistory(it, 'p0', 1000);
  it.password = 'p2'; Mo.pushPasswordHistory(it, 'p1', 2000);
  assert.deepEqual(it.passwordHistory.map((h) => h.password), ['p1', 'p0']);
  const A = Mo.newVault(); const f = Mo.newFolder('F'); A.children.push(f); f.children.push(it);
  const B = Mo.cloneVault(A);
  const bi = B.children[0].children[0];
  Mo.pushPasswordHistory(bi, bi.password, 3000); bi.password = 'pB'; bi.modified = Date.now() + 5000;
  const out = M.mergeVaults(A, B, M.diffVaults(A, B, 'b', A)).children[0].children[0];
  assert.equal(out.password, 'pB');
  assert.deepEqual(out.passwordHistory.map((h) => h.password), ['p2', 'p1', 'p0']);
});

console.log('構文（画面のスクリプトを含め、すべて読み込めるか）');
{
  const { spawnSync } = await import('node:child_process');
  const dirs = [path.join(here, '..', 'app', 'js'), path.join(here, '..', 'android', 'app', 'src', 'main', 'assets', 'js')];
  for (const dir of dirs.filter((d) => fs.existsSync(d))) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      await test(`${path.basename(path.dirname(dir))}/${f}`, () => {
        const url = pathToFileURL(path.join(dir, f)).href;
        const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(url)}).catch((e) => { if (e instanceof SyntaxError) { console.error(e.message); process.exit(3); } })`], { encoding: 'utf8' });
        assert.notEqual(r.status, 3, `構文エラー: ${r.stderr.trim()}`);
      });
    }
  }
}

console.log('攻撃への耐性');
const D = Dm;
await test('鍵導出の設定が極端・弱い .kagi は開く前に拒否する', async () => {
  const s = await X.deriveSession('pw');
  const { text } = await X.encryptVault(Mo.newVault(), s);
  const env = JSON.parse(text);
  X.parseEnvelope(text); // 正常なものは通る
  for (const kdf of [
    { memKiB: 8, iterations: 1 }, { memKiB: 4 * 1024 * 1024 }, { iterations: 1e9 }, { parallelism: 0 },
    { salt: '' }, { salt: 'AAAA' }, { memKiB: '65536' }, { alg: 'pbkdf2' },
  ]) {
    assert.throws(() => X.parseEnvelope(JSON.stringify({ ...env, kdf: { ...env.kdf, ...kdf } })), undefined, JSON.stringify(kdf));
  }
  assert.throws(() => X.parseEnvelope(JSON.stringify({ ...env, cipher: { ...env.cipher, iv: 'AAAA' } })));
});
await test('ドメイン照合：偽サイトの典型例をすべて拒否する', () => {
  const ok = (url, host) => D.hostAllowed(host, D.allowedDomainsOf({ url }));
  assert.ok(ok('https://login.yahoo.co.jp', 'login.yahoo.co.jp'));
  assert.ok(ok('https://login.yahoo.co.jp', 'yahoo.co.jp'));
  assert.ok(!ok('https://login.yahoo.co.jp', 'yahoo.co.jp.evil.com'));
  assert.ok(!ok('https://login.yahoo.co.jp', 'evilyahoo.co.jp'));
  assert.ok(!ok('https://login.yahoo.co.jp', D.hostOf('https://yahoo.co.jp@evil.com/')));
  assert.ok(!ok('https://login.yahoo.co.jp', D.hostOf('https://evil.com\\@yahoo.co.jp')));
  assert.equal(D.hostOf('blob:https://evil.com/1234'), 'evil.com');
  assert.equal(D.hostOf('view-source:https://evil.com/'), 'evil.com');
  assert.equal(D.hostOf('https://ｙａｈｏｏ.co.jp'), 'yahoo.co.jp'); // 全角はブラウザと同じく半角に
  // 利用者ごとにサブドメインが割り当てられるサービスは、別の利用者を同じサイトとみなさない
  for (const [url, evil] of [
    ['https://myshop.sakura.ne.jp/login', 'attacker.sakura.ne.jp'], ['https://shop.xsrv.jp/', 'attacker.xsrv.jp'],
    ['https://foo.myshopify.com', 'attacker.myshopify.com'], ['https://foo.s3.amazonaws.com', 'attacker.s3.amazonaws.com'],
    ['https://user.github.io', 'attacker.github.io'], ['https://acct.blob.core.windows.net', 'evil.blob.core.windows.net'],
    ['https://github.io', 'attacker.github.io'], ['https://jp', 'attacker.jp'], ['https://co.jp', 'evil.co.jp'],
  ]) assert.ok(!ok(url, evil), `${url} vs ${evil}`);
  assert.deepEqual(D.allowedForHost(['yahoo.co.jp', 'github.io']), ['yahoo.co.jp', '=github.io']);
});
await test('自動入力：値に含まれる改行・Tab は Enter・Tab として入力しない', () => {
  const steps = AT.compileTemplate('{ID}{TAB}{PASSWORD}', { account: 'user\r\n', password: 'p\nrm -rf ~\n\tx' });
  assert.deepEqual(steps, [{ t: 'text', v: 'user' }, { t: 'key', v: 'TAB' }, { t: 'text', v: 'prm -rf ~x' }]);
  // 値の中の { } は記号として解釈しない
  assert.deepEqual(AT.compileTemplate('{ID}', { account: '{ENTER}{DELAY 1}' }), [{ t: 'text', v: '{ENTER}{DELAY 1}' }]);
});
await test('.idm の XML：外部実体・入れ子の実体は展開しない', () => {
  const xml = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "AAAA"><!ENTITY b "&a;&a;&a;">]><idmData><item><name>&b;&lt;</name></item></idmData>';
  const v = L.legacyXmlToVault(xml);
  assert.ok(!JSON.stringify(v).includes('AAAA'));
});

console.log('公式ドメインの点検（主要サービス）');
const BC = await import(pathToFileURL(path.join(here, '..', 'app', 'js', 'brandcheck.js')).href);
const { BRANDS } = await import(pathToFileURL(path.join(here, '..', 'app', 'js', 'brands.js')).href);
await test('一覧の形式：ID の重複なし・公式 URL は自分の公式ドメイン', () => {
  const ids = new Set();
  for (const b of BRANDS) {
    assert.ok(!ids.has(b.id), `ID 重複: ${b.id}`); ids.add(b.id);
    assert.ok(b.domains.length && b.aliases.length && b.url.startsWith('https://'), b.id);
    assert.ok(BC.isGroupDomain(b, Dm.hostOf(b.url)), `公式 URL が公式ドメインにない: ${b.id}`);
  }
});
await test('一覧の分け方：どのサービスも、大項目・中項目のどれか1つに入っている', async () => {
  const { CATEGORIES } = await import(pathToFileURL(path.join(here, '..', 'app', 'js', 'brands.js')).href);
  const mids = CATEGORIES.flatMap(([, m]) => m);
  assert.equal(new Set(mids).size, mids.length, '中項目の名前は重ならない');
  for (const b of BRANDS) assert.ok(mids.includes(b.cat), `分け方にない cat: ${b.id} ${b.cat}`);
  for (const m of mids) assert.ok(BRANDS.some((b) => b.cat === m), `中身のない中項目: ${m}`);
});
await test('一覧のどの公式ドメインも「似せたドメイン」と判定しない（追加で取り違えが増えていない）', () => {
  for (const d of new Set(BRANDS.flatMap((b) => b.domains))) assert.equal(BC.lookalike(d), null, `誤検知: ${d}`);
});
await test('2026-11-23 に足した金融機関：タイトルで見分け、ログインのドメインを公式と判定する', () => {
  const t = (s) => BC.brandOfTitle(s)?.id;
  assert.equal(t('auじぶん銀行'), 'jibunbank', 'au より長い呼び名を優先');
  assert.equal(t('auカブコム証券'), 'kabucom', '社名変更前の呼び名でも');
  assert.equal(t('七十七銀行'), '77bank');
  assert.equal(t('しがぎん'), 'shigagin');
  assert.equal(t('セディナ'), 'smbc-card', '三井住友カードに統合済み');
  assert.equal(t('dカード'), 'docomo', 'dカードはドコモの項目');
  assert.equal(t('ブレイクダンス'), undefined, 'カタカナ語の途中の「レイク」は拾わない');
  assert.equal(t('コンプロミス'), undefined);
  assert.equal(t('BOOKBANK'), undefined, '英字の途中の OKB は拾わない');
  // ログインが別のドメイン（共同のインターネットバンキングを含む）でも、公式と判定する
  for (const [name, url] of [['七十七銀行', 'https://www.parasol.anser.ne.jp/ib/index.do?PT=BS&CCT0080=0125'], ['八十二銀行', 'https://direct1.82bank.co.jp/'],
    ['東邦銀行', 'https://bb3.ib.finemax.net/'], ['十六銀行', 'https://www.inb.jurokubank.chance.co.jp/'], ['大垣共立銀行', 'https://okbnetplaza.com/'],
    ['トヨタファイナンス', 'https://my.tscubic.com/'], ['BITPOINT', 'https://trades.bpj-ex.com/'], ['三菱UFJ eスマート証券', 'https://mauth-sso.kabu.co.jp/']]) {
    assert.equal(BC.checkItem({ name, url }).level, 'ok', `${name} ${url}`);
  }
  for (const d of ['jibunbank-login.com', '77bank.co.jp.secure-login.net', 'bitbank-jp.cc', 'sbineotrade-jp.com']) assert.ok(BC.lookalike(d), `見逃し: ${d}`);
});
await test('2026-11-23 に足した飲食・家電・行政・ゲーム：見分けと誤検知', () => {
  const t = (s) => BC.brandOfTitle(s)?.id;
  assert.equal(t('マクド'), 'mcdonalds');
  assert.equal(t('スタバ'), 'starbucks');
  assert.equal(t('ガスト'), 'skylark');
  assert.equal(t('パズドラ'), 'gungho');
  assert.equal(t('スカラネット'), 'jasso');
  assert.equal(t('Wolt'), undefined, '日本で終了した Wolt は外した');
  assert.ok(BRANDS.some((b) => b.id === 'yodobashi' && b.cat === '家電量販店・パソコン'), '家電量販店は専用のカテゴリ');
  assert.ok(BRANDS.some((b) => b.id === 'demaecan' && b.cat === 'デリバリー・グルメ・レシピ'), '出前館は飲食のカテゴリ');
  for (const d of ['mcdonalds-jp.com', 'starbucks-card.net', 'sukiya-login.com', 'dominos-pizza-login.com']) assert.ok(BC.lookalike(d), `見逃し: ${d}`);
  for (const d of ['pretty.com', 'doctor.com', 'mydoctor.jp', 'stayathome.jp']) assert.equal(BC.lookalike(d), null, `誤検知: ${d}`);
  assert.equal(BC.checkItem({ name: '登記', url: 'https://www.touki-kyoutaku-online.moj.go.jp/' }).official[0]?.id, 'moj-touki');
});
await test('利用者の多いサービスの追加（コンビニ・ドラッグストア・マンガ・チケット・求人 など）', () => {
  const t = (s) => BC.brandOfTitle(s)?.id;
  assert.equal(t('ローソン'), 'lawson');
  assert.equal(t('ローソン銀行'), 'lawsonbank', '長い呼び名が優先');
  assert.equal(t('ローチケ'), 'ltike');
  assert.equal(t('ファミマ'), 'familymart');
  assert.equal(t('進研ゼミ'), 'benesse');
  assert.equal(t('Google+'), 'google', '「e+」のような記号で終わる短い呼び名を入れない');
  assert.equal(t('ぴあの教室'), undefined);
  assert.equal(t('弥生'), undefined, '人名・月の名前にもなる言葉だけでは判定しない');
  // ラクマは楽天のフリマ。fril.jp を楽天の公式ドメインに入れた（前は食い違いと出ていた）
  const r = BC.checkItem({ name: 'ラクマ', url: 'https://fril.jp/' });
  assert.equal(r.level, 'ok');
  assert.equal(r.mismatch, false);
  assert.ok(BRANDS.some((b) => b.id === 'duolingo' && b.cat === '学び・教育'));
});
await test('タイトルから考えられるサービスの候補と、候補から選んだサービスの判定', () => {
  const names = (t) => BC.brandCandidates(t).map((b) => b.id);
  const mitsui = names('三井住友');
  assert.equal(mitsui[0], 'smbc', 'いちばん合うものが先頭（brandOfTitle と同じ）');
  for (const id of ['smbc-card', 'smtb']) assert.ok(mitsui.includes(id), `候補に ${id}`);
  assert.ok(names('楽天').includes('rakuten-bank'));
  assert.deepEqual(names('社内システム'), [], '合うものがなければ候補なし');
  assert.deepEqual(names('銀行'), [], '一般の言葉だけでは候補を出さない');
  assert.equal(new Set(BC.brandCandidates('ゆうちょ銀行').map((b) => b.url)).size, BC.brandCandidates('ゆうちょ銀行').length, '同じ URL は1つ');
  // 候補から三井住友信託銀行を選んだアイテム：タイトルが「三井住友」でも食い違いにしない
  const picked = { name: '三井住友', url: 'https://www.smtb.jp/', brandHint: 'smtb' };
  assert.equal(BC.checkItem(picked).titleBrand.id, 'smtb');
  assert.equal(BC.checkItem(picked).mismatch, false);
  assert.equal(BC.checkItem({ name: '三井住友', url: 'https://www.smtb.jp/' }).mismatch, true, '選んでいなければ今までどおり');
  assert.equal(BC.checkItem({ name: '三井住友', url: 'https://www.smtb.jp/', brandHint: 'none' }).titleBrand, null, '「このサービスではない」も今までどおり');
  assert.equal(BC.checkItem({ name: '三井住友', url: '', brandHint: 'no-such-brand' }).titleBrand.id, 'smbc', '知らない id はタイトルで判定');
});
await test('似せたドメインを見抜く', () => {
  for (const d of ['amaz0n.co.jp', 'amazon-security.com', 'rakuten-card-login.net', 'rakuten.co.jp.secure-login.com', 'rnicrosoft.com',
    'paypa1.com', 'appleid-support.com', 'myapple-id.com', 'yahoo-japan.net', 'jp-bank-japanpost.com', 'rakuten-login.github.io', 'smbc-card-jp.com',
    'amazom.co.jp', 'rakutten.co.jp', 'googel.com', 'softbonk.jp']) {
    assert.ok(BC.lookalike(d), `見逃し: ${d}`);
  }
});
await test('公式ドメインや無関係の単語は警告しない', () => {
  for (const d of ['www.rakuten-card.co.jp', 'login.yahoo.co.jp', 'accounts.google.com', 'signin.aws.amazon.com', 'online-shop.jp', 'stream.jp',
    'canvas.com', 'japan.travel', 'applebees.com', 'pineapple.jp', 'note-pc.jp', 'example.com',
    // 1文字違いでも、形の違う文字への置き換えは別の会社（北海道電力 hepco と東京電力 tepco を取り違えていた）
    'www.enemall.hepco.co.jp', 'tesco.com', 'apply.jp']) {
    assert.equal(BC.lookalike(d), null, `誤検知: ${d}`);
  }
});
await test('タイトルからサービスを見分け、ドメインとの食い違いを見つける', () => {
  assert.equal(BC.brandOfTitle('楽天カード（e-NAVI）').id, 'rakuten-card');
  assert.equal(BC.brandOfTitle('Online banking'), null); // online の中の line は拾わない
  // カタカナ語の後ろ半分では一致させない（ブックオフオン「ライン」→ LINE と誤判定していた）
  assert.equal(BC.brandOfTitle('ブックオフオンライン').id, 'bookoff');
  assert.equal(BC.brandOfTitle('オンラインショップ'), null);
  assert.equal(BC.brandOfTitle('マイナスイオン'), null);
  assert.equal(BC.brandOfTitle('ライン').id, 'line');
  assert.equal(BC.brandOfTitle('イオンカード').id, 'aeon');
  assert.equal(BC.brandOfTitle('ｱﾏｿﾞﾝ').id, 'amazon'); // 半角カナ
  // 「このサービスではない」と指定したアイテムは、タイトルで判定しない
  assert.equal(BC.checkItem({ name: 'LINE', url: 'https://example.com/', brandHint: 'none' }).mismatch, false);
  assert.equal(BC.checkItem({ name: '楽天カード', url: 'https://rakuten-card-login.net/', brandHint: 'none' }).level, 'danger'); // 偽ドメインの点検は続ける
  assert.equal(BC.checkItem({ name: '楽天カード', url: 'https://www.rakuten-card.co.jp/' }).level, 'ok');
  assert.equal(BC.checkItem({ name: '楽天カード', url: 'https://example.com/' }).mismatch, true);
  assert.equal(BC.checkItem({ name: '楽天カード', url: 'https://rakuten-card-login.net/' }).level, 'danger');
  assert.equal(BC.checkItem({ name: '楽天カード', url: '' }).suggestUrl, 'https://www.rakuten-card.co.jp/');
  assert.equal(BC.checkItem({ name: '社内システム', url: 'https://intra.example.co.jp/' }).level, 'unknown');
  assert.equal(BC.checkItem({ name: 'Amazon', url: 'https://www.amazon.co.jp/', allowedDomains: ['amaz0n-jp.com'] }).level, 'danger');
  // 利用者が「本物と確認した」ドメインは、そのアイテムだけ警告しない（別のドメインに変えれば、また点検する）
  const fake = { name: '楽天カード', url: 'https://rakuten-card-login.net/' };
  assert.equal(BC.checkItem(fake).level, 'danger');
  fake.verifiedDomains = ['rakuten-card-login.net'];
  assert.equal(BC.checkItem(fake).level, 'ok');
  assert.equal(BC.checkItem(fake).userVerified, true);
  fake.url = 'https://rakuten-card-secure.net/';
  assert.equal(BC.checkItem(fake).level, 'danger', '確認したのと別のドメインは点検する');
  assert.equal(BC.checkItem({ name: 'Amazon', url: 'https://www.amazon.co.jp/', allowedDomains: ['amaz0n-jp.com'], verifiedDomains: ['amaz0n-jp.com'] }).level, 'ok');
});


console.log('ツリーのドラッグ移動');
await test('フォルダの中・前後へ移動でき、決まりに反する移動は何も変えない', () => {
  const v = Mo.newVault(); const A = Mo.newFolder('A'), B = Mo.newFolder('B'), C = Mo.newFolder('C');
  v.children.push(A, B); A.children.push(C);
  const i1 = Mo.newItem(v, 'i1'), i2 = Mo.newItem(v, 'i2'); A.children.push(i1); B.children.push(i2);
  const shape = () => JSON.stringify(v.children.map((f) => [f.name, f.children.map((c) => (c.type === 'folder' ? [c.name, c.children.map((x) => x.name)] : c.name))]));
  assert.ok(Mo.moveNodeTo(v, i1.id, B.id, 'inside'));
  assert.equal(shape(), '[["A",[["C",[]]]],["B",["i2","i1"]]]');
  assert.ok(Mo.moveNodeTo(v, i2.id, i1.id, 'after'));
  assert.equal(shape(), '[["A",[["C",[]]]],["B",["i1","i2"]]]');
  const before = shape();
  assert.equal(Mo.moveNodeTo(v, i1.id, A.id, 'before'), false, 'アイテムは最上位に置けない');
  assert.equal(Mo.moveNodeTo(v, A.id, C.id, 'inside'), false, 'フォルダを自分の子の中へは移せない');
  assert.equal(Mo.moveNodeTo(v, A.id, A.id, 'inside'), false, '自分自身へは移せない');
  assert.equal(Mo.moveNodeTo(v, i1.id, i2.id, 'inside'), false, 'アイテムの中へは入れられない');
  assert.equal(Mo.moveNodeTo(v, i1.id, null, null), false, 'アイテムは最上位に置けない');
  assert.equal(shape(), before, '失敗した移動では何も変わらない');
  assert.ok(Mo.moveNodeTo(v, C.id, null, null));
  assert.ok(Mo.moveNodeTo(v, B.id, A.id, 'before'));
  assert.equal(shape(), '[["B",["i1","i2"]],["A",[]],["C",[]]]');
});


console.log('パスワード生成：使う記号を選ぶ');
await test('選んだ記号だけを使い、記号を1つも選ばなければ記号は入らない', () => {
  const pw = Array.from({ length: 300 }, () => G.generatePassword({ length: 24, symbols: '!@' })).join('');
  const syms = new Set([...pw].filter((ch) => !/[A-Za-z0-9]/.test(ch)));
  assert.deepEqual([...syms].sort(), ['!', '@']);
  for (let i = 0; i < 50; i++) assert.ok(!/[^A-Za-z0-9]/.test(G.generatePassword({ length: 32, symbols: '' })));
  // 記号を選んでいて、ほかの文字種を全部外しても、選んだ記号だけで作れる
  assert.ok(/^[#%]+$/.test(G.generatePassword({ length: 12, upper: false, lower: false, digit: false, symbols: '#%' })));
  assert.equal(G.normalizeSymbols('@!!x#あ'), '!#@');
  for (const [, , s] of G.SYMBOL_PRESETS) assert.equal(G.normalizeSymbols(s), s);
});

console.log('パスワードの点検（使い回し・弱いもの）');
const HL = await appJs('health.js');
await test('弱いパスワードを見つけ、強いものは通す', () => {
  const r = (pw, o) => HL.checkPassword(pw, o)?.reasons || [];
  assert.ok(r('password123').includes('よく使われるパスワード'));
  assert.ok(r('qwerty!').includes('よく使われるパスワード'));
  assert.ok(r('123456').includes('数字だけ'));
  assert.ok(r('abcd').some((x) => x.startsWith('短い')));
  assert.ok(r('aaaaaaaa').includes('同じ文字のくり返し'));
  assert.ok(r('98765432').includes('並んだ文字（1234・abcd など）'));
  assert.ok(r('taro2024xyz', { account: 'taro@example.com' }).includes('ID と同じ文字を含む'));
  assert.equal(HL.checkPassword('Kq7#vT2p!mZ9wL4s'), null, '十分に強い');
  assert.equal(HL.checkPassword('correcthorsebatterystaple'), null, '長い英字だけは問題にしない');
  assert.equal(HL.checkPassword(''), null);
});
await test('よく使われるパスワードの一覧（SecLists の1万件＋日本でよく見るもの）', async () => {
  const { COMMON_PASSWORDS } = await appJs('common-passwords.js');
  const list = COMMON_PASSWORDS.split('\n');
  assert.ok(list.length >= 10000, `件数 ${list.length}`);
  assert.ok(list.every((w) => w && w === w.toLowerCase() && !/\s/.test(w)), '小文字・空白なし');
  const common = (pw) => (HL.checkPassword(pw)?.reasons || []).includes('よく使われるパスワード');
  assert.ok(common('Dragon'), '一覧にある（大文字小文字は区別しない）');
  assert.ok(common('letmein'));
  assert.ok(common('starwars1987!'), '一覧の言葉の後ろに数字・記号を足しただけ');
  assert.ok(common('naruto'), '前からある日本向けの言葉も残す');
  assert.ok(!common('Kq7#vT2p!mZ9wL4s'), '強いものは一覧に当たらない');
  assert.ok(!common('mydragonhouse77'), '一覧の言葉を途中に含むだけでは当てない');
});
await test('使い回しをまとめ、暗証番号らしいものは分ける', () => {
  const e = (name, password, extra = {}) => ({ node: { id: name, name, password, ...extra }, path: [] });
  const res = HL.analyzePasswords([e('A', 'Same-Pass-91!x'), e('B', 'Same-Pass-91!x'), e('C', 'Same-Pass-91!x'), e('D', 'Other-Pass-55#q'),
    e('キャッシュカード', '1234'), e('E', 'abc'), e('F', '')]);
  assert.equal(res.reused.length, 1);
  assert.deepEqual(res.reused[0].map((x) => x.node.id), ['A', 'B', 'C']);
  assert.equal(res.reusedItems, 3);
  assert.equal(res.checked, 6, 'パスワードが空のものは数えない');
  const pin = res.weak.find((w) => w.node.id === 'キャッシュカード');
  assert.ok(pin && pin.pin, '暗証番号らしいもの');
  assert.ok(res.weak.find((w) => w.node.id === 'E' && !w.pin));
  assert.equal(res.okCount, 2, 'D と暗証番号は問題なし扱い');
  assert.equal(HL.reuseCount([e('A', 'x1'), e('B', 'x1'), e('C', 'y')], { id: 'A', password: 'x1' }), 1);
});

console.log('新しいフォルダの名前');
await test('同じ階層に同じ名前があれば番号を付ける（別の階層・アイテムの名前は数えない）', () => {
  const list = [];
  assert.equal(Mo.uniqueFolderName(list), '新しいフォルダ');
  list.push(Mo.newFolder('新しいフォルダ'));
  assert.equal(Mo.uniqueFolderName(list), '新しいフォルダ (2)');
  list.push(Mo.newFolder('新しいフォルダ (2)'));
  assert.equal(Mo.uniqueFolderName(list), '新しいフォルダ (3)');
  const onlyItem = [Mo.newItem(null, '新しいフォルダ')];
  assert.equal(Mo.uniqueFolderName(onlyItem), '新しいフォルダ', 'アイテムの名前とは重なってもよい');
});

console.log('端末内の控え（自動入力で最初に選ぶデータ）');
await test('最後に開いたファイルが先頭に来る（中身が同じで記録し直さないときも）', async () => {
  const St = await appJs('store.js');
  const snap = (r) => ({ revId: `r${r}`, revision: r, savedAt: '', device: '', contentHash: '', fileText: '' });
  const tick = () => new Promise((r) => setTimeout(r, 5));
  await St.recordHead('kagi:mine', 'mine.kagi', snap(1));
  await tick();
  await St.recordHead('kagi:sample', 'sample.kagi', snap(1)); // あとから初めて開いたサンプル
  assert.equal((await St.listKnown())[0].key, 'kagi:sample');
  await tick();
  await St.markOpened('kagi:mine'); // 自分のファイルを開き直した（中身が同じなので recordHead はされない）
  assert.equal((await St.listKnown())[0].key, 'kagi:mine');
  await St.markOpened('kagi:none'); // 記録のないファイルでは何もしない
  assert.equal((await St.listKnown()).length, 2);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

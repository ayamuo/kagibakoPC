// Shift_JIS（Windows-31J / CP932）の符号化・復号。
// 復号はブラウザ/Node 標準の TextDecoder('shift_jis')（WHATWG 仕様では CP932 相当）を使い、
// 符号化は同じデコーダから逆引き表を作って行う（外部テーブル不要）。

let encMap = null;
const decoder = () => new TextDecoder('shift_jis', { fatal: false });

function buildEncMap() {
  const map = new Map();
  const dec = decoder();
  // ASCII
  for (let b = 0; b < 0x80; b++) map.set(b, [b]);
  // 半角カナ
  for (let b = 0xa1; b <= 0xdf; b++) map.set(0xff61 + (b - 0xa1), [b]);
  // 2バイト文字。重複定義がある文字は Windows の変換に近い優先順位
  // （JIS X 0208 → IBM拡張(FA-FC) → NEC特殊文字(87) → NEC選定IBM拡張(ED-EE)）で登録する。
  const leads = [];
  for (let b = 0x81; b <= 0x9f; b++) if (b !== 0x87) leads.push(b);
  for (let b = 0xe0; b <= 0xec; b++) leads.push(b);
  for (let b = 0xfa; b <= 0xfc; b++) leads.push(b);
  leads.push(0x87, 0xed, 0xee);
  for (const lead of leads) {
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      const s = dec.decode(new Uint8Array([lead, trail]));
      if (s.length !== 1) continue; // サロゲート等は対象外
      const cp = s.charCodeAt(0);
      if (cp === 0xfffd) continue;
      if (!map.has(cp)) map.set(cp, [lead, trail]);
    }
  }
  return map;
}

/** 文字列 → CP932 バイト列。変換できない文字は unmappable に記録し '?' に置換する。 */
export function encodeSjis(str) {
  if (!encMap) encMap = buildEncMap();
  const out = [];
  const unmappable = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    const bytes = cp <= 0xffff ? encMap.get(cp) : undefined;
    if (bytes) out.push(...bytes);
    else {
      unmappable.push(ch);
      out.push(0x3f);
    }
  }
  return { bytes: new Uint8Array(out), unmappable };
}

export function decodeSjis(bytes) {
  return decoder().decode(bytes);
}

/** CP932 で表現できない文字の一覧（重複なし） */
export function findUnmappable(str) {
  return [...new Set(encodeSjis(str).unmappable)];
}

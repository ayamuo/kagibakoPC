// Blowfish（ECB）実装 — .idm ファイルの読み込み専用。
// 8バイトブロックを「リトルエンディアンの32bit語×2」として読み書きする。
// .kagi では使用しない（.kagi は AES-256-GCM）。
import { P_INIT, S_INIT } from './bf-tables.js';

export class Blowfish {
  /** @param {Uint8Array} key 1〜56バイト */
  constructor(key) {
    if (!(key instanceof Uint8Array) || key.length < 1 || key.length > 56) {
      throw new Error('Blowfish key must be 1..56 bytes');
    }
    this.P = new Uint32Array(P_INIT);
    this.S = new Uint32Array(S_INIT); // 4 x 256 を連続配置
    let j = 0;
    for (let i = 0; i < 18; i++) {
      let d = 0;
      for (let k = 0; k < 4; k++) {
        d = ((d << 8) | key[j]) >>> 0;
        j = (j + 1) % key.length;
      }
      this.P[i] = (this.P[i] ^ d) >>> 0;
    }
    const lr = [0, 0];
    for (let i = 0; i < 18; i += 2) {
      this._enc(lr);
      this.P[i] = lr[0];
      this.P[i + 1] = lr[1];
    }
    for (let i = 0; i < 1024; i += 2) {
      this._enc(lr);
      this.S[i] = lr[0];
      this.S[i + 1] = lr[1];
    }
  }

  _f(x) {
    const S = this.S;
    return ((((S[x >>> 24] + S[256 + ((x >>> 16) & 255)]) >>> 0) ^ S[512 + ((x >>> 8) & 255)]) + S[768 + (x & 255)]) >>> 0;
  }

  _enc(lr) {
    const P = this.P;
    let l = lr[0], r = lr[1];
    for (let i = 0; i < 16; i += 2) {
      l = (l ^ P[i]) >>> 0;
      r = (r ^ this._f(l)) >>> 0;
      r = (r ^ P[i + 1]) >>> 0;
      l = (l ^ this._f(r)) >>> 0;
    }
    lr[0] = (r ^ P[17]) >>> 0;
    lr[1] = (l ^ P[16]) >>> 0;
  }

  _dec(lr) {
    const P = this.P;
    let l = lr[0], r = lr[1];
    for (let i = 17; i > 1; i -= 2) {
      l = (l ^ P[i]) >>> 0;
      r = (r ^ this._f(l)) >>> 0;
      r = (r ^ P[i - 1]) >>> 0;
      l = (l ^ this._f(r)) >>> 0;
    }
    lr[0] = (r ^ P[0]) >>> 0;
    lr[1] = (l ^ P[1]) >>> 0;
  }

  _ecb(data, decrypt) {
    if (data.length % 8 !== 0) throw new Error('Blowfish input must be a multiple of 8 bytes');
    const out = new Uint8Array(data.length);
    const inV = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const outV = new DataView(out.buffer);
    const lr = [0, 0];
    for (let i = 0; i < data.length; i += 8) {
      lr[0] = inV.getUint32(i, true);
      lr[1] = inV.getUint32(i + 4, true);
      if (decrypt) this._dec(lr); else this._enc(lr);
      outV.setUint32(i, lr[0], true);
      outV.setUint32(i + 4, lr[1], true);
    }
    return out;
  }

  encryptECB(data) { return this._ecb(data, false); }
  decryptECB(data) { return this._ecb(data, true); }

  wipe() {
    this.P.fill(0);
    this.S.fill(0);
  }
}

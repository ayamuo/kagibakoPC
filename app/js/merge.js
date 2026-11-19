// 2つの版（A=いま開いている版, B=比べる版）の比較と統合
//
// base（共通の元の版）が分かる場合は3方向比較を行い、片方だけが変えた項目は自動でその変更を採用する。
// 同じ項目を両方が変えた「衝突」だけ、更新日時が新しい方を初期値にしてユーザーに選んでもらう。
import { ITEM_FIELDS, PROFILE_FIELDS, listItems, newFolder, walk, cloneVault, mergePasswordHistory, pushPasswordHistory } from './model.js';

const CONTENT_KEYS = ITEM_FIELDS.map(([k]) => k);
const val = (o, k) => (o?.[k] ?? '');

function itemEqual(a, b) {
  return CONTENT_KEYS.every((k) => val(a, k) === val(b, k));
}

function pathKey(entry) {
  return [...entry.path, entry.node.name].join('\u0001');
}

/** 2つの版のアイテムを対応付ける（ID優先、無ければ「フォルダ階層＋タイトル」） */
function matchItems(listA, listB) {
  const pairs = [];
  const usedB = new Set();
  const byIdB = new Map(listB.map((e) => [e.node.id, e]));
  const restA = [];
  for (const ea of listA) {
    const eb = byIdB.get(ea.node.id);
    if (eb && !usedB.has(eb)) { pairs.push([ea, eb]); usedB.add(eb); }
    else restA.push(ea);
  }
  const byPathB = new Map();
  for (const eb of listB) {
    if (usedB.has(eb)) continue;
    const k = pathKey(eb);
    if (!byPathB.has(k)) byPathB.set(k, []);
    byPathB.get(k).push(eb);
  }
  const onlyA = [];
  for (const ea of restA) {
    const cand = byPathB.get(pathKey(ea));
    if (cand?.length) { const eb = cand.shift(); pairs.push([ea, eb]); usedB.add(eb); }
    else onlyA.push(ea);
  }
  const onlyB = listB.filter((e) => !usedB.has(e));
  return { pairs, onlyA, onlyB };
}

function baseLookup(base) {
  if (!base) return () => null;
  const list = listItems(base);
  const byId = new Map(list.map((e) => [e.node.id, e]));
  const byPath = new Map();
  for (const e of list) if (!byPath.has(pathKey(e))) byPath.set(pathKey(e), e);
  return (e) => byId.get(e.node.id) || byPath.get(pathKey(e)) || null;
}

/**
 * 差分一覧を作る。
 *   modified: fields[].choice（項目ごと 'a'|'b'）と choice（場所が違う場合にどちらの場所を使うか）
 *   onlyA / onlyB: choice 'a'|'b'（A の状態 / B の状態 を採用）
 * preferSide: 判断材料が無いときに優先する側（新しく保存された方）
 */
export function diffVaults(A, B, preferSide = 'a', base = null) {
  const { pairs, onlyA, onlyB } = matchItems(listItems(A), listItems(B));
  const inBase = baseLookup(base);
  const tombA = new Map((A.tombstones || []).map((t) => [t.id, t.deletedAt]));
  const tombB = new Map((B.tombstones || []).map((t) => [t.id, t.deletedAt]));
  const diffs = [];

  for (const [ea, eb] of pairs) {
    const samePath = ea.path.join('/') === eb.path.join('/');
    if (itemEqual(ea.node, eb.node) && samePath) continue;
    const ma = ea.node.modified || 0, mb = eb.node.modified || 0;
    const newer = ma === mb ? preferSide : ma > mb ? 'a' : 'b';
    const be = inBase(ea) || inBase(eb);
    let conflicts = 0;
    const fields = ITEM_FIELDS.filter(([k]) => val(ea.node, k) !== val(eb.node, k)).map(([k, label]) => {
      let choice = newer, auto = false;
      if (be) {
        const bv = val(be.node, k);
        if (val(ea.node, k) === bv) { choice = 'b'; auto = true; }      // B だけが変更
        else if (val(eb.node, k) === bv) { choice = 'a'; auto = true; } // A だけが変更
        else conflicts++;
      } else conflicts++;
      return { key: k, label, choice, auto };
    });
    let choice = newer;
    if (!samePath && be) {
      const bp = be.path.join('/');
      if (ea.path.join('/') === bp) choice = 'b';
      else if (eb.path.join('/') === bp) choice = 'a';
    }
    diffs.push({
      kind: 'modified', a: ea, b: eb, choice, fields, moved: !samePath, conflicts,
      reason: be ? (conflicts ? `両方で同じ項目が変更（${conflicts}件）。初期値は後で更新された方` : '別々の項目の変更なので自動で両方を反映')
        : (ma === mb ? '更新日時が同じ/不明のため新しく保存された方' : `${newer.toUpperCase()} の方が後で更新`),
    });
  }
  for (const ea of onlyA) {
    const del = tombB.get(ea.node.id);
    let deleted = !!del && del >= (ea.node.modified || 0);
    // base にあって B に無い＝B で削除された（A で変更されていなければ削除を採用）
    const be = inBase(ea);
    if (!deleted && be && itemEqual(be.node, ea.node)) deleted = true;
    diffs.push({ kind: 'onlyA', a: ea, b: null, choice: deleted ? 'b' : 'a', reason: deleted ? 'B で削除済み' : 'A にだけある' });
  }
  for (const eb of onlyB) {
    const del = tombA.get(eb.node.id);
    let deleted = !!del && del >= (eb.node.modified || 0);
    const be = inBase(eb);
    if (!deleted && be && itemEqual(be.node, eb.node)) deleted = true;
    diffs.push({ kind: 'onlyB', a: null, b: eb, choice: deleted ? 'a' : 'b', reason: deleted ? 'A で削除済み' : 'B にだけある' });
  }

  const profile = [];
  for (const [k, label] of PROFILE_FIELDS) {
    const va = val(A.profile, k), vb = val(B.profile, k);
    if (va === vb) continue;
    let choice = preferSide;
    if (base) {
      const bv = val(base.profile, k);
      if (va === bv) choice = 'b';
      else if (vb === bv) choice = 'a';
    }
    profile.push({ key: k, label, a: va, b: vb, choice });
  }
  return { diffs, profile };
}

/** フォルダの場所（名前の並び）を用意する。作るときは、相手の版の同じ場所のフォルダの ID を引き継ぐ */
function ensureFolderPath(vault, path, other = null) {
  let container = vault.children, otherContainer = other?.children || null;
  for (const name of path) {
    let f = container.find((c) => c.type === 'folder' && c.name === name);
    const of = otherContainer?.find((c) => c.type === 'folder' && c.name === name) || null;
    if (!f) {
      f = newFolder(name);
      if (of && !locate(vault, of.id)) { f.id = of.id; f.created = of.created ?? f.created; }
      container.push(f);
    }
    container = f.children;
    otherContainer = of?.children || null;
  }
  return container;
}

function folderEntries(vault) {
  const m = new Map();
  for (const e of walk(vault.children)) if (e.node.type === 'folder') m.set(e.node.id, e);
  return m;
}
const hasItems = (folder) => [...walk(folder.children)].some((e) => e.node.type === 'item');

/**
 * フォルダの後始末（アイテムの統合のあと）
 *  - 相手の版で削除された・名前を変えた・移動したフォルダが、こちらで空になったら取り除く
 *  - 相手の版で作られた空のフォルダを足す（こちらで削除したものは足さない）
 */
function mergeFolders(out, A, B) {
  const aFolders = folderEntries(A), bFolders = folderEntries(B);
  const tombA = new Set((A.tombstones || []).map((t) => t.id));
  const tombB = new Set((B.tombstones || []).map((t) => t.id));
  const pathOf = (e) => [...e.path, e.node.name].join('\u0001');
  let removed = true;
  while (removed) { // 入れ子のフォルダが順に空になる場合があるので、変わらなくなるまで繰り返す
    removed = false;
    for (const e of [...walk(out.children)]) {
      const fo = e.node;
      if (fo.type !== 'folder' || hasItems(fo) || fo.children.length) continue;
      const inB = bFolders.get(fo.id), inA = aFolders.get(fo.id);
      const goneInB = tombB.has(fo.id) && !inB;
      const movedInB = inB && inA && pathOf(inB) !== pathOf(inA) && hasItems(inA.node);
      if (goneInB || movedInB) {
        const list = e.parent ? e.parent.children : out.children;
        list.splice(list.indexOf(fo), 1);
        removed = true;
        // 名前を変えた・移動した先のフォルダに、元の ID を引き継ぐ（次の統合でも同じフォルダと分かるように）
        if (movedInB) {
          const to = [...walk(out.children)].find((x) => x.node.type === 'folder' && pathOf(x) === pathOf(inB));
          if (to) to.node.id = fo.id;
        }
      }
    }
  }
  for (const [id, e] of bFolders) {
    if (aFolders.has(id) || tombA.has(id) || locate(out, id)) continue;
    ensureFolderPath(out, [...e.path, e.node.name], B);
  }
}

function locate(vault, id) {
  for (const e of walk(vault.children)) if (e.node.id === id) return e;
  return null;
}

function removeById(vault, id) {
  const e = locate(vault, id);
  if (!e) return null;
  const list = e.parent ? e.parent.children : vault.children;
  list.splice(list.indexOf(e.node), 1);
  return e.node;
}

/** 選択結果に従って統合した新しい vault を返す（A の構造をベースにする） */
export function mergeVaults(A, B, result) {
  const out = cloneVault(A);
  const now = Date.now();
  out.tombstones = [...(A.tombstones || [])];
  const tombIds = new Set(out.tombstones.map((t) => t.id));
  for (const t of B.tombstones || []) if (!tombIds.has(t.id)) { out.tombstones.push(t); tombIds.add(t.id); }

  for (const d of result.diffs) {
    if (d.kind === 'modified') {
      const loc = locate(out, d.a.node.id);
      if (!loc) continue;
      const item = loc.node;
      let changed = false;
      for (const f of d.fields) if (f.choice === 'b') { item[f.key] = d.b.node[f.key]; changed = true; }
      if (changed) item.modified = Math.max(d.a.node.modified || 0, d.b.node.modified || 0, now);
      // パスワード履歴は両方を合わせ、採用しなかった方のパスワードも履歴に残す
      item.passwordHistory = mergePasswordHistory(d.a.node.passwordHistory, d.b.node.passwordHistory);
      const lost = item.password === d.a.node.password ? d.b.node.password : d.a.node.password;
      if (lost && lost !== item.password && !item.passwordHistory.some((x) => x.password === lost)) pushPasswordHistory(item, lost, now);
      if (d.moved && d.choice === 'b') {
        removeById(out, item.id);
        ensureFolderPath(out, d.b.path, B).push(item);
      }
    } else if (d.kind === 'onlyA' && d.choice === 'b') {
      removeById(out, d.a.node.id);
      if (!tombIds.has(d.a.node.id)) { out.tombstones.push({ id: d.a.node.id, deletedAt: now }); tombIds.add(d.a.node.id); }
    } else if (d.kind === 'onlyB' && d.choice === 'b') {
      ensureFolderPath(out, d.b.path, B).push(structuredClone(d.b.node));
    }
  }
  mergeFolders(out, A, B);
  for (const p of result.profile) if (p.choice === 'b') out.profile[p.key] = p.b;
  out.tombstones = out.tombstones.slice(-2000);
  return out;
}

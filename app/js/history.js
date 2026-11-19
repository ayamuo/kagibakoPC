// デグレ（古い版での上書き・アップロード漏れ）の検出。
//
// この端末が最後に扱った版（＝端末内の記録）と、いま開いたファイルを比べて分類する。
//   same     : 同じ版
//   newer    : 開いたファイルの方が新しい（他の端末で更新された正常なケース）
//   older    : 開いたファイルの方が古い ← デグレ。端末内の新しい版で復旧できる
//   diverged : 別々の端末で別々に編集された（分岐）→ 比較・統合が必要
//   changed  : .idm ファイルで内容が変わっている（.idm には系譜情報がないため新旧は判定不能）
//   unknown  : この端末では初めて扱うファイル

export function classifyVault(header, known) {
  if (!known?.head) return 'unknown';
  const head = known.head;
  if (header.revId === head.revId) return 'same';
  if ((header.lineage || []).includes(head.revId)) return 'newer';
  // 「古い版」は、この端末の最新の版の【祖先】のときだけ。
  // この端末で前に見たことがあっても、祖先でなければ（別の枝の版なら）分岐として扱う。
  // （古い版として扱うと、統合のときに開いた版を「共通の元」とみなし、その版にしかない変更を消してしまう）
  if ((head.lineage || []).includes(header.revId)) return 'older';
  return 'diverged';
}

export function classifyLegacy(contentHash, known) {
  if (!known?.head) return 'unknown';
  if (contentHash === known.head.contentHash) return 'same';
  const older = known.snapshots.slice(1).some((s) => s.contentHash === contentHash);
  if (older) return 'older';
  return 'changed';
}

/** ヘッダ同士の新旧比較（2つの .kagi を比べるとき用）: 'same' | 'a' | 'b' | 'diverged' (新しい方) */
export function compareHeaders(a, b) {
  if (!a || !b) return 'unknown';
  if (a.vaultId !== b.vaultId) return 'different-vault';
  if (a.revId === b.revId) return 'same';
  if ((a.lineage || []).includes(b.revId)) return 'a';
  if ((b.lineage || []).includes(a.revId)) return 'b';
  return 'diverged';
}

/** header の版が、revId の版の変更を含んでいるか（同じ版か、その版の続きか） */
export function includesRev(header, revId) {
  if (!header || !revId) return false;
  return header.revId === revId || (header.lineage || []).includes(revId);
}

/**
 * 統合したあと、相手の版の系譜を自分の版に取り込む。
 * こうすると、統合した内容を保存した版は「両方の版の続き」になり、
 * 統合済みの版をあとで開いても「分岐」とは言われず、古い方を開けば「古い版」と分かる。
 */
export function absorbHeader(mine, other) {
  if (!mine || !other || mine.vaultId !== other.vaultId || includesRev(mine, other.revId)) return mine;
  const lineage = [...new Set([...(other.lineage || []), other.revId, ...(mine.lineage || [])])].filter((r) => r !== mine.revId);
  return { ...mine, revision: Math.max(mine.revision || 0, other.revision || 0), lineage };
}

export const STATUS_TEXT = {
  same: 'この端末で最後に扱った版と同じです。',
  newer: '他の端末で更新された新しい版です。',
  older: 'この端末が前に扱った版より【古い版】です（デグレの可能性）。',
  diverged: 'この端末の版とは別々に編集されています（分岐）。',
  changed: 'この端末で最後に扱った内容から変更されています。',
  unknown: 'この端末では初めて開くファイルです。',
};

/**
 * core/fleet/dirty-union-apply.ts — the mechanical half of the dirty-union
 * preview. Given one file's base, ours and theirs texts, compute the merged
 * text when every conflict hunk is union-safe (both sides add-only over the
 * same base region): non-overlapping changes apply cleanly, identical changes
 * emit once, and a union-safe conflict emits ours' region then theirs' added
 * lines — a deterministic "ours first" union order.
 *
 * Any hunk the shared classifier rejects — a deletion, an edit, a side that
 * dropped base lines — refuses the WHOLE file: union-apply never emits a
 * partial merge. Pure text in/out; the caller owns git and filesystem work.
 */
import { classifyUnionConflict, unionAddedLines, unionLines } from './dirty-union-preview.js';

export type UnionMerge =
  | { ok: true; text: string }
  | { ok: false; hunk: number; reason: string };

interface Anchor { a: number; b: number }

/** Longest strictly increasing subsequence of pair.b; pairs are pre-sorted by a. */
function longestIncreasing(pairs: Anchor[]): Anchor[] {
  const tails: number[] = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  pairs.forEach((pair, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]!.b < pair.b) lo = mid + 1; else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1;
    if (lo === tails.length) tails.push(i); else tails[lo] = i;
  });
  const out = new Array<Anchor>(tails.length);
  for (let i = tails.length - 1, t = tails[i] ?? -1; i >= 0; i--, t = prev[t]!) out[i] = pairs[t]!;
  return out;
}

const occurrences = (lines: string[], lo: number, hi: number): Map<string, number> => {
  const map = new Map<string, number>();
  for (let i = lo; i < hi; i++) map.set(lines[i]!, (map.get(lines[i]!) ?? 0) + 1);
  return map;
};

/** Patience-diff anchors: index pairs equal in both sequences, strictly increasing. */
function diffAnchors(a: string[], b: string[]): Anchor[] {
  const out: Anchor[] = [];
  const stack: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (stack.length > 0) {
    let [aLo, aHi, bLo, bHi] = stack.pop()!;
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) { out.push({ a: aLo, b: bLo }); aLo++; bLo++; }
    let tail = 0;
    while (aHi - tail > aLo && bHi - tail > bLo && a[aHi - tail - 1] === b[bHi - tail - 1]) tail++;
    aHi -= tail; bHi -= tail;
    if (tail > 0) stack.push([aHi, aHi + tail, bHi, bHi + tail]);
    if (aLo >= aHi || bLo >= bHi) continue;
    const countA = occurrences(a, aLo, aHi), countB = occurrences(b, bLo, bHi);
    const uniqueA = new Map<string, number>();
    for (let i = aLo; i < aHi; i++) {
      if (countA.get(a[i]!) === 1 && countB.has(a[i]!)) uniqueA.set(a[i]!, i);
    }
    const pairs: Anchor[] = [];
    for (let j = bLo; j < bHi; j++) {
      const ai = countB.get(b[j]!) === 1 ? uniqueA.get(b[j]!) : undefined;
      if (ai !== undefined) pairs.push({ a: ai, b: j });
    }
    pairs.sort((x, y) => x.a - y.a);
    const anchors = longestIncreasing(pairs);
    let pa = aLo, pb = bLo;
    for (const anchor of anchors) {
      if (anchor.a > pa || anchor.b > pb) stack.push([pa, anchor.a, pb, anchor.b]);
      out.push(anchor);
      pa = anchor.a + 1; pb = anchor.b + 1;
    }
    if (anchors.length > 0 && (pa < aHi || pb < bHi)) stack.push([pa, aHi, pb, bHi]);
  }
  return out.sort((x, y) => x.a - y.a || x.b - y.b);
}

interface ChangeRun { bs: number; be: number; ss: number; se: number }

/** The gaps between anchors: base range [bs,be) replaced by side range [ss,se). */
function changeRuns(baseLen: number, sideLen: number, anchors: Anchor[]): ChangeRun[] {
  const runs: ChangeRun[] = [];
  let bs = 0, ss = 0;
  for (const { a, b } of anchors) {
    if (a > bs || b > ss) runs.push({ bs, be: a, ss, se: b });
    bs = a + 1; ss = b + 1;
  }
  if (bs < baseLen || ss < sideLen) runs.push({ bs, be: baseLen, ss, se: sideLen });
  return runs;
}

interface Group {
  gs: number;
  ge: number;
  a: ChangeRun[];
  b: ChangeRun[];
  /** Insertion points already inside this group — a second insert there conflicts. */
  zeros: Set<number>;
}

/**
 * Merge both sides' base-coordinate change runs into disjoint regions.
 * Runs conflict when their base spans strictly overlap, or when two insertions
 * land on the same base offset (zero-length runs sort first at equal bs, so
 * same-offset inserts always meet an occupied group). An insertion exactly at
 * a participating side's region end is absorbed too: the side-text span that
 * emission reads already contains those lines, so a separate run would emit
 * them twice.
 */
function groupRuns(aRuns: ChangeRun[], bRuns: ChangeRun[]): Group[] {
  const all = [
    ...aRuns.map((run) => ({ side: 'a' as const, run })),
    ...bRuns.map((run) => ({ side: 'b' as const, run })),
  ].sort((x, y) =>
    x.run.bs - y.run.bs ||
    (x.run.bs === x.run.be ? 0 : 1) - (y.run.bs === y.run.be ? 0 : 1) ||
    x.run.be - y.run.be);
  const groups: Group[] = [];
  for (const { side, run } of all) {
    const cur = groups[groups.length - 1];
    const joins = cur !== undefined &&
      (run.bs < cur.ge ||
       (run.bs === run.be && (cur.zeros.has(run.bs) || (run.bs === cur.ge && cur[side].length > 0))));
    if (!joins) {
      groups.push({ gs: run.bs, ge: run.be, a: [], b: [], zeros: new Set(run.bs === run.be ? [run.bs] : []) });
    } else {
      cur!.ge = Math.max(cur!.ge, run.be);
      if (run.bs === run.be) cur!.zeros.add(run.bs);
    }
    groups[groups.length - 1]![side].push(run);
  }
  return groups;
}

/** For each base index, the side index it matches (or -1); boundaries map to the index after the last match. */
function matchBounds(match: Int32Array, baseLen: number, sideLen: number): { prev: Int32Array; next: Int32Array } {
  const prev = new Int32Array(baseLen + 1), next = new Int32Array(baseLen + 1);
  let last = -1;
  for (let i = 0; i <= baseLen; i++) {
    prev[i] = last + 1;
    if (i < baseLen && match[i] !== -1) last = match[i]!;
  }
  let found = sideLen;
  for (let i = baseLen; i >= 0; i--) {
    if (i < baseLen && match[i] !== -1) found = match[i]!;
    next[i] = found;
  }
  return { prev, next };
}

/** Merge `ours` and `theirs` over `base`; refuses the first hunk classifyUnionConflict rejects. */
export function resolveUnionMerge(base: string, ours: string, theirs: string): UnionMerge {
  const baseLines = unionLines(base), oursLines = unionLines(ours), theirsLines = unionLines(theirs);
  const aAnchors = diffAnchors(baseLines, oursLines);
  const bAnchors = diffAnchors(baseLines, theirsLines);
  const groups = groupRuns(changeRuns(baseLines.length, oursLines.length, aAnchors),
    changeRuns(baseLines.length, theirsLines.length, bAnchors));

  const aMatch = new Int32Array(baseLines.length).fill(-1), bMatch = new Int32Array(baseLines.length).fill(-1);
  for (const { a, b } of aAnchors) aMatch[a] = b;
  for (const { a, b } of bAnchors) bMatch[a] = b;
  const aBounds = matchBounds(aMatch, baseLines.length, oursLines.length);
  const bBounds = matchBounds(bMatch, baseLines.length, theirsLines.length);

  const parts: string[] = [];
  let cursor = 0, hunk = 0;
  for (const group of groups) {
    parts.push(baseLines.slice(cursor, group.gs).join(''));
    cursor = group.ge;
    if (group.b.length === 0) {
      parts.push(group.a.map((run) => oursLines.slice(run.ss, run.se).join('')).join(''));
      continue;
    }
    if (group.a.length === 0) {
      parts.push(group.b.map((run) => theirsLines.slice(run.ss, run.se).join('')).join(''));
      continue;
    }
    const oursText = oursLines.slice(aBounds.prev[group.gs]!, aBounds.next[group.ge]!).join('');
    const theirsText = theirsLines.slice(bBounds.prev[group.gs]!, bBounds.next[group.ge]!).join('');
    if (oursText === theirsText) { parts.push(oursText); continue; }
    hunk++;
    const baseText = baseLines.slice(group.gs, group.ge).join('');
    if (classifyUnionConflict(baseText, oursText, theirsText) !== 'union-safe') {
      const where = group.gs === group.ge ? `base offset ${group.gs}` : `base lines ${group.gs + 1}-${group.ge}`;
      return { ok: false, hunk, reason: `hunk ${hunk} (${where}) is not union-safe` };
    }
    // union-safe: both sides kept every base line of the hunk, so ours' region
    // already contains them once — append theirs' additions after it, dropping
    // lines both sides added identically (a duplicated export is not the union).
    const oursAdded = new Set(unionAddedLines(baseText, oursText)!);
    const theirsAdded = unionAddedLines(baseText, theirsText)!.filter(line => !oursAdded.has(line));
    parts.push(oursText + theirsAdded.join(''));
  }
  parts.push(baseLines.slice(cursor).join(''));
  return { ok: true, text: parts.join('') };
}

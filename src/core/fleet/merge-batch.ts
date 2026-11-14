/**
 * core/fleet/merge-batch.ts — pure merge-batch planner for the merge treadmill.
 *
 * The fleet's open bridge PRs conflict with each other faster than they merge:
 * every merge to main moves the base under the other ~180 open PRs, and any PR
 * sharing a file with a landed one owes a rebase before its own merge — the
 * treadmill. This module turns one open-PR snapshot into a
 * `fleet.merge-batch.v1` plan: which PRs can land in any order, which must
 * serialize, and the serial order that minimizes rebase churn.
 *
 * THE MODEL. Two open PRs conflict only when they touch the same file, so the
 * file→PR index gives an overlap graph; its connected components are the
 * merge batches. PRs in different batches touch disjoint file sets and merge
 * in any order — concurrently, even — because a merge in one batch can never
 * conflict with a PR in another. Inside a batch the order matters: when a PR
 * merges after an overlapping one it rebases once against the final main
 * (one rebase absorbs every earlier same-batch merge at once), so the number
 * of rebase events in a batch is the number of PRs ordered after at least
 * one neighbour — minimized by ordering a maximum independent set of the
 * overlap graph first (those members merge clean), then everyone else once.
 *
 * THE ORDERING. The clean wave is a greedy minimum-degree independent set
 * restricted to PRs that could actually merge clean (not draft, not already
 * conflicting or behind, with file evidence): min-degree picks leave the most
 * non-adjacent PRs clean, and ties prefer the largest file sets so the
 * cheapest-to-rebase PRs pay the rebase. A conflicted, behind or draft PR is
 * never credited to the clean wave — its rebase is already owed. Within each
 * wave the order is FIFO by creation time (merge-queue fairness), the rebase
 * wave additionally sorting least-ready last so an uncertain merge does not
 * sit ahead of a likely one.
 *
 * READ-ONLY and PURE: no I/O, no gh, no clock. The caller supplies a parsed
 * snapshot and `now`. Missing evidence stays unknown: a PR with no file data
 * is an independent batch flagged `evidence: 'no-file-data'`, never silently
 * proven-disjoint; rows the snapshot cannot describe count as `unreadable`,
 * not as absent.
 */

import { normalizeRepoPath } from '../authority/protected-paths.js';
import { scrubSecrets } from '../util/scrub.js';
import { parsePrHygieneOpenPr, type PrHygieneOpenPr } from './pr-hygiene.js';

export const MERGE_BATCH_SCHEMA = 'fleet.merge-batch.v1' as const;

/** Snapshot row cap shared by every planner on this input. */
export const MAX_PRS = 5_000;
/** File-list cap per PR; a list at the cap is treated as unproven (possibly truncated). */
export const MAX_FILES_PER_PR = 300;
const MAX_TEXT_CHARS = 200;
const MAX_SHARED_FILES = 12;
const MAX_HOT_FILES = 8;
/** A file three or more batch members touch is a collision magnet. */
const HOT_FILE_FAN_IN = 3;

/** One open PR the planner can reason about (bounded, normalized fields only). */
export interface MergeBatchPr {
  number: number;
  title: string;
  headRef: string;
  /** Head commit oid when the snapshot carries one (gh `headRefOid`); null otherwise. */
  headSha: string | null;
  isDraft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /** GitHub's mergeStateStatus, upper-cased (CLEAN, DIRTY, BEHIND, BLOCKED, …). */
  mergeStateStatus: string;
  createdAt: string | null;
  updatedAt: string | null;
  files: string[];
  /** False when the wire list was absent, capped or contained invalid paths. */
  filesComplete?: boolean;
  /** Explicit merged-replacement evidence carried by a PR hygiene report. */
  supersededBy?: number;
}

/** Snapshot shapes the parser accepts — all forms a `gh pr list` page already takes. */
export type MergeBatchInputKind = 'gh-pr-list' | 'merge-backlog' | 'pr-hygiene';

export interface MergeBatchPrsParseOk {
  ok: true;
  kind: MergeBatchInputKind;
  /** Canonical owner/name when the snapshot envelope carries one. */
  repo: string | null;
  /**
   * The envelope's own read state when it carries one — a merge-backlog read's
   * `source` ('gh-failed') or a pr-hygiene report's `reads.open` ('failed').
   * 'ok'/healthy otherwise; the planner never plans a failed read's empty
   * items as if they were a clean backlog.
   */
  upstream: string;
  prs: MergeBatchPr[];
  /** Rows the snapshot sent that did not describe a PR at all. */
  unreadable: number;
  /** Rows repeating an already-seen PR number (first sighting wins). */
  duplicates: number;
}
export type MergeBatchPrsParse = MergeBatchPrsParseOk | { ok: false; reason: string };

const bounded = (value: unknown, max = MAX_TEXT_CHARS): string =>
  typeof value === 'string' ? value.slice(0, max) : '';

const iso = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** File list from either wire form — `[{path}]` gh rows or `["a/b.ts"]` report items. */
function fileList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const file of value.slice(0, MAX_FILES_PER_PR)) {
    const raw = typeof file === 'string'
      ? file
      : isRecord(file) && typeof file['path'] === 'string' ? file['path'] : null;
    const path = raw === null ? null : normalizeRepoPath(raw);
    if (path !== null) out.push(path);
  }
  return out;
}

function filesComplete(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length < MAX_FILES_PER_PR
    && value.every(file => normalizeRepoPath(typeof file === 'string' ? file
      : isRecord(file) ? file['path'] as string : '') !== null);
}

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const repoName = (value: unknown): string | null =>
  typeof value === 'string' && REPO_RE.test(value) ? value : null;

const sha = (value: unknown): string | null =>
  typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value) ? value : null;

/**
 * One `gh pr list --json number,title,headRefName,isDraft,mergeable,
 * mergeStateStatus,createdAt,updatedAt,files` row (same contract
 * parsePrHygieneOpenPr validates), plus the optional `headRefOid`.
 */
function ghRowToPr(row: unknown): MergeBatchPr | null {
  const pr: PrHygieneOpenPr | null = parsePrHygieneOpenPr(row);
  if (pr === null) return null;
  const headSha = isRecord(row) ? sha(row['headRefOid'] ?? row['headSha']) : null;
  return { ...pr, headSha, filesComplete: isRecord(row) && filesComplete(row['files'])
    && fileList(row['files']).length === pr.files.length };
}

/**
 * One item of a `merge-backlog` read ({v:1, items:[…]}) or a
 * `fleet.pr-hygiene.v1` report ({schema, items:[…]}): `headRef` instead of
 * `headRefName`, `files` as plain strings, no `mergeable` — the conflicted
 * half comes back through mergeStateStatus DIRTY or the hygiene `conflicted`
 * flag.
 */
function itemToPr(row: unknown): MergeBatchPr | null {
  if (!isRecord(row)) return null;
  const number = row['number'];
  if (!Number.isSafeInteger(number) || (number as number) < 1) return null;
  const mergeStateStatus = bounded(row['mergeStateStatus'], 40).toUpperCase() || 'UNKNOWN';
  const flaggedConflicted = Array.isArray(row['flags']) && row['flags'].includes('conflicted');
  return {
    number: number as number,
    title: bounded(row['title']),
    headRef: bounded(row['headRef'] ?? row['headRefName']),
    headSha: sha(row['headSha'] ?? row['headRefOid']),
    isDraft: row['isDraft'] === true,
    mergeable: flaggedConflicted || mergeStateStatus === 'DIRTY' ? 'CONFLICTING' : 'UNKNOWN',
    mergeStateStatus,
    createdAt: iso(row['createdAt']),
    updatedAt: iso(row['updatedAt']),
    files: fileList(row['files']),
    filesComplete: filesComplete(row['files']),
    ...(Array.isArray(row['flags']) && row['flags'].includes('superseded')
      && isRecord(row['supersededBy']) && Number.isSafeInteger(row['supersededBy']['number'])
      && (row['supersededBy']['number'] as number) > 0 && row['supersededBy']['number'] !== number
      ? { supersededBy: row['supersededBy']['number'] as number } : {}),
  };
}

/**
 * Parse one snapshot into planner rows. Accepts the three wire shapes a
 * `gh pr list` page arrives as: the raw JSON array, a merge-backlog read
 * ({v:1, items}) and a fleet.pr-hygiene.v1 report ({schema, items}) — the
 * same rows `phm fleet backlog`/`pr-hygiene` already produce, so a scheduler
 * can snapshot whichever read it already runs. Duplicate PR numbers collapse
 * to the first sighting; unrecognized shapes fail honestly.
 */
export function parseMergeBatchPrs(raw: unknown): MergeBatchPrsParse {
  let rows: unknown[];
  let kind: MergeBatchInputKind;
  let repo: string | null = null;
  let upstream = 'ok';
  let rowToPr: (row: unknown) => MergeBatchPr | null;
  if (Array.isArray(raw)) {
    rows = raw;
    kind = 'gh-pr-list';
    rowToPr = ghRowToPr;
  } else if (isRecord(raw) && Array.isArray(raw['items'])) {
    rows = raw['items'] as unknown[];
    kind = raw['schema'] === 'fleet.pr-hygiene.v1' ? 'pr-hygiene' : 'merge-backlog';
    repo = repoName(raw['repo']);
    if (kind === 'pr-hygiene' && isRecord(raw['reads']) && typeof raw['reads']['open'] === 'string') {
      upstream = raw['reads']['open'];
    } else if (typeof raw['source'] === 'string') {
      upstream = raw['source'];
    }
    rowToPr = itemToPr;
  } else {
    return { ok: false, reason: 'input is neither a gh pr list array nor a {items:[…]} report' };
  }

  const seen = new Set<number>();
  const prs: MergeBatchPr[] = [];
  let unreadable = 0;
  let duplicates = 0;
  for (const row of rows.slice(0, MAX_PRS)) {
    const pr = rowToPr(row);
    if (pr === null) { unreadable += 1; continue; }
    if (seen.has(pr.number)) { duplicates += 1; continue; }
    seen.add(pr.number);
    prs.push(pr);
  }
  return { ok: true, kind, repo, upstream, prs, unreadable, duplicates };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type MergeBatchWave = 'clean' | 'rebase';
export type MergeBatchRebase = 'none' | 'expected' | 'already-required';
export type MergeBatchRiskLevel = 'low' | 'medium' | 'high';

export interface MergeBatchPlanPr {
  number: number;
  /** Bounded and secret-scrubbed — a title is untrusted text. */
  title: string;
  headRef: string;
  mergeStateStatus: string;
  isDraft: boolean;
  /** GitHub already reports a merge conflict (mergeable CONFLICTING or DIRTY). */
  conflicted: boolean;
  fileCount: number;
  /** Other PRs in this batch sharing at least one file, ascending. */
  overlaps: number[];
  /** Which wave the proposed order places the PR in (null in an independent batch). */
  wave: MergeBatchWave | null;
  /**
   * `none` — proposed to merge clean; `expected` — must rebase onto at least
   * one earlier same-batch merge; `already-required` — owes a sync whatever
   * the order (conflicted or BEHIND today).
   */
  rebase: MergeBatchRebase;
}

export interface MergeBatchRisk {
  /** Deterministic 0..1 score; see planMergeBatches for the formula. */
  score: number;
  level: MergeBatchRiskLevel;
  /** Machine-readable tokens explaining the score (e.g. 'rebases:3'). */
  reasons: string[];
}

export interface MergeBatch {
  /** B1..Bn assigned after the plan's batch ordering. */
  id: string;
  /** `serial` batches must merge in `order`; `independent` batches are single PRs. */
  kind: 'independent' | 'serial';
  prs: MergeBatchPlanPr[];
  /** Proposed merge order for this batch (PR numbers). */
  order: number[];
  /** Conflicting pairs inside the batch. */
  overlapEdges: number;
  /** Files two or more members touch (bounded list, most-shared first). */
  sharedFiles: string[];
  /** Shared files three or more members touch — tomorrow's conflicts. */
  hotFiles: string[];
  /** Members whose proposed merge expects a rebase (the rebase wave). */
  rebasesExpected: number;
  /** `no-file-data` when no member has file evidence — unmeasured, not disjoint. */
  evidence: 'ok' | 'no-file-data';
  conflictRisk: MergeBatchRisk;
}

export interface MergeBatchPlan {
  schema: typeof MERGE_BATCH_SCHEMA;
  v: 1;
  repo: string | null;
  generatedAt: string;
  counts: {
    /** Parsed, de-duplicated open PRs. */
    open: number;
    unreadable: number;
    duplicates: number;
    /** PRs carrying at least one normalized file path. */
    withFileData: number;
    batches: number;
    independent: number;
    serial: number;
    overlapEdges: number;
    /** Total PRs the proposed order expects to rebase once. */
    expectedRebases: number;
  };
  /** Safest batch first; disjoint batches may merge in any order or concurrently. */
  batches: MergeBatch[];
  /** Flattened proposed merge sequence (all batches serialized). */
  order: number[];
}

export interface MergeBatchPlanInput {
  prs: readonly MergeBatchPr[];
  repo?: string | null;
  /** Counts carried over from the parse so the plan reports honestly. */
  unreadable?: number;
  duplicates?: number;
  now?: Date;
}

const conflicted = (pr: MergeBatchPr): boolean =>
  pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY';

/** Could this PR merge without syncing against main first? */
const mergeClean = (pr: MergeBatchPr): boolean =>
  pr.files.length > 0 && !pr.isDraft && !conflicted(pr)
  && pr.mergeStateStatus !== 'BEHIND' && pr.mergeStateStatus !== 'BLOCKED';

/**
 * Readiness rank inside the rebase wave: a mergeable PR first, unknown or
 * behind next, an already-conflicting one after that, a draft last — an
 * uncertain merge never sits ahead of a likely one.
 */
const readinessRank = (pr: MergeBatchPr): number =>
  pr.isDraft ? 3
    : conflicted(pr) ? 2
      : pr.mergeable === 'MERGEABLE' && pr.mergeStateStatus === 'CLEAN' ? 0 : 1;

/** FIFO key: creation time, then update time, then number (merge-queue fairness). */
function fifoMs(pr: MergeBatchPr): [number, number, number] {
  const created = pr.createdAt === null ? NaN : Date.parse(pr.createdAt);
  const updated = pr.updatedAt === null ? NaN : Date.parse(pr.updatedAt);
  return [
    Number.isFinite(created) ? created : Number.MAX_SAFE_INTEGER,
    Number.isFinite(updated) ? updated : Number.MAX_SAFE_INTEGER,
    pr.number,
  ];
}

const fifoCompare = (a: MergeBatchPr, b: MergeBatchPr): number => {
  const [ac, au, an] = fifoMs(a);
  const [bc, bu, bn] = fifoMs(b);
  return ac - bc || au - bu || an - bn;
};

/**
 * Greedy minimum-degree independent set over the PRs that could merge clean.
 * Each pick takes the candidate with the fewest remaining clean neighbours —
 * the pick least likely to exclude others — preferring the largest file set
 * on ties (a wide-diff PR is the expensive rebase, so it keeps its clean
 * slot), then the lowest number for determinism.
 */
function cleanWave(members: readonly MergeBatchPr[], adjacency: ReadonlyMap<number, ReadonlySet<number>>): Set<number> {
  const byNumber = new Map(members.map(pr => [pr.number, pr]));
  const candidates = new Set(members.filter(mergeClean).map(pr => pr.number));
  const picked = new Set<number>();
  while (candidates.size > 0) {
    let pick = -1;
    let pickDegree = Number.MAX_SAFE_INTEGER;
    let pickFiles = -1;
    for (const number of candidates) {
      let degree = 0;
      for (const other of adjacency.get(number) ?? []) if (candidates.has(other)) degree += 1;
      const files = byNumber.get(number)!.files.length;
      if (degree < pickDegree
        || (degree === pickDegree && files > pickFiles)
        || (degree === pickDegree && files === pickFiles && number < pick)) {
        pick = number;
        pickDegree = degree;
        pickFiles = files;
      }
    }
    picked.add(pick);
    candidates.delete(pick);
    for (const other of adjacency.get(pick) ?? []) candidates.delete(other);
  }
  return picked;
}

function riskFor(members: number, edges: number, rebases: number, conflictedCount: number, topFanIn: number): MergeBatchRisk {
  const reasons: string[] = [];
  if (members < 2) return { score: 0, level: 'low', reasons: ['no-shared-files'] };
  const rebaseRatio = rebases / members;
  const conflictedRatio = conflictedCount / members;
  const density = edges / (members * (members - 1) / 2);
  const hotness = Math.min(1, topFanIn / HOT_FILE_FAN_IN);
  const score = Math.min(1, 0.45 * rebaseRatio + 0.25 * conflictedRatio + 0.15 * density + 0.15 * hotness);
  if (rebases > 0) reasons.push(`rebases:${rebases}`);
  if (conflictedCount > 0) reasons.push(`conflicted:${conflictedCount}`);
  if (density >= 0.5) reasons.push(`dense-overlap:${edges}-edges`);
  if (topFanIn >= HOT_FILE_FAN_IN) reasons.push(`hot-file-fan-in:${topFanIn}`);
  if (reasons.length === 0) reasons.push('serializes-overlapping-prs');
  const rounded = Math.round(score * 1000) / 1000;
  return { score: rounded, level: rounded >= 0.6 ? 'high' : rounded >= 0.3 ? 'medium' : 'low', reasons };
}

/**
 * The planner. `prs` comes from parseMergeBatchPrs (or any caller-built list);
 * the result is fully deterministic for a fixed input. `now` only stamps
 * `generatedAt`.
 */
export function planMergeBatches(input: MergeBatchPlanInput): MergeBatchPlan {
  const now = input.now ?? new Date();
  const prs = input.prs.slice(0, MAX_PRS);

  // File → PRs index; duplicate paths inside one PR collapse first.
  const prsByFile = new Map<string, Set<number>>();
  for (const pr of prs) {
    for (const file of new Set(pr.files)) {
      const set = prsByFile.get(file) ?? new Set<number>();
      set.add(pr.number);
      prsByFile.set(file, set);
    }
  }

  // Overlap graph: an edge per pair sharing at least one file.
  const adjacency = new Map<number, Set<number>>();
  const link = (a: number, b: number): void => {
    (adjacency.get(a) ?? adjacency.set(a, new Set<number>()).get(a)!).add(b);
    (adjacency.get(b) ?? adjacency.set(b, new Set<number>()).get(b)!).add(a);
  };
  for (const numbers of prsByFile.values()) {
    if (numbers.size < 2) continue;
    const list = [...numbers];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) link(list[i]!, list[j]!);
    }
  }

  // Connected components via union-find over edges — each component is a
  // batch whose members must serialize relative to each other.
  const parent = new Map<number, number>(prs.map(pr => [pr.number, pr.number]));
  const find = (n: number): number => {
    let root = n;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let node = n;
    while (parent.get(node) !== root) { const next = parent.get(node)!; parent.set(node, root); node = next; }
    return root;
  };
  for (const [a, neighbours] of adjacency) {
    for (const b of neighbours) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const components = new Map<number, MergeBatchPr[]>();
  for (const pr of prs) {
    const root = find(pr.number);
    const list = components.get(root) ?? [];
    list.push(pr);
    components.set(root, list);
  }

  let overlapEdges = 0;
  let expectedRebases = 0;
  const batches: MergeBatch[] = [];
  for (const members of components.values()) {
    members.sort((a, b) => a.number - b.number);
    if (members.length === 1) {
      const pr = members[0]!;
      const already = conflicted(pr) || pr.mergeStateStatus === 'BEHIND';
      batches.push({
        id: '', kind: 'independent', order: [pr.number],
        prs: [{
          number: pr.number, title: scrubSecrets(pr.title.slice(0, MAX_TEXT_CHARS)),
          headRef: pr.headRef, mergeStateStatus: pr.mergeStateStatus, isDraft: pr.isDraft,
          conflicted: conflicted(pr), fileCount: pr.files.length, overlaps: [],
          wave: null, rebase: already ? 'already-required' : 'none',
        }],
        overlapEdges: 0, sharedFiles: [], hotFiles: [], rebasesExpected: 0,
        evidence: pr.files.length > 0 ? 'ok' : 'no-file-data',
        conflictRisk: { score: 0, level: 'low', reasons: [pr.files.length > 0 ? 'disjoint-file-sets' : 'no-file-data'] },
      });
      continue;
    }

    // Serial batch: every member reached the component through a shared file,
    // so file evidence is complete here by construction.
    const edges = new Set<string>();
    const fileFanIn = new Map<string, number>();
    for (const pr of members) {
      for (const file of new Set(pr.files)) fileFanIn.set(file, (fileFanIn.get(file) ?? 0) + 1);
      for (const other of adjacency.get(pr.number) ?? []) {
        if (other > pr.number) edges.add(`${pr.number}:${other}`);
      }
    }
    const shared = [...fileFanIn.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const topFanIn = shared.length > 0 ? shared[0]![1] : 0;

    // Independent clean wave first (merges without rebasing), then the
    // rebase wave least-ready last.
    const clean = cleanWave(members, adjacency);
    const rebaseWave = members.filter(pr => !clean.has(pr.number));
    const waveSort = (a: MergeBatchPr, b: MergeBatchPr): number =>
      readinessRank(a) - readinessRank(b) || fifoCompare(a, b);
    const ordered = [
      ...members.filter(pr => clean.has(pr.number)).sort(fifoCompare),
      ...rebaseWave.sort(waveSort),
    ];
    const conflictedCount = members.filter(conflicted).length;
    const rebases = rebaseWave.length;
    const risk = riskFor(members.length, edges.size, rebases, conflictedCount, topFanIn);
    overlapEdges += edges.size;
    expectedRebases += rebases;
    batches.push({
      id: '', kind: 'serial', order: ordered.map(pr => pr.number),
      prs: ordered.map(pr => {
        const already = conflicted(pr) || pr.mergeStateStatus === 'BEHIND';
        return {
          number: pr.number, title: scrubSecrets(pr.title.slice(0, MAX_TEXT_CHARS)),
          headRef: pr.headRef, mergeStateStatus: pr.mergeStateStatus, isDraft: pr.isDraft,
          conflicted: conflicted(pr), fileCount: pr.files.length,
          overlaps: [...(adjacency.get(pr.number) ?? [])].sort((a, b) => a - b),
          wave: clean.has(pr.number) ? 'clean' as const : 'rebase' as const,
          rebase: already ? 'already-required' as const : clean.has(pr.number) ? 'none' as const : 'expected' as const,
        };
      }),
      overlapEdges: edges.size,
      sharedFiles: shared.slice(0, MAX_SHARED_FILES).map(([path]) => path),
      hotFiles: shared.filter(([, count]) => count >= HOT_FILE_FAN_IN).slice(0, MAX_HOT_FILES).map(([path]) => path),
      rebasesExpected: rebases,
      evidence: 'ok',
      conflictRisk: risk,
    });
  }

  // Safest batch first: rising risk, then rising size, then the lowest member
  // number — the flat `order` serializes the whole plan when a consumer wants
  // one sequence.
  batches.sort((a, b) =>
    a.conflictRisk.score - b.conflictRisk.score
    || a.prs.length - b.prs.length
    || a.order[0]! - b.order[0]!);
  batches.forEach((batch, i) => { batch.id = `B${i + 1}`; });

  return {
    schema: MERGE_BATCH_SCHEMA,
    v: 1,
    repo: input.repo ?? null,
    generatedAt: now.toISOString(),
    counts: {
      open: prs.length,
      unreadable: input.unreadable ?? 0,
      duplicates: input.duplicates ?? 0,
      withFileData: prs.filter(pr => pr.files.length > 0).length,
      batches: batches.length,
      independent: batches.filter(batch => batch.kind === 'independent').length,
      serial: batches.filter(batch => batch.kind === 'serial').length,
      overlapEdges,
      expectedRebases,
    },
    batches,
    order: batches.flatMap(batch => batch.order),
  };
}

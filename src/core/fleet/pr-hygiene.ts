/**
 * core/fleet/pr-hygiene.ts — pure open-PR hygiene audit for the merge cockpit.
 *
 * One `gh pr list` page plus the fleet's superseded evidence produces a
 * `fleet.pr-hygiene.v1` triage report: every open PR flagged stale (idle past
 * a threshold), conflicted (GitHub reports a merge conflict), overlapping
 * (shares files with other open PRs — tomorrow's conflict), superseded (a
 * merged fleet job's prompt named it), behind, or still a draft, then sorted
 * into one advisory triage lane:
 *
 *   close-candidate   superseded by a merged PR — a host-side closer may reap it
 *   refix             conflicting — the produced change must be redone
 *   review            stale or file-overlapping — a human or judge should look
 *   ok                no hygiene signal
 *
 * Advisory only: this report grants no close, merge or dispatch authority and
 * the audit itself only reads GitHub. Consumers re-verify before acting.
 * Missing evidence stays unknown: an unreadable timestamp is no flag, a failed
 * merged-PR or prompts read skips only the superseded leg (`reads` records it)
 * — never a clean-looking report.
 */
import { normalizeRepoPath } from '../authority/protected-paths.js';
import { scrubSecrets } from '../util/scrub.js';
import { findSupersededPrs, type MergedFleetPr, type OpenFleetPr } from './superseded-prs.js';

export const PR_HYGIENE_SCHEMA = 'fleet.pr-hygiene.v1' as const;

export type PrHygieneFlag = 'superseded' | 'conflicted' | 'stale' | 'overlap' | 'behind' | 'draft';
export type PrHygieneTriage = 'close-candidate' | 'refix' | 'review' | 'ok';

const DAY_MS = 86_400_000;
const MAX_TEXT_CHARS = 200;
const MAX_URL_CHARS = 300;
const MAX_FILES_PER_PR = 300;
const MAX_OVERLAP_PRS = 5;

/** A validated open-PR row from `gh pr list --json` (bounded fields only). */
export interface PrHygieneOpenPr {
  number: number;
  title: string;
  url: string | null;
  headRef: string;
  isDraft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  createdAt: string | null;
  updatedAt: string | null;
  files: string[];
}

export interface PrHygieneSupersededBy {
  number: number;
  title: string;
  jobId: string;
}

export interface PrHygieneItem {
  number: number;
  /** Bounded and secret-scrubbed — a title is untrusted text. */
  title: string;
  url: string | null;
  headRef: string;
  isDraft: boolean;
  mergeStateStatus: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** Whole days since createdAt; null when GitHub did not send a parseable one. */
  ageDays: number | null;
  /** Whole days since updatedAt (falling back to createdAt); null when both are unparseable. */
  idleDays: number | null;
  flags: PrHygieneFlag[];
  triage: PrHygieneTriage;
  /** One machine token: `superseded-by-merged-pr`, `merge-conflict`, `stale-no-update`, `file-overlap` or `ok`. */
  reason: string;
  supersededBy?: PrHygieneSupersededBy;
  /** Present when flag `overlap`: up to 5 other open PRs sharing files, plus the distinct total. */
  overlap?: { count: number; prs: number[] };
}

/** Evidence quality per leg — a 'failed'/'unavailable'/'skipped' leg means its flags were never evaluated. */
export interface PrHygieneReads {
  open: 'ok' | 'failed';
  merged: 'ok' | 'failed' | 'skipped';
  prompts: 'ok' | 'unavailable' | 'skipped';
}

export interface PrHygieneReport {
  schema: typeof PR_HYGIENE_SCHEMA;
  v: 1;
  /** Canonical owner/name the audit describes. */
  repo: string;
  generatedAt: string;
  /** Idle-day threshold the `stale` flag was computed at. */
  staleDays: number;
  /** Page size the open read used; `complete` is false when the page filled. */
  limit: number;
  complete: boolean;
  reads: PrHygieneReads;
  counts: {
    open: number;
    /** Raw rows gh sent that did not yield an audited PR (unreadable or a duplicate) — never silently dropped. */
    unreadable: number;
    /** Items whose triage is not 'ok'. */
    flagged: number;
    triage: Record<PrHygieneTriage, number>;
    flags: Record<PrHygieneFlag, number>;
  };
  /** Every audited PR, flagged lanes first, then oldest-idle first. */
  items: PrHygieneItem[];
  /** Fixed machine token when the open read failed (reads.open: 'failed'); never gh's stderr. */
  error?: string;
}

/** The report a failed open read still emits — empty items, `open: 'failed'`, never a fake-clean backlog. */
export function failedPrHygieneReport(input: {
  repo: string; staleDays: number; limit: number; reason: string; now?: Date;
}): PrHygieneReport {
  const now = input.now ?? new Date();
  return {
    schema: PR_HYGIENE_SCHEMA, v: 1, repo: input.repo, generatedAt: now.toISOString(),
    staleDays: input.staleDays, limit: input.limit, complete: false,
    reads: { open: 'failed', merged: 'skipped', prompts: 'unavailable' },
    counts: {
      open: 0, unreadable: 0, flagged: 0,
      triage: { 'close-candidate': 0, 'refix': 0, 'review': 0, 'ok': 0 },
      flags: { superseded: 0, conflicted: 0, stale: 0, overlap: 0, behind: 0, draft: 0 },
    },
    items: [],
    error: input.reason.slice(0, 120),
  };
}

export interface PrHygieneAuditInput {
  repo: string;
  open: readonly PrHygieneOpenPr[];
  /** Merged-PR page for the superseded leg; 'failed' = the read failed, absent = not attempted. */
  merged?: readonly MergedFleetPr[] | 'failed';
  /** Job prompts for the superseded leg; 'unavailable'/absent = that leg cannot run. */
  prompts?: ReadonlyMap<string, string> | 'unavailable';
  staleDays: number;
  limit: number;
  /** Raw row count the open page carried before parsing; defaults to `open.length`. */
  observedOpen?: number;
  now?: Date;
}

const bounded = (value: unknown, max = MAX_TEXT_CHARS): string =>
  typeof value === 'string' ? value.slice(0, max) : '';

const iso = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;

/** Validate one `gh pr list` row; null when gh could not describe the PR at all. */
export function parsePrHygieneOpenPr(raw: unknown): PrHygieneOpenPr | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const number = row['number'];
  if (!Number.isSafeInteger(number) || (number as number) < 1) return null;
  const mergeable = row['mergeable'];
  const url = row['url'];
  const files = Array.isArray(row['files']) ? row['files'].slice(0, MAX_FILES_PER_PR) : [];
  return {
    number: number as number,
    title: bounded(row['title']),
    url: typeof url === 'string' && url.length <= MAX_URL_CHARS && /^https:\/\/\S+$/.test(url) ? url : null,
    headRef: bounded(row['headRefName']),
    isDraft: row['isDraft'] === true,
    mergeable: mergeable === 'MERGEABLE' || mergeable === 'CONFLICTING' ? mergeable : 'UNKNOWN',
    mergeStateStatus: bounded(row['mergeStateStatus'], 40).toUpperCase() || 'UNKNOWN',
    createdAt: iso(row['createdAt']),
    updatedAt: iso(row['updatedAt']),
    files: files.flatMap(file => {
      if (file === null || typeof file !== 'object' || !('path' in file)) return [];
      const path = normalizeRepoPath(file.path);
      return path === null ? [] : [path];
    }),
  };
}

/** Days between two timestamps, floored at 0 (clock skew never makes a PR look idle). */
function daysBetween(from: string, toMs: number): number | null {
  const ms = Date.parse(from);
  return Number.isFinite(ms) ? Math.max(0, Math.floor((toMs - ms) / DAY_MS)) : null;
}

const TRIAGE_RANK: Readonly<Record<PrHygieneTriage, number>> = {
  'close-candidate': 0, 'refix': 1, 'review': 2, 'ok': 3,
};

/**
 * The audit itself. Precedence is load-bearing: a superseded PR is a close
 * candidate even when it also conflicts (refixing it is waste), a conflict
 * outranks staleness (refix is the cheaper fix), and overlap only reviews —
 * sharing files is a warning, not a conflict yet.
 */
export function auditPrHygiene(input: PrHygieneAuditInput): PrHygieneReport {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const merged = Array.isArray(input.merged) ? input.merged : null;
  const prompts = input.prompts instanceof Map ? input.prompts : null;
  const reads: PrHygieneReads = {
    open: 'ok',
    merged: merged ? 'ok' : input.merged === 'failed' ? 'failed' : 'skipped',
    prompts: prompts ? 'ok' : 'unavailable',
  };

  // One observation per PR number; a duplicated row describes the same PR,
  // and the first sighting wins (a later duplicate adds nothing new).
  const seenNumbers = new Set<number>();
  const open = input.open.filter(pr => !seenNumbers.has(pr.number) && seenNumbers.add(pr.number));
  const observedOpen = input.observedOpen ?? open.length;
  const superseded = new Map<number, PrHygieneSupersededBy>();
  if (merged && prompts) {
    const openForMatch: OpenFleetPr[] = open.map(pr => ({ number: pr.number, title: pr.title, mergeStateStatus: pr.mergeStateStatus }));
    for (const row of findSupersededPrs(openForMatch, merged, prompts)) {
      superseded.set(row.pr.number, {
        number: row.supersededBy.number,
        title: scrubSecrets(row.supersededBy.title.slice(0, MAX_TEXT_CHARS)),
        jobId: row.evidence.jobId,
      });
    }
  }

  // File overlap: a file touched by two open PRs is a conflict waiting to land.
  const prsByFile = new Map<string, Set<number>>();
  for (const pr of open) {
    for (const file of new Set(pr.files)) {
      const set = prsByFile.get(file) ?? new Set<number>();
      set.add(pr.number);
      prsByFile.set(file, set);
    }
  }
  const overlapping = new Map<number, Set<number>>();
  for (const prs of prsByFile.values()) {
    if (prs.size < 2) continue;
    for (const number of prs) {
      const set = overlapping.get(number) ?? new Set<number>();
      for (const other of prs) if (other !== number) set.add(other);
      overlapping.set(number, set);
    }
  }

  const items: PrHygieneItem[] = open.map(pr => {
    const ageDays = pr.createdAt === null ? null : daysBetween(pr.createdAt, nowMs);
    const lastActivity = pr.updatedAt ?? pr.createdAt;
    const idleDays = lastActivity === null ? null : daysBetween(lastActivity, nowMs);

    const flags: PrHygieneFlag[] = [];
    const by = superseded.get(pr.number);
    if (by) flags.push('superseded');
    if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') flags.push('conflicted');
    if (idleDays !== null && idleDays >= input.staleDays) flags.push('stale');
    const overlapPrs = overlapping.get(pr.number);
    if (overlapPrs) flags.push('overlap');
    if (pr.mergeStateStatus === 'BEHIND') flags.push('behind');
    if (pr.isDraft) flags.push('draft');

    const { triage, reason } = by
      ? { triage: 'close-candidate' as const, reason: 'superseded-by-merged-pr' }
      : flags.includes('conflicted')
        ? { triage: 'refix' as const, reason: 'merge-conflict' }
        : flags.includes('stale')
          ? { triage: 'review' as const, reason: 'stale-no-update' }
          : flags.includes('overlap')
            ? { triage: 'review' as const, reason: 'file-overlap' }
            : { triage: 'ok' as const, reason: 'ok' };

    return {
      number: pr.number,
      title: scrubSecrets(pr.title),
      url: pr.url,
      headRef: pr.headRef,
      isDraft: pr.isDraft,
      mergeStateStatus: pr.mergeStateStatus,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      ageDays,
      idleDays,
      flags,
      triage,
      reason,
      ...(by ? { supersededBy: by } : {}),
      ...(overlapPrs ? { overlap: { count: overlapPrs.size, prs: [...overlapPrs].sort((a, b) => a - b).slice(0, MAX_OVERLAP_PRS) } } : {}),
    };
  });

  items.sort((a, b) =>
    TRIAGE_RANK[a.triage] - TRIAGE_RANK[b.triage] ||
    (b.idleDays ?? -1) - (a.idleDays ?? -1) ||
    a.number - b.number);

  const triage: Record<PrHygieneTriage, number> = { 'close-candidate': 0, 'refix': 0, 'review': 0, 'ok': 0 };
  const flags: Record<PrHygieneFlag, number> = { superseded: 0, conflicted: 0, stale: 0, overlap: 0, behind: 0, draft: 0 };
  for (const item of items) {
    triage[item.triage] += 1;
    for (const flag of item.flags) flags[flag] += 1;
  }
  return {
    schema: PR_HYGIENE_SCHEMA,
    v: 1,
    repo: input.repo,
    generatedAt: now.toISOString(),
    staleDays: input.staleDays,
    limit: input.limit,
    complete: observedOpen < input.limit,
    reads,
    counts: {
      open: items.length,
      unreadable: Math.max(0, observedOpen - items.length),
      flagged: items.length - triage.ok,
      triage,
      flags,
    },
    items,
  };
}

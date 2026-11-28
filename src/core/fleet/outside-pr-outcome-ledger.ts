/**
 * outside-pr-outcome-ledger.ts — the journal contract for outside-PR
 * outcome evidence.
 *
 * The fleet's own ledgers (jobs.jsonl, merge-events.jsonl,
 * work-market.jsonl) only see `codex-bridge/*` work, so a merged outside
 * PR leaves no outcome evidence anywhere the self-improvement loop
 * reads. src/core/fleet/outside-outcome-sync.ts journals what
 * src/core/fleet/outside-pr-outcomes.ts measures — merged non-fleet PRs
 * per fleet repo joined to the standing revert set — as append-only
 * rows in <runs>/metrics/outside-pr-outcomes.jsonl, and
 * src/core/improve/outside-pr-backlog.ts folds the same file back into
 * backlog items. This module is the leaf both sides share: schema
 * names, row shapes, the journal path and the tolerant parser, with no
 * gh, secrets or ledger-write imports, so the read side stays a light
 * closure.
 *
 * Two row kinds, both `v: 1`:
 *  - `fleet.outside-pr-outcome.v1` — one row per (repo, PR) per recorded
 *    verdict. The sync appends a row when a PR is first seen or its
 *    revert verdict changes; later lines win, so the file's last row
 *    for a key is the current verdict.
 *  - `fleet.outside-pr-scan.v1` — one coverage receipt per sync pass:
 *    the gh source state, the outcome window and per-repo read health,
 *    so the fold can say when evidence may be partial instead of
 *    implying silence means health.
 *
 * Honesty rules carried in the rows themselves: `agent` is the product a
 * recorded branch/login convention attributes the change to (see
 * outside-pr-outcomes.ts outsidePrAgentAttribution) — a well-formed
 * lowercase slug or null, never a model/runtime claim — and `model` is
 * always null because gh records none. `reverted: 'unknown'` marks a
 * verdict the revert ledger could not support, never a guess at 'no'.
 * `createdAt` is the PR's open timestamp (null when gh recorded none)
 * and `reviews` is gh's review evidence — a bounded `latest` reviewer
 * count plus the closed-vocabulary `decision`, or null when the row
 * carries none (pre-fields rows read as null until the sync's next pass
 * rewrites them; the dedup treats a changed evidence tuple as a new
 * verdict). `ci` is the check-rollup verdict the outcomes read's bounded
 * per-PR `gh pr view` pass recorded — the same closed vocabulary
 * cloud/tracker.ts reports — or null when the row carries none
 * (pre-fields rows, a failed or capped read); 'none' inside that
 * vocabulary is a real empty-rollup signal, never missing evidence.
 * `diff` is gh's recorded merge size — the `additions`/`deletions`/
 * `changedFiles` triple the same merged-list read returns, frozen at
 * merge — or null when the row carries none (pre-fields rows) or the
 * record is malformed; a partial triple never counts as real zeros.
 */
import { join } from 'node:path';

import type { OutsidePrCiVerdict, OutsidePrDiffEvidence, OutsidePrReviewDecision, OutsidePrReviewEvidence, OutsidePrRevertVerdict } from './outside-pr-outcomes.js';

export const OUTSIDE_PR_OUTCOME_SCHEMA = 'fleet.outside-pr-outcome.v1';
export const OUTSIDE_PR_SCAN_SCHEMA = 'fleet.outside-pr-scan.v1';
export const OUTSIDE_PR_OUTCOME_JOURNAL_NAME = 'outside-pr-outcomes.jsonl';

/** <runs>/metrics/outside-pr-outcomes.jsonl — the sync's append target and the fold's read source. */
export function outsidePrOutcomeJournalPath(runsDir: string): string {
  return join(runsDir, 'metrics', OUTSIDE_PR_OUTCOME_JOURNAL_NAME);
}

/**
 * Dedup key for one outside PR: lowercased `owner/name#N`, the same
 * shape improve/lesson-trial.ts's prKey produces for the revert join.
 * Inlined here so this leaf pulls in no improve modules.
 */
export const outsidePrJournalKey = (repo: string, number: number): string =>
  `${repo.toLowerCase()}#${number}`;

export interface OutsidePrOutcomeJournalRow {
  v: 1;
  kind: typeof OUTSIDE_PR_OUTCOME_SCHEMA;
  /** ISO time the sync recorded this verdict. */
  at: string;
  repo: string;
  number: number;
  title: string;
  /** gh author login, or null for a ghost author. */
  author: string | null;
  /**
   * Agent product the recorded branch/login convention attributes the
   * change to — a lowercase slug or null (no known convention matched).
   * Convention attribution only, never a model/runtime claim.
   */
  agent: string | null;
  /** gh never records which model produced the change — always null. */
  model: null;
  mergedAt: string;
  /** When the PR opened, or null when gh recorded none — open→merge latency needs both stamps. */
  createdAt: string | null;
  /** gh's review evidence for the merge; null when the row carries none. */
  reviews: OutsidePrReviewEvidence | null;
  /** CI verdict on the merge's head checks; null when the row carries none. */
  ci: OutsidePrCiVerdict | null;
  /** gh's recorded diff size for the merge; null when the row carries none or the record is malformed. */
  diff: OutsidePrDiffEvidence | null;
  reverted: OutsidePrRevertVerdict;
}

export interface OutsidePrScanRepoRow {
  repo: string;
  state: 'healthy' | 'degraded';
  /** Merged PR rows gh returned before window/author filtering. */
  listed: number;
  /** True when gh's --limit may have cut the merged list short. */
  hitLimit: boolean;
  /** Outside merged PRs inside the outcome window this read returned. */
  prs: number;
}

export interface OutsidePrScanJournalRow {
  v: 1;
  kind: typeof OUTSIDE_PR_SCAN_SCHEMA;
  at: string;
  sourceState: 'healthy' | 'missing' | 'degraded';
  windowDays: number;
  since: string;
  /** Standing revert-ledger state; 'unreadable' forced every verdict to 'unknown'. */
  revertLedger: 'read' | 'missing' | 'unreadable';
  repos: OutsidePrScanRepoRow[];
}

const VERDICTS: ReadonlySet<string> = new Set(['yes', 'no', 'unknown']);
/** Agent attribution is a lowercase product slug; anything else reads as unattributed, never carried raw. */
const AGENT_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SOURCE_STATES: ReadonlySet<string> = new Set(['healthy', 'missing', 'degraded']);
const REPO_STATES: ReadonlySet<string> = new Set(['healthy', 'degraded']);
const REVERT_LEDGER_STATES: ReadonlySet<string> = new Set(['read', 'missing', 'unreadable']);
/** gh's reviewDecision vocabulary (same closed set cloud/tracker.ts validates). */
const REVIEW_DECISIONS: ReadonlySet<string> = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);
/** The check-rollup verdict vocabulary outside-pr-outcomes.ts reports (same closed set cloud/tracker.ts uses). */
const CI_VERDICTS: ReadonlySet<string> = new Set(['success', 'failure', 'pending', 'none']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) ? v : null;

/**
 * The journaled review evidence, or null when the row carries none or the
 * shape is malformed — a partial record never counts as a real zero. An
 * out-of-vocabulary decision reads as null (gh recorded no usable
 * decision); a non-integer or negative `latest` rejects the whole object.
 */
function parseReviewEvidenceRow(raw: unknown): OutsidePrReviewEvidence | null {
  if (!isRecord(raw)) return null;
  const latest = int(raw['latest']);
  if (latest === null || latest < 0) return null;
  const d = raw['decision'];
  const decision = typeof d === 'string' && REVIEW_DECISIONS.has(d) ? d as OutsidePrReviewDecision : null;
  return { decision, latest };
}

/**
 * The journaled diff-size evidence, or null when the row carries none or
 * the record is malformed — a partial triple never counts as real zeros.
 * All three counts must be nonnegative safe integers; anything else
 * (pre-fields rows, corrupt rows) reads as no evidence, matching the
 * reviews/ci rule.
 */
function parseDiffRow(raw: unknown): OutsidePrDiffEvidence | null {
  if (!isRecord(raw)) return null;
  const additions = int(raw['additions']);
  const deletions = int(raw['deletions']);
  const changedFiles = int(raw['changedFiles']);
  if (additions === null || additions < 0 || deletions === null || deletions < 0 ||
      changedFiles === null || changedFiles < 0) return null;
  return { additions, deletions, changedFiles };
}

function parseOutcomeRow(row: Record<string, unknown>): OutsidePrOutcomeJournalRow | null {
  const repo = str(row['repo']);
  const number = int(row['number']);
  const reverted = str(row['reverted']);
  const mergedAt = str(row['mergedAt']);
  const at = str(row['at']);
  if (repo === null || repo === '' || repo.length > 200) return null;
  if (number === null || number <= 0) return null;
  if (reverted === null || !VERDICTS.has(reverted)) return null;
  if (mergedAt === null || at === null) return null;
  const title = str(row['title']);
  const author = row['author'];
  const agent = row['agent'];
  const createdAt = str(row['createdAt']);
  const reviews = row['reviews'] === undefined || row['reviews'] === null ? null : parseReviewEvidenceRow(row['reviews']);
  const ciRaw = row['ci'];
  const ci = typeof ciRaw === 'string' && CI_VERDICTS.has(ciRaw) ? ciRaw as OutsidePrCiVerdict : null;
  const diff = row['diff'] === undefined || row['diff'] === null ? null : parseDiffRow(row['diff']);
  return {
    v: 1,
    kind: OUTSIDE_PR_OUTCOME_SCHEMA,
    at,
    repo,
    number,
    title: title ?? '',
    author: typeof author === 'string' ? author : null,
    agent: typeof agent === 'string' && AGENT_SLUG.test(agent) ? agent : null,
    model: null,
    mergedAt,
    createdAt,
    reviews,
    ci,
    diff,
    reverted: reverted as OutsidePrRevertVerdict,
  };
}

function parseScanRepo(raw: unknown): OutsidePrScanRepoRow | null {
  if (!isRecord(raw)) return null;
  const repo = str(raw['repo']);
  const state = str(raw['state']);
  if (repo === null || repo === '' || repo.length > 200) return null;
  if (state === null || !REPO_STATES.has(state)) return null;
  return {
    repo,
    state: state as OutsidePrScanRepoRow['state'],
    listed: int(raw['listed']) ?? 0,
    hitLimit: raw['hitLimit'] === true,
    prs: int(raw['prs']) ?? 0,
  };
}

function parseScanRow(row: Record<string, unknown>): OutsidePrScanJournalRow | null {
  const at = str(row['at']);
  const sourceState = str(row['sourceState']);
  if (at === null || sourceState === null || !SOURCE_STATES.has(sourceState)) return null;
  const revertLedger = str(row['revertLedger']);
  const windowDays = int(row['windowDays']);
  const since = str(row['since']);
  const reposRaw = row['repos'];
  return {
    v: 1,
    kind: OUTSIDE_PR_SCAN_SCHEMA,
    at,
    sourceState: sourceState as OutsidePrScanJournalRow['sourceState'],
    windowDays: windowDays ?? 0,
    since: since ?? '',
    revertLedger:
      revertLedger !== null && REVERT_LEDGER_STATES.has(revertLedger)
        ? (revertLedger as OutsidePrScanJournalRow['revertLedger'])
        : 'unreadable',
    repos: Array.isArray(reposRaw)
      ? reposRaw.map(parseScanRepo).filter((r): r is OutsidePrScanRepoRow => r !== null)
      : [],
  };
}

export interface OutsidePrJournalParse {
  /**
   * repo#number -> the newest recorded revert verdict. Later lines win,
   * matching append order; a key absent here was never journaled inside
   * the read window.
   */
  verdicts: Map<string, OutsidePrRevertVerdict>;
  /**
   * The newest outcome row per PR (same last-line-wins rule), in
   * first-seen key order — the fold's per-PR evidence.
   */
  outcomes: OutsidePrOutcomeJournalRow[];
  /** The last well-formed scan row in the file, or null when none parsed. */
  scan: OutsidePrScanJournalRow | null;
  /** Lines that were not one complete JSON row of a known kind. */
  ignored: number;
}

/**
 * Tolerant whole-file parse of the journal text. Malformed lines are
 * counted in `ignored`, never thrown on and never defaulted into
 * evidence; a foreign `kind` is ignored the same way — this file is
 * dedicated, so anything else is corruption, not data.
 * Bounded reads require a parseable receipt timestamp and skip future
 * receipts before selecting the standing verdict and scan.
 */
export function parseOutsidePrOutcomeJournal(text: string, throughMs?: number): OutsidePrJournalParse {
  const verdicts = new Map<string, OutsidePrRevertVerdict>();
  const byKey = new Map<string, OutsidePrOutcomeJournalRow>();
  let scan: OutsidePrScanJournalRow | null = null;
  let ignored = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      ignored += 1;
      continue;
    }
    if (!isRecord(raw) || raw['v'] !== 1) {
      ignored += 1;
      continue;
    }
    const kind = raw['kind'];
    const row = kind === OUTSIDE_PR_OUTCOME_SCHEMA ? parseOutcomeRow(raw)
      : kind === OUTSIDE_PR_SCAN_SCHEMA ? parseScanRow(raw) : null;
    if (row === null) {
      ignored += 1;
      continue;
    }
    if (throughMs !== undefined) {
      const at = Date.parse(row.at);
      if (!Number.isFinite(at)) {
        ignored += 1;
        continue;
      }
      if (at > throughMs) continue;
    }
    if (row.kind === OUTSIDE_PR_OUTCOME_SCHEMA) {
      const key = outsidePrJournalKey(row.repo, row.number);
      verdicts.set(key, row.reverted);
      byKey.set(key, row);
    } else {
      scan = row;
    }
  }
  return { verdicts, outcomes: [...byKey.values()], scan, ignored };
}

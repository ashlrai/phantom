/**
 * pick-grade-sync.ts — grades funded selector picks against the jobs ledger.
 *
 * pick-grader.ts built the grading machinery (RQ-PSEL-3-GRADER) but nothing
 * ever called it: picks.jsonl records predictedValue "so a later run can
 * compare it with the real outcome" and the friction contract promises only
 * the grader's 7d grade closes an item — yet no run graded anything, so
 * weights.json never moved and funded friction items never auto-closed. This
 * module is that run: `phm select` calls syncPickGrades on every non-dry
 * pass, folding <runs>/metrics/jobs.jsonl into per-job timestamped evidence
 * and handing pick-grader the (pick, window) pairs whose windows elapsed.
 *
 * THE RULES, and why:
 *   - WINDOW-ANCHORED EVIDENCE. A pick's 24h/7d grade reads only rows stamped
 *     inside [pickedAt, pickedAt + window]; later evidence never leaks back
 *     into an earlier window.
 *   - MERGED needs a held merge: a MERGED-resolved row (the shared
 *     ledgerOutcomeState dialect — phase fields, 'merged' event names,
 *     merged:true) whose mergedAt-preferring stamp lands in-window, with no
 *     newer positive revert evidence (hasRevertEvidence — the same discount
 *     reward-feed and skill-nudge apply). A revert recorded after the window
 *     but before the grade run still discounts: the fleet's standing rule is
 *     that a reverted merge is not a held merge.
 *   - used means the pick produced a reviewable artifact in-window: a
 *     publish row meeting the slot-yield PR-claim convention (class 'pr', or
 *     an unclassified row carrying a PR link — the tally rule
 *     selector-picks-backlog applies) or any row carrying a canonical
 *     github.com pull URL. A held merge implies used: merged work was
 *     certainly consumed.
 *   - stars/installs have no per-pick channel in the jobs ledger, so they
 *     stay null and realizedScore renormalizes over merged+used — unknown
 *     stays unknown, never a recorded zero.
 *   - COVERAGE GUARD. The jobs tail is bounded (16 MiB); when its first dated
 *     row is newer than a pick's window start, early-window evidence may
 *     have been cut and the grade defers rather than scoring a partial
 *     window as a miss. A pick funded before the retained tail can never be
 *     proven — it stays ungraded, which is the honest answer.
 *   - features = { mergeRate }: the recorded smoothed merge prior is the only
 *     calibrated [0,1] probability picks.jsonl stores. score/predictedValue
 *     are unbounded value-scale products and minutes/usage are unsigned
 *     estimates, so they stay out of the weight model rather than being
 *     invented into [0,1].
 *   - BOUNDED AND BEST-EFFORT. Both journals use the router-outcome tail
 *     bound; syncPickGrades never throws — ledger problems come back as
 *     `state`, and a missing picks file simply means nothing funded yet.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ledgerPhase, ledgerPrUrl } from './empty-cause.js';
import {
  isNodePoolLedgerRow, ledgerEventTs, ledgerJobId, ledgerLifecycleEvent,
  ledgerOutcomeState,
} from './jobs-ledger-dialect.js';
import {
  formatPickAccuracyLine, GRADE_WINDOWS, runPickGrader,
  type GradeWindow, type PickRecord, type PickSignals,
} from './pick-grader.js';
import { frictionLedgerPath } from './friction-ledger.js';
import { hasRevertEvidence } from './slot-yield.js';
import {
  readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE,
  type LedgerReadState, type LedgerTailRead,
} from '../router/outcomes.js';

/** Future-stamp guard — the same skew allowance selector-picks-backlog applies. */
const SKEW_MS = 300_000;
/** A github.com pull URL in the canonical shape dispatchd and the fleet writers emit. */
const GITHUB_PULL_URL = /^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/([1-9]\d*)\/?$/i;
/** Same identifier alphabet the reward writer and grader pick ids use. */
const PICK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface PickJobEvidence {
  /** Stamps of MERGED-resolved rows (mergedAt-preferring via ledgerEventTs). */
  merges: number[];
  /** Stamps of rows carrying positive revert evidence. */
  reverts: number[];
  /** Stamps of publish-claim or canonical-PR-url rows — the used signal. */
  used: number[];
}

export interface PickGradeEvidenceFold {
  /** job id → timestamped evidence (absent when the tail holds no rows for it). */
  evidence: Map<string, PickJobEvidence>;
  /**
   * Timestamp of the first dated row in the retained tail — the oldest
   * evidence the bounded read kept, in tail order. A pick funded before it
   * cannot be proven: its window rows may have been cut. Null when no
   * retained row carried a parseable, non-future timestamp.
   */
  coverageStartMs: number | null;
  /** Non-blank lines that were not a JSON object. */
  malformed: number;
}

/**
 * The publish-claim rule selector-picks-backlog's tally applies, plus the
 * canonical-URL floor: class 'pr' claims a PR outright; an unclassified or
 * 'unknown' publish row counts only with a PR link; 'empty' and 'abort*'
 * never do. Any row carrying a canonical github.com pull URL records that a
 * PR artifact exists for the job — merged and closed-unmerged verdicts
 * included, since both prove work product was produced.
 */
function isUsedEvidence(row: Record<string, unknown>, event: string | null): boolean {
  const url = ledgerPrUrl(row);
  if (url !== null && GITHUB_PULL_URL.test(url)) return true;
  if (event !== 'publish') return false;
  const kind = typeof row['class'] === 'string' ? row['class'].trim().toLowerCase() : '';
  return kind === 'pr' || ((kind === '' || kind === 'unknown') && url !== null);
}

/**
 * Pure: fold one jobs-ledger tail into per-job timestamped grade evidence.
 * Only rows inside [−∞, now+skew] join; node-pool producer schemas (a
 * different id dialect), malformed lines, unsafe job ids and undated rows
 * are skipped, never guessed. `coverageStartMs` records the first dated
 * row seen in tail order regardless of job — retained bytes, not verdicts.
 */
export function foldPickGradeEvidence(text: string, nowMs: number): PickGradeEvidenceFold {
  const fold: PickGradeEvidenceFold = { evidence: new Map(), coverageStartMs: null, malformed: 0 };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { fold.malformed += 1; continue; }
      row = parsed as Record<string, unknown>;
    } catch { fold.malformed += 1; continue; }
    if (isNodePoolLedgerRow(row)) continue;
    const phase = ledgerPhase(row);
    const atMs = ledgerEventTs(row, phase);
    if (atMs === null) continue;
    if (atMs <= nowMs + SKEW_MS) {
      if (fold.coverageStartMs === null) fold.coverageStartMs = atMs;
    } else {
      // A future-dated row is not evidence and must not move the coverage bound.
      continue;
    }
    const id = ledgerJobId(row);
    if (id === null || !PICK_ID.test(id)) continue;
    const event = ledgerLifecycleEvent(row, phase);
    const state = ledgerOutcomeState(row, event, phase);
    const reverted = hasRevertEvidence(row);
    const usedEvidence = isUsedEvidence(row, event);
    if (state !== 'MERGED' && !reverted && !usedEvidence) continue;
    let ev = fold.evidence.get(id);
    if (ev === undefined) {
      ev = { merges: [], reverts: [], used: [] };
      fold.evidence.set(id, ev);
    }
    if (state === 'MERGED') ev.merges.push(atMs);
    if (reverted) ev.reverts.push(atMs);
    if (usedEvidence) ev.used.push(atMs);
  }
  return fold;
}

/**
 * The latest in-window merge stamp is the held-merge candidate; any recorded
 * revert newer than it discounts the merge (a re-merge after the revert is a
 * fresh held merge because it is the later stamp). Reverts older than the
 * merge belong to an earlier era and never count.
 */
function heldMergeInWindow(ev: PickJobEvidence, start: number, end: number): boolean {
  let latest = -1;
  for (const at of ev.merges) if (at >= start && at <= end && at > latest) latest = at;
  if (latest < 0) return false;
  for (const at of ev.reverts) if (at > latest) return false;
  return true;
}

/**
 * readSignals for runPickGrader: undefined defers the grade (coverage cannot
 * be proven), otherwise merged/used are measured inside the pick's own
 * window and stars/installs stay null — the jobs ledger has no such channel.
 */
function pickSignals(
  pick: PickRecord, window: GradeWindow, fold: PickGradeEvidenceFold,
): PickSignals | undefined {
  const start = pick.pickedAt;
  const end = start + GRADE_WINDOWS[window];
  if (fold.coverageStartMs === null || fold.coverageStartMs > start) return undefined;
  const ev = fold.evidence.get(pick.id);
  const merged = ev !== undefined && heldMergeInWindow(ev, start, end);
  const used = merged || (ev !== undefined && ev.used.some((at) => at >= start && at <= end));
  return { merged, used, stars: null, installs: null };
}

/**
 * Pure: picks.jsonl rows → grader PickRecords. A row needs a usable id, a
 * parseable `at` and a finite recorded mergeRate — the pick's only calibrated
 * feature; rows missing any of them are skipped rather than graded against a
 * fabricated prediction. features is exactly { mergeRate }: score and
 * predictedValue are unbounded value-scale products and minutes/usage are
 * unsigned estimates, so they stay out of the weight model (see module doc).
 */
export function selectorPickRecords(text: string): { picks: PickRecord[]; skipped: number } {
  const picks: PickRecord[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { skipped += 1; continue; }
      row = parsed as Record<string, unknown>;
    } catch { skipped += 1; continue; }
    const id = row['id'];
    const at = row['at'];
    const mergeRate = row['mergeRate'];
    const pickedAt = typeof at === 'string' ? Date.parse(at) : NaN;
    const frictionId = row['frictionId'] ?? row['friction_id'];
    if (typeof id !== 'string' || !PICK_ID.test(id) || !Number.isFinite(pickedAt)
      || typeof mergeRate !== 'number' || !Number.isFinite(mergeRate)
      || mergeRate < 0 || mergeRate > 1) { skipped += 1; continue; }
    picks.push({
      id, pickedAt, features: { mergeRate },
      ...(typeof frictionId === 'string' && frictionId !== '' ? { frictionId } : {}),
    });
  }
  return { picks, skipped };
}

export interface PickGradeSyncOptions {
  /** Fleet runs dir; defaults to ASHLR_RUNS_DIR then ~/.ashlr-runs (same as reward-feed). */
  runsDir?: string;
  /** picks.jsonl override; defaults to <runsDir>/selector/picks.jsonl. */
  picksPath?: string;
  /** Injected jobs-ledger tail text; skips the jobs.jsonl read when set. */
  jobsText?: string;
  /** Grader home for ~/.ashlr/picks; defaults to the OS home (tests relocate HOME). */
  home?: string;
  /** Friction ledger the 7d close writes; defaults to frictionLedgerPath(home). */
  frictionPath?: string;
  now?: () => Date;
}

export interface PickGradeSyncResult {
  /** Health of the jobs-ledger tail; only 'read' can produce grades. */
  state: LedgerReadState | 'error';
  jobsPath: string;
  /** True when the jobs tail dropped older bytes — deferred picks may never grade. */
  jobsTruncated: boolean;
  /** Grader pick records parsed from picks.jsonl. */
  picks: number;
  /** picks.jsonl rows skipped as malformed or ungradable. */
  picksSkipped: number;
  /** True when the picks tail dropped older bytes — the oldest funded picks were not graded this pass. */
  picksTruncated: boolean;
  /** Grades persisted this pass (24h and 7d count separately). */
  newGrades: number;
  /** Friction-ledger ids this pass closed (empty unless a 7d grade hit). */
  frictionClosed: string[];
  /** The accuracy line for the daily line, e.g. `picks 24h 7/10 70% · mae 0.21`. */
  line: string;
}

function emptyResult(
  state: PickGradeSyncResult['state'], jobsPath: string,
): PickGradeSyncResult {
  return {
    state, jobsPath, jobsTruncated: false, picks: 0, picksSkipped: 0, picksTruncated: false,
    newGrades: 0, frictionClosed: [], line: formatPickAccuracyLine([]),
  };
}

/**
 * Grade due selector picks against the fleet jobs ledger and persist grades,
 * weights and friction closes through runPickGrader. Runs inside `phm select`
 * on the hourly pass; safe to call any time. Never throws: ledger problems
 * come back as `state`, write problems as `state: 'error'`.
 */
export async function syncPickGrades(opts: PickGradeSyncOptions = {}): Promise<PickGradeSyncResult> {
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const jobsPath = join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
  const picksPath = opts.picksPath ?? join(runsDir, 'selector', 'picks.jsonl');
  const home = opts.home ?? homedir();
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  try {
    const jobs: LedgerTailRead = opts.jobsText !== undefined
      ? { state: 'read', text: opts.jobsText, truncated: false }
      : await readLedgerTail(jobsPath);
    // A missing or unreadable picks journal just means nothing was funded;
    // runPickGrader still returns the standing accuracy line from prior grades.
    const picksRead = await readLedgerTail(picksPath);
    const { picks, skipped } = picksRead.state === 'read'
      ? selectorPickRecords(picksRead.text)
      : { picks: [] as PickRecord[], skipped: 0 };
    const fold = jobs.state === 'read' ? foldPickGradeEvidence(jobs.text, nowMs) : null;
    const run = runPickGrader({
      home,
      picks,
      readSignals: (pick, window) => (fold === null ? undefined : pickSignals(pick, window, fold)),
      now: nowMs,
      // Trust the recorded merge prior at face value until grades say otherwise:
      // predict = mergeRate, so a grade's hit reads "the prior's direction matched reality".
      defaultWeights: { mergeRate: 1 },
      frictionPath: opts.frictionPath ?? frictionLedgerPath(home),
    });
    return {
      state: jobs.state, jobsPath,
      jobsTruncated: jobs.state === 'read' ? jobs.truncated : false,
      picks: picks.length, picksSkipped: skipped,
      picksTruncated: picksRead.state === 'read' ? picksRead.truncated : false,
      newGrades: run.newGrades.length, frictionClosed: run.frictionClosed, line: run.line,
    };
  } catch {
    return emptyResult('error', jobsPath);
  }
}

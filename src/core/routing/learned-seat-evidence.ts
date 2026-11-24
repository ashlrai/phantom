/**
 * learned-seat-evidence.ts — feed the fleet's own outcome record into the
 * seat router.
 *
 * routeSeat has always accepted `learnedPenalty`/`learningNote`
 * (src/core/routing/router.ts), and outcome-learning.ts computes per-cell
 * posterior seat penalties — but until now nothing in production ever
 * supplied them, so the loop from "what the fleet's jobs actually did" to
 * "which seat the router prefers" was dead code. This module is the missing
 * join: it reads the same bounded evidence `phm fleet outcomes` and
 * `phm select` fold (the dispatch event log and the jobs-ledger tail, plus
 * the standing revert set and the router censor config), pools every cell
 * per resource through learnedFleetSeatPenalty, and hands routeSeat a
 * penalty map plus an honest one-line note.
 *
 * Honesty rules, same as every other outcome consumer:
 *  - Read-only. Both ledgers are read through bounded sync tails; nothing
 *    is written and no network is touched.
 *  - Fail-closed. A missing, unreadable, oversized or non-regular file
 *    contributes nothing; with no usable evidence the penalty is {} and
 *    the router's ranking is byte-identical to today.
 *  - Unknown stays unknown. Cells exist only for measured attempts; the
 *    pooled penalty never invents a score for a resource the ledger has
 *    not recorded.
 *  - Bounded and cached. The ledger tail cap matches
 *    ROUTER_OUTCOME_LEDGER_LIMIT and the events log matches the fleet
 *    outcomes 8 MiB whole-file bound. routeSeat is invoked once per seat
 *    variant during planning, so the computed evidence is cached for
 *    LEARNED_SEAT_EVIDENCE_TTL_MS — a long-lived router gateway refreshes
 *    it on the next call after expiry instead of re-reading the ledgers
 *    per request.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfigReadOnly } from '../config.js';
import { dispatchEventsCandidates } from '../fleet/dispatch-events-path.js';
import { readStandingRevertKeys } from '../improve/revert-ledger.js';
import {
  ROUTER_OUTCOME_LEDGER_LIMIT,
  ROUTER_OUTCOME_LEDGER_RELATIVE,
} from '../router/outcomes.js';
import {
  censorFromConfig,
  learnFleetOutcomes,
  learnedFleetSeatPenalty,
  type CensorOptions,
  type OutcomeLearning,
} from './outcome-learning.js';

/** Whole-file bound for the dispatch event log — the same cap `phm fleet outcomes` applies. */
export const LEARNED_SEAT_EVENTS_MAX_BYTES = 8 * 1024 * 1024;
/** How long a computed penalty stays fresh; route calls inside the window reuse it. */
export const LEARNED_SEAT_EVIDENCE_TTL_MS = 15 * 60 * 1000;

export interface LearnedSeatRouteEvidence {
  /** Per-seatId additive penalty for routeSeat; {} when there is no usable evidence. */
  learnedPenalty: Record<string, number>;
  /** One-line provenance note appended to the decision's why/summary; absent with no evidence. */
  learningNote?: string;
}

export interface LearnedSeatEvidenceOptions {
  /** Clock for the censor fold and cache key (default: Date.now()). */
  nowMs?: number;
  /** Runs dir for the default ledger paths (default: $ASHLR_RUNS_DIR ?? ~/.ashlr-runs). */
  runsDir?: string;
  /** Dispatch event log override; default: the first readable canonical candidate. */
  eventsPath?: string;
  /** Jobs ledger override; default: <runsDir>/metrics/jobs.jsonl. */
  ledgerPath?: string;
  /** Standing revert PR keys; default: readStandingRevertKeys(). Pass null to skip the join. */
  revertedPrKeys?: ReadonlySet<string> | null;
  /** Censor options; default: censorFromConfig(loadConfigReadOnly().router, nowMs). Pass null to skip. */
  censor?: CensorOptions | null;
  /** Learning override for tests; skips the file reads entirely. */
  learning?: OutcomeLearning;
}

function runsDirOf(opts: LearnedSeatEvidenceOptions): string {
  return opts.runsDir
    ?? process.env['ASHLR_RUNS_DIR']
    ?? join(homedir(), '.ashlr-runs');
}

/**
 * Sync mirror of router/outcomes.ts readLedgerTail: last `maxBytes` of a
 * regular file, first partial line dropped when truncated, O_NOFOLLOW so a
 * symlinked ledger is refused rather than followed. Returns the text only
 * on a clean read; every failure maps to null so the caller contributes
 * nothing.
 */
function readLedgerTailSync(path: string, maxBytes = ROUTER_OUTCOME_LEDGER_LIMIT): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const truncated = stat.size > maxBytes;
    const start = truncated ? stat.size - maxBytes : 0;
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const n = readSync(fd, buf, offset, length - offset, start + offset);
      if (n === 0) break;
      offset += n;
    }
    let text = buf.subarray(0, offset).toString('utf8');
    if (truncated) {
      const newline = text.indexOf('\n');
      text = newline < 0 ? '' : text.slice(newline + 1);
    }
    return text;
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** Whole-file read under `maxBytes`; null on missing, non-regular, oversized or unreadable. */
function readWholeFileSync(path: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const n = readSync(fd, buf, offset, stat.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return buf.subarray(0, offset).toString('utf8');
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

function readDispatchEvents(opts: LearnedSeatEvidenceOptions): string | null {
  const candidates = opts.eventsPath !== undefined
    ? [opts.eventsPath]
    : dispatchEventsCandidates(runsDirOf(opts));
  for (const path of candidates) {
    const text = readWholeFileSync(path, LEARNED_SEAT_EVENTS_MAX_BYTES);
    if (text !== null) return text;
  }
  return null;
}

function readJobsLedger(opts: LearnedSeatEvidenceOptions): string | null {
  const path = opts.ledgerPath ?? join(runsDirOf(opts), ROUTER_OUTCOME_LEDGER_RELATIVE);
  return readLedgerTailSync(path);
}

/**
 * Compute the seat-router penalty from the fleet's recorded outcomes. Pure
 * with respect to `opts.learning` (tests inject a fold directly); otherwise
 * reads the bounded ledgers synchronously. Never throws: any read or fold
 * failure degrades to the empty evidence rather than breaking routing.
 */
export function computeLearnedSeatEvidence(opts: LearnedSeatEvidenceOptions = {}): LearnedSeatRouteEvidence {
  try {
    const nowMs = opts.nowMs ?? Date.now();
    const learning = opts.learning ?? learnFleetOutcomes(
      readDispatchEvents(opts),
      readJobsLedger(opts),
      opts.censor === undefined
        ? censorFromConfig(loadConfigReadOnly().router, nowMs)
        : opts.censor ?? undefined,
      opts.revertedPrKeys === undefined ? readStandingRevertKeys() : opts.revertedPrKeys ?? undefined,
    );
    const learnedPenalty = learnedFleetSeatPenalty(learning);
    const measured = Object.keys(learnedPenalty).length;
    if (measured === 0) return { learnedPenalty };
    return {
      learnedPenalty,
      learningNote: 'Fleet outcome learning ranked seats by their pooled merge and allowance record.',
    };
  } catch {
    return { learnedPenalty: {} };
  }
}

let cache: { atMs: number; runsDir: string; evidence: LearnedSeatRouteEvidence } | null = null;

/**
 * The cached entry point routeSeat's dep uses: recomputes at most once per
 * LEARNED_SEAT_EVIDENCE_TTL_MS. `nowMs` is the caller's clock so tests can
 * age the cache deterministically; a changed runs dir (ASHLR_RUNS_DIR)
 * invalidates immediately rather than serving another fleet's record.
 */
export function learnedSeatRouteEvidence(nowMs: number = Date.now()): LearnedSeatRouteEvidence {
  const runsDir = runsDirOf({});
  if (cache !== null
    && cache.runsDir === runsDir
    && nowMs - cache.atMs < LEARNED_SEAT_EVIDENCE_TTL_MS) return cache.evidence;
  const evidence = computeLearnedSeatEvidence({ nowMs });
  cache = { atMs: nowMs, runsDir, evidence };
  return evidence;
}

/** Tests only: drop the cached evidence so the next call recomputes. */
export function resetLearnedSeatEvidenceCacheForTests(): void {
  cache = null;
}

/**
 * outside-outcome-sync.ts — the self-improvement loop's recorder for
 * outside-PR outcome evidence.
 *
 * src/core/fleet/outside-pr-outcomes.ts measures merged PRs that are NOT
 * fleet work — community contributions the fleet's own ledgers never
 * see — but until now its only readers were the `phm fleet
 * outside-outcomes` report and the verse projection: a merged-then-
 * reverted outside PR left evidence only in a report someone had to run
 * and read. This module journals each sync's outcome rows plus one
 * coverage receipt into <runs>/metrics/outside-pr-outcomes.jsonl
 * (schema fleet.outside-pr-outcome.v1 / fleet.outside-pr-scan.v1, the
 * contract in outside-pr-outcome-ledger.ts), where
 * src/core/improve/outside-pr-backlog.ts folds recurring reverts into
 * backlog items on the same cadence.
 *
 * THE RULES, sharing empty-tag-sync.ts's shape:
 *   - JOURNAL GATES THE PASS. The journal's own tail is read first
 *     through readLedgerTail's bounded no-follow read; an unreadable or
 *     non-file journal skips the whole pass rather than risk appending
 *     duplicate verdict rows. 'missing' is a clean empty ledger.
 *   - VERDICT CHANGE APPENDS. A PR gets a new outcome row when it is
 *     first seen or its recorded evidence changes — the revert verdict
 *     flipping ('unknown' -> 'yes' when the revert ledger recovers
 *     counts), or the merge's open timestamp / review evidence / CI
 *     verdict / recorded diff size changing as gh reports them (a
 *     review landing after merge, a bounded CI read arriving late, or
 *     a row journaled before the fields existed being rewritten once).
 *     An unchanged evidence tuple appends nothing, so steady state
 *     costs one scan row per pass.
 *   - SCAN ROW IS THE RECEIPT. Every pass that got a real gh read
 *     (sourceState 'healthy' or 'degraded') appends one
 *     fleet.outside-pr-scan.v1 row recording source state, window and
 *     per-repo read health — the fold's coverage honesty. An absent gh
 *     ('missing') writes nothing: no tool, no evidence.
 *   - BOUNDED AND BEST-EFFORT. The journal tail read is capped; the
 *     pass never throws — ledger problems come back as `state`, write
 *     problems as `state: 'error'`.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { readLedgerTail, type LedgerReadState } from '../router/outcomes.js';
import {
  listOutsidePrOutcomes,
  type ListOutsidePrOutcomesOptions,
  type OutsidePrOutcomeV1,
  type OutsidePrOutcomesV1,
  type OutsidePrReviewEvidence,
} from './outside-pr-outcomes.js';
import {
  OUTSIDE_PR_OUTCOME_SCHEMA,
  OUTSIDE_PR_SCAN_SCHEMA,
  outsidePrJournalKey,
  outsidePrOutcomeJournalPath,
  parseOutsidePrOutcomeJournal,
  type OutsidePrJournalParse,
  type OutsidePrOutcomeJournalRow,
  type OutsidePrScanJournalRow,
} from './outside-pr-outcome-ledger.js';

/** Journal tail cap for the dedup read — the same 8 MiB bound the sibling outcome ledgers use. */
export const OUTSIDE_OUTCOME_JOURNAL_TAIL_BYTES = 8 * 1024 * 1024;

export interface OutsideOutcomeSyncOptions extends ListOutsidePrOutcomesOptions {
  /** Journal path override; default <runsDir>/metrics/outside-pr-outcomes.jsonl. */
  journalPath?: string;
  /**
   * Injected outcomes read (tests); receives every list option verbatim,
   * including `now`, `gh`, `days`, `limit` and the discovery seams.
   */
  list?: (opts: ListOutsidePrOutcomesOptions) => Promise<OutsidePrOutcomesV1>;
}

export interface OutsideOutcomeSyncResult {
  /** Health of the journal tail the dedup read saw; 'error' when the append failed. */
  state: LedgerReadState | 'error';
  journalPath: string;
  /** The outcomes read's source state; null when the read never ran or threw. */
  sourceState: OutsidePrOutcomesV1['sourceState'] | null;
  /** fleet.outside-pr-outcome.v1 rows appended this pass. */
  appended: number;
  /** True when this pass's fleet.outside-pr-scan.v1 coverage row was appended. */
  scanAppended: boolean;
  /** Distinct outside PRs the journal tail already carried (plus this pass's). */
  seen: number;
  /** True when the journal tail dropped older bytes — earlier verdicts may be missing. */
  truncated: boolean;
}

function skipped(
  state: OutsideOutcomeSyncResult['state'],
  journalPath: string,
  sourceState: OutsideOutcomeSyncResult['sourceState'] = null,
): OutsideOutcomeSyncResult {
  return { state, journalPath, sourceState, appended: 0, scanAppended: false, seen: 0, truncated: false };
}

/**
 * The mutable evidence one outcome row records, as the dedup compares it:
 * the revert verdict plus the merge's open timestamp, review evidence, CI
 * verdict and recorded diff size. gh's fields are frozen at merge except
 * reviews (a review can land after merge), ci (the bounded per-PR rollup
 * read can fail or arrive after the row was first journaled) and diff
 * (a row journaled before the fields existed gets its first recorded
 * triple once), so any change here is a real evidence change worth a new
 * row — last-line-wins keeps the newest.
 */
function outcomeEvidence(row: {
  reverted: OutsidePrOutcomeJournalRow['reverted'];
  createdAt: string | null;
  reviews: OutsidePrReviewEvidence | null;
  ci: OutsidePrOutcomeJournalRow['ci'];
  diff: OutsidePrOutcomeJournalRow['diff'];
}): string {
  return JSON.stringify([
    row.reverted, row.createdAt, row.reviews?.decision ?? null, row.reviews?.latest ?? null, row.ci ?? null,
    row.diff === null ? null : [row.diff.additions, row.diff.deletions, row.diff.changedFiles],
  ]);
}

function outcomeJournalRow(at: string, repo: string, pr: OutsidePrOutcomeV1): OutsidePrOutcomeJournalRow {
  return {
    v: 1,
    kind: OUTSIDE_PR_OUTCOME_SCHEMA,
    at,
    repo,
    number: pr.number,
    title: pr.title,
    author: pr.author,
    // The outcomes read attributes agent by recorded branch/login
    // convention (outsidePrAgentAttribution); null stays the honest
    // unattributed bucket. model is never recorded — always null.
    agent: pr.agent,
    model: null,
    mergedAt: pr.mergedAt,
    createdAt: pr.createdAt,
    reviews: pr.reviews,
    ci: pr.ci,
    diff: pr.diff,
    reverted: pr.reverted,
  };
}

function scanJournalRow(at: string, outcomes: OutsidePrOutcomesV1): string {
  const row: OutsidePrScanJournalRow = {
    v: 1,
    kind: OUTSIDE_PR_SCAN_SCHEMA,
    at,
    sourceState: outcomes.sourceState,
    windowDays: outcomes.windowDays,
    since: outcomes.since,
    revertLedger: outcomes.revertLedger,
    repos: outcomes.repos.map((repo) => ({
      repo: repo.repo,
      state: repo.state,
      listed: repo.listed,
      hitLimit: repo.hitLimit,
      prs: repo.prs.length,
    })),
  };
  return JSON.stringify(row);
}

/**
 * Refresh the outside-PR outcome journal from one live outcomes read.
 * Runs inside the cloud scheduler's hourly improve tick beside
 * autoDiscover; safe to call any time. Never throws: journal problems
 * come back as `state`, and an absent gh writes nothing.
 */
export async function syncOutsidePrOutcomes(
  opts: OutsideOutcomeSyncOptions = {},
): Promise<OutsideOutcomeSyncResult> {
  const { journalPath: journalOverride, list, ...listOpts } = opts;
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const journalPath = journalOverride ?? outsidePrOutcomeJournalPath(runsDir);
  try {
    // The journal gates the pass: without a readable verdict map a write
    // could append a second row for an already-recorded verdict, so an
    // unreadable or non-file journal skips the gh read entirely rather
    // than risk duplicate evidence. 'missing' is a clean empty ledger.
    const read = await readLedgerTail(journalPath, OUTSIDE_OUTCOME_JOURNAL_TAIL_BYTES);
    if (read.state !== 'read' && read.state !== 'missing') return skipped(read.state, journalPath);
    const truncated = read.state === 'read' ? read.truncated : false;
    const parsed: OutsidePrJournalParse = read.state === 'read'
      ? parseOutsidePrOutcomeJournal(read.text)
      : { verdicts: new Map(), outcomes: [], scan: null, ignored: 0 };

    const outcomes = await (list ?? listOutsidePrOutcomes)(listOpts);
    const sourceState = outcomes.sourceState;
    if (sourceState === 'missing') {
      return {
        state: read.state, journalPath, sourceState,
        appended: 0, scanAppended: false, seen: parsed.verdicts.size, truncated,
      };
    }

    const at = (listOpts.now ?? (() => new Date()))().toISOString();
    const lines: string[] = [];
    let appended = 0;
    // Newest journaled row per PR: the dedup compares the full recorded
    // evidence (verdict + open stamp + review/CI/diff evidence), so a
    // review landing after merge, a late CI read or a pre-fields row
    // being rewritten appends once, then goes quiet.
    const latestByKey = new Map(parsed.outcomes.map((row) => [outsidePrJournalKey(row.repo, row.number), row]));
    for (const repo of outcomes.repos) {
      for (const pr of repo.prs) {
        const key = outsidePrJournalKey(repo.repo, pr.number);
        const row = outcomeJournalRow(at, repo.repo, pr);
        const prev = latestByKey.get(key);
        if (prev !== undefined && outcomeEvidence(prev) === outcomeEvidence(row)) continue;
        latestByKey.set(key, row);
        lines.push(JSON.stringify(row));
        appended += 1;
      }
    }
    lines.push(scanJournalRow(at, outcomes));

    await mkdir(dirname(journalPath), { recursive: true });
    await appendFile(journalPath, `${lines.join('\n')}\n`, { mode: 0o600 });
    return {
      state: read.state, journalPath, sourceState,
      // seen = distinct PRs known after this pass: the journaled keys plus
      // any first-seen ones (evidence-changed keys were already counted).
      appended, scanAppended: true, seen: latestByKey.size, truncated,
    };
  } catch {
    return skipped('error', journalPath);
  }
}

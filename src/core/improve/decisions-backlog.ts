/**
 * Fleet decisions-ledger judge-infrastructure failures →
 * self-improvement backlog items.
 *
 * Every proposal the fleet's merge machinery judges appends lifecycle
 * rows to ~/.ashlr/decisions/YYYY-MM-DD.jsonl — recordDecision in
 * src/core/fleet/decisions-ledger.ts, one DecisionEntry per event:
 * 'proposed', 'verified', 'judged', 'merge-authorized', 'merged',
 * 'handoff', 'rejected', 'escalated' plus the self-improve and
 * skill-library writes. readDecisionsDetailed is the bounded,
 * safety-checked reader every consumer shares; rows whose contract
 * fails validation count as invalidRows and degrade the whole read.
 *
 * Judge infrastructure failures are recorded distinctly from real
 * judgments:
 *
 *   - A 'judged' row whose judgeReasonCode is 'judge-parse-failure'
 *     or 'judge-network-failure' is a synthetic fail-closed fallback —
 *     judgeProposal never got a considered verdict from the model
 *     (its output would not parse, or the call itself failed). The
 *     code is derived by judgeDecisionReasonCode in
 *     src/core/fleet/judge-decision-metadata.ts from the finite
 *     detail sentinel the writers record ('judge-parse-failure' /
 *     'judge-network-failure'), so it can never be confused with a
 *     genuine 'judge-review' — the exact conflation M507 fixed after
 *     ~22% of judge calls looked like deliberate rejections.
 *     Writers: runManager in src/core/fleet/manager.ts, the inline
 *     Gate-7 judge in src/core/inbox/merge.ts, the auto-merge pass in
 *     src/core/fleet/automerge-pass.ts and the racing recorder in
 *     src/core/fleet/model-racing.ts.
 *   - An 'escalated' row whose reason is 'manager-judge-unavailable'
 *     (manager.ts, no judge client at all) or begins 'manager judge
 *     unavailable' (merge.ts Gate 7 fail-closed) records a merge path
 *     that could not obtain a judge verdict and left the proposal
 *     pending. Every other escalated reason — 'manager gate held: …'
 *     and 'self-target: …', both recorded with detail 'gate-held' —
 *     is a designed hold, and unclassifiable free text never counts.
 *
 * Until now the ledger's only readers were point-in-time surfaces —
 * `phm fleet status` and the quality-metrics reports, the comms
 * events/director-context rollups, web visibility, the merge gate's
 * own priorEntries dedup read — every one a read someone had to run
 * or a gate check, never a trend fold. A judge engine whose calls
 * kept failing to parse or kept erroring on the network, or a merge
 * path whose judge kept being unavailable, looked identical to a
 * healthy quiet week: proposals accumulated as pending or took the
 * synthetic 'review' fallback and nobody saw the infrastructure
 * failure recur. The judge-trace feeder (judge-backlog.ts) cannot see
 * this evidence at all — judge-traces record verdicts, and a
 * parse/network fallback lands there as an ordinary 'review' with no
 * failure marker; only the decisions ledger carries the distinct
 * reason codes. decisionsBacklogItems carries that failure evidence
 * into discoverBacklog like the sibling fleet-evidence feeds.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The day files are read once through
 *    readDecisionsDetailed's bounded, safety-checked read; nothing
 *    is written and no network is touched. A missing ledger is the
 *    writer's normal first-run state — a fresh install whose merge
 *    path never judged is clean, not degraded. A degraded or
 *    incomplete read (unsafe file or directory, an off-contract or
 *    oversized row, a bound hit, a mid-read mutation) emits one
 *    source-health item carrying the read's own diagnostics — the
 *    degradation itself is known fact, not a guess — while the
 *    failure cells fold only a healthy read, never partial evidence.
 *  - Rows count only under the writer's and the shared reader's own
 *    contracts: the closed action vocabulary, the v2 judge-metadata
 *    recomputation of judgeReasonCode, the detail allowlist and the
 *    partition-date agreement check. Malformed lines are already
 *    counted as invalidRows by the reader and degrade the source;
 *    the fold never guesses at rows the reader rejected.
 *  - Recurring means recorded across work: a (kind, engine) cell
 *    emits only at DECISIONS_FAILURE_MIN_RECORDS failure records
 *    across DECISIONS_MIN_DAYS distinct UTC days AND
 *    DECISIONS_MIN_PROPOSALS distinct proposals inside the 7-day
 *    window — one unlucky proposal retried, or a single deploy's
 *    provider outage, never queues a session.
 *  - Fleet machinery only: the ledger carries no repository column —
 *    every recordDecision call site is this install's own merge and
 *    manager path — so items emit only when the backlog target's
 *    repository name is 'phantom', the same last-segment rule the
 *    sibling feeds apply. Dedup is downstream: the item id hashes
 *    the (kind, engine) cell only — never the tallies, timestamps or
 *    proposal ids — so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; a judge path that
 *    recovers simply stops re-adding.
 *  - Recorded metadata only: prompts quote the failure kind, the
 *    recorded engine/model label (flattened, secret-scrubbed, capped)
 *    and the counts — never the free-text reason, proposal ids,
 *    rationales or any other ledger free text.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  readDecisionsDetailed,
  type DecisionsReadResult,
  type ReadDecisionsOptions,
} from '../fleet/decisions-ledger.js';
import type { DecisionEntry } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';

/** Failure-kind cells one call may emit; engine diversity is small but unbounded in principle. */
export const DECISIONS_BACKLOG_MAX_ITEMS = 8;
const DECISIONS_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const DECISIONS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on entry timestamps, same convention the sibling folds tolerate. */
const DECISIONS_FUTURE_SKEW_MS = 60_000;
/** Failure records one (kind, engine) cell needs before it counts as recurring. */
export const DECISIONS_FAILURE_MIN_RECORDS = 3;
/** Distinct UTC days those records must span — recurring means recorded across days. */
export const DECISIONS_MIN_DAYS = 2;
/** Distinct proposals the records must touch — recurring machinery failure shows across work, not one stubborn proposal. */
export const DECISIONS_MIN_PROPOSALS = 2;
/** The fleet's own repository label: decisions evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded engine/model labels are unbounded text; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;

/**
 * The closed failure vocabulary the fold emits. 'judge-parse-failure'
 * and 'judge-network-failure' are the ledger's own judgeReasonCode
 * values; 'judge-unavailable' is this fold's class for the two
 * producer reason strings that record "no judge verdict could be
 * obtained at all".
 */
export type JudgeFailureKind =
  | 'judge-parse-failure'
  | 'judge-network-failure'
  | 'judge-unavailable';

const JUDGE_FAILURE_REASON_CODES: ReadonlySet<string> = new Set<JudgeFailureKind>([
  'judge-parse-failure',
  'judge-network-failure',
]);

export interface DecisionsItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Evidence window in ms (default DECISIONS_WINDOW_MS). */
  windowMs?: number;
  /** Most failure-kind cells one call emits (default DECISIONS_BACKLOG_MAX_ITEMS, hard-capped); the degraded-source item is emitted in addition. */
  limit?: number;
  /** Clock anchoring the window and the read's sinceMs (default: now, ms epoch). */
  now?: number;
  /**
   * Injected decisions-ledger read (tests); skips the real read when
   * set. Same contract as readDecisionsDetailed — the caller still
   * applies the source-state bars.
   */
  readDecisions?: (opts: ReadDecisionsOptions) => DecisionsReadResult;
}

/** Per-(kind, engine) in-window fold before the recurring bars apply. */
export interface JudgeFailureFold {
  kind: JudgeFailureKind;
  /** Sanitized recorded engine/model label, 'unknown' when unrecorded. */
  engine: string;
  /** In-window failure records for the cell. */
  records: number;
  /** Distinct proposal ids the records belong to. */
  proposals: Set<string>;
  /** Distinct UTC days the records fall on. */
  days: Set<string>;
  /** ISO bounds of the cell's records; null when none carried a usable timestamp. */
  firstMs: number | null;
  lastMs: number | null;
}

/** One emitted recurring cell: the failure kind, engine and the recorded detail the prompt quotes. */
export interface JudgeFailureCell {
  kind: JudgeFailureKind;
  engine: string;
  records: number;
  proposals: number;
  /** Distinct UTC days the records fell on. */
  days: number;
  /** Sorted distinct UTC days, for the prompt's evidence list. */
  dayList: string[];
  firstSeen: string | null;
  lastSeen: string | null;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded engine/model labels are unbounded text; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

/**
 * Pure: classify one validated escalated row's free-text reason into
 * the closed failure vocabulary. Only the two producer strings that
 * record "no judge verdict could be obtained" classify — every other
 * escalated reason ('manager gate held: …', 'self-target: …', or
 * anything a future writer adds) is a designed hold or unclassifiable
 * free text and never counts.
 */
export function classifyEscalatedReason(reason: string | undefined): 'judge-unavailable' | null {
  if (reason === 'manager-judge-unavailable') return 'judge-unavailable';
  if (typeof reason === 'string' && reason.startsWith('manager judge unavailable')) return 'judge-unavailable';
  return null;
}

/**
 * Pure: classify one validated decision row into a failure kind plus
 * the recorded engine label, or null when the row is not judge-
 * infrastructure failure evidence. 'judged' rows trust the reader's
 * recomputed judgeReasonCode — the only place parse/network failure
 * is distinguishable from a real 'review' fallback; 'escalated' rows
 * classify their reason through the closed producer vocabulary.
 */
export function classifyDecisionFailure(entry: DecisionEntry): { kind: JudgeFailureKind; engine: string } | null {
  const engine = fieldText(entry.model ?? '') || fieldText(entry.engine ?? '') || 'unknown';
  if (entry.action === 'judged' && typeof entry.judgeReasonCode === 'string' &&
    JUDGE_FAILURE_REASON_CODES.has(entry.judgeReasonCode)) {
    return { kind: entry.judgeReasonCode as JudgeFailureKind, engine };
  }
  if (entry.action === 'escalated') {
    const kind = classifyEscalatedReason(entry.reason);
    if (kind !== null) return { kind, engine };
  }
  return null;
}

/**
 * Pure: fold validated decisions into per-(kind, engine) failure
 * cells over the in-window rows. Rows outside the window (or past the
 * sibling feeds' one-minute future-skew tolerance) never join a
 * cell; non-failure rows contribute nothing. Cells keep every
 * matching record — the items layer applies the recurring bars.
 */
export function foldJudgeFailureCells(
  decisions: readonly DecisionEntry[],
  opts: { nowMs: number; windowMs?: number },
): Map<string, JudgeFailureFold> {
  const windowMs = opts.windowMs ?? DECISIONS_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const until = opts.nowMs + DECISIONS_FUTURE_SKEW_MS;
  const cells = new Map<string, JudgeFailureFold>();
  for (const entry of decisions) {
    const atMs = Date.parse(entry.ts);
    if (!Number.isFinite(atMs) || atMs < windowStart || atMs > until) continue;
    const hit = classifyDecisionFailure(entry);
    if (hit === null) continue;
    const key = `${hit.kind}|${hit.engine}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        kind: hit.kind,
        engine: hit.engine,
        records: 0,
        proposals: new Set(),
        days: new Set(),
        firstMs: null,
        lastMs: null,
      };
      cells.set(key, cell);
    }
    cell.records += 1;
    cell.proposals.add(entry.proposalId);
    cell.days.add(dayOf(atMs));
    cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
    cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
  }
  return cells;
}

/**
 * Pure: the recurring cells the fold justifies — (kind, engine)
 * cells whose failure records reach DECISIONS_FAILURE_MIN_RECORDS
 * across DECISIONS_MIN_DAYS distinct UTC days AND
 * DECISIONS_MIN_PROPOSALS distinct proposals. Sorted by record count,
 * worst first.
 */
export function judgeFailureCells(folds: ReadonlyMap<string, JudgeFailureFold>): JudgeFailureCell[] {
  const cells: JudgeFailureCell[] = [];
  for (const cell of folds.values()) {
    if (cell.records < DECISIONS_FAILURE_MIN_RECORDS ||
      cell.days.size < DECISIONS_MIN_DAYS ||
      cell.proposals.size < DECISIONS_MIN_PROPOSALS) continue;
    cells.push({
      kind: cell.kind,
      engine: cell.engine,
      records: cell.records,
      proposals: cell.proposals.size,
      days: cell.days.size,
      dayList: [...cell.days].sort(),
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
    });
  }
  return cells.sort((a, b) =>
    b.records - a.records
    || a.kind.localeCompare(b.kind)
    || a.engine.localeCompare(b.engine));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is ~/.ashlr/decisions/YYYY-MM-DD.jsonl under the Ashlr home (~/.ashlr or $ASHLR_HOME; decisionsDir() in src/core/fleet/decisions-ledger.ts resolves it): recordDecision appends one DecisionEntry per fleet oversight event and readDecisionsDetailed is the bounded, safety-checked reader every consumer shares — `phm fleet status` and the quality-metrics reports, the comms events and director-context rollups, web visibility, and the merge gate\'s own priorEntries dedup read are its consumers, each a point-in-time read rather than a trend. Judge infrastructure failures are recorded distinctly: a \'judged\' row whose judgeReasonCode is \'judge-parse-failure\' or \'judge-network-failure\' is a synthetic fail-closed fallback, never a considered verdict (judgeDecisionReasonCode in src/core/fleet/judge-decision-metadata.ts derives the code from the finite detail sentinel), and an \'escalated\' row whose reason is \'manager-judge-unavailable\' or begins \'manager judge unavailable\' records a merge path that could not obtain a judge verdict at all. The judge-trace ledger cannot see this evidence — a parse/network fallback lands in ~/.ashlr/judge-traces/ as an ordinary \'review\' verdict with no failure marker.';

const OWNERSHIP = 'This repository owns the judge path itself — judgeProposal and the frontier-judge resolution in src/core/fleet/manager.ts, the inline Gate-7 judge and its fail-closed escalation in src/core/inbox/merge.ts, the auto-merge pass in src/core/fleet/automerge-pass.ts, the racing recorder in src/core/fleet/model-racing.ts, the verdict parsing and failure classification those callers share, and the decisions-ledger writer/reader contract in src/core/fleet/decisions-ledger.ts and judge-decision-metadata.ts. What it does not own is provider-side quota, network or model availability behind a network failure, ops-pinned dispatcher machinery, or owner-side judge configuration — those stay reported, never edited.';

const NO_CHANGE = 'If the window has rolled forward, the failures trace to a provider incident or quota exhaustion outside this repository\'s control, the judge engine configuration was deliberately changed mid-window, the recorded failures belong to proposals the pipeline correctly held for other reasons, or the ledger read has since gone healthy — report no-change and name the evidence.';

/** What each failure kind means and where to hunt, stated once per cell. */
const KIND_TEXT: Record<JudgeFailureKind, { meaning: string; hunt: string; title: string }> = {
  'judge-parse-failure': {
    meaning: 'the judge model responded but its output could not be parsed into a verdict even after the writer\'s retry — judgeProposal recorded a synthetic fail-closed fallback verdict (\'review\'), not a considered judgment, so every one of these rows is merge-path work that silently lost its real verdict',
    hunt: 'whether the judge prompt or expected response format drifted from what the verdict parser accepts, whether the recorded model label is the engine that actually answered (the writers record the fallback-aware model), whether parse failures cluster on particular proposal shapes — large diffs, unusual file types, long context — and whether the parser\'s strictness or the retry budget in the judge path needs adjustment',
    title: 'judge keeps producing unparseable verdicts',
  },
  'judge-network-failure': {
    meaning: 'the judge call itself failed — network, API or spawn error — so no model response was ever obtained and the recorded verdict is a synthetic fail-closed fallback, again not a considered judgment',
    hunt: 'whether the failures cluster on one provider, endpoint or engine label, whether the judge client\'s timeout and retry configuration matches provider reality, whether credential or quota exhaustion surfaces as network failure, and whether the fallback ordering that picks the judge engine keeps routing to a seat that cannot answer',
    title: 'judge keeps failing on network/API errors',
  },
  'judge-unavailable': {
    meaning: 'no judge client could be obtained at all — the manager recorded an escalated decision (\'manager-judge-unavailable\') or merge Gate 7 fail-closed (\'manager judge unavailable — gate 7 fail closed\'), leaving proposals pending rather than judged; designed gate-held and self-target escalations never count here',
    hunt: 'why the judge client resolved to none — missing or malformed judge configuration, an unavailable engine seat, auth or spawn failure in the client factory — and whether the fail-closed escalation is correctly leaving work pending instead of silently merging unjudged proposals',
    title: 'judge path keeps escalating proposals as unavailable',
  },
};

const engineText = (engine: string): string =>
  engine === 'unknown' ? 'the unattributed judge path' : `judge engine '${engine}'`;

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (cell: JudgeFailureCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

function failurePrompt(cell: JudgeFailureCell, windowDays: number): string {
  const cls = KIND_TEXT[cell.kind];
  const engine = fieldText(cell.engine) || 'unknown';
  const unattributed = cell.engine === 'unknown'
    ? ' Rows that carry no engine/model label — the Gate-7 fail-closed escalation records none — fold into this unattributed cell.'
    : '';
  return [
    `Phantom's fleet decisions ledger keeps recording judge-infrastructure failures for ${engineText(engine)} — ${cell.records} '${cell.kind}' record(s) across ${cell.days} separate UTC day(s) (${daysText(cell.dayList)}) touching ${cell.proposals} distinct proposal(s) inside the ${windowDays}-day window, the self-improvement work this backlog exists for.`,
    '',
    `${cls.meaning}.${seenText(cell)}${unattributed}`,
    '',
    EVIDENCE,
    '',
    OWNERSHIP,
    '',
    `Find whether the recurring failure is a machinery gap this repository can close — ${cls.hunt}. Fix what lives here; if the cause is a provider incident, quota exhaustion, deliberately changed judge configuration, designed gate behavior, or pinned machinery — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function failureItem(cell: JudgeFailureCell, repo: string, windowDays: number): CloudBacklogItem {
  const id = `fleet-decisions-${sha(`judge-failure:${cell.kind}:${cell.engine}`)}`;
  const engine = fieldText(cell.engine) || 'unknown';
  const display = engine === 'unknown' ? '' : ` '${engine.length > 60 ? `${engine.slice(0, 59)}…` : engine}'`;
  const title = `Judge infrastructure: ${KIND_TEXT[cell.kind].title}${display}`.slice(0, MAX_TITLE_CHARS);
  return {
    id,
    title,
    prompt: failurePrompt(cell, windowDays),
    area: 'judge-failures',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** Diagnostics the degraded-source item quotes — the read's own fields, never guessed. */
function degradedPrompt(result: DecisionsReadResult): string {
  const parts = [
    `sourceState '${result.sourceState}'`,
    `complete ${result.complete}`,
    `filesRead ${result.filesRead}`,
    `bytesRead ${result.bytesRead}`,
    `rowsScanned ${result.rowsScanned}`,
    `invalidRows ${result.invalidRows}`,
    `unreadableFiles ${result.unreadableFiles}`,
    `semanticRejectedRows ${result.semanticRejectedRows ?? 0}`,
    `stopReasons [${result.stopReasons.join(', ')}]`,
  ];
  return [
    `Phantom's fleet decisions ledger reads degraded — ${parts.join('; ')} — so every consumer that requires a complete read goes blind: the merge gate's priorEntries dedup (readDecisions with requireComplete in src/core/inbox/merge.ts), the inbox store's mergedRows check, the comms events and director-context rollups, and web visibility all withhold their decision-derived state while the source is degraded.`,
    '',
    'A degraded read means at least one of: an unsafe file or directory (symlink, wrong owner, group/other-writable mode), a row that failed the reader\'s contract validation (malformed JSON, off-contract action or judge metadata, a row over 128 KiB, a timestamp that disagrees with its day-file partition), a read bound hit (file/byte/row limit), or a mid-read mutation. Each is counted in the diagnostics above — the read never guesses.',
    '',
    EVIDENCE,
    '',
    OWNERSHIP,
    '',
    `Find which diagnostic fired and whether it is a real integrity problem or a transient mid-append read — ls -l the decisions directory for unsafe modes or stray entries, check whether the offending day-file holds a malformed or oversized row, and whether the bound that tripped reflects genuine ledger growth. Fix what lives here — the writer's row contract or the reader's bounds in src/core/fleet/decisions-ledger.ts. ${NO_CHANGE}`,
  ].join('\n');
}

function degradedItem(result: DecisionsReadResult, repo: string): CloudBacklogItem {
  return {
    id: `fleet-decisions-${sha('decisions-ledger:degraded-source')}`,
    title: 'Decisions ledger reads degraded — oversight consumers go blind'.slice(0, MAX_TITLE_CHARS),
    prompt: degradedPrompt(result),
    area: 'judge-failures',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the fleet decisions ledger's recurring
 * judge-infrastructure failure cells plus its degraded-source
 * signal. Total: another repository, a missing ledger, a read
 * failure, or any fold failure yields no items rather than throwing
 * into discovery; a degraded read yields the source-health item
 * alone since partial rows cannot prove recurrence.
 */
export async function decisionsBacklogItems(opts: DecisionsItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = opts.now ?? Date.now();
    const windowMs = opts.windowMs ?? DECISIONS_WINDOW_MS;
    const read = opts.readDecisions ?? ((filter: ReadDecisionsOptions) => readDecisionsDetailed(filter));
    const result = read({ sinceMs: nowMs - windowMs });

    const items: CloudBacklogItem[] = [];
    // A degraded or incomplete read is itself the evidence: the fold
    // cannot prove recurrence from partial rows, but every
    // requireComplete consumer is already blind — emit the source-
    // health item and stop rather than guessing at cells.
    if (result.sourceState === 'degraded' || result.complete !== true) {
      items.push(degradedItem(result, repo));
      return items;
    }
    if (result.sourceState !== 'healthy' || result.decisions.length === 0) return items;

    const folds = foldJudgeFailureCells(result.decisions, { nowMs, windowMs });
    if (folds.size === 0) return items;
    const cells = judgeFailureCells(folds);
    const limit = Math.max(1, Math.min(opts.limit ?? DECISIONS_BACKLOG_MAX_ITEMS, DECISIONS_BACKLOG_ITEM_HARD_MAX));
    const windowDays = Math.round(windowMs / 86_400_000);
    items.push(...cells.slice(0, limit).map((cell) => failureItem(cell, repo, windowDays)));
    return items;
  } catch {
    return [];
  }
}

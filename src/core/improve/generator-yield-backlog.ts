/**
 * Queue generation journal → self-improvement backlog items.
 *
 * Phantom's queue intake drafts candidate jobs through two writers that
 * share one trace: planAutofill (src/core/fleet/queue-autofill.ts) emits a
 * queue.generation-event.v1 row per candidate it drafts or refuses —
 * 'duplicate', 'stopped_family', 'missing_capability',
 * 'already_queued_or_completed', 'already_completed' — and the autofill
 * runner (src/core/fleet/autofill-run.ts) plus the supply-floor pass
 * (src/core/fleet/supply-floor.ts) append the trace to
 * <runs>/metrics/generation.jsonl on every applied pass, rewriting
 * overflow drafts to 'hourly_cap' rejections. `phm queue yield --since
 * 7d --json` folds the same ledger with metrics/jobs.jsonl into
 * queue.generator-yield.v1 (src/core/queue/generator-yield.ts), the
 * metrics panel carries the report, and queue-autofill ranks candidates
 * from it — but all of those are reports and rankings someone had to
 * run or that steer one pass at a time. Until now nothing carried the
 * journal's own evidence into the self-improvement backlog, so an
 * intake whose candidate sources keep minting work the fleet refuses —
 * stopped families the stop verdicts already killed, jobs needing
 * capabilities no lane declares, ideas and bets resurfacing shipped
 * work, the same candidate re-drafted under new ids — never became
 * work even though the refusals are the self-improvement loop's own
 * intake diagnosing itself.
 *
 * generatorYieldBacklogItems carries that journal into discoverBacklog,
 * so `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the fleet outcome-learning, nightly retro, policy,
 * local-gate, pass^k, friction, tick-health, cross-review, empty-tag,
 * post-merge, ci-rerun, lost-launch, memory, fleet-controller,
 * skill-outcome, precheck-skip, source-yield, gateway-shadow, recheck,
 * stuck-job, lesson-trial, work-market, dupcheck, improve-outcome,
 * typed-route, branch-gardener, reward, job-control and usage-gap
 * sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/generation.jsonl is read through readSource's
 *    bounded no-follow tail read; nothing is written and no network is
 *    touched. Only the decision's job id, src, event, reason and
 *    timestamp are consumed — candidate goals and prompts never reach a
 *    prompt.
 *  - Healthy-only evidence. A missing ledger yields no items (a fresh
 *    install or autofill never applied is normal, not a finding); an
 *    unreadable or oversized source yields no items — unknown stays
 *    unknown, never a guessed tally. Malformed lines and rows missing
 *    the fields the fold needs are skipped, never counted.
 *  - Windowed on recorded evidence. A rejection counts only when its
 *    recorded timestamp lands inside the window; a row with no
 *    parseable timestamp cannot anchor a cell, so a ledger that stopped
 *    being written weeks ago never queues work for stale refusals.
 *  - Recurring means recorded, across passes. A (src, reason) cell
 *    emits only at GENERATION_CELL_MIN_EVENTS recorded rejections
 *    spanning GENERATION_CELL_MIN_DAYS distinct UTC days inside the
 *    window — one bad pass or one stubborn candidate refused twice
 *    never queues a session, while the same refusal recurring day after
 *    day does. Drafted events are tallied per src as context so the
 *    prompt can quote the refusal share, but never emit on their own.
 *  - The journal carries no per-job repository dimension — it describes
 *    this install's queue intake. Items therefore emit only when the
 *    backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply;
 *    self-improvement pointed at another repository never inherits
 *    this install's evidence it cannot attribute. Rows whose src went
 *    unrecorded group as 'unknown' and never emit, the same
 *    catch-all rule the source-yield feed applies.
 *  - Dedup is downstream. The item id embeds a stable hash of the cell
 *    identity — src and reason — never the counts or timestamps, so a
 *    refresh re-derives the same id and appendUserBacklogItems adds
 *    only what is new; shifted tallies do not spawn twin items, and a
 *    cell that recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, src and reason are ledger-scrubbed safe tokens,
 *    example job ids are scrubbed and capped, and each brief names the
 *    ledger, its writers and the `phm queue yield` report with the
 *    usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readSource } from '../fleet/runs-parked-queue.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the (src, reason) cell set is small and bounded. */
export const GENERATOR_YIELD_MAX_ITEMS = 8;
const GENERATOR_YIELD_ITEM_HARD_MAX = 25;
/**
 * Recorded rejections a (src, reason) cell needs inside the window
 * before it counts as recurring — refusals are discrete recorded
 * decisions, so four across multiple passes is a pattern, not a burst.
 */
export const GENERATION_CELL_MIN_EVENTS = 4;
/**
 * Distinct UTC days the cell's rejections must span — the recurring bar
 * the sibling feeds apply, so one pass or one bad afternoon never emits.
 */
export const GENERATION_CELL_MIN_DAYS = 2;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const GENERATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on event timestamps, same convention the sibling folds apply. */
const GENERATION_FUTURE_SKEW_MS = 60_000;
/**
 * Bounded no-follow tail of the generation journal. Rows are a few
 * hundred bytes and writers append one batch per applied pass, so ~4 MiB
 * — the same bound the dupcheck feed applies — covers far more than the
 * 7-day window; past it the tail still holds the newest rows and the
 * counts read as lower bounds.
 */
const GENERATION_LEDGER_MAX_BYTES = 4 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: generation evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Example job ids quoted per cell inside one prompt. */
const MAX_EXAMPLES = 3;
/** The catch-all src bucket — a missing src is corrupt evidence, never a channel. */
const UNKNOWN_SRC = 'unknown';

export interface GeneratorYieldItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/generation.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default GENERATOR_YIELD_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default GENERATION_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window, ms epoch (default: now). */
  now?: number;
  /**
   * Injected generation.jsonl text (tests); skips the file read when set.
   * Same contract as the sibling feeds' text inputs: null means the
   * ledger is missing — withheld evidence, never zero-filled tallies.
   */
  ledgerText?: string | null;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded names are unbounded-shaped strings; scrub, flatten and cap before use. */
function safeToken(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const firstString = (row: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

/**
 * The generation-event field dialect: job ids take job|job_id|jobId|id,
 * the decision event|type|kind, timestamps ts|timestamp|at|time and the
 * intake channel src|source|generator — the same alias families the
 * jobs-ledger folds accept, so a producer that renames its fields still
 * folds.
 */
const JOB_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const EVENT_KEYS = ['event', 'type', 'kind'] as const;
const TS_KEYS = ['ts', 'timestamp', 'at', 'time'] as const;
const SRC_KEYS = ['src', 'source', 'generator'] as const;
const REASON_KEYS = ['reason'] as const;
/** The only schema the two writers emit; anything else in the file is foreign evidence. */
const GENERATION_EVENT_SCHEMA = 'queue.generation-event.v1';

const parseAt = (row: Record<string, unknown>): number | null => {
  const value = firstString(row, TS_KEYS);
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/** UTC day bucket for the recurring-days bar — 'YYYY-MM-DD', never local time. */
const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** One (src, reason) refusal cell accumulating its in-window evidence. */
interface GenerationCell {
  src: string;
  reason: string;
  /** Recorded 'rejected' events inside the window. */
  events: number;
  /** Distinct UTC days carrying at least one rejection. */
  days: Set<string>;
  /** Distinct job ids the refusals name. */
  jobs: Set<string>;
  /** Up to MAX_EXAMPLES raw job ids, ledger-scrubbed at prompt time. */
  examples: string[];
  /** The src's in-window drafted+rejected decisions — refusal-share context, set on firing cells. */
  srcDecisions: number;
}

export interface GenerationRejectionFold {
  /** Cells that met the recurring bars, most-recurring first. */
  cells: GenerationCell[];
  /** 'rejected' events consumed from the text inside the window. */
  rejections: number;
  /** 'drafted' events consumed from the text inside the window. */
  drafts: number;
  /** (src, reason) cells tracked before the bars applied. */
  tracked: number;
}

/**
 * Pure: fold one generation.jsonl text into recurring refusal cells.
 * Each line must parse to an object carrying a job id, a drafted or
 * rejected event and a parseable timestamp inside the window; anything
 * else is skipped like the sibling readers' own parse. Replayed decisions
 * with identical evidence count once. Rejections group
 * by (src, reason); drafts tally per src so prompts can quote the
 * refusal share. The 'unknown' src bucket never emits — it is the
 * catch-all for rows that lost their channel, not a channel.
 */
export function foldGenerationRejections(
  text: string,
  opts: { nowMs: number; windowMs?: number },
): GenerationRejectionFold {
  const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
    ? opts.windowMs
    : GENERATION_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const windowEnd = opts.nowMs + GENERATION_FUTURE_SKEW_MS;

  const cells = new Map<string, GenerationCell>();
  const srcDecisions = new Map<string, number>();
  const seenDecisions = new Set<string>();
  let rejections = 0;
  let drafts = 0;
  let tracked = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isRecord(row) || row['schema'] !== GENERATION_EVENT_SCHEMA) continue;
    const event = firstString(row, EVENT_KEYS)?.toLowerCase();
    if (event !== 'drafted' && event !== 'rejected') continue;
    const atMs = parseAt(row);
    if (atMs === null || atMs < windowStart || atMs > windowEnd) continue;
    const job = firstString(row, JOB_KEYS);
    if (job === null) continue;
    const src = firstString(row, SRC_KEYS) ?? UNKNOWN_SRC;
    const reason = event === 'rejected' ? firstString(row, REASON_KEYS) ?? 'unknown' : null;
    const decisionKey = JSON.stringify([job, src, event, reason, atMs]);
    if (seenDecisions.has(decisionKey)) continue;
    seenDecisions.add(decisionKey);
    srcDecisions.set(src, (srcDecisions.get(src) ?? 0) + 1);
    if (reason === null) {
      drafts += 1;
      continue;
    }
    rejections += 1;
    const key = `${src} ${reason}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { src, reason, events: 0, days: new Set(), jobs: new Set(), examples: [], srcDecisions: 0 };
      cells.set(key, cell);
      tracked += 1;
    }
    cell.events += 1;
    cell.days.add(dayKey(atMs));
    cell.jobs.add(job);
    if (cell.examples.length < MAX_EXAMPLES) cell.examples.push(job);
  }

  const firing = [...cells.values()]
    .filter((cell) => cell.src !== UNKNOWN_SRC
      && cell.events >= GENERATION_CELL_MIN_EVENTS
      && cell.days.size >= GENERATION_CELL_MIN_DAYS)
    .sort((a, b) => b.events - a.events || a.src.localeCompare(b.src) || a.reason.localeCompare(b.reason));

  // Attach per-src decision context for the prompt's refusal share.
  for (const cell of firing) {
    cell.srcDecisions = srcDecisions.get(cell.src) ?? 0;
  }

  return { cells: firing, rejections, drafts, tracked };
}

/** What each recorded refusal reason means at the intake boundary — kept to one clause so prompts stay short. */
const REASON_NOTES: Record<string, string> = {
  duplicate: 'the same work was already queued under another id or title hash',
  stopped_family: 'the fleet\'s own stop verdicts — empty-rate family stops and retired candidates — already refuse this work',
  missing_capability: 'the target lane\'s declared capabilities lack something the job needs',
  already_queued_or_completed: 'the Ideas list says the goal was already queued or shipped, yet a candidate source resurfaced it',
  already_completed: 'the bets check found the goal already shipped, yet a candidate source resurfaced it',
  hourly_cap: 'the autofill hourly draft cap refused the overflow',
};

const reasonNote = (reason: string): string =>
  REASON_NOTES[reason] ?? 'a refusal the intake recorded without a recognized reason';

/** The evidence pointers every prompt shares; the journal, its writers and the yield report are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is metrics/generation.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), schema queue.generation-event.v1 — one row per candidate the queue intake drafted or refused, appended by planAutofill\'s trace through src/core/fleet/autofill-run.ts and src/core/fleet/supply-floor.ts on every applied pass. `phm queue yield --since 7d --json` folds the same ledger with metrics/jobs.jsonl into queue.generator-yield.v1 (src/core/queue/generator-yield.ts); the metrics panel carries the report and queue-autofill ranks candidates from it.';

const NO_CHANGE = 'If the window has rolled forward, the refusals were correct filtering of genuinely bad candidates, the candidate sources have since learned the same verdicts, or the fix belongs to pinned ops machinery this repository cannot change — report no-change and name the evidence.';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function cellPrompt(cell: GenerationCell, windowDays: number): string {
  const src = safeToken(cell.src, 80);
  const reason = safeToken(cell.reason, 80);
  const jobs = cell.jobs.size;
  const days = cell.days.size;
  const share = cell.srcDecisions > 0 ? ` — ${cell.events} of ${cell.srcDecisions} recorded ${src} decisions inside the window` : '';
  const lines: string[] = [
    `Phantom's queue intake keeps refusing candidates — ${plural(cell.events, 'rejection')} for reason '${reason}' from '${src}' across ${plural(days, 'distinct UTC day')} and ${plural(jobs, 'distinct job')} inside the ${windowDays}-day window${share}, the self-improvement work this backlog exists for.`,
    '',
    `Every applied autofill or supply-floor pass records each candidate it drafts or refuses in the generation journal. '${reason}' means ${reasonNote(cell.reason)}. Refusals are the intake's own filter working — the question is whether the candidate sources keep minting work the fleet already refuses, or the refusal checks in src/core/fleet/queue-autofill.ts (candidateRank, stoppedFamilies, laneLacks) mis-fire or their vocabulary drifted from what the sources produce.`,
  ];
  lines.push('', EVIDENCE);
  if (cell.examples.length > 0) {
    lines.push('', `Example job ids: ${cell.examples.map((id) => safeToken(id, 80)).join(', ')}.`);
  }
  lines.push(
    '',
    `Find out which side owns the recurring refusal: join the example job ids to metrics/jobs.jsonl and queue/router-queue.md for what the candidates were, then decide whether the fix is in the candidate sources (Ideas list items, bets proposals, EMPTY-job follow-ups resurfacing refused work), the refusal checks themselves, or the capability/stop-verdict vocabulary they share. Run the affected suite. ${NO_CHANGE}`,
  );
  return lines.join('\n');
}

function cellItem(cell: GenerationCell, repo: string, windowDays: number): CloudBacklogItem {
  const src = safeToken(cell.src, 80);
  const reason = safeToken(cell.reason, 80);
  const id = `fleet-generation-${createHash('sha256').update(`generation-yield:${cell.src}:${cell.reason}`).digest('hex').slice(0, 16)}`;
  const title = `Queue intake '${src}' keeps refusing candidates: ${reason} (${cell.events} in ${windowDays}d)`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: cellPrompt(cell, windowDays),
    area: 'fleet-generation',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the generation journal's recurring refusal cells.
 * Total: another repository, a withheld or unreadable ledger, or any
 * read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function generatorYieldBacklogItems(opts: GeneratorYieldItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const now = opts.now ?? Date.now();
    let text: string | null;
    if (opts.ledgerText !== undefined) {
      text = opts.ledgerText;
    } else {
      const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(opts.homeDir ?? homedir(), '.ashlr-runs');
      const read = await readSource(join(runsDir, 'metrics', 'generation.jsonl'), GENERATION_LEDGER_MAX_BYTES, true);
      text = read.state === 'healthy' ? read.text : null;
    }
    if (text === null) return [];
    const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : GENERATION_WINDOW_MS;
    const fold = foldGenerationRejections(text, { nowMs: now, windowMs });
    if (fold.cells.length === 0) return [];
    const windowDays = Math.max(1, Math.round(windowMs / 86_400_000));
    const limit = Math.max(1, Math.min(opts.limit ?? GENERATOR_YIELD_MAX_ITEMS, GENERATOR_YIELD_ITEM_HARD_MAX));
    return fold.cells.slice(0, limit).map((cell) => cellItem(cell, repo, windowDays));
  } catch {
    return [];
  }
}

/**
 * Pre-launch dupcheck gate precision → self-improvement backlog items.
 *
 * The dispatcher runs `phm queue dupcheck <prompt> --gate --json`
 * (contrib/mac/launch_precheck.py) before it claims a row; every decision —
 * skip, warn or launch — is appended to <runs>/metrics/dupcheck.jsonl as a
 * queue.dupcheck-event.v1 row, and the daemon's empty-tag-sync (and
 * `phm jobs empty --record`) appends an outcome row when a let-through job
 * finishes EMPTY already_done. `phm queue dupcheck --stats` folds the same
 * ledger into checked/skips/warns/launches, warned_ended_already_done,
 * launched_ended_already_done, false_skips and skip_precision, and the
 * Ideas list's dupcheck-gate signal ranks the same tallies — but both are
 * reports someone had to run and act on by hand. Until now nothing carried
 * the gate's precision evidence into the self-improvement backlog, so a
 * gate whose recall keeps missing duplicates (let-through jobs that still
 * finish already_done) or whose skips keep being wrong (skipped jobs that
 * launch anyway) never became autonomous work.
 *
 * dupcheckGateBacklogItems carries that ledger into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it exactly
 * like the fleet outcome-learning, nightly retro, policy, local-gate,
 * pass^k, friction, tick-health, cross-review, empty-tag, post-merge,
 * ci-rerun, lost-launch, memory, fleet-controller, skill-outcome,
 * precheck-skip, source-yield, gateway-shadow, recheck, stuck-job and
 * lesson-trial sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/dupcheck.jsonl is read through readSource's
 *    bounded no-follow tail read; nothing is written and no network is
 *    touched. Only the event's job id, action, outcome tag and timestamp
 *    are consumed — evidence refs and summaries never reach a prompt.
 *  - Healthy-only evidence. A missing ledger yields no items (a fresh
 *    install or a dispatcher that never ran the gate is normal, not a
 *    finding); an unreadable or oversized source yields no items —
 *    unknown stays unknown, never a guessed tally. Malformed lines are
 *    skipped like the stats reader's own parse, and a row missing the
 *    fields the fold needs contributes nothing rather than sinking the
 *    pass.
 *  - Windowed on recorded evidence. A job's missed-duplicate evidence is
 *    its outcome row's timestamp; a false skip's evidence is the later
 *    launch/warn decision's timestamp — the moment the gate's answer
 *    proved wrong inside the window. Decisions and outcomes older than
 *    DUPCHECK_WINDOW_MS never count, and a row with no parseable
 *    timestamp cannot anchor a cell, so a ledger that stopped being
 *    written weeks ago never queues work for stale verdicts.
 *  - Recurring means recorded, at the same bars the Ideas list applies:
 *    a missed-duplicates cell emits only at DUPCHECK_MISSED_MIN let-through
 *    jobs ending already_done inside the window AND a missed share of at
 *    least DUPCHECK_MISSED_RATE of the jobs the gate let through in the
 *    same evidence; a false-skips cell emits at DUPCHECK_FALSE_SKIP_MIN
 *    skipped jobs recorded launching or warning later inside the window.
 *    One deliberate re-queue never queues a session.
 *  - The fold mirrors summarizeDupcheck's per-job semantics over the
 *    bounded tail: the FIRST non-outcome decision classifies the job
 *    (a skip→launch sequence is a false skip, never a missed duplicate),
 *    and each job counts once however many decisions it recorded. Rows
 *    cut off by the tail bound simply have no earlier context — they
 *    under-count rather than guess, the same conservative direction every
 *    sibling feed takes.
 *  - The gate is this repository's machinery (src/core/queue/dupcheck.ts
 *    and the dispatcher's pre-claim call), and the ledger carries no
 *    repository column. Items therefore emit only when the backlog
 *    target's repository name is 'phantom', the same last-segment rule
 *    the sibling fleet-evidence sources apply; self-improvement pointed
 *    at another repository inherits nothing.
 *  - Dedup is downstream. The item id embeds a stable hash of the cell
 *    identity — 'missed' or 'false-skips' — never the counts or
 *    timestamps, so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; shifted tallies do not
 *    spawn twin items, and a cell that recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, example job ids are ledger-scrubbed safe tokens,
 *    and the brief names the ledger, the stats verb and the gate module
 *    with the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { parseDupcheckEvents, type DupcheckEvent } from '../queue/dupcheck-gate.js';
import { readSource } from '../fleet/runs-parked-queue.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell set is closed at two. */
export const DUPCHECK_MAX_ITEMS = 4;
const DUPCHECK_ITEM_HARD_MAX = 25;
/**
 * Let-through jobs ending already_done inside the window before the
 * missed-duplicates cell counts as recurring — the same absolute bar the
 * Ideas list's dupcheck-gate signal applies (DUPCHECK_MISSED_MIN).
 */
export const DUPCHECK_MISSED_MIN = 3;
/** The missed share of let-through jobs the Ideas list requires before it ranks the cell. */
export const DUPCHECK_MISSED_RATE = 0.1;
/**
 * Skipped jobs recorded launching or warning later inside the window
 * before the false-skips cell counts as recurring — the same bar the
 * Ideas list applies (DUPCHECK_FALSE_SKIP_MIN): one can be a deliberate
 * re-queue, two is a pattern.
 */
export const DUPCHECK_FALSE_SKIP_MIN = 2;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const DUPCHECK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on event timestamps, same convention the sibling folds apply. */
const DUPCHECK_FUTURE_SKEW_MS = 60_000;
/**
 * Bounded no-follow tail of the gate ledger. Rows are a few hundred bytes
 * and the gate records one decision per claimed job plus outcome rows, so
 * ~4 MiB — the same bound the Ideas signal reader uses — covers far more
 * than the 7-day window with sequence context to spare; past it the tail
 * still holds the newest rows.
 */
const DUPCHECK_LEDGER_MAX_BYTES = 4 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: gate evidence is this repo's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Example job ids quoted per cell inside one prompt. */
const MAX_EXAMPLES = 3;

export interface DupcheckGateItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/dupcheck.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default DUPCHECK_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default DUPCHECK_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window, ms epoch (default: now). */
  now?: number;
  /**
   * Injected dupcheck.jsonl text (tests); skips the file read when set.
   * Same contract as the sibling feeds' text inputs: null means the
   * ledger is missing — withheld evidence, never zero-filled tallies.
   */
  eventsText?: string | null;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded job ids are unbounded-shaped strings; scrub, flatten and cap before use. */
function jobText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const parseAt = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

type GateAction = Exclude<DupcheckEvent['action'], 'outcome'>;

/** One job's folded gate history — the same per-job semantics summarizeDupcheck applies. */
interface JobGateFold {
  /** First non-outcome decision in ledger order; null until one is seen. */
  firstAction: GateAction | null;
  /** That decision's recorded timestamp; null when absent or unparseable. */
  firstAtMs: number | null;
  /** Whether any skip decision was recorded (a later non-skip decision makes it a false skip). */
  skipped: boolean;
  /** The first launch/warn decision after a skip, anchored on its recorded timestamp. */
  relaunchAtMs: number | null;
  /** The first outcome row's recorded timestamp; null when absent or unparseable. */
  outcomeAtMs: number | null;
}

/** A recurring cell: which failure mode, its in-window tallies and bounded example job ids. */
interface DupcheckCell {
  /** Stable identity hashed into the item id — never counts or timestamps. */
  key: 'missed' | 'false-skips';
  /** Let-through jobs ending already_done in-window, split by first decision. */
  missedLaunched: number;
  missedWarned: number;
  /** Jobs the gate let through inside the window's evidence (decisions or outcomes). */
  letThrough: number;
  /** Skipped jobs recorded launching or warning later inside the window. */
  falseSkips: number;
  /** Up to MAX_EXAMPLES ledger-scrubbed job ids behind the cell. */
  examples: string[];
}

export interface DupcheckGateFold {
  cells: DupcheckCell[];
  /** Parsed gate events consumed from the text. */
  events: number;
  /** Distinct job ids the fold tracked. */
  jobs: number;
  /** In-window tallies behind the cells, for prompts and tests. */
  missedLaunched: number;
  missedWarned: number;
  letThrough: number;
  falseSkips: number;
}

const GATE_ACTIONS: ReadonlySet<string> = new Set(['skip', 'warn', 'launch', 'outcome']);

/**
 * Pure: fold one dupcheck.jsonl text into recurring precision cells.
 * `text` is the raw JSONL; each line validates through parseDupcheckEvents
 * (schema + job id), then per-job sequences fold in ledger order exactly
 * like summarizeDupcheck — first non-outcome decision wins, a non-skip
 * decision after a skip is a relaunch, an outcome row marks the job. Only
 * timestamps inside the window anchor a cell.
 */
export function foldDupcheckGate(
  text: string,
  opts: { nowMs: number; windowMs?: number },
): DupcheckGateFold {
  const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
    ? opts.windowMs
    : DUPCHECK_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const windowEnd = opts.nowMs + DUPCHECK_FUTURE_SKEW_MS;
  const inWindow = (ms: number | null): ms is number => ms !== null && ms >= windowStart && ms <= windowEnd;

  const jobs = new Map<string, JobGateFold>();
  let events = 0;
  for (const event of parseDupcheckEvents(text)) {
    // The stats reader accepts any action spelling; the fold only trusts
    // the recorded vocabulary — an unknown action is corrupt evidence,
    // never a decision.
    if (!GATE_ACTIONS.has(event.action)) continue;
    events += 1;
    const atMs = parseAt(event.at);
    let fold = jobs.get(event.job);
    if (fold === undefined) {
      fold = { firstAction: null, firstAtMs: null, skipped: false, relaunchAtMs: null, outcomeAtMs: null };
      jobs.set(event.job, fold);
    }
    if (event.action === 'outcome') {
      // First outcome row wins; a later duplicate never re-anchors the job.
      if (fold.outcomeAtMs === null) fold.outcomeAtMs = atMs;
      continue;
    }
    if (fold.firstAction === null) {
      fold.firstAction = event.action;
      fold.firstAtMs = atMs;
    }
    if (event.action === 'skip') {
      fold.skipped = true;
    } else if (fold.skipped && fold.relaunchAtMs === null && atMs !== null) {
      fold.relaunchAtMs = atMs;
    }
  }

  let missedLaunched = 0;
  let missedWarned = 0;
  let letThrough = 0;
  let falseSkips = 0;
  const missedExamples: string[] = [];
  const falseSkipExamples: string[] = [];
  for (const [job, fold] of jobs) {
    if (fold.firstAction === 'launch' || fold.firstAction === 'warn') {
      // Let-through evidence is the decision or the already_done outcome,
      // whichever the window holds — a job decided before the window but
      // finishing inside it still counts as let-through.
      if (inWindow(fold.firstAtMs) || inWindow(fold.outcomeAtMs)) {
        letThrough += 1;
        if (inWindow(fold.outcomeAtMs)) {
          if (fold.firstAction === 'launch') missedLaunched += 1;
          else missedWarned += 1;
          if (missedExamples.length < MAX_EXAMPLES) missedExamples.push(job);
        }
      }
    }
    if (inWindow(fold.relaunchAtMs)) {
      falseSkips += 1;
      if (falseSkipExamples.length < MAX_EXAMPLES) falseSkipExamples.push(job);
    }
  }

  const missedTotal = missedLaunched + missedWarned;
  const missedRate = letThrough > 0 ? missedTotal / letThrough : 0;
  const cells: DupcheckCell[] = [];
  if (missedTotal >= DUPCHECK_MISSED_MIN && missedRate >= DUPCHECK_MISSED_RATE) {
    cells.push({
      key: 'missed', missedLaunched, missedWarned, letThrough, falseSkips: 0, examples: missedExamples,
    });
  }
  if (falseSkips >= DUPCHECK_FALSE_SKIP_MIN) {
    cells.push({
      key: 'false-skips', missedLaunched: 0, missedWarned: 0, letThrough: 0, falseSkips, examples: falseSkipExamples,
    });
  }
  return { cells, events, jobs: jobs.size, missedLaunched, missedWarned, letThrough, falseSkips };
}

/** The evidence pointers every prompt shares; the ledger, the stats verb and the gate module are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is metrics/dupcheck.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), schema queue.dupcheck-event.v1 — one row per `phm queue dupcheck <prompt> --gate` decision (skip, warn or launch) the dispatcher records before claiming a queue row via contrib/mac/launch_precheck.py, plus outcome rows the daemon\'s empty-tag-sync and `phm jobs empty --record` append when a let-through job finishes EMPTY already_done. `phm queue dupcheck --stats` folds the same ledger into checked/skips/warns/launches, warned_ended_already_done, launched_ended_already_done, false_skips and skip_precision; the Ideas list\'s dupcheck-gate signal ranks the same tallies.';

const NO_CHANGE = 'If the window has rolled forward, the gate\'s answers were right and the relaunches or finishes were legitimate, the misses trace to one producer\'s re-checked work rather than the gate, or the fix belongs to pinned ops machinery this repository cannot change — report no-change and name the evidence.';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function cellPrompt(cell: DupcheckCell, windowDays: number): string {
  const lines: string[] = [];
  if (cell.key === 'missed') {
    const missed = cell.missedLaunched + cell.missedWarned;
    lines.push(
      `Phantom's pre-launch dupcheck gate keeps letting through jobs that finish EMPTY already_done — ${plural(missed, 'job')} of ${plural(cell.letThrough, 'let-through job')} inside the ${windowDays}-day window ended already_done (${cell.missedLaunched} unflagged launches, ${cell.missedWarned} warned launches), the self-improvement work this backlog exists for.`,
      '',
      'Every fleet job the dispatcher claims passes the dupcheck gate before launch; a let-through job that still finishes EMPTY already_done is a duplicate the gate\'s recall missed — each one spent a launch to prove work master already had.',
    );
  } else {
    lines.push(
      `Phantom's pre-launch dupcheck gate keeps skipping jobs that get launched anyway — ${plural(cell.falseSkips, 'skipped job')} recorded a later launch or warn decision inside the ${windowDays}-day window, the self-improvement work this backlog exists for.`,
      '',
      'A false skip means the gate\'s high-confidence already_done verdict did not hold: either the skip was wrong, or the queue row came back without the evidence that would have changed the answer. Each one is suppressed work that had to be re-queued anyway.',
    );
  }
  lines.push('', EVIDENCE);
  if (cell.examples.length > 0) {
    lines.push('', `Example job ids: ${cell.examples.map((id) => jobText(id, 80)).join(', ')}.`);
  }
  lines.push(
    '',
    cell.key === 'missed'
      ? `Find out why let-through jobs keep ending already_done: join the missed job ids to metrics/jobs.jsonl for their lanes and sources, then decide which side owns the cause — dupcheck recall in src/core/queue/dupcheck.ts (the noun and verdict thresholds), warned jobs that should stop before launch, or producers minting already-done work. Run the affected suite. ${NO_CHANGE}`
      : `Find out why skipped jobs keep coming back: read the false-skip job ids against their decision rows, then decide which side owns the cause — a wrong high-confidence verdict in src/core/queue/dupcheck.ts, or queue rows re-queued without carrying what changed. Run the affected suite. ${NO_CHANGE}`,
  );
  return lines.join('\n');
}

function cellItem(cell: DupcheckCell, repo: string, windowDays: number): CloudBacklogItem {
  const id = `fleet-dupcheck-${createHash('sha256').update(`dupcheck-gate:${cell.key}`).digest('hex').slice(0, 16)}`;
  const title = cell.key === 'missed'
    ? `Dupcheck gate keeps missing duplicates (${cell.missedLaunched + cell.missedWarned} let-through jobs ended already_done)`
    : `Dupcheck gate keeps wrong-skipping jobs (${cell.falseSkips} skipped jobs launched anyway)`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: cellPrompt(cell, windowDays),
    area: 'fleet-dupcheck',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the dupcheck gate ledger's recurring precision cells.
 * Total: another repository, a withheld or unreadable ledger, or any read
 * or fold failure yields no items rather than throwing into discovery.
 */
export async function dupcheckGateBacklogItems(opts: DupcheckGateItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const now = opts.now ?? Date.now();
    let text: string | null;
    if (opts.eventsText !== undefined) {
      text = opts.eventsText;
    } else {
      const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(opts.homeDir ?? homedir(), '.ashlr-runs');
      const read = await readSource(join(runsDir, 'metrics', 'dupcheck.jsonl'), DUPCHECK_LEDGER_MAX_BYTES, true);
      text = read.state === 'healthy' ? read.text : null;
    }
    if (text === null) return [];
    const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : DUPCHECK_WINDOW_MS;
    const fold = foldDupcheckGate(text, { nowMs: now, windowMs });
    if (fold.cells.length === 0) return [];
    const windowDays = Math.max(1, Math.round(windowMs / 86_400_000));
    const limit = Math.max(1, Math.min(opts.limit ?? DUPCHECK_MAX_ITEMS, DUPCHECK_ITEM_HARD_MAX));
    return fold.cells.slice(0, limit).map((cell) => cellItem(cell, repo, windowDays));
  } catch {
    return [];
  }
}

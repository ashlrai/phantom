/**
 * Bridge source-heal journal recurring evidence →
 * self-improvement backlog items.
 *
 * Every bridge worktree creation runs healSource
 * (scripts/bridge-heal.mjs, called from scripts/bridge-worktree.mjs):
 * it probes the fleet source checkout's node_modules for the two tools
 * `phm doctor worktree` checks — tsgo and eslint — and on a broken
 * probe takes bridge-source-repair.lock under the source's .git and
 * runs `npm ci --ignore-scripts --no-audit --no-fund` at most once an
 * hour. Every call appends one
 * {schema: 'phm.bridge.source-heal/1', at, event, ok, reason, tsgo,
 * eslint} JSONL line to bridge-source-repair.jsonl beside the lock —
 * <source>/.git/ when the source has a .git directory, else the source
 * root (the same location rule worktree-doctor.ts repairLogPath
 * mirrors). The event vocabulary is closed: 'probe' records a healthy
 * source (reason 'source tools start'), while 'repaired', 'failed' and
 * 'skipped' all mean a probe found the source broken — the heal then
 * succeeded, failed, or was deferred by the lock wait, the hourly
 * repair cap or a lock error.
 *
 * Until now the journal's only reader was `phm doctor worktree`
 * (src/core/worktree-doctor.ts readRepairLog), which prints the last
 * five lines as a display tail — a point-in-time surface someone had
 * to open, never a recurrence fold: a source checkout whose toolchain
 * keeps breaking — every 'repaired', 'failed' or 'skipped' row is one
 * bridge worktree creation that found tsgo or eslint dead and degraded
 * verify-changed/typecheck for every job cloned from it — looked like
 * five rows in a report, never work. The journal describes this
 * install's own source checkout, so its recurring cells are direct
 * evidence.
 *
 * sourceHealBacklogItems carries the same journal into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the sibling fleet-evidence feeds
 * beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no lock, process
 *    or network is touched beyond the one git rev-parse findSource
 *    needs to locate the source checkout. A missing journal is the
 *    writer's normal first-run state; an unreadable one yields no
 *    items — unknown stays unknown, never a guessed tally — and a
 *    truncated tail folds the retained rows with the prompts stating
 *    the counts as lower bounds.
 *  - Rows count only under the writer's contract: the exact schema
 *    stamp, a parseable `at`, `event` inside the closed four-value
 *    vocabulary, boolean `ok`/`tsgo`/`eslint`, and a bounded non-empty
 *    `reason` string. Malformed lines are counted, never guessed.
 *  - Recurring means recorded across days at a rate that cannot be a
 *    transient burst: a kind emits only when its in-window records
 *    reach SOURCE_HEAL_MIN_UNITS across SOURCE_HEAL_MIN_DAYS distinct
 *    UTC days — one broken probe is a bad night, a one-day storm is a
 *    reinstall someone ran, recurrence across days is a toolchain
 *    that keeps dying. The window is anchored on the clock with the
 *    sibling feeds' future-skew allowance, and every row is already
 *    one healSource call — units count distinct broken-source probes,
 *    not retries inside one call.
 *  - The evidence is this install's source checkout: the journal
 *    lives inside the clone's own .git and records heals of that
 *    clone's node_modules, so items emit only when the backlog
 *    target's repository name is 'phantom', the same last-segment
 *    rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Item ids key on the event kind — never the
 *    counts or timestamps — so a refresh re-derives the same ids and
 *    appendUserBacklogItems adds only what is new; a toolchain that
 *    gets fixed simply stops re-adding.
 *  - Every journal string is untrusted text even though the writer
 *    controls it: reason text is scrubbed, flattened and capped again
 *    before it reaches a prompt, and cell identity stays the closed
 *    event vocabulary, never journal text.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';
import { findSource, realProbe, repairLogPath, type WorktreeProbe } from '../worktree-doctor.js';

/** Items one call may emit; only three event kinds can ever recur, so the cap is slack. */
export const SOURCE_HEAL_BACKLOG_MAX_ITEMS = 6;
const SOURCE_HEAL_ITEM_HARD_MAX = 12;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const SOURCE_HEAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, same convention the sibling folds tolerate. */
const SOURCE_HEAL_FUTURE_SKEW_MS = 60_000;
/** In-window records a kind needs before its recurrence counts. */
export const SOURCE_HEAL_MIN_UNITS = 3;
/** Distinct UTC days the records must span — recurring means recorded across days. */
export const SOURCE_HEAL_MIN_DAYS = 2;
/**
 * Bounded tail of the journal. The writer never rotates the file — one
 * line per healSource call, every bridge worktree creation — so 4 MiB
 * retains months of fleet traffic; a contract-violating larger file
 * still folds its newest rows with lower-bound counts.
 */
export const SOURCE_HEAL_FILE_TAIL_BYTES = 4 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** The writer's reasons are short constants (one carries an errno code); bound anyway. */
const MAX_REASON_CHARS = 512;
/** The fleet's own repository label: heal evidence is this install's source checkout, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The writer's schema stamp (HEAL_SCHEMA in scripts/bridge-heal.mjs). */
const HEAL_SCHEMA = 'phm.bridge.source-heal/1';
/** The closed event vocabulary healSource records. */
export const SOURCE_HEAL_EVENTS = ['probe', 'repaired', 'failed', 'skipped'] as const;
export type SourceHealEvent = (typeof SOURCE_HEAL_EVENTS)[number];
/** The kinds that mean a probe found the source broken — the adverse cells. */
export const SOURCE_HEAL_CELL_KINDS = ['repaired', 'failed', 'skipped'] as const;
export type SourceHealCellKind = (typeof SOURCE_HEAL_CELL_KINDS)[number];

export interface SourceHealItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Checkout root the source resolution starts from (default: process.cwd()). */
  root?: string;
  /** Worktree probe for findSource (default: realProbe); tests only. */
  probe?: WorktreeProbe;
  /** Direct journal path override; $ASHLR_BRIDGE_HEAL_LOG wins next when set (tests only). */
  logPath?: string;
  /** Most items one call emits (default SOURCE_HEAL_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default SOURCE_HEAL_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated journal row inside the evidence window. */
export interface SourceHealRow {
  atMs: number;
  utcDay: string;
  event: SourceHealEvent;
  ok: boolean;
  reason: string;
  tsgo: boolean;
  eslint: boolean;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isEvent = (value: unknown): value is SourceHealEvent =>
  typeof value === 'string' && (SOURCE_HEAL_EVENTS as readonly string[]).includes(value);

/**
 * Pure: validate one parsed journal line against the writer's record
 * contract — the exact schema stamp, a parseable `at`, the closed
 * event vocabulary, boolean ok/tsgo/eslint and a bounded non-empty
 * reason. Anything else is not a heal row.
 */
export function parseSourceHealEntry(value: unknown): SourceHealRow | null {
  if (!isRecord(value)) return null;
  if (value['schema'] !== HEAL_SCHEMA) return null;
  const at = value['at'];
  const atMs = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const event = value['event'];
  if (!isEvent(event)) return null;
  const ok = value['ok'];
  const tsgo = value['tsgo'];
  const eslint = value['eslint'];
  if (typeof ok !== 'boolean' || typeof tsgo !== 'boolean' || typeof eslint !== 'boolean') return null;
  const reason = value['reason'];
  if (typeof reason !== 'string' || reason === '' || reason.length > MAX_REASON_CHARS) return null;
  return { atMs, utcDay: utcDayOf(atMs), event, ok, reason, tsgo, eslint };
}

/**
 * Pure: parse one journal file's text into validated rows plus the
 * count of lines that were not on-contract records — malformed JSON
 * and off-contract rows are counted, never guessed.
 */
export function parseSourceHealLedger(text: string): { rows: SourceHealRow[]; invalidRows: number } {
  const rows: SourceHealRow[] = [];
  let invalidRows = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      invalidRows += 1;
      continue;
    }
    const row = parseSourceHealEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

/** One event kind's recurring tally across the in-window rows. */
export interface SourceHealCell {
  kind: SourceHealCellKind;
  /** healSource calls of this kind inside the window — each is one broken-source probe. */
  units: number;
  /** Distinct UTC days those calls fall on. */
  days: Set<string>;
  /** Reason-string tallies, raw writer text (scrubbed again at prompt time). */
  reasons: Map<string, number>;
  /** Rows whose recorded probe still showed tsgo broken. */
  tsgoBroken: number;
  /** Rows whose recorded probe still showed eslint broken. */
  eslintBroken: number;
  firstAtMs: number;
  lastAtMs: number;
}

/** Journal-recorded strings are untrusted text; flatten, scrub and cap before use. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/**
 * Pure: fold validated rows into per-kind tallies. 'probe' rows are
 * the healthy baseline — counted for context, never a cell — while
 * 'repaired', 'failed' and 'skipped' each mean a bridge worktree
 * creation found the source's toolchain broken.
 */
export function foldSourceHealEvidence(
  rows: readonly SourceHealRow[],
  opts: { nowMs: number; windowMs?: number },
): { cells: SourceHealCell[]; records: number; healthyProbes: number; outsideWindow: number } {
  const windowMs = opts.windowMs ?? SOURCE_HEAL_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const cells = new Map<SourceHealCellKind, SourceHealCell>();
  let inWindow = 0;
  let healthyProbes = 0;
  let outsideWindow = 0;
  for (const row of rows) {
    if (row.atMs < windowStart || row.atMs > opts.nowMs + SOURCE_HEAL_FUTURE_SKEW_MS) {
      outsideWindow += 1;
      continue;
    }
    inWindow += 1;
    if (row.event === 'probe') {
      healthyProbes += 1;
      continue;
    }
    let cell = cells.get(row.event);
    if (cell === undefined) {
      cell = {
        kind: row.event,
        units: 0,
        days: new Set(),
        reasons: new Map(),
        tsgoBroken: 0,
        eslintBroken: 0,
        firstAtMs: Infinity,
        lastAtMs: -Infinity,
      };
      cells.set(row.event, cell);
    }
    cell.units += 1;
    cell.days.add(row.utcDay);
    cell.reasons.set(row.reason, (cell.reasons.get(row.reason) ?? 0) + 1);
    if (!row.tsgo) cell.tsgoBroken += 1;
    if (!row.eslint) cell.eslintBroken += 1;
    cell.firstAtMs = Math.min(cell.firstAtMs, row.atMs);
    cell.lastAtMs = Math.max(cell.lastAtMs, row.atMs);
  }
  const recurring = [...cells.values()]
    .filter((cell) => cell.units >= SOURCE_HEAL_MIN_UNITS && cell.days.size >= SOURCE_HEAL_MIN_DAYS)
    .sort((a, b) => b.units - a.units || a.kind.localeCompare(b.kind));
  return { cells: recurring, records: inWindow, healthyProbes, outsideWindow };
}

/** The evidence pointers every prompt shares; the journal, its writer and its existing reader are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is bridge-source-repair.jsonl under the fleet source checkout\'s .git (or its root when the source has no .git directory): healSource in scripts/bridge-heal.mjs appends one {schema: \'phm.bridge.source-heal/1\', at, event, ok, reason, tsgo, eslint} line per call — scripts/bridge-worktree.mjs runs it on every bridge worktree creation — recording \'probe\' when the source tools already start and \'repaired\'/\'failed\'/\'skipped\' when a broken probe ended in a successful npm ci, a failed repair, or a deferred one (repair lock held, hourly cap, lock error). Until this feed the journal\'s only reader was `phm doctor worktree`\'s last-five-lines display in src/core/worktree-doctor.ts (findSource, repairLogPath, readRepairLog).';

const NO_CHANGE = 'If the window has rolled forward, the breakage was a one-off a reinstall already fixed, or the cause is owner-side or pinned ops machinery — npm registry reachability, disk space, credentials only Mason can fix — report no-change and name the evidence.';

const KIND_HEADLINE: Record<SourceHealCellKind, string> = {
  repaired: 'keeps having to repair',
  failed: 'keeps failing to repair',
  skipped: 'keeps deferring repairs for',
};

const KIND_FIND: Record<SourceHealCellKind, string> = {
  repaired:
    'Find what keeps breaking the source checkout\'s node_modules between bridge runs: the worktree reaper or a disk cleanup removing it, a manual install or npm ci run in the source, lockfile drift against origin/master, or a partial install that leaves tsgo/eslint dead. Reproduce read-only first — `phm doctor worktree` from a job worktree reports the source checkout, its branch, its lockfile match and the journal\'s tail.',
  failed:
    'Find why the repair does not restore the tools: compare the source checkout\'s package-lock.json against origin/master (`phm doctor worktree` reports the lock match — a mismatch means npm ci installs a stale tree), check npm registry reachability and disk space on the host, and look for a partial install that leaves .bin/tsgo or eslint/lib/cli.js missing. The reason tallies split npm-ci-failed from repaired-but-still-broken — they are different causes.',
  skipped:
    'Find what keeps the heal from running: a killed npm ci leaves bridge-source-repair.lock behind and every later heal waits out the ten-minute lock window before recording \'another repair has held the lock\' — check whether the lock or stamp files under the source\'s .git are stale, and whether \'already repaired within the last hour\' rows mean the source breaks again inside every repair interval (chronic breakage the cap can never catch up with) versus a wedged lock.',
};

function spanText(firstAtMs: number, lastAtMs: number): string {
  if (!Number.isFinite(firstAtMs) || !Number.isFinite(lastAtMs)) return '';
  const first = new Date(firstAtMs).toISOString();
  const last = new Date(lastAtMs).toISOString();
  return first === last ? ` Recorded ${first}.` : ` Recorded ${first} through ${last}.`;
}

function coverageNote(truncated: boolean, invalidRows: number, outsideWindow: number): string {
  const notes: string[] = [];
  if (truncated) notes.push('the bounded tail dropped older rows, so every count is a lower bound');
  if (invalidRows > 0) notes.push(`${invalidRows} malformed or off-contract lines dropped`);
  if (outsideWindow > 0) notes.push(`${outsideWindow} rows outside the window not counted`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

/** The cell's reason tallies as prompt text: top reasons by count, each scrubbed and capped. */
function reasonText(cell: SourceHealCell): string {
  const ranked = [...cell.reasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = ranked.slice(0, 4).map(([reason, count]) => `'${fieldText(reason)}' ×${count}`);
  const rest = ranked.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more distinct reason(s)` : shown.join(', ');
}

function healPrompt(
  cell: SourceHealCell,
  truncated: boolean,
  invalidRows: number,
  outsideWindow: number,
  healthyProbes: number,
): string {
  const toolText = [
    cell.tsgoBroken > 0 ? `tsgo still broken in ${cell.tsgoBroken} row(s)` : null,
    cell.eslintBroken > 0 ? `eslint still broken in ${cell.eslintBroken} row(s)` : null,
  ].filter((part): part is string => part !== null);
  const toolClause = toolText.length === 0 ? '' : ` Recorded tool state: ${toolText.join('; ')}.`;
  const healthy = healthyProbes > 0
    ? ` The same window recorded ${healthyProbes} healthy 'probe' row(s) (tools already starting), so the journal is live and this is intermittent breakage, not a dead log.`
    : '';
  return [
    `Phantom's bridge worktree self-heal ${KIND_HEADLINE[cell.kind]} the fleet source checkout's toolchain — ${cell.units} '${cell.kind}' record(s) across ${cell.days.size} UTC days inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each record is one healSource call (scripts/bridge-heal.mjs, run by scripts/bridge-worktree.mjs on every bridge worktree creation): it probes the source checkout's node_modules for tsgo and eslint — the same checks \`phm doctor worktree\` runs — and on a broken probe takes bridge-source-repair.lock under the source's .git and runs \`npm ci --ignore-scripts --no-audit --no-fund\` at most once an hour. This cell is the '${cell.kind}' outcome: ${reasonText(cell)}.${toolClause}${spanText(cell.firstAtMs, cell.lastAtMs)}${coverageNote(truncated, invalidRows, outsideWindow)}${healthy}`,
    '',
    EVIDENCE,
    '',
    `${KIND_FIND[cell.kind]} ${NO_CHANGE}`,
  ].join('\n');
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const KIND_TITLE: Record<SourceHealCellKind, string> = {
  repaired: 'Bridge source checkout keeps losing its toolchain',
  failed: 'Bridge source toolchain self-heal keeps failing',
  skipped: 'Bridge source toolchain self-heal keeps being skipped',
};

function sourceHealItem(
  cell: SourceHealCell,
  repo: string,
  truncated: boolean,
  invalidRows: number,
  outsideWindow: number,
  healthyProbes: number,
): CloudBacklogItem {
  return {
    id: `source-heal-${sha(`source-heal:${cell.kind}`)}`,
    title: KIND_TITLE[cell.kind].slice(0, MAX_TITLE_CHARS),
    prompt: healPrompt(cell, truncated, invalidRows, outsideWindow, healthyProbes),
    area: 'source-heal',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the bridge source-heal journal's recurring
 * evidence. Total: any read or fold failure yields no items rather
 * than throwing into discovery.
 */
export async function sourceHealBacklogItems(opts: SourceHealItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? SOURCE_HEAL_WINDOW_MS;

    // The journal lives inside the source checkout's .git (or its
    // root): an explicit path or $ASHLR_BRIDGE_HEAL_LOG wins (the same
    // override convention as $ASHLR_RUNS_DIR), else resolve the source
    // the same way the writer's caller does — findSource on the
    // process's checkout — through the pair the doctor uses. A
    // checkout git cannot identify has no journal to fold; unknown
    // stays unknown.
    let logPath = opts.logPath ?? process.env['ASHLR_BRIDGE_HEAL_LOG'];
    if (logPath === undefined) {
      const source = findSource(opts.root ?? process.cwd(), opts.probe ?? realProbe);
      if (source === null) return [];
      logPath = repairLogPath(source);
    }
    if (typeof logPath !== 'string' || logPath === '') return [];

    const read = await readLedgerTail(logPath, SOURCE_HEAL_FILE_TAIL_BYTES);
    if (read.state !== 'read') return [];
    const parsed = parseSourceHealLedger(read.text);

    const folded = foldSourceHealEvidence(parsed.rows, { nowMs, windowMs });
    const items: CloudBacklogItem[] = [];
    for (const cell of folded.cells) {
      items.push(sourceHealItem(cell, repo, read.truncated, parsed.invalidRows, folded.outsideWindow, folded.healthyProbes));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? SOURCE_HEAL_BACKLOG_MAX_ITEMS, SOURCE_HEAL_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}

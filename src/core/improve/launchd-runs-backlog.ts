/**
 * launchd run-sample telemetry → self-improvement backlog items.
 *
 * `phm autofix`'s launchd-crashloop fixer samples every monitored
 * `ai.ashlr.`/`com.ashlr.` launchd job on each pass: after `launchctl
 * print` succeeds it appends one JSON line to
 * <runs>/ledger/launchd-runs.jsonl (rememberSample in
 * src/core/autofix/launchd.ts):
 *
 *   {label, atMs, runs, lastExitCode, pid}
 *
 *   - label         the launchd job label collectLaunchd admitted
 *                  (`ai.ashlr.`/`com.ashlr.`-prefixed only).
 *   - atMs          the sample's epoch-ms timestamp.
 *   - runs          launchctl's cumulative spawn count for the job —
 *                  the crash-loop signal is its DELTA, never the level.
 *   - lastExitCode  the job's last recorded exit status (null when
 *                  launchctl reported 'never exited' or no number).
 *   - pid           the job's current pid (null when not running).
 *
 * collect.ts's readJournal folds the same rows into per-label
 * RunsSample[] that feed assessCrashRate — the live pass that decides
 * whether a job is crash-looping enough to disable. Until now the
 * journal's only reader was that pass itself: the samples are the
 * fixer's short-term memory, and no report or fold ever read the
 * history. A job whose runs kept churning or whose lastExitCode stayed
 * nonzero WITHOUT ever crossing the disable bar — sub-threshold
 * flakiness autofix correctly leaves alone — left no trace in
 * autofix.jsonl (no action was attempted, so no ledger line) and never
 * became work. launchdRunsBacklogItems carries the recorded samples
 * into discoverBacklog like the sibling backlog feeds.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no launchctl,
 *    process or network is touched. A missing file is the writer's
 *    normal first-run state — a fresh install whose Eng Ops ticks
 *    never reached a monitored job is clean, not degraded; an
 *    unreadable one is counted in the prompt's coverage note and a
 *    truncated tail folds the retained rows flagged as a lower bound.
 *  - Rows count only under the writer's contract. A sample needs a
 *    LABEL_RE label, a finite numeric atMs and a finite numeric runs
 *    >= 0; lastExitCode and pid stay optional finite numbers-or-null
 *    exactly as readJournal tolerates, except a non-finite number is
 *    treated as absent rather than recorded. Malformed lines and
 *    off-contract rows are counted, never guessed.
 *  - Adverse means recorded instability, judged by the fleet's own
 *    bars. A sample is exit-adverse when its lastExitCode is a finite
 *    nonzero number. The runs-churn signal reuses assessCrashRate's
 *    own hourDelta rule per sample: the oldest sample within the
 *    trailing HOUR_MS that is at least SAMPLE_GAP_MS older supplies
 *    the baseline, and a runs gain over CRASH_THRESHOLD is churn
 *    evidence — the same ">20 new runs in the last hour" bar the
 *    disable guard applies, never a re-guess. Runs is cumulative per
 *    boot, so only positive deltas count; a reset (negative delta), a
 *    flat count or a too-coarse sampling gap is not evidence.
 *  - Recurring means recorded across days. A label emits only at
 *    LAUNCHD_RUNS_MIN_ROWS adverse records across LAUNCHD_RUNS_MIN_DAYS
 *    distinct UTC days inside the 7-day window — the fleet's
 *    RECURRING_FAILURES convention the sibling feeds apply — so one
 *    crashy afternoon or a job still settling after an operator
 *    restart never queues a session.
 *  - The journal describes this install's launchd machinery and
 *    carries no repository column, so items emit only when the
 *    backlog target's repository name is 'phantom' — the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. The item id hashes the label only — never
 *    the tallies or timestamps — so a refresh re-derives the same id
 *    and appendUserBacklogItems adds only what is new; a job that
 *    recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, the label is scrubbed, flattened and
 *    capped before it is quoted, and the brief names the journal, the
 *    writer, the fold and the usual no-change escape naming the
 *    pinned/owner-side causes (the plist, launchd state and the
 *    job's own script are ops-side; this repo owns the sampler and
 *    the threshold, not the service).
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CRASH_THRESHOLD, HOUR_MS, SAMPLE_GAP_MS } from '../autofix/types.js';
import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells are bounded by distinct launchd labels. */
export const LAUNCHD_RUNS_BACKLOG_MAX_ITEMS = 8;
const LAUNCHD_RUNS_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const LAUNCHD_RUNS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on sample timestamps, same convention the sibling folds tolerate. */
const LAUNCHD_RUNS_FUTURE_SKEW_MS = 60_000;
/** Adverse records a label needs inside the window before it counts as recurring. */
export const LAUNCHD_RUNS_MIN_ROWS = 3;
/** Distinct UTC days those records must span — recurring means recorded across days. */
export const LAUNCHD_RUNS_MIN_DAYS = 2;
/**
 * Bounded tail for the sample journal. Rows run ~120 bytes, so 512 KiB
 * covers several thousand samples — far past a week of Eng Ops ticks;
 * a contract-violating larger file still folds its newest rows flagged
 * as a lower bound.
 */
export const LAUNCHD_RUNS_TAIL_BYTES = 512 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded label text is unbounded; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** The fleet's own repository label: launchd evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The writer's launchd-label contract (LABEL_RE in src/core/autofix/launchd.ts). */
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export interface LaunchdRunsItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding ledger/launchd-runs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default LAUNCHD_RUNS_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default LAUNCHD_RUNS_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated launchd-runs.jsonl row: a single launchd run sample for one label. */
export interface LaunchdRunSample {
  atMs: number;
  utcDay: string;
  label: string;
  runs: number;
  lastExitCode: number | null;
  pid: number | null;
}

/** One label's in-window sample fold: the recurring-instability cell the prompt quotes. */
export interface LaunchdRunCell {
  label: string;
  /** Valid in-window samples recorded for the label. */
  samples: number;
  /** Distinct UTC days the samples fall on. */
  days: Set<string>;
  /** Samples whose lastExitCode was a finite nonzero number. */
  exitRows: number;
  /** Distinct UTC days carrying at least one nonzero-exit sample. */
  exitDays: Set<string>;
  /** runs-churn episodes: samples whose trailing-hour runs gain exceeded CRASH_THRESHOLD. */
  churnRows: number;
  /** Distinct UTC days carrying at least one churn episode. */
  churnDays: Set<string>;
  /** Distinct nonzero exit codes recorded, most frequent first (capped). */
  exitCodes: { code: number; count: number }[];
  /** Newest sample's recorded runs count — context only, never a rate. */
  latestRuns: number | null;
  /** Newest sample's lastExitCode — the job's standing last termination. */
  latestExitCode: number | null;
  /** ISO bounds of the cell's recorded samples; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when a bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Optional finite-number-or-null field, matching readJournal's tolerance but refusing NaN/Infinity. */
function optionalFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Pure: validate one parsed launchd-runs.jsonl line against the writer's
 * rememberSample contract — a LABEL_RE label, a finite numeric atMs, a
 * finite numeric runs >= 0, and lastExitCode/pid tolerated as
 * number-or-absent exactly as collect.ts's readJournal reads them.
 * Anything else is not a sample row.
 */
export function parseLaunchdRunEntry(value: unknown): LaunchdRunSample | null {
  if (!isRecord(value)) return null;
  const label = value['label'];
  if (typeof label !== 'string' || !LABEL_RE.test(label)) return null;
  const atMs = value['atMs'];
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return null;
  const runs = value['runs'];
  if (typeof runs !== 'number' || !Number.isFinite(runs) || runs < 0) return null;
  return {
    atMs,
    utcDay: utcDayOf(atMs),
    label,
    runs,
    lastExitCode: optionalFinite(value['lastExitCode']),
    pid: optionalFinite(value['pid']),
  };
}

/**
 * Pure: parse one launchd-runs.jsonl file's text into validated samples
 * plus the count of lines that were not on-contract records — malformed
 * JSON and off-contract rows are counted, never guessed.
 */
export function parseLaunchdRunJournal(text: string): { rows: LaunchdRunSample[]; invalidRows: number } {
  const rows: LaunchdRunSample[] = [];
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
    const row = parseLaunchdRunEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const inWindow = (atMs: number, windowStartMs: number, nowMs: number): boolean =>
  atMs >= windowStartMs && atMs <= nowMs + LAUNCHD_RUNS_FUTURE_SKEW_MS;

/**
 * assessCrashRate's hourDelta rule applied per sample: the baseline is
 * the oldest sample within the trailing HOUR_MS that is at least
 * SAMPLE_GAP_MS older than the current one; a runs gain over
 * CRASH_THRESHOLD is one churn episode on the current sample's day.
 * Samples are pre-sorted by atMs per label. Only positive deltas count —
 * runs is cumulative per boot, so a reset is not churn.
 */
function churnEvidence(samples: readonly LaunchdRunSample[]): { episodes: number; days: Set<string> } {
  const days = new Set<string>();
  let episodes = 0;
  let baseline = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const cur = samples[i]!;
    const hourAgo = cur.atMs - HOUR_MS;
    const gapFloor = cur.atMs - SAMPLE_GAP_MS;
    while (baseline < i && samples[baseline]!.atMs < hourAgo) baseline += 1;
    if (baseline >= i) continue;
    const base = samples[baseline]!;
    if (base.atMs > gapFloor) continue;
    if (cur.runs - base.runs > CRASH_THRESHOLD) {
      episodes += 1;
      days.add(cur.utcDay);
    }
  }
  return { episodes, days };
}

/**
 * Pure: fold validated samples into per-label cells over the in-window
 * rows. Rows outside the window never join a cell. A label's churn
 * episodes come from its own time-ordered series; exit-adverse rows are
 * counted per sample. Cells keep every label — the items layer applies
 * the recurring bars.
 */
export function foldLaunchdRunCells(
  rows: readonly LaunchdRunSample[],
  opts: { nowMs: number; windowMs?: number },
  lowerBound = false,
): LaunchdRunCell[] {
  const windowMs = opts.windowMs ?? LAUNCHD_RUNS_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const byLabel = new Map<string, LaunchdRunSample[]>();
  for (const row of rows) {
    if (!inWindow(row.atMs, windowStart, opts.nowMs)) continue;
    const list = byLabel.get(row.label) ?? [];
    list.push(row);
    byLabel.set(row.label, list);
  }
  const cells: LaunchdRunCell[] = [];
  for (const [label, samples] of byLabel) {
    samples.sort((a, b) => a.atMs - b.atMs || a.runs - b.runs);
    const days = new Set<string>();
    const exitDays = new Set<string>();
    const exitCodes = new Map<number, number>();
    let exitRows = 0;
    let firstMs: number | null = null;
    let lastMs: number | null = null;
    let latest: LaunchdRunSample | null = null;
    for (const sample of samples) {
      days.add(sample.utcDay);
      firstMs = firstMs === null ? sample.atMs : Math.min(firstMs, sample.atMs);
      lastMs = lastMs === null ? sample.atMs : Math.max(lastMs, sample.atMs);
      latest = sample;
      if (sample.lastExitCode !== null && sample.lastExitCode !== 0) {
        exitRows += 1;
        exitDays.add(sample.utcDay);
        exitCodes.set(sample.lastExitCode, (exitCodes.get(sample.lastExitCode) ?? 0) + 1);
      }
    }
    const churn = churnEvidence(samples);
    cells.push({
      label,
      samples: samples.length,
      days,
      exitRows,
      exitDays,
      churnRows: churn.episodes,
      churnDays: churn.days,
      exitCodes: [...exitCodes.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count || a.code - b.code)
        .slice(0, 4),
      latestRuns: latest?.runs ?? null,
      latestExitCode: latest?.lastExitCode ?? null,
      firstSeen: firstMs === null ? null : new Date(firstMs).toISOString(),
      lastSeen: lastMs === null ? null : new Date(lastMs).toISOString(),
      lowerBound,
    });
  }
  return cells.sort((a, b) =>
    (b.exitRows + b.churnRows) - (a.exitRows + a.churnRows)
    || b.samples - a.samples
    || a.label.localeCompare(b.label));
}

/** The evidence pointers every prompt shares; the write-only-telemetry gap is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is <runs>/ledger/launchd-runs.jsonl — the runs dir resolves as $ASHLR_RUNS_DIR, then ~/.ashlr-runs. fixLaunchdCrashloop (src/core/autofix/launchd.ts) appends one {label, atMs, runs, lastExitCode, pid} sample per monitored ai.ashlr.*/com.ashlr.* job on every `phm autofix` pass after `launchctl print` succeeds; collect.ts\'s readJournal folds the same rows into the RunsSample[] assessCrashRate consumes for the live disable decision. Until this feed the journal\'s only reader was that pass itself — the samples are the fixer\'s short-term memory, never a recurrence fold.';

const NO_CHANGE = 'If the window has rolled forward, the samples were a one-off burst an operator restart or plist edit already absorbed, the nonzero exits or churn trace to pinned ops machinery or host state this repo does not own (the LaunchAgent plist, launchd itself, the job\'s own script under ~/.ashlr-runs/bin, Security GATES v3 files under contrib/mac), the job was since disabled or its plist retired, or the cause is owner-only — report no-change and name the evidence.';

function seenText(firstSeen: string | null, lastSeen: string | null): string {
  if (firstSeen === null || lastSeen === null) return '';
  return firstSeen === lastSeen
    ? ` Recorded ${firstSeen}.`
    : ` Recorded ${firstSeen} through ${lastSeen}.`;
}

function boundText(lowerBound: boolean): string {
  return lowerBound ? ' A bounded journal tail was truncated, so these counts are a lower bound.' : '';
}

function coverageNote(invalidRows: number): string {
  return invalidRows > 0 ? ` ${invalidRows} malformed or off-contract lines dropped.` : '';
}

function exitCodeText(codes: readonly { code: number; count: number }[]): string {
  return codes.length === 0 ? '' : ` Recorded nonzero exits: ${codes.map((c) => `${c.code} ×${c.count}`).join(', ')}.`;
}

function launchdPrompt(cell: LaunchdRunCell, invalidRows: number): string {
  const label = fieldText(cell.label);
  const adverse = cell.exitRows + cell.churnRows;
  const adverseDays = new Set([...cell.exitDays, ...cell.churnDays]).size;
  const parts: string[] = [];
  if (cell.exitRows > 0) parts.push(`${cell.exitRows} sample(s) recorded a nonzero last exit code across ${cell.exitDays.size} UTC day(s)`);
  if (cell.churnRows > 0) parts.push(`${cell.churnRows} sample(s) showed the runs count gaining more than ${CRASH_THRESHOLD} inside a trailing hour across ${cell.churnDays.size} UTC day(s)`);
  const latest = cell.latestRuns === null ? 'runs unknown' : `latest recorded runs ${cell.latestRuns}`;
  const standing = cell.latestExitCode === null ? '' : cell.latestExitCode === 0 ? ' last exit 0' : ` last exit ${cell.latestExitCode}`;
  return [
    `Phantom's launchd run-sample journal keeps recording instability for '${label}' — ${adverse} adverse record(s) across ${adverseDays} UTC day(s) inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one \`phm autofix\` pass's \`launchctl print\` sample for the job (${cell.samples} recorded): ${parts.join('; ')}. ${latest}${standing}.${exitCodeText(cell.exitCodes)}${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}${coverageNote(invalidRows)}`,
    '',
    EVIDENCE,
    '',
    `Find why this launchd job keeps flaking below the autofix disable bar: the sampler and the crash threshold this repo owns are src/core/autofix/launchd.ts (assessCrashRate, CRASH_THRESHOLD in types.ts) and the journal writer rememberSample; the job's plist, its script under ~/.ashlr-runs/bin and launchd state are ops-side. Check whether the exits cluster on one failure the job's own logging names, whether the churn is a KeepAlive respawn loop a plist or script fix would stop, whether the sampler's sampling cadence makes healthy jobs look churning, or whether the job should be retired. Fix what lives here; if the cause is ops-pinned machinery, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function launchdItem(cell: LaunchdRunCell, repo: string, invalidRows: number): CloudBacklogItem {
  const id = `launchd-runs-${createHash('sha256').update(`launchd-runs:${cell.label}`).digest('hex').slice(0, 16)}`;
  const label = fieldText(cell.label);
  const display = label.length > 120 ? `${label.slice(0, 119)}…` : label;
  const title = `Launchd job '${display}' keeps flaking below the autofix bar`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: launchdPrompt(cell, invalidRows),
    area: 'autofix',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * Backlog items for the launchd run-sample journal's recurring
 * per-label instability: labels at the adverse-row+day bars. Total: any
 * read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function launchdRunsBacklogItems(opts: LaunchdRunsItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the writer's own readers apply: explicit dir, then
    // a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? LAUNCHD_RUNS_WINDOW_MS;

    const read = await readLedgerTail(join(runsDir, 'ledger', 'launchd-runs.jsonl'), LAUNCHD_RUNS_TAIL_BYTES);
    if (read.state !== 'read') return [];
    const parsed = parseLaunchdRunJournal(read.text);
    if (parsed.rows.length === 0) return [];

    const cells = foldLaunchdRunCells(parsed.rows, { nowMs, windowMs }, read.truncated);
    const recurring = cells.filter((cell) => {
      const adverseDays = new Set([...cell.exitDays, ...cell.churnDays]);
      return cell.exitRows + cell.churnRows >= LAUNCHD_RUNS_MIN_ROWS && adverseDays.size >= LAUNCHD_RUNS_MIN_DAYS;
    });
    if (recurring.length === 0) return [];

    const limit = Math.max(1, Math.min(opts.limit ?? LAUNCHD_RUNS_BACKLOG_MAX_ITEMS, LAUNCHD_RUNS_ITEM_HARD_MAX));
    return recurring.slice(0, limit).map((cell) => launchdItem(cell, repo, parsed.invalidRows));
  } catch {
    return [];
  }
}

/**
 * Efficiency-baseline ranked bottleneck evidence → self-improvement backlog items.
 *
 * The ops-side `ai.ashlr.efficiency-hourly` launchd job
 * (~/.ashlr-runs/bin/efficiency_hourly.py — pinned machinery, not this
 * repo) appends one `ashlr.efficiency-hourly/v1` row per hourly pass to
 * `<runs>/ledger/efficiency-hourly.jsonl`: host/lane outcome sections
 * (lanes, exec, processes, pauses, harness, worktrees, ci) plus a
 * `ranked` list — the writer's top-N measured bottlenecks, each carrying
 * a stable `key`, a fixed `item` label, an Eng Ops `owner` label, a
 * `unit`, an optional `cost_per_day`, a `rank`, a `detail` payload and
 * `source`/`lower_bound`/`note` qualifiers — and a static `unmeasured`
 * instrumentation-gap list. The ledger exists so fleet efficiency is
 * measured at all: per-lane merges and tokens, agent exec-trace wall
 * time, live process CPU/RSS, the memory guard's paused fraction, CI
 * runner wall samples, worktree disk footprint and per-session harness
 * size.
 *
 * Until now the ledger's only readers were other ops-side rollups
 * (telemetry_index.py, node_capacity_sampler.py,
 * node_capacity_rollup.py) and the job's own optional `--report`
 * baseline markdown — a report someone had to run and read. A
 * bottleneck that stayed ranked week over week — full-suite test runs
 * in agent sessions, an outsized per-session prompt harness, CI runner
 * wall time, worktree disk growth, repeated builds/installs/rescans —
 * never became work even though every row is measured evidence with a
 * named owner axis. efficiencyBacklogItems carries the recurring
 * ranked cells into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read once through readLedgerTail's
 *    bounded no-follow tail; rows are validated against the writer's
 *    contract — schema `ashlr.efficiency-hourly/v1`, a parseable `ts`
 *    and a `ranked` array — and nothing is written and no process,
 *    file tree or network is touched.
 *  - Missing or unreadable evidence yields no items. An absent,
 *    non-file or unreadable ledger reads as no evidence — unknown
 *    stays unknown, never a guessed tally — while a truncated tail
 *    still folds the retained rows with the prompts stating the
 *    counts as lower bounds.
 *  - Rows the writer marked degraded (`errors` non-empty: a section
 *    threw and its metrics are partial or absent) never count toward
 *    recurrence — a partial measurement cannot prove a pattern. They
 *    are tallied and disclosed in the prompts instead.
 *  - Recurring means recorded, on the sibling feeds' bars: a cell
 *    emits only while it appears in `ranked` on at least
 *    EFFICIENCY_MIN_ROWS distinct hourly samples across at least
 *    EFFICIENCY_MIN_DAYS separate UTC days inside the window — the
 *    writer's own top-N cut means a cell that recovered simply stops
 *    appearing, and the already-emitted item stops re-adding through
 *    downstream dedup.
 *  - Only cells with a repo-side fix surface emit. The ranked
 *    vocabulary is closed writer machinery: host-level cells
 *    (fs_indexer, fleet_control_plane, git_maintenance, build_test,
 *    session_rss), the memory guard's dispatch_paused cell — already
 *    folded from metrics/swapout-rate.jsonl by memoryBacklogItems —
 *    and the process-class `install` variant (unit core-hours/day,
 *    host install processes rather than agent-session installs) have
 *    no change this repository can ship, so they never mint items.
 *    Actionable cells are exactly the seven agent-efficiency axes
 *    below; anything outside the map is context, never work.
 *  - The evidence carries no repository dimension — it describes this
 *    install's host and fleet machinery. Items therefore emit only
 *    when the backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Item ids are stable slugs of the actionable
 *    cell — never the counts, ranks or timestamps — so a refresh
 *    re-derives the same ids and appendUserBacklogItems adds only what
 *    is new; shifted tallies do not spawn twin items.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded (unpriced cells say so, lower bounds are
 *    stated, the codex-lanes-only exec-trace coverage is named), the
 *    brief names the journal, the ops-side writer and its pinned
 *    boundary, and the usual no-change escape covers a window that
 *    rolled forward or a cause that lives outside this repo.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the actionable cell set is small and closed. */
export const EFFICIENCY_BACKLOG_MAX_ITEMS = 8;
const EFFICIENCY_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const EFFICIENCY_WINDOW_HOURS = 168;
/** A cell emits only after appearing in `ranked` on this many distinct hourly samples... */
export const EFFICIENCY_MIN_ROWS = 3;
/** ...spread across at least this many distinct UTC days. */
export const EFFICIENCY_MIN_DAYS = 2;
/**
 * Bounded tail of the append-only ledger. Rows run ~30–40 KB (the ci and
 * worktrees detail payloads dominate), so 8 MiB retains ~200 hourly
 * samples — more than the 168-hour window — and prompts state any
 * truncation as a lower bound.
 */
const EFFICIENCY_LEDGER_TAIL_BYTES = 8 * 1024 * 1024;
/** The writer's schema tag; anything else is not this ledger's evidence. */
const EFFICIENCY_SCHEMA = 'ashlr.efficiency-hourly/v1';
const EFFICIENCY_LEDGER_RELATIVE = join('ledger', 'efficiency-hourly.jsonl');
/** The fleet's own repository label: efficiency evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on ledger timestamps. */
const SKEW_MS = 300_000;
const HOUR_MS = 3_600_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 120;
/** Distinct repo rows quoted inside the ci-wall prompt. */
const MAX_CI_REPOS = 3;

export interface EfficiencyItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding ledger/efficiency-hourly.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default EFFICIENCY_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default EFFICIENCY_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Stable cell slug for a writer `key`/`unit` pair: lowercase, every
 * non-alphanumeric run becomes '-', edges trimmed. 'test_full' +
 * 'session wall-hours/day' → 'test-full|session-wall-hours-day'.
 */
function slugPair(key: string, unit: string): { keySlug: string; unitSlug: string } {
  const slug = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return { keySlug: slug(key), unitSlug: slug(unit) };
}

// ---------------------------------------------------------------------------
// Actionable cells — the closed set of ranked keys with a repo-side fix surface
// ---------------------------------------------------------------------------

type EfficiencyKind =
  | 'test-selection'
  | 'harness-size'
  | 'ci-wall'
  | 'worktree-footprint'
  | 'agent-builds'
  | 'agent-installs'
  | 'agent-rescans';

interface ActionableSpec {
  /** Backlog id suffix: the emitted id is `efficiency-<slug>`. */
  slug: string;
  /** Normalized unit slug the writer records for this cell; anything else is a different measurement. */
  unit: string;
  kind: EfficiencyKind;
}

/**
 * The actionable vocabulary, keyed by normalized writer `key`. The unit
 * constraint keeps the process-class `install` variant ('local install
 * processes on the Mac', core-hours/day — host install processes, not
 * agent-session installs) out: it shares the key but measures a different
 * thing with no repo-side fix. Excluded on purpose: dispatch_paused
 * (memory-backlog owns memory pressure), fs_indexer, fleet_control_plane,
 * git_maintenance, build_test and session_rss (host/machine resources no
 * repo change repairs).
 */
const ACTIONABLE: Readonly<Record<string, ActionableSpec>> = {
  'test-full': { slug: 'test-full', unit: 'session-wall-hours-day', kind: 'test-selection' },
  'harness': { slug: 'harness-size', unit: 'bytes-session', kind: 'harness-size' },
  'ci-minutes': { slug: 'ci-minutes', unit: 'runner-wall-hours-day', kind: 'ci-wall' },
  'worktrees': { slug: 'worktrees', unit: 'gb-disk', kind: 'worktree-footprint' },
  'build': { slug: 'agent-builds', unit: 'session-wall-hours-day', kind: 'agent-builds' },
  'install': { slug: 'agent-installs', unit: 'session-wall-hours-day', kind: 'agent-installs' },
  'scan': { slug: 'agent-rescans', unit: 'session-wall-hours-day', kind: 'agent-rescans' },
};

// ---------------------------------------------------------------------------
// Fold — validated rows into per-cell recurrence evidence
// ---------------------------------------------------------------------------

/** One validated ranked sighting: the writer's recorded fields, nothing inferred. */
export interface EfficiencySighting {
  atMs: number;
  utcDay: string;
  /** Recorded rank inside the writer's top-N (null when the row carried none usable). */
  rank: number | null;
  /** Recorded cost_per_day — 0.0 is a recorded measurement, null is unpriced. */
  costPerDay: number | null;
  /** Recorded unit text, scrubbed and capped ('unrecorded' when absent). */
  unit: string;
  /** Recorded item label, scrubbed and capped. */
  item: string;
  /** True when the writer flagged the figure a lower bound. */
  lowerBound: boolean;
  /** Recorded disk_gb figure (worktrees cells), null when unrecorded. */
  diskGb: number | null;
  /** Recorded ram_gb figure (untimed cells), null when unrecorded. */
  ramGb: number | null;
  /** The entry's detail payload, kept for per-kind scalar extraction; null when absent. */
  detail: Record<string, unknown> | null;
}

/** One actionable cell's recurrence tally plus its newest sighting. */
export interface EfficiencyCell {
  /** Normalized 'keySlug|unitSlug' cell identity. */
  id: string;
  /** The actionable spec this cell maps to. */
  spec: ActionableSpec;
  /** Distinct hourly samples the cell appeared in inside the window. */
  rows: number;
  /** Sorted distinct UTC days those samples fell on. */
  days: string[];
  /** ISO bounds of the cell's sightings; null when none carried a usable timestamp (unreachable while a cell exists). */
  firstSeen: string | null;
  lastSeen: string | null;
  /** The newest in-window sighting — every quoted figure comes from it. */
  latest: EfficiencySighting | null;
}

export interface EfficiencyEvidence {
  /** 'known' when the window holds at least one valid in-window row; 'unknown' is no evidence, never a zero. */
  state: 'known' | 'unknown';
  /** Schema-valid rows inside the window. */
  rows: number;
  /** Lines that were not a valid ledger row; ignored, never guessed. */
  invalidRows: number;
  /** Valid rows the writer marked degraded (non-empty `errors`); excluded from recurrence, disclosed in prompts. */
  degradedRows: number;
  /** Valid rows dated outside the window or in the future; not evidence either way. */
  outsideWindow: number;
  /** True when the retained tail dropped older bytes — coverage is the retained window only. */
  ledgerTruncated: boolean;
  /** Ranked-array entries skipped for missing key/item strings, across valid rows. */
  malformedRanked: number;
  /** Actionable cells folded, recurrence-filtered or not. */
  cells: EfficiencyCell[];
}

const recordedText = (value: unknown): string =>
  typeof value === 'string' && value.trim() !== '' ? fieldText(value, MAX_NAME_CHARS) || 'unrecorded' : 'unrecorded';

/**
 * One ranked entry under the writer's contract: an object carrying a
 * non-empty `key` and `item` string. Every other field is optional —
 * rank/cost_per_day/disk_gb/ram_gb are numbers or null, lower_bound a
 * boolean, detail an object or absent — and extras are ignored for
 * forward compatibility.
 */
function rankedSighting(value: unknown, atMs: number): { sighting: EfficiencySighting; spec: ActionableSpec; cellId: string } | null {
  if (!isRecord(value)) return null;
  const key = value['key'];
  const item = value['item'];
  if (typeof key !== 'string' || key.trim() === '' || typeof item !== 'string' || item.trim() === '') return null;
  const { keySlug, unitSlug } = slugPair(key, recordedText(value['unit']));
  const spec = ACTIONABLE[keySlug];
  if (spec === undefined || spec.unit !== unitSlug) return null;
  const unitRaw = value['unit'];
  const detail = isRecord(value['detail']) ? value['detail'] : null;
  return {
    spec,
    cellId: `${keySlug}|${unitSlug}`,
    sighting: {
      atMs,
      utcDay: dayOf(atMs),
      rank: num(value['rank']),
      costPerDay: num(value['cost_per_day']),
      unit: typeof unitRaw === 'string' && unitRaw.trim() !== '' ? fieldText(unitRaw, MAX_NAME_CHARS) : 'unrecorded',
      item: fieldText(item, MAX_NAME_CHARS),
      lowerBound: value['lower_bound'] === true,
      diskGb: num(value['disk_gb']),
      ramGb: num(value['ram_gb']),
      detail,
    },
  };
}

/** A row is degraded when the writer recorded any section error — partial measurement, never recurrence proof. */
function rowDegraded(row: Record<string, unknown>): boolean {
  const errors = row['errors'];
  if (isRecord(errors)) return Object.keys(errors).length > 0;
  if (Array.isArray(errors)) return errors.length > 0;
  return false;
}

/**
 * Pure: fold parsed ledger lines into the efficiency evidence. `values`
 * are the JSON.parsed ledger lines; each must carry the writer's schema
 * tag, a parseable `ts` inside the window and a `ranked` array —
 * anything else is invalidRows, out-of-window rows are outsideWindow,
 * degraded rows are degradedRows, and only clean in-window rows feed the
 * actionable cells. Unknown stays unknown: an empty window reports
 * state 'unknown', never a zero.
 */
export function foldEfficiencyEvidence(
  values: readonly unknown[],
  opts: { nowMs: number; windowHours?: number },
): EfficiencyEvidence {
  const windowHours = opts.windowHours ?? EFFICIENCY_WINDOW_HOURS;
  const nowMs = opts.nowMs;
  const since = nowMs - windowHours * HOUR_MS;
  const until = nowMs + SKEW_MS;
  const evidence: EfficiencyEvidence = {
    state: 'unknown', rows: 0, invalidRows: 0, degradedRows: 0, outsideWindow: 0,
    ledgerTruncated: false, malformedRanked: 0, cells: [],
  };
  const cells = new Map<string, EfficiencyCell>();
  for (const value of values) {
    if (!isRecord(value)) { evidence.invalidRows += 1; continue; }
    if (value['schema'] !== EFFICIENCY_SCHEMA) { evidence.invalidRows += 1; continue; }
    const ts = value['ts'];
    const atMs = typeof ts === 'string' ? Date.parse(ts) : Number.NaN;
    if (!Number.isFinite(atMs)) { evidence.invalidRows += 1; continue; }
    const ranked = value['ranked'];
    if (!Array.isArray(ranked)) { evidence.invalidRows += 1; continue; }
    if (atMs < since || atMs > until) { evidence.outsideWindow += 1; continue; }
    if (rowDegraded(value)) { evidence.degradedRows += 1; continue; }
    evidence.rows += 1;
    if (evidence.state === 'unknown') evidence.state = 'known';
    for (const entry of ranked) {
      const folded = rankedSighting(entry, atMs);
      if (folded === null) {
        const rec = isRecord(entry) ? entry : null;
        if (rec === null || typeof rec['key'] !== 'string' || typeof rec['item'] !== 'string') evidence.malformedRanked += 1;
        continue;
      }
      let cell = cells.get(folded.cellId);
      if (cell === undefined) {
        cell = {
          id: folded.cellId, spec: folded.spec, rows: 0, days: [],
          firstSeen: null, lastSeen: null, latest: null,
        };
        cells.set(folded.cellId, cell);
      }
      cell.rows += 1;
      if (!cell.days.includes(folded.sighting.utcDay)) cell.days.push(folded.sighting.utcDay);
      cell.days.sort();
      const iso = new Date(atMs).toISOString();
      if (cell.firstSeen === null || iso < cell.firstSeen) cell.firstSeen = iso;
      if (cell.lastSeen === null || iso > cell.lastSeen) cell.lastSeen = iso;
      if (cell.latest === null || atMs >= cell.latest.atMs) cell.latest = folded.sighting;
    }
  }
  evidence.cells = [...cells.values()].sort((a, b) => {
    const ra = a.latest?.rank ?? Number.MAX_SAFE_INTEGER;
    const rb = b.latest?.rank ?? Number.MAX_SAFE_INTEGER;
    return ra - rb || a.id.localeCompare(b.id);
  });
  return evidence;
}

/** Recurrence bars: enough distinct samples across enough distinct days. */
function recurring(cell: EfficiencyCell): boolean {
  return cell.rows >= EFFICIENCY_MIN_ROWS && cell.days.length >= EFFICIENCY_MIN_DAYS;
}

// ---------------------------------------------------------------------------
// Prompts — measured evidence, repo-side suspects, ops boundary, no-change escape
// ---------------------------------------------------------------------------

const NO_CHANGE = 'If the window has rolled forward, the cell dropped out of the writer\'s ranked top-N on its own, the measured cost was a one-off burst the later samples recovered from, or the cause is owner-only or pinned ops machinery (the efficiency_hourly.py producer and other ~/.ashlr-runs/bin launchd jobs, contrib/mac dispatcher files, host hardware and owner-side apps, Security GATES v3 files, billing) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the journal, its ops-side writer and its existing readers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is ledger/efficiency-hourly.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), schema ashlr.efficiency-hourly/v1 — one row per hourly pass of the ops-side efficiency baseline (ai.ashlr.efficiency-hourly launchd job, ~/.ashlr-runs/bin/efficiency_hourly.py, pinned machinery outside this repo) carrying lanes/exec/processes/pauses/harness/worktrees/ci sections and a top-N `ranked` measured-bottleneck list, folded by this feed through the writer\'s own row contract. Until now the ledger\'s only readers were other ops-side rollups (telemetry_index.py, node_capacity_sampler.py, node_capacity_rollup.py) and the job\'s optional --report baseline markdown — a report someone had to run and read — so a bottleneck that stayed ranked never became work.';

function spanText(cell: EfficiencyCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` First and last recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function costText(cell: EfficiencyCell): string {
  const latest = cell.latest;
  if (latest === null) return 'cost unrecorded';
  const cost = latest.costPerDay === null ? 'unpriced' : `${latest.costPerDay} ${latest.unit}`;
  const rank = latest.rank === null ? 'rank unrecorded' : `rank ${latest.rank}`;
  const bound = latest.lowerBound ? ' (writer-flagged lower bound)' : '';
  return `${cost}, ${rank}${bound}`;
}

function coverageNote(ev: EfficiencyEvidence): string {
  const notes: string[] = [];
  if (ev.ledgerTruncated) notes.push('the retained tail dropped older rows, so every count is a lower bound');
  if (ev.invalidRows > 0) notes.push(`${ev.invalidRows} malformed lines dropped`);
  if (ev.degradedRows > 0) notes.push(`${ev.degradedRows} degraded rows (writer-recorded section errors) excluded from recurrence`);
  if (ev.malformedRanked > 0) notes.push(`${ev.malformedRanked} ranked entries missing key/item strings skipped`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

/** detail scalar lookup: finite numbers only, everything else is unrecorded. */
function detailNum(detail: Record<string, unknown> | null, key: string): number | null {
  if (detail === null) return null;
  return num(detail[key]);
}

function detailRecord(detail: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  if (detail === null) return null;
  const value = detail[key];
  return isRecord(value) ? value : null;
}

/** 'unknown' for absent measurements — never a fabricated zero. */
const measured = (value: number | null, digits = 1): string =>
  value === null ? 'unrecorded' : String(Number(value.toFixed(digits)));

function testSelectionPrompt(cell: EfficiencyCell, ev: EfficiencyEvidence): string {
  const d = cell.latest?.detail ?? null;
  const fullCmds = detailNum(d, 'full_commands_rank_window');
  const fullMin = detailNum(d, 'full_wall_min_rank_window');
  const tgtCmds = detailNum(d, 'targeted_commands_rank_window');
  const tgtMin = detailNum(d, 'targeted_wall_min_rank_window');
  const fullMean = detailNum(d, 'full_p_mean_s');
  const tgtMean = detailNum(d, 'targeted_mean_s');
  return [
    `Agent sessions keep running test suites beyond the affected-only selection — the efficiency baseline ranked 'local test runs beyond affected-only (full-suite invocations in agent sessions)' on ${cell.rows} hourly samples across ${cell.days.length} UTC days inside the window (${costText(cell)}), the self-improvement work this backlog exists for.`,
    '',
    `The newest recorded split: ${measured(fullCmds, 0)} full-suite commands (${measured(fullMin)} wall-minutes in the rank window, mean ${measured(fullMean)}s each) against ${measured(tgtCmds, 0)} targeted commands (${measured(tgtMin)} wall-minutes, mean ${measured(tgtMean)}s each) — full-suite invocations are the minority of commands but the heaviest per-invocation class.${spanText(cell)}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `The exec-trace coverage is codex lanes only — claude-lane logs keep final text, so the tally undercounts fleet-wide full-suite runs rather than overstating them. Find where agent sessions are told or choose to run full suites: the local gate's affected-test selection (scripts/verify-changed.mjs and the ci-affected selection it shares logic with), the test:ci lane selection, the agent-facing guidance in AGENTS.md/CLAUDE.md and the launch prompts this repo assembles. If the full-suite runs are already targeted-by-necessity (a change that genuinely needs the whole suite) or the residual is ops-side — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function harnessSizePrompt(cell: EfficiencyCell, ev: EfficiencyEvidence): string {
  const d = cell.latest?.detail ?? null;
  const windowH = detailNum(d, 'window_h');
  const files = detailNum(d, 'prompt_files');
  const p50 = detailNum(d, 'prompt_bytes_p50');
  const p95 = detailNum(d, 'prompt_bytes_p95');
  const total = detailNum(d, 'prompt_bytes_total');
  const mcp = detailNum(d, 'mcp_procs_per_running_session_p50');
  const samples = detailNum(d, 'mcp_samples');
  return [
    `The per-session harness stays a top measured cost — the efficiency baseline ranked 'harness size per session' on ${cell.rows} hourly samples across ${cell.days.length} UTC days inside the window (${costText(cell)}), the self-improvement work this backlog exists for.`,
    '',
    `The newest recorded sizes: prompt p50 ${measured(p50, 0)} bytes, p95 ${measured(p95, 0)} bytes across ${measured(files, 0)} prompt files in the ${measured(windowH, 0)}h window (${measured(total, 0)} bytes total), with ${measured(mcp)} MCP server processes per running session at p50 over ${measured(samples, 0)} load-curve samples.${spanText(cell)}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Every byte of prompt and every MCP tool description is paid on every session launch, so a harness that stays ranked is a standing per-job token cost. The surfaces this repo owns: launch-prompt assembly (src/core/run/prompts and the fleet planner/session prompt builders), the MCP tool surface agents are handed, and the agent-facing docs injected into jobs. Look for repeated or low-value prompt sections, tool descriptions that could be lazy or trimmed, and docs that ride every launch without earning their tokens. If the size is already minimal for the fleet's actual needs — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function ciWallPrompt(cell: EfficiencyCell, ev: EfficiencyEvidence): string {
  const latest = cell.latest;
  const d = latest?.detail ?? null;
  const repos: string[] = [];
  if (d !== null) {
    const rows = Object.entries(d)
      .map(([name, v]) => {
        const rec = isRecord(v) ? v : null;
        return { name: fieldText(name, 60), wall: rec === null ? null : num(rec['wall_min_sampled']), perPr: rec === null ? null : num(rec['per_merged_pr_sampled']), total: rec === null ? null : num(rec['runs_total']), sampled: rec === null ? null : num(rec['runs_sampled']) };
      })
      .filter((r) => r.name !== '')
      .sort((a, b) => (b.wall ?? -1) - (a.wall ?? -1))
      .slice(0, MAX_CI_REPOS);
    for (const r of rows) {
      repos.push(`${r.name} ${measured(r.wall)} sampled wall-min${r.perPr === null ? '' : ` (${measured(r.perPr)} per merged PR)`}${r.total !== null && r.sampled !== null && r.total > r.sampled ? ', sampled-only lower bound' : ''}`);
    }
  }
  const repoText = repos.length === 0 ? 'per-repo detail unrecorded' : repos.join('; ');
  const lower = latest?.lowerBound === true ? ' The writer flags the figure a lower bound where a repo\'s run inventory exceeded the sample page.' : '';
  return [
    `Hosted-runner CI wall time stays a top measured cost — the efficiency baseline ranked 'CI run wall time on hosted runners' on ${cell.rows} hourly samples across ${cell.days.length} UTC days inside the window (${costText(cell)}), the self-improvement work this backlog exists for.`,
    '',
    `This is runner wall-hours on GitHub-hosted runners, not Mac CPU: ${repoText}.${spanText(cell)}${lower}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `The repo-side surface is the CI selection and partitioning logic under .github/scripts/ — the ci-fast-*, ci-risk-*, ci-release-*, ci-mcp-*, ci-affected-* and ci-release-gate modules decide which suites and lanes each change pays for. .github/workflows itself is off-limits to agents, and the other ecosystem repos' workflows are their own repositories' concern. Find whether selection breadth, suite partitioning, caching or retry policy in the scripts can cut runner wall without weakening the required checks; if the cost is workflow shape only ops can change — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function worktreePrompt(cell: EfficiencyCell, ev: EfficiencyEvidence): string {
  const latest = cell.latest;
  const d = latest?.detail ?? null;
  const registered = detailNum(d, 'registered_worktrees_all_repos');
  const flatEntries = detailNum(d, 'runs_dir_flat_entries');
  const dispatchd = detailRecord(d, 'dispatchd');
  const kept = dispatchd === null ? null : num(dispatchd['kept_worktrees']);
  const reaping = dispatchd === null ? null : num(dispatchd['reaping']);
  const disk = latest?.diskGb ?? null;
  return [
    `The worktree footprint stays a top measured cost — the efficiency baseline ranked 'worktree footprint (linked worktrees, not full clones)' on ${cell.rows} hourly samples across ${cell.days.length} UTC days inside the window (${costText(cell)}), the self-improvement work this backlog exists for.`,
    '',
    `The newest recorded footprint: ${disk === null ? 'disk size unrecorded this sample' : `${measured(disk)} GB disk`}; ${measured(registered, 0)} worktrees registered across repos, ${measured(flatEntries, 0)} flat entries in the runs dir, and the dispatcher's own bookkeeping keeping ${measured(kept, 0)} while ${measured(reaping, 0)} sit in its reaping set.${spanText(cell)}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Hundreds of registered worktrees slow every git operation on the shared repos (gc, prune, worktree list) and fill the disk the fleet needs for builds. The repo-side surfaces: the worktree census and reap machinery (src/core/fleet/worktrees.ts, src/core/inbox/temp-worktree-reaper.ts), the keep-list policy deciding which worktrees survive, and the queue-side bookkeeping that decides reaping vs kept. The wt root layout, the launchd reaper schedule and the dispatcher's pinned reaping constants are ops machinery — if the evidence says the caps or the root layout are wrong, report no-change and name the measurement. ${NO_CHANGE}`,
  ].join('\n');
}

function execCategoryPrompt(cell: EfficiencyCell, ev: EfficiencyEvidence, kind: 'agent-builds' | 'agent-installs' | 'agent-rescans'): string {
  const label = kind === 'agent-builds'
    ? 'per-agent builds and typechecks (no shared content-addressed build cache)'
    : kind === 'agent-installs'
      ? 'per-agent dependency installs (no shared install cache)'
      : 'repo-wide rescans per session (no precomputed context index)';
  const d = cell.latest?.detail ?? null;
  const cmds = detailNum(d, 'commands_rank_window');
  const wallMin = detailNum(d, 'wall_min_rank_window');
  const sessions = detailNum(d, 'sessions_traced_rank_window');
  const perSession = detailNum(d, 'per_session');
  const perPr = detailNum(d, 'wall_min_per_merged_pr_traced_lanes');
  const shortMin = detailNum(d, 'wall_min_short_window');
  const noun = kind === 'agent-builds' ? 'build/typecheck' : kind === 'agent-installs' ? 'install' : 'repo-rescan';
  return [
    `Agent sessions keep paying ${noun} wall time — the efficiency baseline ranked '${label}' on ${cell.rows} hourly samples across ${cell.days.length} UTC days inside the window (${costText(cell)}), the self-improvement work this backlog exists for.`,
    '',
    `The newest recorded tally: ${measured(cmds, 0)} ${noun} commands (${measured(wallMin)} wall-minutes in the rank window) across ${measured(sessions, 0)} traced sessions — ${measured(perSession)} commands per session, ${measured(perPr)} wall-minutes per merged PR on the traced lanes, ${measured(shortMin)} wall-minutes in the short window.${spanText(cell)}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Coverage is codex lanes only — the exec traces come from <job>.log files the codex lanes keep; claude-lane logs retain final text, so the tally undercounts rather than overstates. The durable fix is shared caching infrastructure (a content-addressed build or install cache) which is ops-side, but this repo owns the agent-facing guidance: AGENTS.md/CLAUDE.md and the launch prompts decide whether agents re-run installs, rebuild from clean, or re-scan the repo when a narrower command or a cached artifact would do. Find the repo-side guidance or tooling win first; if the residual is purely the missing shared cache — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

const PROMPT_BUILDERS: Record<EfficiencyKind, (cell: EfficiencyCell, ev: EfficiencyEvidence) => string> = {
  'test-selection': testSelectionPrompt,
  'harness-size': harnessSizePrompt,
  'ci-wall': ciWallPrompt,
  'worktree-footprint': worktreePrompt,
  'agent-builds': (cell, ev) => execCategoryPrompt(cell, ev, 'agent-builds'),
  'agent-installs': (cell, ev) => execCategoryPrompt(cell, ev, 'agent-installs'),
  'agent-rescans': (cell, ev) => execCategoryPrompt(cell, ev, 'agent-rescans'),
};

const KIND_TITLES: Record<EfficiencyKind, string> = {
  'test-selection': 'Agent sessions keep running full test suites beyond affected-only selection',
  'harness-size': 'Per-session prompt harness stays a top measured cost',
  'ci-wall': 'Hosted-runner CI wall time stays a top measured cost',
  'worktree-footprint': 'Worktree disk footprint stays a top measured cost',
  'agent-builds': 'Agent sessions keep paying build and typecheck wall time',
  'agent-installs': 'Agent sessions keep paying dependency-install wall time',
  'agent-rescans': 'Agent sessions keep paying repo-rescan wall time',
};

function efficiencyItem(id: string, title: string, prompt: string, repo: string): CloudBacklogItem {
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'fleet-efficiency',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * Backlog items for the efficiency baseline's recurring ranked
 * bottleneck cells. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function efficiencyBacklogItems(opts: EfficiencyItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling feeds apply: explicit dir, then a
    // non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env value
    // is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const ledger = await readLedgerTail(join(runsDir, EFFICIENCY_LEDGER_RELATIVE), EFFICIENCY_LEDGER_TAIL_BYTES);
    if (ledger.state !== 'read') return [];
    const values: unknown[] = [];
    for (const line of ledger.text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { values.push(JSON.parse(line)); } catch { values.push(null); }
    }
    const evidence = foldEfficiencyEvidence(values, { nowMs, windowHours: opts.windowHours });
    evidence.ledgerTruncated = ledger.truncated;
    const items: CloudBacklogItem[] = [];
    for (const cell of evidence.cells) {
      if (!recurring(cell)) continue;
      items.push(efficiencyItem(
        `efficiency-${cell.spec.slug}`,
        KIND_TITLES[cell.spec.kind],
        PROMPT_BUILDERS[cell.spec.kind](cell, evidence),
        repo,
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? EFFICIENCY_BACKLOG_MAX_ITEMS, EFFICIENCY_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}

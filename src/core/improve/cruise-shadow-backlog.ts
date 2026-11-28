/**
 * Cruise shadow-controller journal → self-improvement backlog items.
 *
 * The ops-side cruise package (~/.ashlr-runs/bin/cruise-pkg — pinned
 * machinery, not this repository) samples host pressure on a ~5 minute
 * cadence and appends one `ashlr.cruise.shadow.v1` record per pass to
 * <runs>/metrics/cruise-shadow.jsonl. Each record carries the
 * controller's verdict — `cruise.zone` (ok | warn | danger | unknown,
 * from learned stress thresholds plus the OS pressure level and
 * thermal state), `cruise.action` (the lane-target move the controller
 * would take: hold_foreign when foreign — non-fleet — pressure
 * dominates, decrease/shed when it would pull fleet capacity,
 * hold_warn/raise_warmup on the milder bands) — and the dispatchd
 * state the sample saw (`dispatchd.running_total`, `target_total`,
 * `queued_total`, `paused`, `last_tick`), plus `bad_event`, the
 * `sample` pressure block and the `reasons` list behind the verdict.
 *
 * Until now the journal had no reader at all: the controller's own
 * state file and heartbeat are ops-side surfaces, so a host that kept
 * sampling danger-zone stress — whether because fleet lane targets
 * oversubscribed it, because foreign (owner-side) pressure dominated,
 * or because the fleet's job mix kept loading it — never became work
 * even though every row is measured evidence about this install's
 * capacity posture. cruiseShadowBacklogItems carries the journal into
 * discoverBacklog so `phm improve discover` and the scheduler's
 * autoDiscover queue the recurring cells like the sibling
 * fleet-evidence sources.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; records are validated by their own
 *    fields — the shadow schema, mode 'shadow', a parseable
 *    in-window timestamp, a zone inside the controller's closed
 *    vocabulary and an action string — and nothing is written and no
 *    process, file tree or network is touched. A missing, unreadable
 *    or non-file journal yields no items; a truncated tail still
 *    folds the retained records with the prompts stating the counts
 *    as lower bounds.
 *  - Only adverse zones are evidence. 'ok' samples are the controller
 *    healthy and 'unknown' is a cold-start/no-evidence verdict —
 *    neither counts toward a cell. warn and danger samples fold;
 *    bad_event rows count as context, never as their own cell.
 *  - Recurring means sampled across days: a cell emits only at
 *    CRUISE_SHADOW_MIN_SAMPLES records across CRUISE_SHADOW_MIN_DAYS
 *    distinct UTC days inside the window, so one bad afternoon never
 *    queues a session.
 *  - The evidence carries no repository dimension — it describes this
 *    install's host and fleet. Items therefore emit only when the
 *    backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Reasons are generated strings, never quoted: the fold counts
 *    them by their leading signal class only (pressure_score,
 *    foreign_pressure, os_pressure_*, thermal_*, cold_start, load,
 *    memory, swap, other) so a prompt can say WHICH pressure signal
 *    dominated without quoting floats or parameter dumps.
 *  - Recipients of the signal stay honest: the dispatchd totals are
 *    quoted as recorded ranges — running vs target shows whether the
 *    fleet was at its lane ceiling or leaving admitted capacity
 *    idle while the controller read danger — and unknown fields stay
 *    absent, never zero.
 *  - Dedup is downstream. The item id embeds a stable hash of the
 *    (zone, action) cell only — never counts, timestamps or reason
 *    text — so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; a host that
 *    recovers simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { parseLedgerTs } from '../metrics/loop.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; cells are bounded by zone x action diversity (the controller's closed vocabulary is small). */
export const CRUISE_SHADOW_MAX_ITEMS = 6;
const CRUISE_SHADOW_ITEM_HARD_MAX = 12;
/** A cell emits only at this many in-window samples... */
export const CRUISE_SHADOW_MIN_SAMPLES = 3;
/** ...across at least this many distinct UTC days. */
export const CRUISE_SHADOW_MIN_DAYS = 2;
/** Evidence window: the sibling fleet-evidence convention. */
export const CRUISE_SHADOW_WINDOW_HOURS = 168;
/** Newest-bytes bound on the shadow journal; a record is ~1-2 KB so this covers the whole window at the ~5-minute cadence. */
const CRUISE_SHADOW_TAIL_BYTES = 8 * 1024 * 1024;
/** Journal path under the runs root: metrics/cruise-shadow.jsonl, the writer's own location. */
const CRUISE_SHADOW_JOURNAL_RELATIVE = join('metrics', 'cruise-shadow.jsonl');
/** The producer's record schema literal (cruise shadow mode), inlined so this reader validates the persisted contract without importing ops-side code. */
const CRUISE_SHADOW_SCHEMA = 'ashlr.cruise.shadow.v1';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: cruise evidence is this install's host and fleet, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Five-minute future skew tolerance for clock drift between the writer's host and the reader, matching the sibling folds. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Zone/action strings are producer vocabulary; anything past this bound is foreign and the row is skipped. */
const MAX_LABEL_CHARS = 64;
/** Reason entries are generated strings; the leading signal class is all this fold keeps. */
const MAX_REASON_CHARS = 256;
/** Reason classes quoted per cell in prompts; the rest fold into 'other'. */
const MAX_REASON_CLASSES = 6;

/**
 * The controller's closed zone vocabulary (ZONES in the ops-side
 * controller plus its 'unknown' cold-start verdict), mirrored so this
 * reader validates persisted rows without importing the package.
 */
const CRUISE_ZONES: ReadonlySet<string> = new Set(['ok', 'warn', 'danger', 'unknown']);
/** The only zones that carry adverse evidence: warn stops admission, danger sheds capacity. */
const ADVERSE_ZONES: ReadonlySet<string> = new Set(['warn', 'danger']);

/**
 * The leading signal class of one recorded reason string. The
 * controller emits generated reasons — "<signal> z=<float>",
 * "foreign_pressure fleet_mem_share=<float>", "os_pressure_critical",
 * "thermal_serious", "cold_start" — so the class is the token before
 * the first space or '=' (a bare "fleet_mem_share=<float>" reason
 * still names its signal), bounded to identifier characters;
 * anything else is 'other'. Numbers and parameter dumps never reach
 * a prompt.
 */
export type CruiseReasonClass =
  | 'pressure_score'
  | 'foreign_pressure'
  | 'os_pressure'
  | 'thermal'
  | 'cold_start'
  | 'load'
  | 'memory'
  | 'swap'
  | 'fleet_share'
  | 'other';

const REASON_CLASS: ReadonlyMap<string, CruiseReasonClass> = new Map([
  ['pressure_score', 'pressure_score'],
  ['foreign_pressure', 'foreign_pressure'],
  ['os_pressure_critical', 'os_pressure'],
  ['os_pressure_warn', 'os_pressure'],
  ['thermal_critical', 'thermal'],
  ['thermal_serious', 'thermal'],
  ['thermal_nominal', 'thermal'],
  ['cold_start', 'cold_start'],
  ['load1', 'load'],
  ['load5', 'load'],
  ['load15', 'load'],
  ['load_per_core', 'load'],
  ['mem_free_pct', 'memory'],
  ['compressed_bytes', 'memory'],
  ['swap_used_bytes', 'swap'],
  ['swap_used_mb', 'swap'],
  ['fleet_mem_share', 'fleet_share'],
]);

export function classifyCruiseReason(reason: string): CruiseReasonClass {
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > MAX_REASON_CHARS) return 'other';
  const head = reason.split(/[= ]/, 1)[0] ?? '';
  return REASON_CLASS.get(head) ?? 'other';
}

/** One validated adverse sample: the controller's verdict plus the fleet state it saw. */
export interface CruiseShadowSample {
  atMs: number;
  zone: 'warn' | 'danger';
  action: string;
  /** The controller's stress score when the row carried a finite one. */
  stress: number | null;
  badEvent: boolean;
  /** dispatchd totals the sample recorded; each null when the row omitted or malformed it. */
  runningTotal: number | null;
  targetTotal: number | null;
  queuedTotal: number | null;
  reasonClasses: CruiseReasonClass[];
}

/** One (zone, action) cell: the recurring verdict identity. */
export interface CruiseShadowCell {
  zone: 'warn' | 'danger';
  action: string;
  /** In-window samples folded into the cell. */
  samples: number;
  /** Distinct UTC days the samples fall on. */
  days: number;
  /** bad_event rows inside the cell. */
  badEvents: number;
  /** Highest recorded stress score; null when no sample carried one. */
  maxStress: number | null;
  /** Highest recorded queued_total; null when no sample carried one. */
  maxQueued: number | null;
  /** Samples whose recorded running_total sat below target_total — fleet capacity left idle under stress. */
  idleCapacitySamples: number;
  /** Highest recorded running_total and target_total; null when never recorded. */
  maxRunning: number | null;
  maxTarget: number | null;
  /** Samples carrying any dispatchd total at all (coverage context for the prompt). */
  dispatchdSamples: number;
  /** Reason classes by recorded frequency, capped at MAX_REASON_CLASSES. */
  reasonClasses: { cls: CruiseReasonClass; count: number }[];
  /** ISO bounds of the cell's samples; null when none carried a usable timestamp (cannot happen — samples require one). */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the journal's bounded tail cut older records: counts are a lower bound. */
  lowerBound: boolean;
}

/** The repository name the fleet machinery records: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const label = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_LABEL_CHARS ? value : null;

/**
 * Pure: validate one shadow-journal tail into adverse samples. A record
 * counts only under the producer's contract — schema
 * 'ashlr.cruise.shadow.v1', mode 'shadow', an in-window non-future
 * timestamp, a zone inside the controller's closed vocabulary that is
 * adverse (warn|danger), an action string, and dispatchd totals that
 * are finite numbers when present. 'ok'/'unknown' zones, foreign
 * schemas, malformed JSON, untimestamped and future-stamped records
 * and shapeless cruise blocks are all skipped, never guessed.
 */
export function parseCruiseShadowSamples(text: string, cutoffMs: number, nowMs: number): CruiseShadowSample[] {
  const samples: CruiseShadowSample[] = [];
  const horizon = nowMs + FUTURE_SKEW_MS;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Cheap prefilter: every valid record names the shadow schema.
    if (!line.includes(CRUISE_SHADOW_SCHEMA)) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (r['schema'] !== CRUISE_SHADOW_SCHEMA) continue;
    if (r['mode'] !== 'shadow') continue;
    const atMs = parseLedgerTs(r['ts']);
    if (atMs === null || atMs > horizon || atMs < cutoffMs) continue;
    const cruise = r['cruise'];
    if (cruise === null || typeof cruise !== 'object' || Array.isArray(cruise)) continue;
    const c = cruise as Record<string, unknown>;
    const zoneRaw = c['zone'];
    if (typeof zoneRaw !== 'string' || !CRUISE_ZONES.has(zoneRaw) || !ADVERSE_ZONES.has(zoneRaw)) continue;
    const zone = zoneRaw as 'warn' | 'danger';
    const action = label(c['action']);
    if (action === null) continue;
    const stress = finite(c['stress']);
    const dispatchd = r['dispatchd'];
    const d = dispatchd !== null && typeof dispatchd === 'object' && !Array.isArray(dispatchd)
      ? dispatchd as Record<string, unknown>
      : null;
    const runningTotal = d === null ? null : finite(d['running_total']);
    const targetTotal = d === null ? null : finite(d['target_total']);
    const queuedTotal = d === null ? null : finite(d['queued_total']);
    const reasons = c['reasons'];
    const reasonClasses: CruiseReasonClass[] = [];
    if (Array.isArray(reasons)) {
      for (const entry of reasons) {
        if (typeof entry === 'string') reasonClasses.push(classifyCruiseReason(entry));
      }
    }
    samples.push({
      atMs,
      zone,
      action,
      stress,
      badEvent: r['bad_event'] === true,
      runningTotal,
      targetTotal,
      queuedTotal,
      reasonClasses,
    });
  }
  return samples;
}

/**
 * Pure: fold validated samples into per-(zone, action) cells. Every
 * sample counts once — the ~5-minute cadence means `samples` is the
 * recurrence measure and `days` the distinct-day proof.
 */
export function foldCruiseShadowCells(samples: readonly CruiseShadowSample[], lowerBound = false): CruiseShadowCell[] {
  const cells = new Map<string, {
    zone: 'warn' | 'danger';
    action: string;
    samples: number;
    days: Set<string>;
    badEvents: number;
    maxStress: number | null;
    maxQueued: number | null;
    idleCapacitySamples: number;
    maxRunning: number | null;
    maxTarget: number | null;
    dispatchdSamples: number;
    reasonCounts: Map<CruiseReasonClass, number>;
    firstMs: number;
    lastMs: number;
  }>();
  for (const sample of samples) {
    const key = `${sample.zone}|${sample.action}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        zone: sample.zone,
        action: sample.action,
        samples: 0,
        days: new Set(),
        badEvents: 0,
        maxStress: null,
        maxQueued: null,
        idleCapacitySamples: 0,
        maxRunning: null,
        maxTarget: null,
        dispatchdSamples: 0,
        reasonCounts: new Map(),
        firstMs: sample.atMs,
        lastMs: sample.atMs,
      };
      cells.set(key, cell);
    }
    cell.samples += 1;
    cell.days.add(new Date(sample.atMs).toISOString().slice(0, 10));
    if (sample.badEvent) cell.badEvents += 1;
    if (sample.stress !== null) cell.maxStress = cell.maxStress === null ? sample.stress : Math.max(cell.maxStress, sample.stress);
    if (sample.queuedTotal !== null) cell.maxQueued = cell.maxQueued === null ? sample.queuedTotal : Math.max(cell.maxQueued, sample.queuedTotal);
    if (sample.runningTotal !== null || sample.targetTotal !== null || sample.queuedTotal !== null) {
      cell.dispatchdSamples += 1;
      if (sample.runningTotal !== null && sample.targetTotal !== null && sample.runningTotal < sample.targetTotal) {
        cell.idleCapacitySamples += 1;
      }
      if (sample.runningTotal !== null) cell.maxRunning = cell.maxRunning === null ? sample.runningTotal : Math.max(cell.maxRunning, sample.runningTotal);
      if (sample.targetTotal !== null) cell.maxTarget = cell.maxTarget === null ? sample.targetTotal : Math.max(cell.maxTarget, sample.targetTotal);
    }
    for (const cls of sample.reasonClasses) {
      cell.reasonCounts.set(cls, (cell.reasonCounts.get(cls) ?? 0) + 1);
    }
    cell.firstMs = Math.min(cell.firstMs, sample.atMs);
    cell.lastMs = Math.max(cell.lastMs, sample.atMs);
  }
  return [...cells.values()]
    .map((cell) => ({
      zone: cell.zone,
      action: cell.action,
      samples: cell.samples,
      days: cell.days.size,
      badEvents: cell.badEvents,
      maxStress: cell.maxStress,
      maxQueued: cell.maxQueued,
      idleCapacitySamples: cell.idleCapacitySamples,
      maxRunning: cell.maxRunning,
      maxTarget: cell.maxTarget,
      dispatchdSamples: cell.dispatchdSamples,
      reasonClasses: [...cell.reasonCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_REASON_CLASSES)
        .map(([cls, count]) => ({ cls, count })),
      firstSeen: new Date(cell.firstMs).toISOString(),
      lastSeen: new Date(cell.lastMs).toISOString(),
      lowerBound,
    }))
    .sort((a, b) => b.samples - a.samples || a.zone.localeCompare(b.zone) || a.action.localeCompare(b.action));
}

const NO_CHANGE = 'If the window has rolled forward and the controller now reads ok, the stress was transient host load that has since cleared; if the danger samples are foreign (owner-side) pressure the fleet cannot relieve — the reasons classes will say foreign_pressure or os_pressure dominant — the honest outcome is no-change naming that evidence, since no fleet-side change makes another tenant\'s memory pressure ours; if the controller is pinned ops machinery whose thresholds or actions need retuning, that retune is a Security-reviewed ops change a session reports rather than edits; and if recurring danger with queued work is simply this host being undersized for the fleet\'s lane targets, whether the targets should become stress-aware is this repository\'s call only if the lane-target machinery lives here.';

/** The evidence pointers every prompt shares; the journal's writer and its absent prior readers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is metrics/cruise-shadow.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): the ops-side cruise package (~/.ashlr-runs/bin/cruise-pkg — pinned machinery, not this repository) appends one ashlr.cruise.shadow.v1 record per ~5-minute sample — {ts, mode:\'shadow\', kill, pause, bad_event, profile, sample:{pressure_level, pressure_score, free_pct, swap_used_bytes, compressed_bytes, load1, load_per_core, thermal}, cruise:{zone, stress, top, reasons[], action, target, prev_target, ceiling, knee, shed, warmup, params}, memguard_measured, dispatchd:{last_tick, paused, running_total, target_total, queued_total, ...}}. Zones are ok | warn | danger | unknown (warn stops admission, danger sheds one session and shrinks the target); actions observed are hold_foreign (foreign/non-fleet pressure dominates), decrease and shed (pull fleet capacity), hold_warn and raise_warmup (milder bands). Until this feed the journal had no reader at all — the controller\'s own state and heartbeat are ops-side surfaces nobody folds. Reason strings are generated ("<signal> z=<float>", "foreign_pressure fleet_mem_share=<float>", "os_pressure_critical", "thermal_serious", "cold_start"); this fold counts them by leading signal class only and never quotes floats or parameter dumps.';

/** What this repository owns on the capacity path, stated once for every cell. */
const OWNERSHIP = 'What this repository owns is the fleet side the samples describe: lane targets and their audit trail (src/core/improve/lane-target-changes-backlog.ts folds queue/lane-target-changes.log; the writers live in the queue machinery), admission and market routing (src/core/fleet/, src/core/queue/, work-market.v1 route_decision rows in metrics/work-market.jsonl), the ready queue the queued_total counts, and the job mix that loads the host. What it does not own is the cruise controller itself — ops-side pinned Python under ~/.ashlr-runs/bin/cruise-pkg, changed only through Security review and re-pin — the dispatchd lane caps it advises on (contrib/mac, same pin boundary), foreign processes\' memory and CPU (owner-side apps the fleet_mem_share reason exists to measure), and the host\'s physical capacity.';

const ZONE_TEXT: Record<CruiseShadowCell['zone'], string> = {
  warn: 'warn — the controller stopped admitting new fleet work',
  danger: 'danger — the controller shed or shrank fleet capacity',
};

const ACTION_TEXT: Record<string, string> = {
  hold_foreign: 'hold_foreign — foreign (non-fleet) pressure dominates, so the controller holds fleet targets steady rather than shed work it did not cause',
  decrease: 'decrease — the controller would multiplicatively shrink the fleet lane target',
  shed: 'shed — the controller would pull one session\'s worth of fleet capacity',
  hold_warn: 'hold_warn — the controller holds admission at the warn band',
  raise_warmup: 'raise_warmup — the controller is probing back up from a warm-up hold',
};

function actionText(cell: CruiseShadowCell): string {
  return ACTION_TEXT[cell.action] ?? `action '${cell.action}' — a controller verdict outside the commonly observed set`;
}

function reasonText(cell: CruiseShadowCell): string {
  if (cell.reasonClasses.length === 0) return 'No reason classes were recorded on the folded samples.';
  const parts = cell.reasonClasses.map(({ cls, count }) => `${cls} (${count})`);
  const rest = cell.reasonClasses.length >= MAX_REASON_CLASSES ? ' plus lower-frequency classes' : '';
  return `Dominant recorded reason classes: ${parts.join(', ')}${rest}.`;
}

function dispatchdText(cell: CruiseShadowCell): string {
  if (cell.dispatchdSamples === 0) return 'No sample carried dispatchd totals, so fleet running/target/queued state is unknown for this cell.';
  const parts: string[] = [];
  if (cell.maxRunning !== null) parts.push(`peak running_total ${cell.maxRunning}`);
  if (cell.maxTarget !== null) parts.push(`peak target_total ${cell.maxTarget}`);
  if (cell.maxQueued !== null) parts.push(`peak queued_total ${cell.maxQueued}`);
  if (cell.idleCapacitySamples > 0) {
    parts.push(`${cell.idleCapacitySamples} of ${cell.dispatchdSamples} dispatchd-carrying sample(s) showed running_total below target_total — fleet capacity admitted but idle while the controller read ${cell.zone}`);
  }
  return `Across ${cell.dispatchdSamples} dispatchd-carrying sample(s): ${parts.join('; ')}.${cell.idleCapacitySamples === 0 ? ' Every dispatchd-carrying sample showed the fleet at or above its lane target.' : ''}`;
}

function seenText(cell: CruiseShadowCell): string {
  return cell.firstSeen === cell.lastSeen
    ? ` Sampled ${cell.firstSeen}.`
    : ` Sampled ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function boundText(cell: CruiseShadowCell): string {
  return cell.lowerBound ? ' The journal tail was truncated, so these counts are a lower bound.' : '';
}

function cruiseShadowPrompt(cell: CruiseShadowCell): string {
  return [
    `Phantom's host keeps recording ${ZONE_TEXT[cell.zone]} cruise-controller samples whose verdict is '${cell.action}' — ${cell.samples} samples across ${cell.days} separate UTC day(s) inside the window${cell.badEvents > 0 ? `, including ${cell.badEvents} bad_event row(s)` : ''}.`,
    '',
    `${actionText(cell)}. ${ZONE_TEXT[cell.zone]}. ${reasonText(cell)} ${dispatchdText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    OWNERSHIP,
    '',
    `Find whether the recurring verdict is a fleet-side gap this repository can close — whether lane targets or admission should respond to the stress the controller keeps recording, whether the fleet's job mix or lane hints are loading the host the samples describe, or whether foreign pressure is being misattributed to fleet capacity. If the pressure is foreign/owner-side, the controller is pinned ops machinery needing a Security-reviewed retune, or the host is simply undersized for the targets — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function cruiseShadowItem(cell: CruiseShadowCell, repo: string): CloudBacklogItem {
  const id = `fleet-cruise-shadow-${createHash('sha256').update(`cruise-shadow:${cell.zone}:${cell.action}`).digest('hex').slice(0, 16)}`;
  const title = `Cruise shadow controller keeps reading ${cell.zone}/${cell.action}`.slice(0, MAX_TITLE_CHARS);
  return {
    id,
    title,
    prompt: cruiseShadowPrompt(cell),
    area: 'cruise-shadow',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

export interface CruiseShadowItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/cruise-shadow.jsonl; $ASHLR_RUNS_DIR wins when set, else <home>/.ashlr-runs. */
  runsDir?: string;
  /** Journal override (default: join(runsDir, 'metrics', 'cruise-shadow.jsonl'), the writer's own location). */
  journalPath?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default CRUISE_SHADOW_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default CRUISE_SHADOW_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/**
 * Backlog items for the cruise shadow-controller journal's recurring
 * adverse cells. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function cruiseShadowBacklogItems(opts: CruiseShadowItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling fleet-evidence feeds apply: explicit
    // dir, then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an
    // empty env value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const journalPath = opts.journalPath ?? join(runsDir, CRUISE_SHADOW_JOURNAL_RELATIVE);
    const nowMs = (opts.now ?? new Date()).getTime();
    const cutoffMs = nowMs - (opts.windowHours ?? CRUISE_SHADOW_WINDOW_HOURS) * 3_600_000;
    const tail = await readLedgerTail(journalPath, CRUISE_SHADOW_TAIL_BYTES);
    const samples = tail.state === 'read' ? parseCruiseShadowSamples(tail.text, cutoffMs, nowMs) : [];
    if (samples.length === 0) return [];
    const cells = foldCruiseShadowCells(samples, tail.state === 'read' && tail.truncated === true)
      .filter((cell) => cell.samples >= CRUISE_SHADOW_MIN_SAMPLES && cell.days >= CRUISE_SHADOW_MIN_DAYS);
    const limit = Math.max(1, Math.min(opts.limit ?? CRUISE_SHADOW_MAX_ITEMS, CRUISE_SHADOW_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => cruiseShadowItem(cell, repo));
  } catch {
    return [];
  }
}

/**
 * Cruise runaway-daemon alert journal → self-improvement backlog items.
 *
 * The ops-side cruise package (~/.ashlr-runs/bin/cruise-pkg — pinned
 * machinery, not this repository) runs a watchdog on the same tick
 * cadence as its shadow controller. `watchdog.py scan_daemons` keeps a
 * per-name robust baseline of RSS and CPU and, when a process outside
 * the fleet's live job groups sustains a reading past the learned bar
 * (with a per-name alert cooldown that doubles while the condition
 * persists), it appends one alert record per firing to
 * <runs>/metrics/cruise-alerts.jsonl and drops a
 * bus/core/CRUISE-ALERT-<name>.md notice. The action is always
 * 'alert_only': the watchdog never kills — it is the fleet's own
 * tripwire for processes that keep running away.
 *
 * The sibling fold (cruiseShadowBacklogItems) reads the controller's
 * per-tick zone verdicts from metrics/cruise-shadow.jsonl; this journal
 * is the same package's other output and until now had no reader at
 * all. A host whose node, git or helper processes keep tripping the
 * runaway bar — a leak, an unbounded spawn, a missing cleanup — never
 * became work even though every row is measured evidence about this
 * install's process hygiene. cruiseAlertsBacklogItems carries the
 * journal into discoverBacklog so `phm improve discover` and the
 * scheduler's autoDiscover queue the recurring cells like the sibling
 * fleet-evidence sources.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; records are validated by their own
 *    fields — kind 'runaway_daemon', a bounded printable process name,
 *    an in-window epoch-seconds timestamp and a sane pid when present
 *    — and nothing is written and no process, file tree or network is
 *    touched. A missing, unreadable or non-file journal yields no
 *    items; a truncated tail still folds the retained records with
 *    the prompts stating the counts as lower bounds.
 *  - Every row is already an alert: the watchdog's own sustain and
 *    cooldown logic decided the process is running away, so there is
 *    no healthy class to filter — recurrence is what separates a
 *    chronic condition from a one-off spike.
 *  - Recurring means alerting across days: a cell emits only at
 *    CRUISE_ALERTS_MIN_ALERTS records across CRUISE_ALERTS_MIN_DAYS
 *    distinct UTC days inside the window, so one bad afternoon never
 *    queues a session.
 *  - The evidence carries no repository dimension — it describes this
 *    install's host and fleet. Items therefore emit only when the
 *    backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - The process name is the cell identity and is quoted in prompts;
 *    it is bounded and stripped of control characters at parse time.
 *    Measured peaks (rss share, cpu percent, robust z) are quoted
 *    rounded — they are the evidence a session needs — while pids are
 *    counted, never listed.
 *  - Recipients of the signal stay honest: 'system' rows are flagged
 *    by the watchdog as outside the cruise user's uid (OS daemons and
 *    other accounts' processes the fleet cannot relieve), and
 *    same-uid rows are processes outside live fleet job groups — a
 *    fleet-adjacent helper or orphan and an owner-side app look
 *    identical until the session investigates. Both framings say so.
 *  - Dedup is downstream. The item id embeds a stable hash of the
 *    (name, system, action) cell only — never counts, timestamps or
 *    pids — so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; a host that
 *    recovers simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; cells are bounded by distinct alerting names (the watchdog's vocabulary is process names). */
export const CRUISE_ALERTS_MAX_ITEMS = 8;
const CRUISE_ALERTS_ITEM_HARD_MAX = 16;
/** A cell emits only at this many in-window alerts... */
export const CRUISE_ALERTS_MIN_ALERTS = 3;
/** ...across at least this many distinct UTC days. */
export const CRUISE_ALERTS_MIN_DAYS = 2;
/** Evidence window: the sibling fleet-evidence convention. */
export const CRUISE_ALERTS_WINDOW_HOURS = 168;
/** Newest-bytes bound on the alert journal; a record is ~400-600 bytes so this covers the whole window at the observed alert rate. */
const CRUISE_ALERTS_TAIL_BYTES = 8 * 1024 * 1024;
/** Journal path under the runs root: metrics/cruise-alerts.jsonl, the writer's own location. */
const CRUISE_ALERTS_JOURNAL_RELATIVE = join('metrics', 'cruise-alerts.jsonl');
/** The producer's only alert kind (watchdog.py scan_daemons), inlined so this reader validates the persisted contract without importing ops-side code. */
const CRUISE_ALERT_KIND = 'runaway_daemon';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: alert evidence is this install's host and fleet, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Five-minute future skew tolerance for clock drift between the writer's host and the reader, matching the sibling folds. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Process names are comm-style strings (macOS app names carry spaces and parentheses); anything past this bound is foreign and the row is skipped. */
const MAX_NAME_CHARS = 128;
/** Action strings are producer vocabulary; anything past this bound is foreign and the row is skipped. */
const MAX_ACTION_CHARS = 64;
/** Control characters can never appear in a real process name; their presence means the row is not the producer's contract. */
const CONTROL_CHARS = /[\p{Cc}]/u;

/** One validated alert: the watchdog's firing plus the measured peaks the fold keeps. */
export interface CruiseAlertSample {
  atMs: number;
  /** Process name exactly as the watchdog recorded it (bounded, control-free). */
  name: string;
  /** Watchdog's uid flag: true = outside the cruise user's uid (OS daemon or another account), false = same uid, null = unrecorded. */
  system: boolean | null;
  /** The watchdog's action string ('alert_only' is the only value it emits today). */
  action: string | null;
  /** The alerting process id when the row carried a sane one; pids are counted per cell, never listed. */
  pid: number | null;
  /** Fraction of host RAM the process held at alert time, when recorded. */
  rssShare: number | null;
  /** CPU percent at alert time, when recorded. */
  cpuPct: number | null;
  /** The watchdog's robust z score (max of the RSS and CPU legs), when recorded. */
  z: number | null;
}

/** One (name, system, action) cell: the recurring alert identity. */
export interface CruiseAlertCell {
  name: string;
  /** true = outside the cruise user's uid; false = same uid; null = the rows never recorded it. */
  system: boolean | null;
  action: string | null;
  /** In-window alerts folded into the cell. */
  alerts: number;
  /** Distinct UTC days the alerts fall on. */
  days: number;
  /** Distinct process ids seen alerting under this name; rows without a usable pid add nothing. */
  pids: number;
  /** Highest recorded robust z; null when no alert carried one. */
  maxZ: number | null;
  /** Highest recorded rss_share (fraction of host RAM); null when never recorded. */
  peakRssShare: number | null;
  /** Highest recorded cpu_pct; null when never recorded. */
  peakCpuPct: number | null;
  /** ISO bounds of the cell's alerts; null when none carried a usable timestamp (cannot happen — alerts require one). */
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

const boundedLabel = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL_CHARS.test(value) ? value : null;

/**
 * The watchdog stamps each alert with epoch seconds (a float, as
 * `dict(a, ts=now)` serializes time.time()). Accept only that contract:
 * a finite positive number whose millisecond form lands in range.
 * Strings, ISO text and absurd magnitudes are not this journal's
 * dialect and stay unparsed.
 */
function alertTsMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const ms = value * 1000;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Pure: validate one alert-journal tail into alert samples. A record
 * counts only under the producer's contract — kind 'runaway_daemon', a
 * bounded control-free process name, an in-window epoch-seconds
 * timestamp, and evidence fields that are finite numbers when present.
 * Other kinds, foreign shapes, untimestamped and future-stamped
 * records and shapeless rows are all skipped, never guessed.
 */
export function parseCruiseAlerts(text: string, cutoffMs: number, nowMs: number): CruiseAlertSample[] {
  const samples: CruiseAlertSample[] = [];
  const horizon = nowMs + FUTURE_SKEW_MS;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Cheap prefilter: every valid record names the runaway kind.
    if (!line.includes(CRUISE_ALERT_KIND)) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (r['kind'] !== CRUISE_ALERT_KIND) continue;
    const atMs = alertTsMs(r['ts']);
    if (atMs === null || atMs > horizon || atMs < cutoffMs) continue;
    const name = boundedLabel(r['name'], MAX_NAME_CHARS);
    if (name === null) continue;
    const pidRaw = r['pid'];
    const pid = typeof pidRaw === 'number' && Number.isSafeInteger(pidRaw) && pidRaw > 0 ? pidRaw : null;
    const system = typeof r['system'] === 'boolean' ? r['system'] : null;
    samples.push({
      atMs,
      name,
      system,
      action: boundedLabel(r['action'], MAX_ACTION_CHARS),
      pid,
      rssShare: finite(r['rss_share']),
      cpuPct: finite(r['cpu_pct']),
      z: finite(r['z']),
    });
  }
  return samples;
}

/**
 * Pure: fold validated alerts into per-(name, system, action) cells.
 * Every alert counts once — the watchdog's cooldown already spaces
 * repeats, so `alerts` is the recurrence measure and `days` the
 * distinct-day proof; `pids` distinguishes one process alerting
 * repeatedly from a name that keeps claiming fresh processes.
 */
export function foldCruiseAlerts(samples: readonly CruiseAlertSample[], lowerBound = false): CruiseAlertCell[] {
  const cells = new Map<string, {
    name: string;
    system: boolean | null;
    action: string | null;
    alerts: number;
    days: Set<string>;
    pids: Set<number>;
    maxZ: number | null;
    peakRssShare: number | null;
    peakCpuPct: number | null;
    firstMs: number;
    lastMs: number;
  }>();
  for (const sample of samples) {
    const key = JSON.stringify([sample.name, sample.system, sample.action]);
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        name: sample.name,
        system: sample.system,
        action: sample.action,
        alerts: 0,
        days: new Set(),
        pids: new Set(),
        maxZ: null,
        peakRssShare: null,
        peakCpuPct: null,
        firstMs: sample.atMs,
        lastMs: sample.atMs,
      };
      cells.set(key, cell);
    }
    cell.alerts += 1;
    cell.days.add(new Date(sample.atMs).toISOString().slice(0, 10));
    if (sample.pid !== null) cell.pids.add(sample.pid);
    if (sample.z !== null) cell.maxZ = cell.maxZ === null ? sample.z : Math.max(cell.maxZ, sample.z);
    if (sample.rssShare !== null) cell.peakRssShare = cell.peakRssShare === null ? sample.rssShare : Math.max(cell.peakRssShare, sample.rssShare);
    if (sample.cpuPct !== null) cell.peakCpuPct = cell.peakCpuPct === null ? sample.cpuPct : Math.max(cell.peakCpuPct, sample.cpuPct);
    cell.firstMs = Math.min(cell.firstMs, sample.atMs);
    cell.lastMs = Math.max(cell.lastMs, sample.atMs);
  }
  return [...cells.values()]
    .map((cell) => ({
      name: cell.name,
      system: cell.system,
      action: cell.action,
      alerts: cell.alerts,
      days: cell.days.size,
      pids: cell.pids.size,
      maxZ: cell.maxZ,
      peakRssShare: cell.peakRssShare,
      peakCpuPct: cell.peakCpuPct,
      firstSeen: new Date(cell.firstMs).toISOString(),
      lastSeen: new Date(cell.lastMs).toISOString(),
      lowerBound,
    }))
    .sort((a, b) => b.alerts - a.alerts || a.name.localeCompare(b.name)
      || String(a.system).localeCompare(String(b.system)) || String(a.action ?? '').localeCompare(String(b.action ?? '')));
}

/** Rounded measured peaks for prompts: rss share as a whole percent of host RAM, cpu to a whole percent, z to one decimal (exponential past a million — a degenerate baseline can produce enormous z and the compact form stays the true value). */
function peaksText(cell: CruiseAlertCell): string {
  const parts: string[] = [];
  if (cell.peakRssShare !== null) parts.push(`peak rss_share ${Math.round(cell.peakRssShare * 100)}% of host RAM`);
  if (cell.peakCpuPct !== null) parts.push(`peak cpu_pct ${Math.round(cell.peakCpuPct)}%`);
  if (cell.maxZ !== null) parts.push(`peak z ${Math.abs(cell.maxZ) >= 1e6 ? cell.maxZ.toExponential(1) : cell.maxZ.toFixed(1)}`);
  return parts.length === 0 ? 'No alert carried measured rss/cpu/z peaks.' : `Measured peaks: ${parts.join(', ')}.`;
}

function ownershipText(cell: CruiseAlertCell): string {
  if (cell.system === true) {
    return 'The watchdog flagged every folded alert as outside the cruise user\'s uid — an OS daemon or another account\'s process. Fleet-side changes cannot relieve it; the honest outcome is usually no-change naming that evidence, or an ops-side report if the process is degrading this host.';
  }
  if (cell.system === false) {
    return 'The watchdog flagged these as same-uid processes outside the fleet\'s live job groups — a fleet-adjacent helper, daemon or orphaned child and an owner-side app under the same account look identical until investigated. If the name resolves to a fleet-owned process (a phm/ashlr helper, a git or node child a job leaked, an unbounded spawn in this repository\'s machinery), fixing that leak or adding the missing cleanup is the work; if it resolves to an owner-side app, report no-change naming the evidence.';
  }
  return 'The folded alerts never recorded the watchdog\'s uid flag, so whether the process is fleet-adjacent or foreign is unknown — investigate the name and pids before attributing it.';
}

const EVIDENCE = 'The evidence is metrics/cruise-alerts.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): the ops-side cruise package\'s watchdog (~/.ashlr-runs/bin/cruise-pkg/cruise/watchdog.py — pinned machinery, not this repository) appends one JSON record per runaway-daemon alert — {kind:\'runaway_daemon\', name, pid, uid, rss_bytes, rss_share, cpu_pct, z, z_rss, z_cpu, slope_bps, baseline_bytes, system, action:\'alert_only\', ts:<epoch seconds>} — and drops a bus/core/CRUISE-ALERT-<name>.md notice per firing. The watchdog keeps a per-name robust baseline of RSS and CPU, requires the reading to sustain past the learned bar, excludes processes inside the fleet\'s live job groups, backs each name off with a doubling cooldown while the condition persists, and never kills: action is alert_only. Until this feed the journal had no reader at all — the bus notices are ops-side surfaces nobody folds.';

const OWNERSHIP = 'What this repository owns is the fleet side the alerts can implicate: processes this repo\'s machinery spawns outside admitted job groups (helpers, watchers, orphaned children), unbounded process or memory growth in src/ and contrib/ code paths, missing cleanup on job finish, and the queue/dispatch machinery whose children these pids may descend from. What it does not own is the watchdog itself — ops-side pinned Python under ~/.ashlr-runs/bin/cruise-pkg, changed only through Security review and re-pin — its learned baselines and alert thresholds, foreign and owner-side applications, OS daemons, and the host\'s physical capacity.';

function seenText(cell: CruiseAlertCell): string {
  return cell.firstSeen === cell.lastSeen
    ? ` First alert ${cell.firstSeen}.`
    : ` Alerts ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function boundText(cell: CruiseAlertCell): string {
  return cell.lowerBound ? ' The journal tail was truncated, so these counts are a lower bound.' : '';
}

function pidsText(cell: CruiseAlertCell): string {
  if (cell.pids === 0) return 'No alert carried a usable pid, so whether one process or many kept alerting is unknown.';
  return `The alerts span ${cell.pids} distinct process id(s)${cell.pids === 1 ? ' — the same process kept re-alerting' : ''}.`;
}

function cruiseAlertsPrompt(cell: CruiseAlertCell): string {
  const systemNote = cell.system === true ? ' flagged system:true (outside the cruise uid)' : cell.system === false ? '' : ' with the uid flag unrecorded';
  return [
    `Phantom's host keeps recording runaway-daemon alerts for '${cell.name}'${systemNote} — ${cell.alerts} alert(s) across ${cell.days} distinct UTC day(s) inside the window${cell.action !== null && cell.action !== 'alert_only' ? `, action '${cell.action}'` : ''}.`,
    '',
    `${peaksText(cell)} ${pidsText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    OWNERSHIP,
    '',
    `Find whether the recurring alerts are a fleet-side gap this repository can close — a process this repo's machinery leaks, an unbounded spawn or missing cleanup the name resolves to, or a helper that needs a bound. ${ownershipText(cell)} If the alerts are a detector misfire on a foreign process, the watchdog is pinned ops machinery whose baselines need a Security-reviewed retune, or the name resolves to something this repository does not own — report no-change and name the evidence.`,
  ].join('\n');
}

function cruiseAlertsItem(cell: CruiseAlertCell, repo: string): CloudBacklogItem {
  const id = `fleet-cruise-alerts-${createHash('sha256').update(`cruise-alerts:${JSON.stringify([cell.name, cell.system, cell.action])}`).digest('hex').slice(0, 16)}`;
  const title = `Cruise watchdog keeps alerting on '${cell.name}'`.slice(0, MAX_TITLE_CHARS);
  return {
    id,
    title,
    prompt: cruiseAlertsPrompt(cell),
    area: 'cruise-alerts',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

export interface CruiseAlertsItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/cruise-alerts.jsonl; $ASHLR_RUNS_DIR wins when set, else <home>/.ashlr-runs. */
  runsDir?: string;
  /** Journal override (default: join(runsDir, 'metrics', 'cruise-alerts.jsonl'), the writer's own location). */
  journalPath?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default CRUISE_ALERTS_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default CRUISE_ALERTS_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/**
 * Backlog items for the cruise runaway-daemon journal's recurring
 * alert cells. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function cruiseAlertsBacklogItems(opts: CruiseAlertsItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling fleet-evidence feeds apply: explicit
    // dir, then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an
    // empty env value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const journalPath = opts.journalPath ?? join(runsDir, CRUISE_ALERTS_JOURNAL_RELATIVE);
    const nowMs = (opts.now ?? new Date()).getTime();
    const cutoffMs = nowMs - (opts.windowHours ?? CRUISE_ALERTS_WINDOW_HOURS) * 3_600_000;
    const tail = await readLedgerTail(journalPath, CRUISE_ALERTS_TAIL_BYTES);
    const samples = tail.state === 'read' ? parseCruiseAlerts(tail.text, cutoffMs, nowMs) : [];
    if (samples.length === 0) return [];
    const cells = foldCruiseAlerts(samples, tail.state === 'read' && tail.truncated === true)
      .filter((cell) => cell.alerts >= CRUISE_ALERTS_MIN_ALERTS && cell.days >= CRUISE_ALERTS_MIN_DAYS);
    const limit = Math.max(1, Math.min(opts.limit ?? CRUISE_ALERTS_MAX_ITEMS, CRUISE_ALERTS_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => cruiseAlertsItem(cell, repo));
  } catch {
    return [];
  }
}

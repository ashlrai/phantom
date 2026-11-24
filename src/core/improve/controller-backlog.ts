/**
 * Fleet-controller ledger → self-improvement backlog items.
 *
 * The dispatcher's fleet controller (contrib/mac/fleet_controller.py, driven
 * once per dispatchd tick) appends one `fleet-controller.ledger.v1` row to
 * <runs>/metrics/fleet-controller.jsonl — the applied shed plan, the would-be
 * shadow plan, the host/queue/merge readings, per-lane targets and hold
 * state, route.quality.v1 receipts, ambiguous hold attribution, mutations
 * and reroutes — rotating once to `.1` at 8 MiB. Until now that ledger only
 * ever reached `phm fleet admission --details` (settle advice over the last
 * 24 h, src/cli/fleet-admission.ts), `phm amplify`'s advisory snapshots and
 * `phm fleet status`'s tail — reports someone had to run and read. A
 * controller that keeps failing closed, shedding, holding lanes
 * ambiguously, flying blind on merge outcomes or never measuring lane
 * quality never became work. controllerBacklogItems carries the same rows
 * into discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the fleet outcome-learning, nightly
 * retro, policy, local-gate, pass^k, friction, tick-health, cross-review,
 * empty-tag, post-merge, ci-rerun, lost-launch and memory-pressure sources
 * beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Both ledger generations are read through readLedgerTail's
 *    bounded stable-file read; nothing is written and no process is
 *    inspected or signalled — the recorded rows are the only evidence.
 *  - Missing or unreadable evidence yields no items. An absent ledger
 *    reads as an empty row list — unknown stays unknown, never a guessed
 *    tally — and rows the reader cannot validate never reach the fold.
 *  - Recurring means recorded, on the fold's own bars. Every condition is
 *    a per-tick state (shed level, missing/degraded signal lists, hold
 *    attribution, objective and quality fields), so an hour bucket counts
 *    only when the condition holds on at least half of that hour's parsed
 *    ticks — one flapping tick never convicts an hour. Umbrella cells emit
 *    only at CONTROLLER_UMBRELLA_HOURS firing hours across
 *    CONTROLLER_MIN_DAYS separate UTC days; per-key cells (a fail-closed
 *    signature, a degraded signal, a shed driver, an ambiguous lane) at
 *    CONTROLLER_CELL_HOURS across the same days — one bad afternoon is an
 *    incident, not a pattern.
 *  - The ledger carries no per-job repository dimension — it describes
 *    this install's dispatcher and host. Items therefore emit only when
 *    the backlog target's repository name is 'phantom', the same
 *    last-segment rule the friction, tick-health, host-load, lost-launch
 *    and memory-pressure sources apply; self-improvement pointed at
 *    another repository never inherits this install's evidence it cannot
 *    attribute.
 *  - Truncation is stated, never hidden. The ledger rotates at 8 MiB and
 *    keeps one `.1` generation; when either bounded read reports
 *    `truncated` the prompts say the counts cover only the retained
 *    window — a lower bound, not the full window.
 *  - Dedup is downstream. Item ids are stable per cell identity (a fixed
 *    umbrella id, or a hash of the recorded signature/signal/lane — never
 *    the counts or timestamps), so a refresh re-derives the same ids and
 *    appendUserBacklogItems adds only what is new; a quiet window stops
 *    re-adding and shifted tallies do not spawn twin items.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, recorded names are scrubbed, flattened to one line
 *    and capped before they reach a prompt, and each brief names the
 *    ledger, its writer (contrib/mac/dispatchd.py + fleet_controller.py —
 *    pinned dispatcher machinery whose changes need Security review and
 *    re-pin) and its readers, with the usual no-change escape when the
 *    window no longer reproduces or the cause is owner-only.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the fold yields a handful of umbrellas plus bounded per-key cells. */
export const CONTROLLER_MAX_ITEMS = 10;
const CONTROLLER_ITEM_HARD_MAX = 25;
/**
 * Evidence window: the ledger's own practical retention is two 8 MiB
 * generations of per-tick rows — often less than 7 days — so the window is
 * the sibling convention (168 h) and every prompt states the retained
 * span and any truncation honestly.
 */
export const CONTROLLER_WINDOW_HOURS = 168;
/** Umbrella cells: firing hours needed across CONTROLLER_MIN_DAYS separate UTC days. */
export const CONTROLLER_UMBRELLA_HOURS = 6;
/** Per-key cells (one signature, signal, driver or lane): the rarer-event bar. */
export const CONTROLLER_CELL_HOURS = 4;
/** Those firing hours must span at least this many separate UTC days — one bad day is an incident, not a pattern. */
export const CONTROLLER_MIN_DAYS = 2;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded names are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 60;
/** Recorded signal/lane identifiers join only bounded identifier-shaped values; anything else is skipped. */
const SIGNAL_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const LANE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Shed-driver reason entries look like `load=2`; the level digit is recorded but only the name keys the cell. */
const DRIVER_REASON = /^([a-z][a-z0-9_]{0,31})=(\d+)$/;
/** The fleet's own repository label: controller evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Ledger path named inside item prompts, relative to the runs dir. */
const CONTROLLER_LEDGER_RELATIVE = join('metrics', 'fleet-controller.jsonl');
/** Shed levels that count as real throttling for the umbrella: shed25 and freeze (level names in fleet_controller.py). */
const UMBRELLA_SHED_LEVEL = 2;

export interface ControllerItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/fleet-controller.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Ledger override (default: <runsDir>/metrics/fleet-controller.jsonl); its `.1` rotation is read too. */
  ledgerPath?: string;
  /** Most items one call emits (default CONTROLLER_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded names are unbounded text; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

interface ControllerTick {
  atMs: number;
  /** UTC hour bucket 'YYYY-MM-DDTHH' and day bucket 'YYYY-MM-DD'. */
  hour: string;
  day: string;
  mode: string | null;
  /** Applied plan's shed level (0-3); null when the row did not record a usable one. */
  shedLevel: number | null;
  shedReasons: string[];
  /** Would-be shed level from the shadow plan; null when no shadow plan was recorded. */
  shadowLevel: number | null;
  shadowReasons: string[];
  /** Unreadable CRITICAL readings (load1/ncpu/procs/memory) — any entry freezes the planner at level 3. */
  missing: string[];
  /** Unreadable non-critical readings plus 'merge' when the merge feed never landed. */
  degraded: string[];
  /** objective_score === null means the merge readings were unreadable; undefined means the field was absent. */
  objectiveNull: boolean | null;
  /** Lanes whose hold flag disagrees with held_by/held_until attribution. */
  ambiguous: string[];
  /** route.quality.v1 receipts this tick: total with a recorded reason, and how many said 'unmeasured'. */
  qualityTotal: number;
  qualityUnmeasured: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringList = (value: unknown, pattern: RegExp): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && pattern.test(v)) : [];

const reasonList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => fieldText(v, 96)).slice(0, 50)
    : [];

const levelOf = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 3 ? value as number : null;

/**
 * One ledger row → a tick, or null when it is not controller evidence.
 * Strict on the schema tag and timestamp (epoch seconds, as dispatchd
 * writes them); every optional member degrades to "not recorded" rather
 * than failing the row — a partially recorded tick still counts toward
 * the conditions it does carry.
 */
function parseControllerTick(raw: unknown, windowStartMs: number, nowMs: number): ControllerTick | null {
  if (!isRecord(raw) || raw['schema'] !== 'fleet-controller.ledger.v1') return null;
  const ts = raw['ts'];
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null;
  const atMs = ts * 1000;
  // A small future skew is tolerated (same-host clock); anything beyond it is a corrupt row.
  if (atMs < windowStartMs || atMs > nowMs + 60_000) return null;
  const iso = new Date(atMs).toISOString();
  const signals = isRecord(raw['signals']) ? raw['signals'] : {};
  const shadow = isRecord(raw['shadow']) ? raw['shadow'] : null;
  let objectiveNull: boolean | null = null;
  if (raw['objective_score'] === null) objectiveNull = true;
  else if (typeof raw['objective_score'] === 'number' && Number.isFinite(raw['objective_score'])) objectiveNull = false;
  let qualityTotal = 0;
  let qualityUnmeasured = 0;
  if (Array.isArray(raw['quality_receipts'])) {
    for (const receipt of raw['quality_receipts']) {
      if (!isRecord(receipt) || typeof receipt['reason'] !== 'string') continue;
      qualityTotal += 1;
      if (receipt['reason'] === 'unmeasured') qualityUnmeasured += 1;
    }
  }
  return {
    atMs,
    hour: iso.slice(0, 13),
    day: iso.slice(0, 10),
    mode: typeof raw['mode'] === 'string' ? fieldText(raw['mode'], 24) : null,
    shedLevel: levelOf(raw['shed_level']),
    shedReasons: reasonList(raw['shed_reasons']),
    shadowLevel: shadow === null ? null : levelOf(shadow['shed_level']),
    shadowReasons: shadow === null ? [] : reasonList(shadow['reasons']),
    missing: stringList(signals['missing'], SIGNAL_NAME),
    degraded: stringList(signals['degraded'], SIGNAL_NAME),
    objectiveNull,
    ambiguous: stringList(raw['ambiguous_holds'], LANE_NAME),
    qualityTotal,
    qualityUnmeasured,
  };
}

/** Normalize a `fail_closed:` reason tail into one signature: missing-reading sets sort to one identity. */
function failClosedSignature(reason: string): string {
  const rest = reason.slice('fail_closed:'.length).trim();
  if (rest.startsWith('missing=')) {
    const names = rest.slice('missing='.length).split(',').map((n) => n.trim()).filter((n) => SIGNAL_NAME.test(n)).sort();
    if (names.length > 0) return `missing:${names.join(',')}`;
  }
  return `fc:${fieldText(rest, 48).toLowerCase()}`;
}

/** Shed-driver signal names recorded on one tick: applied-plan reasons at shed≥1 plus shadow-plan reasons at would-shed≥1. */
function shedDrivers(tick: ControllerTick): Set<string> {
  const drivers = new Set<string>();
  const collect = (reasons: readonly string[], level: number | null): void => {
    if (level === null || level < 1) return;
    for (const reason of reasons) {
      const m = DRIVER_REASON.exec(reason);
      if (m) drivers.add(m[1]!);
    }
  };
  collect(tick.shedReasons, tick.shedLevel);
  collect(tick.shadowReasons, tick.shadowLevel);
  return drivers;
}

interface Fold {
  ticks: number;
  truncated: boolean;
  /** hour bucket -> parsed in-window ticks (the majority denominator). */
  hourTicks: Map<string, number>;
  /** condition key -> hour bucket -> ticks carrying it. */
  cond: Map<string, Map<string, number>>;
  shedLevelTicks: Map<number, number>;
  shadowShedTicks: number;
  appliedShedTicks: number;
  /** driver signal -> ticks it was recorded as a top shed driver. */
  driverTicks: Map<string, number>;
  failTicks: number;
  degradedTicks: Map<string, number>;
  objectiveTicks: number;
  qualityTicks: number;
  qualityUnmeasured: number;
  qualityTotal: number;
  modeTicks: Map<string, number>;
  firstAtMs: number | null;
  lastAtMs: number | null;
}

const bump = (map: Map<string, Map<string, number>>, key: string, hour: string, by = 1): void => {
  const hours = map.get(key) ?? new Map<string, number>();
  hours.set(hour, (hours.get(hour) ?? 0) + by);
  map.set(key, hours);
};

function foldTick(fold: Fold, tick: ControllerTick): void {
  fold.ticks += 1;
  fold.hourTicks.set(tick.hour, (fold.hourTicks.get(tick.hour) ?? 0) + 1);
  fold.firstAtMs = fold.firstAtMs === null ? tick.atMs : Math.min(fold.firstAtMs, tick.atMs);
  fold.lastAtMs = fold.lastAtMs === null ? tick.atMs : Math.max(fold.lastAtMs, tick.atMs);
  if (tick.mode !== null) fold.modeTicks.set(tick.mode, (fold.modeTicks.get(tick.mode) ?? 0) + 1);

  const mark = (key: string): void => bump(fold.cond, key, tick.hour);

  if (tick.shedLevel !== null) {
    fold.shedLevelTicks.set(tick.shedLevel, (fold.shedLevelTicks.get(tick.shedLevel) ?? 0) + 1);
    if (tick.shedLevel >= UMBRELLA_SHED_LEVEL) mark('U:shed');
    if (tick.shedLevel >= 1) fold.appliedShedTicks += 1;
  }
  if (tick.shadowLevel !== null && tick.shadowLevel >= 1) {
    fold.shadowShedTicks += 1;
    mark('U:shedunapplied');
  }
  for (const driver of shedDrivers(tick)) {
    fold.driverTicks.set(driver, (fold.driverTicks.get(driver) ?? 0) + 1);
    mark(`SD:${driver}`);
  }

  const failSigs = new Set<string>();
  if (tick.missing.length > 0) failSigs.add(`missing:${[...tick.missing].sort().join(',')}`);
  for (const reason of [...tick.shedReasons, ...tick.shadowReasons]) {
    if (reason.startsWith('fail_closed:')) failSigs.add(failClosedSignature(reason));
  }
  for (const sig of failSigs) {
    fold.failTicks += 1;
    mark(`FC:${sig}`);
  }

  for (const name of new Set(tick.degraded)) {
    fold.degradedTicks.set(name, (fold.degradedTicks.get(name) ?? 0) + 1);
    // 'merge' is the objective cell's evidence, never a degraded-signal cell.
    if (name !== 'merge') mark(`DG:${name}`);
  }

  if (tick.objectiveNull !== null) {
    fold.objectiveTicks += 1;
    if (tick.objectiveNull) mark('U:objective');
  }

  if (tick.qualityTotal > 0) {
    fold.qualityTicks += 1;
    fold.qualityTotal += tick.qualityTotal;
    fold.qualityUnmeasured += tick.qualityUnmeasured;
    if (tick.qualityUnmeasured * 2 >= tick.qualityTotal) mark('U:quality');
  }

  for (const lane of new Set(tick.ambiguous)) mark(`AH:${lane}`);
}

interface FiringCell {
  key: string;
  /** Distinct hour buckets where the condition held on at least half the hour's ticks. */
  hours: number;
  /** Distinct UTC days those firing hours span. */
  days: number;
  /** Ticks carrying the condition anywhere in the window (recorded count, quoted as such). */
  ticks: number;
}

/** Hours where a condition held on at least half the hour's parsed ticks; days = distinct UTC days among them. */
function firingCell(fold: Fold, key: string): FiringCell | null {
  const hours = fold.cond.get(key);
  if (hours === undefined) return null;
  const firing = new Set<string>();
  let ticks = 0;
  for (const [hour, count] of hours) {
    ticks += count;
    const total = fold.hourTicks.get(hour) ?? 0;
    if (total > 0 && count * 2 >= total) firing.add(hour);
  }
  if (firing.size === 0) return null;
  const days = new Set([...firing].map((h) => h.slice(0, 10)));
  return { key, hours: firing.size, days: days.size, ticks };
}

const EVIDENCE = 'The evidence is metrics/fleet-controller.jsonl (and its single .1 rotation) under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): the dispatchd fleet controller appends one fleet-controller.ledger.v1 row per tick — applied and shadow shed plans, host/queue/merge readings, per-lane targets and hold state, route.quality.v1 receipts, ambiguous hold attribution — written by contrib/mac/dispatchd.py through contrib/mac/fleet_controller.py ledger_record. `phm fleet admission --details` folds the newest 24 hours for settle advice (explainFleetAdmission in src/cli/fleet-admission.ts), `phm amplify` folds it into advisory snapshots (src/core/amplify/index.ts) and `phm fleet status` tails it; the state file queue/fleet-controller.json feeds route.quality receipts to src/core/router/controller-quality.ts and weight-proposals.ts.';

const NO_CHANGE = 'If the window has rolled forward, the controller has been quiet or healthy since the recorded hours, the evidence traces to a one-off incident, or the cause is owner-only (a protected gate or sandbox profile, credentials, billing, or pinned dispatch machinery only ops may re-pin) — report no-change and name the evidence.';

const windowNote = (fold: Fold): string => {
  if (!fold.truncated) return '';
  return ' The ledger tail was truncated at the bounded read, so the counts above cover only the retained window — a lower bound, not the full window.';
};

const spanNote = (fold: Fold): string => {
  if (fold.firstAtMs === null || fold.lastAtMs === null) return '';
  return ` Recorded span inside the window: ${new Date(fold.firstAtMs).toISOString()} → ${new Date(fold.lastAtMs).toISOString()}.`;
};

const PINNED_NOTE = ' contrib/mac/dispatchd.py and contrib/mac/fleet_controller.py are pinned dispatcher machinery: a fix there needs Security review and re-pin before install — prefer evidence-backed changes in this repository\'s src/ where the cause lives, and document pinned-side findings for the owner rather than working around them.';

function topDrivers(fold: Fold, max = 4): string {
  const top = [...fold.driverTicks.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max);
  return top.length === 0 ? 'none recorded' : top.map(([name, n]) => `${fieldText(name, MAX_NAME_CHARS)} (${n} tick(s))`).join(', ');
}

function levelLine(fold: Fold): string {
  const parts = [...fold.shedLevelTicks.entries()].sort((a, b) => a[0] - b[0])
    .map(([level, n]) => `level ${level} on ${n} tick(s)`);
  return parts.length === 0 ? 'no applied shed levels recorded' : parts.join(', ');
}

// ---------------------------------------------------------------------------
// Item builders — one per evidence cell
// ---------------------------------------------------------------------------

const AREA = 'fleet-controller';

function failClosedGuidance(sig: string): string {
  if (sig.startsWith('missing:')) {
    const names = sig.slice('missing:'.length).split(',').map((n) => fieldText(n, MAX_NAME_CHARS)).join(', ');
    return `The dispatcher's critical readings (${names}) were unreadable, so shed_level() forces level 3 (freeze) and lanes run on floors — the fail-closed path working as designed over a dead readings feed. Find which producer feeds those readings in dispatchd's BUS assembly (host load/memory/process probes) and why they stay unreadable: a missing probe binary, a permissions change, or a reader that silently returns None. `;
  }
  if (sig === 'fc:state_unreadable') {
    return `queue/fleet-controller.json (FC_STATE) was missing or failed shape validation, so shed_level() fails closed at level 3 every tick. Check the state file's writer (fc.save_json's atomic replace) and its readers for a corrupt or repeatedly-unwritable path. `;
  }
  if (sig.startsWith('fc:controller_error:')) {
    return `fc.plan() threw inside the controller phase, so frozen_plan dropped every lane to its floor. The recorded exception type is in the signature; reproduce it against the tick's recorded signals in fleet_controller.py's plan/lane_quality/outcome_quality path. `;
  }
  return `A fail_closed plan reason recurred that is not one of the named cases — read the recorded reason strings in the ledger rows and trace which planner branch emitted them. `;
}

function failClosedItem(cell: FiringCell, fold: Fold, repo: string): CloudBacklogItem {
  const sig = cell.key.slice(3);
  const display = fieldText(sig, MAX_NAME_CHARS);
  return {
    id: `controller-failclosed-${sha(sig.toLowerCase())}`,
    title: `Fleet controller keeps fail-closing on ${display}`.slice(0, MAX_TITLE_CHARS),
    prompt: [
      `Phantom's fleet-controller ledger shows the dispatcher fail-closing on '${display}' — ${cell.ticks} recorded tick(s) carried the signature across ${cell.hours} distinct hour(s) on ${cell.days} separate day(s) inside the ${CONTROLLER_WINDOW_HOURS / 24}-day window. While it holds, the fleet runs on frozen floor targets, not measured ones.`,
      '',
      failClosedGuidance(sig),
      EVIDENCE,
      windowNote(fold) + spanNote(fold),
      PINNED_NOTE,
      ` ${NO_CHANGE}`,
    ].join('\n'),
    area: AREA,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function degradedGuidance(name: string): string {
  switch (name) {
    case 'load5':
      return `The 5-minute load average was unreadable — the restore/hysteresis path that needs load5 cannot see recovery, so shed levels linger. `;
    case 'swap_gb':
    case 'swap_growth_gb':
    case 'mem_free_pct':
    case 'memory_pressure':
      return `A host-memory reading was unreadable, so the memory/swap shed bands ran blind — check the memstat/host probes feeding dispatchd and cross-reference metrics/swapout-rate.jsonl (the swapout-sync ledger \`phm fleet vitals\` folds). `;
    case 'worktrees':
      return `The worktree count was unreadable, so the worktree shed band ran blind — check the worktree audit probe (src/core/fleet/worktrees.ts reads the same inventory) and the queue/worktree-reap.jsonl removal log. `;
    case 'disk_free_gb':
      return `The disk-free reading was unreadable, so disk pressure never reached the controller's signals — check the disk probe and cross-reference \`phm disk-maint\` evidence. `;
    default:
      return `The recorded degraded signal has no named guidance — trace which dispatchd probe produces it. `;
  }
}

function degradedItem(cell: FiringCell, fold: Fold, repo: string): CloudBacklogItem {
  const name = fieldText(cell.key.slice(3), MAX_NAME_CHARS);
  return {
    id: `controller-blind-${sha(name.toLowerCase())}`,
    title: `Controller signal '${name}' unreadable every tick`.slice(0, MAX_TITLE_CHARS),
    prompt: [
      `Phantom's fleet-controller ledger shows the non-critical reading '${name}' in signals.degraded on ${cell.ticks} recorded tick(s) across ${cell.hours} distinct hour(s) on ${cell.days} separate day(s) inside the ${CONTROLLER_WINDOW_HOURS / 24}-day window — the band that reads it ran blind the whole time.`,
      '',
      degradedGuidance(name),
      EVIDENCE,
      windowNote(fold) + spanNote(fold),
      PINNED_NOTE,
      ` ${NO_CHANGE}`,
    ].join('\n'),
    area: AREA,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function shedPrompt(fold: Fold): string {
  const drivers = topDrivers(fold);
  const levels = levelLine(fold);
  const modes = [...fold.modeTicks.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} on ${n} tick(s)`).join(', ');
  return [
    `Phantom's fleet-controller ledger shows the applied shed plan at level 2 (shed25) or 3 (freeze) — fleet targets cut to a quarter or floored — on recurring hour(s) across ${CONTROLLER_MIN_DAYS}+ separate days inside the ${CONTROLLER_WINDOW_HOURS / 24}-day window. This is the controller throttling the fleet itself, not a launch block.`,
    '',
    `Applied levels recorded: ${levels}. Shadow would-shed ticks: ${fold.shadowShedTicks}; fail-closed signature instances: ${fold.failTicks}. Recorded top shed drivers: ${drivers}.${modes ? ` Row modes: ${modes}.` : ''}`,
    '',
    EVIDENCE,
    windowNote(fold) + spanNote(fold),
    PINNED_NOTE,
    ` Decide whether the shed is warranted — if 'procs' or 'worktrees' dominates, this fleet's own process/worktree sprawl is the cause and the fix lives in this repository (worker counts, reap coverage, launch fan-out); if 'load', 'mem_free', 'memory_pressure' or 'swap_growth' dominates, the host is genuinely saturated — cross-reference queue/host-load-history.jsonl (\`phm host load --history\`) and metrics/swapout-rate.jsonl before changing fleet knobs, and consider whether the shed band constants in fleet_controller.py match this host's measured operating point (pinned machinery: Security review and re-pin). ${NO_CHANGE}`,
  ].join('\n');
}

function shedItem(fold: Fold, cell: FiringCell, repo: string): CloudBacklogItem {
  return {
    id: 'controller-shed',
    title: `Fleet controller keeps shedding the fleet (level ≥2 on ${cell.hours} hour(s))`.slice(0, MAX_TITLE_CHARS),
    prompt: shedPrompt(fold),
    area: AREA,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function shedSignalGuidance(signal: string): string {
  switch (signal) {
    case 'procs':
      return `The process-count band keeps firing — this fleet's own worker/child process sprawl is the likely driver and the fix lives in this repository (launch fan-out, per-worker process trees, reap coverage). `;
    case 'worktrees':
      return `The worktree-count band keeps firing — job worktrees are piling past the limit; check the reap tick's coverage and holds (queue/worktree-reap.jsonl, src/core/fleet/worktrees.ts). `;
    case 'load':
    case 'mem_free':
    case 'memory_pressure':
    case 'swap_growth':
      return `A host-pressure band keeps firing — the host is likely genuinely saturated; cross-reference queue/host-load-history.jsonl and metrics/swapout-rate.jsonl, then decide whether the band constants match this host's operating point or fleet parallelism should shrink. `;
    default:
      return `A recorded shed driver with no named guidance — trace which pressure_levels band in fleet_controller.py emits it. `;
  }
}

function shedSignalItem(cell: FiringCell, fold: Fold, repo: string): CloudBacklogItem {
  const signal = fieldText(cell.key.slice(3), MAX_NAME_CHARS);
  return {
    id: `controller-shedsig-${sha(signal.toLowerCase())}`,
    title: `Shed driver '${signal}' keeps throttling the fleet`.slice(0, MAX_TITLE_CHARS),
    prompt: [
      `Phantom's fleet-controller ledger shows '${signal}' recorded as a top shed driver on ${cell.ticks} tick(s) across ${cell.hours} distinct hour(s) on ${cell.days} separate day(s) inside the ${CONTROLLER_WINDOW_HOURS / 24}-day window — the band that reads it keeps hitting its shed threshold.`,
      '',
      shedSignalGuidance(signal),
      EVIDENCE,
      windowNote(fold) + spanNote(fold),
      PINNED_NOTE,
      ` ${NO_CHANGE}`,
    ].join('\n'),
    area: AREA,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function shedUnappliedPrompt(fold: Fold): string {
  const drivers = topDrivers(fold);
  const modes = [...fold.modeTicks.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} on ${n} tick(s)`).join(', ');
  return [
    `Phantom's fleet-controller ledger shows would-shed plans at level 1+ that no tick ever applied — the controller computes shed decisions and the fleet runs unthrottled anyway, on recurring hour(s) across ${CONTROLLER_MIN_DAYS}+ separate days inside the ${CONTROLLER_WINDOW_HOURS / 24}-day window.`,
    '',
    `Shadow would-shed ticks: ${fold.shadowShedTicks}; applied shed ticks: ${fold.appliedShedTicks}.${drivers ? ` Recorded would-be drivers: ${drivers}.` : ''}${modes ? ` Row modes: ${modes}.` : ''}`,
    '',
    EVIDENCE,
    windowNote(fold) + spanNote(fold),
    ` Decide which side is intended: a deliberate shadow rollout is a valid answer (document it and report no-change); a forgotten phase flag or an FC_ENFORCE/FC_PHASES drift is the finding. The flags live in the dispatchd launch context — pinned ops machinery, Security review and re-pin — while the shadow bookkeeping itself is fleet_controller.py ledger_record, same boundary. ${NO_CHANGE}`,
  ].join('\n');
}

function shedUnappliedItem(fold: Fold, cell: FiringCell, repo: string): CloudBacklogItem {
  return {
    id: 'controller-shed-unapplied',
    title: `Controller would-shed never applied (${cell.hours} hour(s) across ${cell.days} day(s))`.slice(0, MAX_TITLE_CHARS),
    prompt: shedUnappliedPrompt(fold),
    area: AREA,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function ambiguousPrompt(lane: string, cell: FiringCell, fold: Fold): string {
  return [
    `Phantom's fleet-controller ledger shows lane '${lane}' in ambiguous_holds on ${cell.ticks} recorded tick(s) across ${cell.hours} distinct hour(s) on ${cell.days} separate day(s) inside the ${CONTROLLER_WINDOW_HOURS / 24}-day window — the dispatcher treats it as unheld while \`phm\` readers report it held: the held flag and its held_by/held_until attribution disagree.`,
    '',
    `ambiguous_holds is computed by fc.ambiguous_holds(slots, LANES) each tick and exists precisely to surface this disagreement — it is recorded, never rewritten.`,
    '',
    EVIDENCE,
    windowNote(fold) + spanNote(fold),
    ` Find which side mis-attributes the hold: the slot writer's hold/unhold paths in contrib/mac/dispatchd.py (held, held_by, held_until, auth_failed keys) versus the phm-side held readers. A lane silently treated as unheld while reported held skews every capacity and backpressure decision that reads it. ${NO_CHANGE}`,
  ].join('\n');
}

function ambiguousItem(cell: FiringCell, fold: Fold, repo: string): CloudBacklogItem {
  const raw = cell.key.slice(3);
  const lane = fieldText(raw, MAX_NAME_CHARS);
  return {
    id: `controller-ambiguous-${sha(raw.toLowerCase())}`,
    title: `Lane '${lane}' hold attribution keeps disagreeing`.slice(0, MAX_TITLE_CHARS),
    prompt: ambiguousPrompt(lane, cell, fold),
    area: AREA,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function objectivePrompt(cell: FiringCell, fold: Fold): string {
  const degradedMerge = fold.degradedTicks.get('merge') ?? 0;
  return [
    `Phantom's fleet-controller ledger shows objective_score null on ${cell.ticks} recorded tick(s) across ${cell.hours} distinct hour(s) on ${cell.days} separate day(s) inside the ${CONTROLLER_WINDOW_HOURS / 24}-day window — the merge readings (merged_1h, ci_fail_rate, closed_unmerged_rate) never landed, so the controller's objective score stayed blind exactly as fleet_controller.py's objective() documents: None when the merge signal is unreadable, never invented.`,
    '',
    `The same unreadable merge feed also lands 'merge' in signals.degraded — recorded on ${degradedMerge} tick(s) inside the window. The objective field itself was recorded on ${fold.objectiveTicks} tick(s), so the blindness is measured, not assumed.`,
    '',
    EVIDENCE,
    windowNote(fold) + spanNote(fold),
    ` Find the merge readings producer in dispatchd's BUS assembly — the jobs-ledger/gh reads that build BUS["merge"] — and why it stays unreadable: a missing ledger path, a gh auth failure, or a reader that silently returns nothing. A blind objective means outcome-weighted lane quality and the scorecard views all degrade together. ${NO_CHANGE}`,
  ].join('\n');
}

function objectiveItem(cell: FiringCell, fold: Fold, repo: string): CloudBacklogItem {
  return {
    id: 'controller-objective-blind',
    title: `Controller objective blind — merge readings unreadable`.slice(0, MAX_TITLE_CHARS),
    prompt: objectivePrompt(cell, fold),
    area: AREA,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function qualityPrompt(cell: FiringCell, fold: Fold): string {
  const share = fold.qualityTotal > 0 ? Math.round((fold.qualityUnmeasured / fold.qualityTotal) * 100) : 0;
  return [
    `Phantom's fleet-controller ledger shows route.quality.v1 receipts answering 'unmeasured' on the majority of ${fold.qualityTicks} recorded receipt-bearing tick(s) — ${fold.qualityUnmeasured} of ${fold.qualityTotal} receipts inside the ${CONTROLLER_WINDOW_HOURS / 24}-day window (${share}%) — across ${cell.hours} distinct hour(s) on ${cell.days} separate day(s). outcome_quality() emits 'unmeasured' when the fleet.eval-report.v1 feed is invalid/stale or a lane has no resolved-merge cohort, so lane quality weights stay neutral and bad lanes are never penalized.`,
    '',
    EVIDENCE,
    windowNote(fold) + spanNote(fold),
    ` Find why the eval-report feed does not land: EVAL_F.result's 0.25 s budget in dispatchd may be shorter than report generation, the report's own sources (jobs, pullRequests, observations) may be degraded, or the cohort join may resolve nothing. The receipts live in queue/fleet-controller.json (FC_STATE) and feed src/core/router/controller-quality.ts + weight-proposals.ts — check \`phm fleet eval-report\` output freshness first. ${NO_CHANGE}`,
  ].join('\n');
}

function qualityItem(cell: FiringCell, fold: Fold, repo: string): CloudBacklogItem {
  return {
    id: 'controller-quality-unmeasured',
    title: `Lane quality receipts keep answering 'unmeasured'`.slice(0, MAX_TITLE_CHARS),
    prompt: qualityPrompt(cell, fold),
    area: AREA,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/**
 * Backlog items for the fleet-controller ledger's recurring control
 * evidence. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function controllerBacklogItems(opts: ControllerItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');
    const ledgerPath = opts.ledgerPath ?? join(runsDir, CONTROLLER_LEDGER_RELATIVE);
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowStartMs = nowMs - CONTROLLER_WINDOW_HOURS * 3_600_000;

    // The writer rotates once at 8 MiB keeping a single `.1` generation;
    // read the older generation first so retained history reaches furthest back.
    const [older, newer] = await Promise.all([
      readLedgerTail(`${ledgerPath}.1`),
      readLedgerTail(ledgerPath),
    ]);
    if (older.state !== 'read' && newer.state !== 'read') return [];

    const fold: Fold = {
      ticks: 0,
      truncated: (older.state === 'read' && older.truncated) || (newer.state === 'read' && newer.truncated),
      hourTicks: new Map(),
      cond: new Map(),
      shedLevelTicks: new Map(),
      shadowShedTicks: 0,
      appliedShedTicks: 0,
      driverTicks: new Map(),
      failTicks: 0,
      degradedTicks: new Map(),
      objectiveTicks: 0,
      qualityTicks: 0,
      qualityUnmeasured: 0,
      qualityTotal: 0,
      modeTicks: new Map(),
      firstAtMs: null,
      lastAtMs: null,
    };
    for (const text of [older.state === 'read' ? older.text : '', newer.state === 'read' ? newer.text : '']) {
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        let raw: unknown;
        try { raw = JSON.parse(line); } catch { continue; }
        const tick = parseControllerTick(raw, windowStartMs, nowMs);
        if (tick !== null) foldTick(fold, tick);
      }
    }
    if (fold.ticks === 0) return [];

    // Umbrella cells at the strict bar, per-key cells at the rarer-event bar.
    const cells = (prefix: string, minHours: number): FiringCell[] => {
      const out: FiringCell[] = [];
      for (const key of fold.cond.keys()) {
        if (!key.startsWith(prefix)) continue;
        const cell = firingCell(fold, key);
        if (cell !== null && cell.hours >= minHours && cell.days >= CONTROLLER_MIN_DAYS) out.push(cell);
      }
      return out.sort((a, b) => b.hours - a.hours || a.key.localeCompare(b.key));
    };
    const umbrellas = cells('U:', CONTROLLER_UMBRELLA_HOURS);
    const failClosed = cells('FC:', CONTROLLER_CELL_HOURS);
    const degraded = cells('DG:', CONTROLLER_CELL_HOURS);
    const shedSignals = cells('SD:', CONTROLLER_CELL_HOURS);
    const ambiguous = cells('AH:', CONTROLLER_CELL_HOURS);
    const byKey = (a: FiringCell, b: FiringCell): number => b.hours - a.hours || a.key.localeCompare(b.key);
    failClosed.sort(byKey);
    degraded.sort(byKey);
    shedSignals.sort(byKey);
    ambiguous.sort(byKey);

    const candidates: CloudBacklogItem[] = [];
    // Severity order: a frozen fleet first, then active shedding, unapplied
    // shed, blind objective, unmeasured quality; per-key cells follow by recurrence.
    for (const cell of failClosed) candidates.push(failClosedItem(cell, fold, repo));
    const shed = umbrellas.find((c) => c.key === 'U:shed');
    if (shed !== undefined) candidates.push(shedItem(fold, shed, repo));
    const unapplied = umbrellas.find((c) => c.key === 'U:shedunapplied');
    if (unapplied !== undefined) candidates.push(shedUnappliedItem(fold, unapplied, repo));
    const objective = umbrellas.find((c) => c.key === 'U:objective');
    if (objective !== undefined) candidates.push(objectiveItem(objective, fold, repo));
    const quality = umbrellas.find((c) => c.key === 'U:quality');
    if (quality !== undefined) candidates.push(qualityItem(quality, fold, repo));
    for (const cell of shedSignals) candidates.push(shedSignalItem(cell, fold, repo));
    for (const cell of degraded) candidates.push(degradedItem(cell, fold, repo));
    for (const cell of ambiguous) candidates.push(ambiguousItem(cell, fold, repo));

    const limit = Math.max(1, Math.min(opts.limit ?? CONTROLLER_MAX_ITEMS, CONTROLLER_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}

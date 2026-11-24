/**
 * Memory-pressure evidence → self-improvement backlog items.
 *
 * The daemon's `swapout-sync` off-tick job folds the bridge's latest
 * memstat.json reading into `<runs>/metrics/swapout-rate.jsonl`
 * (schema `fleet.swapout-sample.v1`, src/core/fleet/swapout-sync.ts): one
 * row per sample carrying `sampled_at`, `free_pct`, `swap_gb` and
 * `swapouts_per_min`, appended at the bridge's own cadence and deduped by
 * sampled_at. The ledger exists because lane-autopilot's MEMORY_GUARD
 * constants are explicitly UNMEASURED — "tune from
 * metrics/swapout-rate.jsonl" is the note on the constants themselves —
 * and until now the only readers were `phm fleet vitals` (the
 * swapout_rate section with per-field guard shares) and the console's
 * memory-guard card: reports and surfaces someone had to open, with no
 * recurrence fold and no path to work. A host that keeps running out of
 * memory is direct fleet-capacity drag on two recorded axes:
 *
 *   - recorded pressure: samples where any recorded field meets a severe
 *     line — free_pct below MEMORY_GUARD.lowFreePct, any swapout
 *     activity (swapouts_per_min above zero, the same real-pressure leg
 *     `phm host memory`'s verdict applies), or swap_gb above
 *     swapBackstopGb. The lanes that use this Mac's memory are
 *     throttled toward their floors by lane-memory-pressure, and every
 *     one of these samples is one the fleet's own evidence calls
 *     starvation — the quiet hysteresis band (free between the low and
 *     raise lines with no swapout activity) stays out of this axis and
 *     shows up only through the withheld-raise one.
 *   - withheld raises: complete readings (all three fields recorded)
 *     that memoryAllowsRaise refuses — the autopilot's lane-target
 *     growth check. memoryAllowsRaise also refuses inside the
 *     25–30 % hysteresis band and on the free≤raiseFreePct return, so a
 *     host idling just under the raise line blocks raises without ever
 *     touching a severe condition; the four per-field shares the prompt
 *     quotes say which mechanism dominates.
 *
 * memoryBacklogItems carries the same ledger into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the fleet outcome-learning, nightly retro, policy,
 * local-gate, pass^k, friction, tick-health, cross-review, empty-tag,
 * post-merge, ci-rerun and lost-launch sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read through readLedgerTail's bounded
 *    no-follow tail (SWAPOUT_LEDGER_TAIL_BYTES, the same window the
 *    sync's dedup read and the vitals evidence read use); rows are
 *    validated by parseSwapoutRow — the same structural check the
 *    writer and read-back apply — and nothing is written and no
 *    process is inspected.
 *  - Missing or unreadable evidence yields no items. An absent,
 *    non-file or unreadable ledger reads as no evidence — unknown
 *    stays unknown, never a guessed tally — and rows outside the
 *    window or failing validation never reach the fold.
 *  - Recurring means recorded, on the fold's own bars. An item emits
 *    only while at least MEMORY_RECURRING_HOURS distinct hour buckets
 *    inside the window each show the condition on at least half of
 *    their judged samples — with at least MEMORY_HOUR_MIN_SAMPLES
 *    judged samples in the bucket, so one stray reading or a sparse
 *    hour never counts — AND those hours span at least
 *    MEMORY_MIN_DAYS separate UTC days, so one bad afternoon never
 *    queues a session. When the retained tail cannot show two days of
 *    recurrence the source stays quiet: the claim is recurrence, and
 *    a short window cannot prove it.
 *  - Judged stays honest. A pressure sample needs only one recorded
 *    field to convict (swapouts_per_min alone proves pressure) but a
 *    row with no stat fields at all is not judged either way; a
 *    withheld-raise sample needs the complete three-field reading
 *    memoryAllowsRaise itself requires, so partial rows never count
 *    as blocked or clear. Per-field coverage counts ride in the
 *    evidence so the prompt quotes real denominators.
 *  - The evidence carries no repository dimension — it describes this
 *    install's host and fleet machinery. Items therefore emit only
 *    when the backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Both ids are stable strings, so a refresh
 *    re-derives the same ids and appendUserBacklogItems adds only what
 *    is new; shifted tallies do not spawn twin items and a quiet
 *    window stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, the guard constants are named from
 *    MEMORY_GUARD itself, and the brief names the ledger, `phm fleet
 *    vitals`, the sync module, the autopilot guard and the
 *    lane-memory-pressure throttle — with the usual no-change escape
 *    when the window no longer reproduces or the cause is owner-side.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  parseSwapoutRow,
  SWAPOUT_FUTURE_SKEW_MS,
  SWAPOUT_LEDGER_TAIL_BYTES,
  SWAPOUT_RATE_LEDGER_RELATIVE,
  type SwapoutSample,
} from '../fleet/swapout-sync.js';
import { MEMORY_GUARD, memoryAllowsRaise } from '../resources/lane-autopilot.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit: at most one per evidence axis. */
export const MEMORY_MAX_ITEMS = 2;
const MEMORY_ITEM_HARD_MAX = 25;
/**
 * Evidence window: seven days, the same convention the friction,
 * tick-health and ci-rerun sources apply. The retained tail may cover
 * less; the fold uses what the window holds and the recurrence bars
 * keep short coverage honest.
 */
export const MEMORY_WINDOW_HOURS = 168;
/**
 * Judged samples one hour bucket needs before its share can convict —
 * sparse hours never count toward recurrence.
 */
export const MEMORY_HOUR_MIN_SAMPLES = 6;
/**
 * Distinct hour buckets that must each show the condition on at least
 * half of their judged samples before it counts as recurring.
 */
export const MEMORY_RECURRING_HOURS = 6;
/** Those recurring hours must span at least this many separate UTC days — one bad day is an incident, not a pattern. */
export const MEMORY_MIN_DAYS = 2;
/** The fleet's own repository label: host memory evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

export interface MemoryItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/swapout-rate.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default MEMORY_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** Recurring-hour tally for one evidence axis: qualifying buckets and the days they span. */
export interface MemoryHourEvidence {
  /** Distinct hour buckets meeting the recurrence bar inside the window. */
  hours: number;
  /** Distinct UTC days those buckets fall on. */
  days: number;
}

/** The fold's measured evidence; every count is over in-window valid rows only. */
export interface MemoryEvidence {
  /** Valid swapout-sample rows inside the window. */
  samples: number;
  /** Lines that were not a valid swapout-sample row; ignored, never guessed. */
  invalidRows: number;
  /** Valid rows dated outside the window or beyond the future skew; not evidence either way. */
  outsideWindow: number;
  /** True when the retained tail dropped older bytes — coverage is the retained window only. */
  ledgerTruncated: boolean;
  /** Sample-time bounds across the in-window rows; null when none parsed. */
  oldestAt: string | null;
  newestAt: string | null;
  /** Rows carrying at least one stat field — the pressure axis's judged denominator. */
  judged: number;
  /** Judged rows meeting a severe line (low free, any swapout activity or swap backstop). */
  pressure: number;
  /** Rows carrying all three stat fields — the complete readings memoryAllowsRaise requires. */
  complete: number;
  /** Complete rows memoryAllowsRaise refuses — the withheld-raise axis's hit count. */
  blocked: number;
  /** Per-field coverage and hit counts behind the prompt's quoted shares (same denominators as the vitals read-back). */
  freePctKnown: number;
  freeBelowLow: number;
  freeAboveRaise: number;
  swapoutsKnown: number;
  swapoutsPositive: number;
  swapoutsGrowing: number;
  swapGbKnown: number;
  swapAboveBackstop: number;
  /** Recurring recorded-pressure hour buckets and the days they span. */
  pressureHours: MemoryHourEvidence;
  /** Recurring withheld-raise hour buckets and the days they span. */
  blockedHours: MemoryHourEvidence;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * A row meets a severe line when any recorded field crosses it: free
 * below the guard's low line, any recorded swapout activity (the host
 * memory verdict's own real-pressure leg), or swap past the absolute
 * backstop. The hysteresis band alone never counts — free between the
 * low and raise lines with no swapout activity is the withheld-raise
 * axis's evidence, not this one's.
 */
function isPressure(row: SwapoutSample): boolean {
  if (row.freePct !== null && row.freePct < MEMORY_GUARD.lowFreePct) return true;
  if (row.swapoutsPerMin !== null && row.swapoutsPerMin > 0) return true;
  if (row.swapGb !== null && row.swapGb > MEMORY_GUARD.swapBackstopGb) return true;
  return false;
}

/** A complete reading is one memoryAllowsRaise can actually judge; partial rows are neither blocked nor clear. */
function isComplete(row: SwapoutSample): row is SwapoutSample & { freePct: number; swapGb: number; swapoutsPerMin: number } {
  return row.freePct !== null && row.swapGb !== null && row.swapoutsPerMin !== null;
}

interface HourBucket {
  judged: number;
  pressure: number;
  complete: number;
  blocked: number;
}

const HOUR_MS = 3_600_000;
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/**
 * Pure: fold parsed ledger values into the memory evidence. `values` are
 * the JSON.parsed ledger lines; each is validated by parseSwapoutRow —
 * the writer's own structural check — then windowed on its own
 * sampled_at. Unknown stays unknown: unparseable lines count as
 * invalidRows, out-of-window rows as outsideWindow, and a row with no
 * stat fields is never judged.
 */
export function foldMemoryEvidence(
  values: readonly unknown[],
  opts: { nowMs: number; windowHours?: number },
): MemoryEvidence {
  const windowMs = (opts.windowHours ?? MEMORY_WINDOW_HOURS) * HOUR_MS;
  const windowStart = opts.nowMs - windowMs;
  const windowEnd = opts.nowMs + SWAPOUT_FUTURE_SKEW_MS;
  const evidence: MemoryEvidence = {
    samples: 0, invalidRows: 0, outsideWindow: 0, ledgerTruncated: false,
    oldestAt: null, newestAt: null,
    judged: 0, pressure: 0, complete: 0, blocked: 0,
    freePctKnown: 0, freeBelowLow: 0, freeAboveRaise: 0,
    swapoutsKnown: 0, swapoutsPositive: 0, swapoutsGrowing: 0,
    swapGbKnown: 0, swapAboveBackstop: 0,
    pressureHours: { hours: 0, days: 0 },
    blockedHours: { hours: 0, days: 0 },
  };
  const buckets = new Map<number, HourBucket>();
  let oldestMs = Number.POSITIVE_INFINITY;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const row = parseSwapoutRow(value);
    if (row === null) { evidence.invalidRows += 1; continue; }
    const at = Date.parse(row.sampledAt);
    if (!Number.isFinite(at) || at < windowStart || at > windowEnd) { evidence.outsideWindow += 1; continue; }
    evidence.samples += 1;
    oldestMs = Math.min(oldestMs, at);
    newestMs = Math.max(newestMs, at);
    const judged = row.freePct !== null || row.swapGb !== null || row.swapoutsPerMin !== null;
    const pressure = judged && isPressure(row);
    // isComplete narrows the row for the guard call itself; the complete flag
    // is the same three-field condition computed plainly for the tallies.
    const blocked = isComplete(row) && !memoryAllowsRaise({
      freePct: row.freePct, swapUsedGb: row.swapGb, swapoutsPerMin: row.swapoutsPerMin,
    });
    const complete = row.freePct !== null && row.swapGb !== null && row.swapoutsPerMin !== null;
    if (judged) evidence.judged += 1;
    if (pressure) evidence.pressure += 1;
    if (complete) evidence.complete += 1;
    if (blocked) evidence.blocked += 1;
    if (row.freePct !== null) {
      evidence.freePctKnown += 1;
      if (row.freePct < MEMORY_GUARD.lowFreePct) evidence.freeBelowLow += 1;
      if (row.freePct > MEMORY_GUARD.raiseFreePct) evidence.freeAboveRaise += 1;
    }
    if (row.swapoutsPerMin !== null) {
      evidence.swapoutsKnown += 1;
      if (row.swapoutsPerMin > 0) evidence.swapoutsPositive += 1;
      if (row.swapoutsPerMin >= MEMORY_GUARD.growingSwapoutsPerMin) evidence.swapoutsGrowing += 1;
    }
    if (row.swapGb !== null) {
      evidence.swapGbKnown += 1;
      if (row.swapGb > MEMORY_GUARD.swapBackstopGb) evidence.swapAboveBackstop += 1;
    }
    // A complete reading always carries a stat field, so judged covers both axes.
    if (judged) {
      const hour = Math.floor(at / HOUR_MS);
      let bucket = buckets.get(hour);
      if (bucket === undefined) { bucket = { judged: 0, pressure: 0, complete: 0, blocked: 0 }; buckets.set(hour, bucket); }
      bucket.judged += 1;
      if (pressure) bucket.pressure += 1;
      if (complete) { bucket.complete += 1; if (blocked) bucket.blocked += 1; }
    }
  }
  if (evidence.samples > 0) {
    evidence.oldestAt = new Date(oldestMs).toISOString();
    evidence.newestAt = new Date(newestMs).toISOString();
  }
  const tally = (pick: (b: HourBucket) => { n: number; d: number }): MemoryHourEvidence => {
    let hours = 0;
    const days = new Set<string>();
    for (const [hour, bucket] of buckets) {
      const { n, d } = pick(bucket);
      if (d >= MEMORY_HOUR_MIN_SAMPLES && n * 2 >= d) {
        hours += 1;
        days.add(new Date(hour * HOUR_MS).toISOString().slice(0, 10));
      }
    }
    return { hours, days: days.size };
  };
  evidence.pressureHours = tally((b) => ({ n: b.pressure, d: b.judged }));
  evidence.blockedHours = tally((b) => ({ n: b.blocked, d: b.complete }));
  return evidence;
}

/** Share of `known` hits as a 0..1 fraction rounded for prompts; null when the field was never measured — unknown stays unknown. */
const share = (hits: number, known: number): number | null => (known > 0 ? round4(hits / known) : null);
const pctText = (hits: number, known: number): string => {
  const s = share(hits, known);
  return s === null ? 'unknown' : `${Math.round(s * 1000) / 10}%`;
};

const NO_CHANGE = 'If the window has rolled forward, the pressure was a one-off burst the next samples recovered from, or the cause is owner-only or pinned ops machinery (credentials, billing, host disk, the Security-reviewed launcher/dispatcher files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the ledger, its writer and its existing readers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is metrics/swapout-rate.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), schema fleet.swapout-sample.v1 — one row per bridge memstat.json sample with sampled_at, free_pct, swap_gb and swapouts_per_min — folded by this feed through the same parseSwapoutRow validation src/core/fleet/swapout-sync.ts writes and src/core/fleet/swapout-sync.ts\'s readSwapoutRateEvidence reads back for `phm fleet vitals`\' swapout_rate section (per-field coverage and the same four guard shares this prompt quotes). `phm host memory` and `phm lanes pressure` show the live verdict; queue/host-load-history.jsonl via `phm host load --history` carries the CPU-side contributor attribution for the same windows.';

function spanText(ev: MemoryEvidence): string {
  if (ev.oldestAt === null || ev.newestAt === null) return '';
  return ev.oldestAt === ev.newestAt
    ? ` Recorded ${ev.oldestAt}.`
    : ` Recorded ${ev.oldestAt} through ${ev.newestAt}.`;
}

function pressurePrompt(ev: MemoryEvidence): string {
  const g = MEMORY_GUARD;
  return [
    `Phantom's fleet host keeps hitting recorded memory pressure — ${ev.pressureHours.hours} distinct hour buckets across ${ev.pressureHours.days} UTC days inside the window each showed pressure on at least half of their judged samples, the self-improvement work this backlog exists for.`,
    '',
    `A sample is recorded pressure when any recorded field meets a severe line: free_pct below ${g.lowFreePct}%, any swapout activity (swapouts_per_min above zero — the same real-pressure leg \`phm host memory\`'s verdict applies), or swap_gb above ${g.swapBackstopGb}GB — anchored to the MEMORY_GUARD constants in src/core/resources/lane-autopilot.ts, explicitly marked UNMEASURED pending exactly this ledger. ${ev.pressure} of ${ev.judged} field-carrying samples met a severe line (${pctText(ev.pressure, ev.judged)}); ${ev.complete} samples carried all three fields and ${ev.blocked} of those would have failed memoryAllowsRaise outright.${spanText(ev)}`,
    '',
    EVIDENCE,
    '',
    `Recorded pressure throttles the lanes that use this Mac's memory — src/core/fleet/lane-memory-pressure.ts drops local lanes toward their floor under warning and critical — and starves lane-target raises through memoryAllowsRaise. Find what is holding the memory: fleet job parallelism and worker footprints, the local model server, long-lived engine processes — the recorded contributor names in the host-load ledger are the first suspects. Fix what lives in this repo (lane targets and floors, autopilot constants the evidence supports, footprint reductions, detectors that read this evidence); if the pressure comes from owner-side apps or pinned ops machinery — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function blockedPrompt(ev: MemoryEvidence): string {
  const g = MEMORY_GUARD;
  const freeBelow = pctText(ev.freeBelowLow, ev.freePctKnown);
  const freeAbove = pctText(ev.freeAboveRaise, ev.freePctKnown);
  const swapoutsGrowing = pctText(ev.swapoutsGrowing, ev.swapoutsKnown);
  const swapBackstop = pctText(ev.swapAboveBackstop, ev.swapGbKnown);
  const swapoutsPositive = pctText(ev.swapoutsPositive, ev.swapoutsKnown);
  return [
    `Phantom's memory guard keeps withholding lane-target raises — ${ev.blockedHours.hours} distinct hour buckets across ${ev.blockedHours.days} UTC days inside the window each had at least half of their complete readings fail memoryAllowsRaise, the self-improvement work this backlog exists for.`,
    '',
    `Of ${ev.freePctKnown} samples carrying free_pct, ${freeBelow} sat below the ${g.lowFreePct}% low line and ${freeAbove} above the ${g.raiseFreePct}% raise line; of ${ev.swapoutsKnown} carrying swapouts_per_min, ${swapoutsPositive} were above zero and ${swapoutsGrowing} met the ${g.growingSwapoutsPerMin}/min growing line; of ${ev.swapGbKnown} carrying swap_gb, ${swapBackstop} exceeded the ${g.swapBackstopGb}GB backstop. ${ev.blocked} of ${ev.complete} complete readings were refused. Which line dominates decides the fix: a high below-low share is genuine memory starvation the pressure item owns; a raise-headroom share near zero over a quiet below-low share means the unmeasured raiseFreePct default sits above this host's normal operating point; a nonzero backstop share means parked swap is accumulating past the absolute ceiling.${spanText(ev)}`,
    '',
    EVIDENCE,
    '',
    `The constants are explicitly UNMEASURED — the comment on MEMORY_GUARD in src/core/resources/lane-autopilot.ts says 'tune from metrics/swapout-rate.jsonl', and this ledger is that measurement. Review the constants against the recorded distribution and either retune them with the measured denominators or document why the current values are right; memoryAllowsRaise, decideLane and the lane targets/floors the autopilot writes are the surfaces. If the block is genuine host pressure rather than miscalibration — report no-change here and name the evidence; the memory-pressure item covers that case. ${NO_CHANGE}`,
  ].join('\n');
}

function recurring(ev: MemoryEvidence, axis: 'pressure' | 'blocked'): boolean {
  const hours = axis === 'pressure' ? ev.pressureHours : ev.blockedHours;
  return hours.hours >= MEMORY_RECURRING_HOURS && hours.days >= MEMORY_MIN_DAYS;
}

function memoryItem(id: string, title: string, prompt: string, repo: string): CloudBacklogItem {
  return {
    id,
    title: title.slice(0, 200),
    prompt,
    area: 'memory-pressure',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the swapout-rate ledger's recurring memory evidence.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function memoryBacklogItems(opts: MemoryItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sync and vitals read apply: explicit dir, then a
    // non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env value is
    // no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const ledger = await readLedgerTail(join(runsDir, SWAPOUT_RATE_LEDGER_RELATIVE), SWAPOUT_LEDGER_TAIL_BYTES);
    if (ledger.state !== 'read') return [];
    const values: unknown[] = [];
    for (const line of ledger.text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { values.push(JSON.parse(line)); } catch { values.push(null); }
    }
    const evidence = foldMemoryEvidence(values, { nowMs });
    evidence.ledgerTruncated = ledger.truncated;
    const items: CloudBacklogItem[] = [];
    if (recurring(evidence, 'pressure')) {
      items.push(memoryItem(
        'memory-pressure-hours',
        'Fleet host memory keeps hitting recorded pressure',
        pressurePrompt(evidence),
        repo,
      ));
    }
    if (recurring(evidence, 'blocked')) {
      items.push(memoryItem(
        'memory-guard-blocked-hours',
        'Memory guard keeps withholding fleet lane raises',
        blockedPrompt(evidence),
        repo,
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? MEMORY_MAX_ITEMS, MEMORY_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}

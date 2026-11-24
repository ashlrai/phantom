/**
 * Daemon tick ledger recurring failures → self-improvement backlog items.
 *
 * Every resident daemon tick records a bounded phase ledger — which stage
 * ran, how long it took, and whether it settled ok, degraded, timed out,
 * was skipped or was abandoned mid-flight (DaemonTick.phases, persisted on
 * each entry of the `ticks` history daemon.json keeps, capped at 100) — plus
 * the tick's own `reason`. Until now the only reader was `phm daemon
 * status`, which prints the LAST tick's phases (`.tick.phases`) and outcome:
 * a phase that throws or exceeds its deadline every few ticks, a stage the
 * tick budget keeps starving, or an off-tick job whose settled runs keep
 * failing was invisible as a pattern — each bad tick looked like a one-off.
 * The strategy's Observe list names steward and daemon health as self-
 * improvement input; nothing folded it into work.
 * tickHealthBacklogItems carries the retained history into discoverBacklog,
 * so `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the fleet outcome-learning, nightly retro, policy,
 * local-gate, pass^k and friction sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. daemon.json is read through readSource's bounded no-follow
 *    whole-file read; nothing is written and no network is touched. Only
 *    the `ticks[].ts`, `ticks[].reason` and `ticks[].phases[]` fields are
 *    consumed — the state file's spend, dispatch and backlog fields never
 *    reach a prompt.
 *  - Healthy-only evidence. A missing state file yields no items (a fresh
 *    install has no daemon — that is normal, not a finding); an unreadable,
 *    oversized or unparseable file, or a `ticks` value that is not an
 *    array, yields no items — unknown stays unknown, never a guessed tally.
 *  - Recency-windowed. Only ticks whose `ts` parses inside
 *    TICK_HEALTH_WINDOW_MS of the clock count, so a daemon that stopped
 *    ticking weeks ago never queues work for stale failures; a tick with
 *    no parseable timestamp cannot be placed in the window and is ignored.
 *  - Recurring means recorded. A phase name emits only after
 *    TICK_HEALTH_RECURRING non-clean outcomes across the in-window ticks —
 *    the fleet's RECURRING_FAILURES convention — so one bad tick never
 *    queues a session. Non-clean means degraded, timeout, abandoned
 *    ('running' persisted in history: the tick was abandoned mid-phase),
 *    skipped because the tick budget was exhausted, or an off-tick job
 *    whose distinct settled runs keep failing (deduplicated by run and
 *    settle time, so one failing run observed on fifty ticks counts once).
 *    Intentional skips ('no-frontier' and friends) and unsettled off-tick
 *    entries are context, never failures.
 *  - Whole-tick failures count too. A tick `reason` in BAD_TICK_REASONS —
 *    'state-persistence-failed' (the tick's state could not be persisted)
 *    or 'activation-refused' (the live tick was refused for a missing or
 *    invalid activation capability) — recurring across the window emits
 *    its own item: those outcomes are recorded on the tick, outside the
 *    phase ledger, so no phase tally can see them. Policy states like
 *    'budget-exhausted' are deliberately not in the set — a spend cap is
 *    an owner decision, not a machinery bug.
 *  - The daemon's machinery is this repository's: tick phases, deadlines
 *    and the state file are Phantom's own code. Items therefore emit only
 *    when the backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply;
 *    self-improvement pointed at another repository never inherits this
 *    install's daemon-health evidence it cannot attribute.
 *  - Dedup is downstream. The item id embeds a stable hash of the phase
 *    name or tick reason (never the counts or timestamps), so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what is
 *    new; a phase that recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: phase names, reasons
 *    and error texts are scrubbed, flattened to one line and capped before
 *    they reach the prompt, counts are quoted only as recorded, and the
 *    brief carries the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readSource } from '../fleet/runs-parked-queue.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; phase names and bad reasons are both bounded in practice. */
export const TICK_HEALTH_MAX_ITEMS = 8;
const TICK_HEALTH_ITEM_HARD_MAX = 25;
/**
 * Failed outcomes inside the retained window a phase name or tick reason
 * needs before it counts as recurring — the same absolute-evidence bar
 * LOCAL_GATE_RECURRING_FAILURES and outcome-learning's RECURRING_FAILURES apply.
 */
export const TICK_HEALTH_RECURRING = 3;
/** Evidence window: the daemon ticks far more often than this, so it covers the whole retained history of a live install. */
export const TICK_HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** daemon.json is metadata-only state; 4 MiB is many times the realistic size (100 ticks × bounded ledgers). */
const TICK_HEALTH_MAX_STATE_BYTES = 4 * 1024 * 1024;
/** The writer caps ticks at 100; the fold re-caps defensively. */
const TICK_HEALTH_MAX_TICKS = 200;
/** The phase ledger caps at 40 entries per tick (MAX_TICK_PHASES / MAX_PERSISTED_TICK_PHASES upstream). */
const TICK_HEALTH_MAX_PHASES = 40;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded names/errors are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 120;
const MAX_ERROR_CHARS = 160;
const MAX_ERROR_SAMPLES = 3;
/** Future-skew allowance on tick timestamps, same convention the friction fold applies. */
const TICK_HEALTH_FUTURE_SKEW_MS = 60_000;
/** The fleet's own repository label: daemon evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** State-file path named inside item prompts, relative to the ASHLR root. */
const DAEMON_STATE_RELATIVE = 'daemon.json';

const TICK_PHASE_STATUSES: ReadonlySet<string> = new Set([
  'ok', 'degraded', 'timeout', 'skipped', 'running', 'off-tick',
]);
/** Whole-tick reasons that mean the machinery itself failed — never policy states. */
const BAD_TICK_REASONS: ReadonlyMap<string, string> = new Map([
  ['state-persistence-failed', 'the tick ran but its daemon state could not be persisted'],
  ['activation-refused', 'the live tick was refused because the activation capability was missing or invalid'],
]);
const BUDGET_EXHAUSTED = 'tick-budget-exhausted';

export interface TickHealthItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** ASHLR root override for the state file (default: ~/.ashlr, daemonStatePath()'s own resolution — ASHLR_HOME does not relocate daemon.json). */
  rootDir?: string;
  /** Most items one call emits (default TICK_HEALTH_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the evidence window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** ASHLR root the daemon state file lives under: explicit override, else ~/.ashlr — daemonStatePath()'s own resolution (ASHLR_HOME is NOT consulted for daemon.json). */
function ashlrRoot(rootDir: string | undefined): string {
  if (rootDir !== undefined && rootDir.trim() !== '') return rootDir;
  return join(homedir(), '.ashlr');
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Tolerant fold of daemon.json's ticks[] history
// ---------------------------------------------------------------------------

/** The phase-entry fields the fold consumes, parsed tolerantly from persisted JSON. */
interface TickPhaseEntry {
  name: string;
  status: string;
  error?: string;
  offTickRun?: number;
  offTickSettledAt?: string;
  offTickLastStatus?: string;
  offTickLastError?: string;
}

interface TickRow {
  tsMs: number;
  ts: string;
  reason: string | null;
  phases: TickPhaseEntry[];
}

/** Parse one persisted phase entry; null when it is not a usable record. */
function phaseEntry(value: unknown): TickPhaseEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row['name'] !== 'string' || row['name'].trim() === '') return null;
  if (typeof row['status'] !== 'string' || !TICK_PHASE_STATUSES.has(row['status'])) return null;
  const offTick = typeof row['offTick'] === 'object' && row['offTick'] !== null && !Array.isArray(row['offTick'])
    ? row['offTick'] as Record<string, unknown>
    : null;
  return {
    name: fieldText(row['name'], MAX_NAME_CHARS),
    status: row['status'],
    ...(typeof row['error'] === 'string' ? { error: row['error'] } : {}),
    ...(offTick !== null && Number.isSafeInteger(offTick['run']) ? { offTickRun: offTick['run'] as number } : {}),
    ...(offTick !== null && typeof offTick['lastSettledAt'] === 'string' ? { offTickSettledAt: offTick['lastSettledAt'] } : {}),
    ...(offTick !== null && typeof offTick['lastStatus'] === 'string' ? { offTickLastStatus: offTick['lastStatus'] } : {}),
    ...(offTick !== null && typeof offTick['lastError'] === 'string' ? { offTickLastError: offTick['lastError'] } : {}),
  };
}

/** Parse one persisted tick; null when it cannot be placed inside the evidence window. */
function tickRow(value: unknown, windowStartMs: number, windowEndMs: number): TickRow | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row['ts'] !== 'string') return null;
  const tsMs = Date.parse(row['ts']);
  if (!Number.isFinite(tsMs) || tsMs < windowStartMs || tsMs > windowEndMs) return null;
  const phases = Array.isArray(row['phases'])
    ? row['phases'].slice(0, TICK_HEALTH_MAX_PHASES).map(phaseEntry).filter((p): p is TickPhaseEntry => p !== null)
    : [];
  return {
    tsMs,
    ts: row['ts'],
    reason: typeof row['reason'] === 'string' && row['reason'] !== '' ? row['reason'] : null,
    phases,
  };
}

/** Non-clean outcome classes the fold counts; everything else is context. */
type FailureKind = 'degraded' | 'timeout' | 'abandoned' | 'budget-skipped' | 'off-tick-failed';

const FAILURE_KINDS: ReadonlySet<string> = new Set<FailureKind>([
  'degraded', 'timeout', 'abandoned', 'budget-skipped', 'off-tick-failed',
]);

/** Worst-first precedence when one tick records the same phase name more than once. */
const OUTCOME_RANK: Readonly<Record<string, number>> = {
  timeout: 7,
  abandoned: 6,
  degraded: 5,
  'budget-skipped': 4,
  'off-tick-failed': 3,
  skipped: 2,
  'off-tick-ok': 1,
  'off-tick-quiet': 1,
  ok: 0,
};

/**
 * The outcome one phase entry reports. 'off-tick' resolves through the
 * job's own settled-run record: only a degraded or timed-out lastStatus is
 * a failure, an 'ok' lastStatus is measured clean, and anything else —
 * still running, never settled, or absent — stays unknown, never a guess.
 */
function entryOutcome(entry: TickPhaseEntry): { kind: string; error: string | null; dedupKey: string | null } {
  switch (entry.status) {
    case 'degraded':
    case 'timeout':
      return { kind: entry.status, error: entry.error ?? null, dedupKey: null };
    case 'running':
      // A 'running' entry survives only in records written while the phase
      // was in flight — the tick was abandoned at its deadline mid-stage.
      return { kind: 'abandoned', error: entry.error ?? null, dedupKey: null };
    case 'skipped':
      // 'tick-budget-exhausted' is a marker, not an error message — the
      // outcome counts already carry it, so no error sample is collected.
      return entry.error === BUDGET_EXHAUSTED
        ? { kind: 'budget-skipped', error: null, dedupKey: null }
        : { kind: 'skipped', error: null, dedupKey: null };
    case 'off-tick': {
      const last = entry.offTickLastStatus;
      if (last === 'degraded' || last === 'timeout') {
        // One settled run failure is observed on every tick until the next
        // run settles; the (run, settledAt) pair counts it exactly once.
        const dedupKey = `${entry.offTickRun ?? 'run?'}|${entry.offTickSettledAt ?? ''}|${last}`;
        return { kind: 'off-tick-failed', error: entry.offTickLastError ?? entry.error ?? null, dedupKey };
      }
      return { kind: last === 'ok' ? 'off-tick-ok' : 'off-tick-quiet', error: null, dedupKey: null };
    }
    default:
      return { kind: 'ok', error: null, dedupKey: null };
  }
}

export interface TickPhaseTally {
  /** Sanitized phase name as recorded. */
  name: string;
  /** In-window ticks that recorded the phase at all. */
  observed: number;
  ok: number;
  degraded: number;
  timeout: number;
  /** Ticks abandoned while this phase was in flight. */
  abandoned: number;
  /** Ticks that skipped this phase because the whole-tick budget ran out. */
  budgetSkipped: number;
  /** Intentional skips — context only, never failures. */
  skipped: number;
  /** Off-tick entries whose job's last settled run was clean. */
  offTickClean: number;
  /** Distinct settled off-tick run failures (deduplicated across ticks). */
  offTickFailed: number;
  /** Off-tick entries with no settled outcome to judge — unknown stays unknown. */
  offTickQuiet: number;
  /** Non-clean outcomes across the window. */
  failures: number;
  /** Up to MAX_ERROR_SAMPLES scrubbed error texts, most recent first. */
  errors: string[];
  /** ISO timestamps bounding the phase's in-window observations. */
  firstSeen: string;
  lastSeen: string;
  /** ISO timestamp of the newest non-clean observation, or null when none failed. */
  lastFailureAt: string | null;
}

export interface TickReasonTally {
  reason: string;
  /** In-window ticks that ended with this reason. */
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface TickHealthFold {
  /** In-window ticks the fold consumed. */
  ticks: number;
  /** Ticks dropped for a missing/unparseable/out-of-window timestamp. */
  skippedTicks: number;
  phases: TickPhaseTally[];
  reasons: TickReasonTally[];
}

/**
 * Fold persisted daemon ticks into per-phase and per-reason tallies.
 * Pure: `rows` is the already-parsed `ticks` array (or any equivalent row
 * list); rows that cannot be placed inside [now-window, now+skew] are
 * counted under skippedTicks, never guessed into the window.
 */
export function foldTickHealth(rows: readonly unknown[], now: Date = new Date(), windowMs: number = TICK_HEALTH_WINDOW_MS): TickHealthFold {
  const nowMs = now.getTime();
  const windowStartMs = nowMs - windowMs;
  const windowEndMs = nowMs + TICK_HEALTH_FUTURE_SKEW_MS;
  const fold: TickHealthFold = { ticks: 0, skippedTicks: 0, phases: [], reasons: [] };
  const byName = new Map<string, TickPhaseTally>();
  const byReason = new Map<string, TickReasonTally>();
  const seenOffTickFailures = new Set<string>();

  for (const raw of rows.slice(-TICK_HEALTH_MAX_TICKS)) {
    const tick = tickRow(raw, windowStartMs, windowEndMs);
    if (tick === null) { fold.skippedTicks += 1; continue; }
    fold.ticks += 1;

    if (tick.reason !== null && BAD_TICK_REASONS.has(tick.reason)) {
      const tally = byReason.get(tick.reason);
      if (tally === undefined) {
        byReason.set(tick.reason, { reason: tick.reason, count: 1, firstSeen: tick.ts, lastSeen: tick.ts });
      } else {
        tally.count += 1;
        tally.lastSeen = tick.ts;
      }
    }

    // Worst outcome per phase name within the tick: the ledger records one
    // entry per run and a stage can legitimately appear more than once.
    const worst = new Map<string, { kind: string; error: string | null; dedupKey: string | null }>();
    for (const entry of tick.phases) {
      if (entry.name === '') continue;
      const outcome = entryOutcome(entry);
      const prev = worst.get(entry.name);
      if (prev === undefined || (OUTCOME_RANK[outcome.kind] ?? 0) > (OUTCOME_RANK[prev.kind] ?? 0)) {
        worst.set(entry.name, outcome);
      }
    }
    for (const [name, outcome] of worst) {
      let tally = byName.get(name);
      if (tally === undefined) {
        tally = {
          name, observed: 0, ok: 0, degraded: 0, timeout: 0, abandoned: 0,
          budgetSkipped: 0, skipped: 0, offTickClean: 0, offTickFailed: 0,
          offTickQuiet: 0, failures: 0, errors: [], firstSeen: tick.ts,
          lastSeen: tick.ts, lastFailureAt: null,
        };
        byName.set(name, tally);
      }
      tally.observed += 1;
      tally.lastSeen = tick.ts;
      const kind = outcome.kind;
      if (kind === 'ok') tally.ok += 1;
      else if (kind === 'degraded') tally.degraded += 1;
      else if (kind === 'timeout') tally.timeout += 1;
      else if (kind === 'abandoned') tally.abandoned += 1;
      else if (kind === 'budget-skipped') tally.budgetSkipped += 1;
      else if (kind === 'skipped') tally.skipped += 1;
      else if (kind === 'off-tick-ok') tally.offTickClean += 1;
      else if (kind === 'off-tick-quiet') tally.offTickQuiet += 1;
      else if (kind === 'off-tick-failed') {
        // The same settled run failure repeats on every tick until the next
        // run settles; count each distinct (run, settle, status) once.
        const key = `${name}${outcome.dedupKey ?? ''}`;
        if (seenOffTickFailures.has(key)) continue;
        seenOffTickFailures.add(key);
        tally.offTickFailed += 1;
      }
      if (FAILURE_KINDS.has(kind)) {
        tally.failures += 1;
        tally.lastFailureAt = tick.ts;
        const error = outcome.error === null ? null : fieldText(outcome.error, MAX_ERROR_CHARS);
        if (error !== null && error !== '' && !tally.errors.includes(error)) {
          tally.errors.unshift(error);
          if (tally.errors.length > MAX_ERROR_SAMPLES) tally.errors.length = MAX_ERROR_SAMPLES;
        }
      }
    }
  }

  fold.phases = [...byName.values()]
    .sort((a, b) => b.failures - a.failures || b.observed - a.observed || a.name.localeCompare(b.name));
  fold.reasons = [...byReason.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return fold;
}

// ---------------------------------------------------------------------------
// Backlog items
// ---------------------------------------------------------------------------

interface BacklogCandidate {
  item: CloudBacklogItem;
  /** Recorded failure count — the sort key, never part of the item. */
  failures: number;
}

function outcomeLine(t: TickPhaseTally): string {
  const parts = [
    `degraded ${t.degraded}`,
    `timeout ${t.timeout}`,
    `abandoned mid-tick ${t.abandoned}`,
    `budget-skipped ${t.budgetSkipped}`,
    `distinct off-tick job failures ${t.offTickFailed}`,
  ];
  return parts.join(', ');
}

function phaseItem(t: TickPhaseTally, fold: TickHealthFold, repo: string): BacklogCandidate {
  const id = `tick-health-${createHash('sha256').update(`phase:${t.name}`).digest('hex').slice(0, 16)}`;
  const title = `Daemon tick phase '${t.name}' keeps failing`.slice(0, MAX_TITLE_CHARS);
  const errors = t.errors.length === 0
    ? 'none recorded'
    : t.errors.map((e) => `- ${e}`).join('\n');
  const prompt = [
    `Phantom's daemon state recorded tick phase '${t.name}' ending non-clean ${t.failures} time(s) across ${t.observed} observed tick(s) in the retained history — recurring self-improvement-machinery failure the backlog exists to fix.`,
    '',
    `Window: ${t.firstSeen} → ${t.lastSeen} (${fold.ticks} in-window tick(s) total).`,
    `Outcomes: ${outcomeLine(t)}; ok ${t.ok}, intentional skips ${t.skipped}, off-tick clean ${t.offTickClean}, off-tick unsettled ${t.offTickQuiet}.`,
    `Last non-clean observation: ${t.lastFailureAt ?? 'unknown'}.`,
    '',
    'Recorded errors (scrubbed, most recent first):',
    errors,
    '',
    `The ledger is ${DAEMON_STATE_RELATIVE} under ~/.ashlr (daemonStatePath()'s resolution; ASHLR_HOME does not relocate it): ticks[].phases[] records each stage's status, duration and error, and ticks[] is capped at 100 entries. \`phm daemon status --json\` shows only the LAST tick's phases (.tick.phases), so recurrence is invisible there; docs/daemon-tick-phases.md documents each phase's deadline and the whole-tick budget. Find which stage throws, exceeds its deadline or starves behind the tick budget — a hung subprocess await, an over-tight deadline, a failing downstream read — and fix the cause in this repository. If the failures were a transient window that no longer reproduces, report no-change and name the evidence.`,
  ].join('\n');
  return {
    item: {
      id,
      title,
      prompt,
      area: 'daemon-tick',
      priority: 3,
      ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
    },
    failures: t.failures,
  };
}

function reasonItem(t: TickReasonTally, fold: TickHealthFold, repo: string): BacklogCandidate {
  const id = `tick-health-${createHash('sha256').update(`reason:${t.reason}`).digest('hex').slice(0, 16)}`;
  const note = BAD_TICK_REASONS.get(t.reason) ?? 'the tick ended abnormally';
  const title = `Daemon tick keeps ending '${t.reason}'`.slice(0, MAX_TITLE_CHARS);
  const prompt = [
    `Phantom's daemon state recorded ${t.count} of ${fold.ticks} in-window tick(s) ending '${t.reason}' — ${note}. The self-improvement machinery's own failure, recurring across the retained history.`,
    '',
    `Window: ${t.firstSeen} → ${t.lastSeen}.`,
    '',
    `The ledger is ${DAEMON_STATE_RELATIVE} under ~/.ashlr (daemonStatePath()'s resolution; ASHLR_HOME does not relocate it): each ticks[] entry records the tick's reason and phase ledger. \`phm daemon status --json\` shows only the LAST tick's outcome (.tick.outcome, .tick.lastError), so recurrence is invisible there. Find why ticks keep ending this way and fix the cause in this repository. If the failures were a transient window that no longer reproduces, report no-change and name the evidence.`,
  ].join('\n');
  return {
    item: {
      id,
      title,
      prompt,
      area: 'daemon-tick',
      priority: 3,
      ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
    },
    failures: t.count,
  };
}

/**
 * Backlog items for the daemon tick ledger's recurring phase failures and
 * whole-tick failure reasons, worst-recorded first. Total: any read or
 * fold failure yields no items rather than throwing into discovery.
 */
export async function tickHealthBacklogItems(opts: TickHealthItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const statePath = join(ashlrRoot(opts.rootDir), DAEMON_STATE_RELATIVE);
    const read = await readSource(statePath, TICK_HEALTH_MAX_STATE_BYTES, false);
    if (read.state !== 'healthy') return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      return [];
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
    const ticks = (parsed as Record<string, unknown>)['ticks'];
    if (!Array.isArray(ticks)) return [];
    const fold = foldTickHealth(ticks, opts.now ?? new Date());

    const candidates: BacklogCandidate[] = [];
    for (const tally of fold.phases) {
      if (tally.failures < TICK_HEALTH_RECURRING) continue;
      candidates.push(phaseItem(tally, fold, repo));
    }
    for (const tally of fold.reasons) {
      if (tally.count < TICK_HEALTH_RECURRING) continue;
      candidates.push(reasonItem(tally, fold, repo));
    }
    candidates.sort((a, b) => b.failures - a.failures || a.item.id.localeCompare(b.item.id));
    const limit = Math.max(1, Math.min(opts.limit ?? TICK_HEALTH_MAX_ITEMS, TICK_HEALTH_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map((c) => c.item);
  } catch {
    return [];
  }
}

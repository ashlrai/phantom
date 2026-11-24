/**
 * Refreshes Claude's native weekly reading when the `claude` lane is held, so
 * reset-release sees a real reset instead of waiting for a hand-run
 * `fleet claude-quota --write`. Never throws; stores only what
 * toClaudeQuotaReading keeps (window ids, percentages, reset times).
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { probeClaudeAccountUsage, type ClaudeAccountUsageResult } from '../resources/claude-account-usage.js';
import type { ClaudeAccountStatusOptions } from '../resources/claude-account-status.js';
import { readResourceLedger } from './runs-resource-ledger.js';
import { readLaneTargets } from './runs-lane-targets.js';
import { readClaudeQuotaReading, toClaudeQuotaReading, writeClaudeQuotaReading } from './claude-quota-reading.js';

export type ClaudeProbeOutcome = 'not-held' | 'fresh' | 'probed' | 'unavailable';
export type Probe = (options: ClaudeAccountStatusOptions) => Promise<ClaudeAccountUsageResult>;

const DEFAULT_MAX_AGE_MS = 30 * 60_000;

export function findClaude(pathEnv = process.env.PATH ?? ''): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'claude');
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate; } } catch { /* next */ }
  }
  return null;
}

export type PeriodicClaudeQuotaState = 'planned' | 'skipped-fresh' | 'probed' | 'unavailable' | 'ledger';
export interface PeriodicClaudeQuotaReport {
  state: PeriodicClaudeQuotaState;
  /** Only meaningful for 'planned' (dry-run): whether --apply would probe. */
  wouldProbe?: boolean;
  /** The all-models weekly percentage from a fresh structured reading; null means unknown, never 0. */
  weeklyPct: number | null;
  observedAt: string | null;
  reason: string;
  /** Set to 'ledger' when the reading came from the resource ledger instead of a live probe. */
  source?: 'ledger';
}

/**
 * The self-tick quota stage: keeps the weekly reading current whether or not
 * the lane is held. A persisted reading younger than maxAgeMs (default 30 min)
 * is a cooldown and spawns nothing. A malformed, stale or future-dated reading
 * never suppresses a refresh (readClaudeQuotaReading drops the malformed ones;
 * a negative age is not fresh), so a bad clock cannot freeze the ledger.
 * Dry-run (`apply` false) reads only: no command lookup, no probe, no write.
 * Never throws; a failed probe is stored as a not-fresh reading with no
 * windows, which stays unknown rather than 0% used.
 */
export async function refreshClaudeQuotaPeriodically(opts: {
  runsDir: string; now: () => number; apply: boolean; probe?: Probe; findCommand?: () => string | null; maxAgeMs?: number;
}): Promise<PeriodicClaudeQuotaReport> {
  const unknown = (state: PeriodicClaudeQuotaState, reason: string, extra: Partial<PeriodicClaudeQuotaReport> = {}): PeriodicClaudeQuotaReport =>
    ({ state, weeklyPct: null, observedAt: null, reason, ...extra });
  try {
    const nowMs = opts.now();
    const existing = await readClaudeQuotaReading(opts.runsDir);
    const age = existing ? nowMs - Date.parse(existing.observedAt) : Number.NaN;
    const weeklyOf = (r: typeof existing) => r?.fresh ? (r.windows.find(w => w.id === 'seven_day')?.usedPct ?? null) : null;
    if (existing && age >= 0 && age < (opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) {
      return { state: 'skipped-fresh', weeklyPct: weeklyOf(existing), observedAt: existing.observedAt, reason: existing.reason };
    }
    if (!opts.apply) return unknown('planned', 'dry-run', { wouldProbe: true });
    const command = (opts.findCommand ?? findClaude)();
    if (!command) return unknown('unavailable', 'claude-not-found');
    const observedAt = new Date(nowMs).toISOString();
    // A throwing probe is stored as the same unknown reading a failed one is, so
    // the cooldown holds and the held-lane refresh after us cannot probe again.
    const reading = await (opts.probe ?? probeClaudeAccountUsage)({ command: [command], cwd: opts.runsDir, timeoutMs: 20_000 })
      .then(result => toClaudeQuotaReading(result, observedAt),
        (): ReturnType<typeof toClaudeQuotaReading> => ({ v: 1, observedAt, reason: 'probe-failed', fresh: false, windows: [] }));
    await writeClaudeQuotaReading(opts.runsDir, reading);
    return { state: reading.fresh ? 'probed' : 'unavailable', weeklyPct: weeklyOf(reading), observedAt: reading.observedAt, reason: reading.reason };
  } catch {
    return unknown('unavailable', 'probe-or-write-failed');
  }
}

export async function refreshHeldClaudeQuota(opts: {
  runsDir: string; now: () => number; probe?: Probe; findCommand?: () => string | null; maxAgeMs?: number;
}): Promise<ClaudeProbeOutcome> {
  try {
    const nowMs = opts.now();
    const targets = await readLaneTargets({ runsDir: opts.runsDir, now: () => new Date(nowMs) });
    // An unreadable slots file proves nothing about holds: say so, probe nothing.
    if (targets.sourceState !== 'healthy') return 'unavailable';
    if (!targets.lanes.some(l => l.lane === 'claude' && l.held)) return 'not-held';
    const existing = await readClaudeQuotaReading(opts.runsDir);
    if (existing) {
      const age = nowMs - Date.parse(existing.observedAt);
      if (age >= 0 && age < (opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) return 'fresh';
    }
    const command = (opts.findCommand ?? findClaude)();
    if (!command) return 'unavailable';
    const result = await (opts.probe ?? probeClaudeAccountUsage)({ command: [command], cwd: opts.runsDir, timeoutMs: 20_000 });
    const reading = toClaudeQuotaReading(result, new Date(nowMs).toISOString());
    await writeClaudeQuotaReading(opts.runsDir, reading);
    // A reply that is not a fresh structured reading is a failed probe, not a reading.
    return reading.fresh ? 'probed' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * The weekly reading `phm pools` shows for the claude lane, taken from the
 * resource ledger. Used when the live probe could not answer: the fleet usually
 * still has a recent reading from its own sensor, and that is the honest input.
 * Returns null when the ledger has no claude weekly percentage. Never throws.
 */
export async function claudeQuotaFromLedger(opts: { runsDir: string; now: () => number }): Promise<PeriodicClaudeQuotaReport | null> {
  try {
    const ledger = await readResourceLedger({ runsDir: opts.runsDir, now: opts.now });
    const lane = ledger.lanes.find(l => l.lane === 'claude');
    if (!lane || typeof lane.usedPct !== 'number') return null;
    return { state: 'ledger', source: 'ledger', weeklyPct: lane.usedPct, observedAt: lane.observation?.asOf ?? ledger.asOf,
      reason: 'live probe unavailable; using the ledger reading' };
  } catch { return null; }
}

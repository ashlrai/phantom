/**
 * swapout-sync.ts — the daemon-side recorder for host memory samples.
 *
 * `metrics/swapout-rate.jsonl` is the tuning ledger
 * src/core/resources/lane-autopilot.ts's MEMORY_GUARD comment names
 * ("tune from metrics/swapout-rate.jsonl (24h of memguard samples)"): the
 * constants behind memoryAllowsRaise are UNMEASURED defaults, and until
 * now no writer existed — memstat.json holds only the bridge's latest
 * sample, so the distribution the thresholds should be tuned against was
 * never retained. This module folds each resident tick's freshest
 * memstat.json reading into the ledger from a daemon off-tick job, beside
 * the reward-sync and visit-sync feeds, and readSwapoutRateEvidence reads
 * the ledger back for `phm fleet vitals`.
 *
 * THE RULES, matching the sibling syncs:
 *   - SAMPLE TIME IS THE EVENT TIME. The row's sampled_at is memstat's own
 *     timestamp normalized exactly like memory-view does (epoch seconds
 *     below 1e11, milliseconds at/above, ISO strings parsed). A sample
 *     with no usable timestamp — or one dated more than a minute ahead of
 *     the clock — is skipped: recording it under the sync's clock would
 *     fabricate when the measurement happened.
 *   - FIRST WRITE WINS PER SAMPLE. Dedup is by sampled_at against the
 *     ledger tail, so re-reading an unchanged memstat.json appends
 *     nothing and a restarted daemon never rewrites history. A ledger
 *     that cannot be read blocks the append rather than risking a second
 *     row for the same sample.
 *   - UNKNOWN STAYS NULL. free_pct/swap_gb/swapouts_per_min carry the
 *     producer's own values or null when the field was absent or failed
 *     the same per-field validation memory-view applies; a sample with no
 *     usable measurement field at all is skipped.
 *   - BOUNDED AND BEST-EFFORT. The memstat read is capped at 64 KiB, the
 *     ledger dedup read at 512 KiB, appends per pass are capped, and the
 *     sync never throws: source problems come back as state.
 *
 * The read-back can also measure memory-guard constants against the
 * recorded distribution: for each guard input it reports the share of
 * field-carrying samples where the condition would fire, so the
 * "tune from metrics/swapout-rate.jsonl" note in lane-autopilot has real
 * denominators instead of a raw mean. The thresholds arrive as an
 * injected parameter — this module stays inside the daemon's Tier-1
 * import closure, so it must not import lane-autopilot itself. Shares
 * are counts over recorded samples only — a field nobody measured
 * stays null, never 0, and no guard supplied means no assessment.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { memoryView } from './memory-view.js';
import { readSource, type Source } from './runs-parked-queue.js';
import { readLedgerTail, type LedgerTailRead } from '../router/outcomes.js';

export const SWAPOUT_SAMPLE_SCHEMA = 'fleet.swapout-sample.v1';
/** `<runs>/metrics/swapout-rate.jsonl` — the ledger lane-autopilot's MEMORY_GUARD comment names. */
export const SWAPOUT_RATE_LEDGER_RELATIVE = join('metrics', 'swapout-rate.jsonl');
/** The bridge's latest-sample file the sync folds; it holds one document, never a history. */
export const SWAPOUT_MEMSTAT_RELATIVE = 'memstat.json';
/** memstat.json is a few hundred bytes; the cap only refuses a corrupt oversized file. */
export const SWAPOUT_MEMSTAT_MAX_BYTES = 64 * 1024;
/** Bounded tail for dedup and evidence reads; ~3500 rows of headroom. */
export const SWAPOUT_LEDGER_TAIL_BYTES = 512 * 1024;
/** Defensive cap; one memstat.json read yields at most one fresh sample per pass. */
export const SWAPOUT_SYNC_MAX_APPEND = 8;
/** A sample dated further than this ahead of the sync clock is corrupt, not early. */
export const SWAPOUT_FUTURE_SKEW_MS = 60_000;

export interface SwapoutSample {
  /** memstat's own timestamp normalized to ISO — the dedup key and event time. */
  sampledAt: string;
  freePct: number | null;
  swapGb: number | null;
  swapoutsPerMin: number | null;
}

/**
 * One memstat.json document -> the ledger sample, or null when it carries
 * no usable evidence. Field validation is memory-view's own: free_pct is a
 * 0..100 percentage, swap_gb and swapouts_per_min non-negative figures,
 * each degrading to null independently.
 */
export function parseSwapoutSample(memstat: unknown, nowMs: number): SwapoutSample | null {
  const sample = memoryView(memstat, null, nowMs).sample;
  if (sample.sampled_at === null) return null;
  if (sample.age_ms !== null && sample.age_ms < -SWAPOUT_FUTURE_SKEW_MS) return null;
  const { free_pct: freePct, swap_gb: swapGb, swapouts_per_min: swapoutsPerMin } = sample;
  if (freePct === null && swapGb === null && swapoutsPerMin === null) return null;
  return { sampledAt: sample.sampled_at, freePct, swapGb, swapoutsPerMin };
}

/** The dedup key inside one ledger line: schema-checked sampled_at, tolerant of torn siblings. */
function sampledAtOf(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row['schema'] !== SWAPOUT_SAMPLE_SCHEMA) return null;
  const at = row['sampled_at'];
  return typeof at === 'string' && at !== '' ? at : null;
}

const INVALID = Symbol('invalid');

/** Producer-range field check: absent reads as null; a present bad value rejects the row. */
function statField(value: unknown, max: number | null): number | null | typeof INVALID {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return INVALID;
  if (max !== null && value > max) return INVALID;
  return value;
}

/**
 * Strict structural check of one ledger row against what the sync writes —
 * schema, a parseable sampled_at, and each stat field either null or a
 * finite number inside the producer's range (free_pct 0..100, the GB and
 * per-minute figures unbounded above). Anything else is corrupt evidence,
 * counted and never partially trusted. Exported so the improvement
 * backlog's memory fold validates rows by the same rule the writer and
 * the vitals read-back apply.
 */
export function parseSwapoutRow(value: unknown): SwapoutSample | null {
  const sampledAt = sampledAtOf(value);
  if (sampledAt === null || !Number.isFinite(Date.parse(sampledAt))) return null;
  const row = value as Record<string, unknown>;
  const freePct = statField(row['free_pct'], 100);
  const swapGb = statField(row['swap_gb'], null);
  const swapoutsPerMin = statField(row['swapouts_per_min'], null);
  if (freePct === INVALID || swapGb === INVALID || swapoutsPerMin === INVALID) return null;
  return { sampledAt, freePct, swapGb, swapoutsPerMin };
}

export interface SwapoutSyncOptions {
  /** Fleet runs dir; defaults to ASHLR_RUNS_DIR then ~/.ashlr-runs (same as the sibling syncs). */
  runsDir?: string;
  now?: () => number;
  signal?: AbortSignal;
  /** Injected memstat.json text; skips the file read when set. */
  memstatText?: string;
  /** Injected ledger tail text; skips the dedup read when set. */
  ledgerText?: string;
  /** Per-pass append cap; defaults to SWAPOUT_SYNC_MAX_APPEND. */
  maxAppend?: number;
}

export interface SwapoutSyncResult {
  /**
   * 'ok' — the sample is recorded (appended now or already present);
   * 'no-sample' — memstat.json is missing, degraded, unparseable or carries
   * no usable measurement; 'ledger-blocked' — a valid sample exists but the
   * ledger cannot be read, so dedup is unverifiable and nothing was
   * appended; 'error' — an unexpected failure (reported, never thrown).
   */
  state: 'ok' | 'no-sample' | 'ledger-blocked' | 'error';
  /** readSource state of memstat.json. */
  memstatState: Source;
  /** Ledger read state behind the dedup seen-set; 'not-read' when the pass never reached it. */
  ledgerState: LedgerTailRead['state'] | 'not-read';
  /** True when the ledger tail dropped older bytes — dedup covers the retained window only. */
  ledgerTruncated: boolean;
  /** The sample's own timestamp when one parsed; null otherwise. */
  sampledAt: string | null;
  /** Rows appended this pass (0 or 1 in practice). */
  appended: number;
  /** True when the sample's sampled_at was already recorded. */
  duplicate: boolean;
}

function syncResult(
  state: SwapoutSyncResult['state'],
  over: Partial<SwapoutSyncResult> = {},
): SwapoutSyncResult {
  return {
    state,
    memstatState: 'missing',
    ledgerState: 'not-read',
    ledgerTruncated: false,
    sampledAt: null,
    appended: 0,
    duplicate: false,
    ...over,
  };
}

/**
 * Fold the bridge's latest memstat.json sample into the swapout-rate
 * ledger. Runs inside the daemon's swapout-sync off-tick job every
 * resident tick; safe to call any time. Never throws: source problems
 * come back as state.
 */
export async function syncSwapoutSamples(opts: SwapoutSyncOptions = {}): Promise<SwapoutSyncResult> {
  const nowMs = (opts.now ?? Date.now)();
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const memstatPath = join(runsDir, SWAPOUT_MEMSTAT_RELATIVE);
  const ledgerPath = join(runsDir, SWAPOUT_RATE_LEDGER_RELATIVE);
  try {
    const memstat = opts.memstatText !== undefined
      ? { state: 'healthy' as const, text: opts.memstatText }
      : await readSource(memstatPath, SWAPOUT_MEMSTAT_MAX_BYTES, false);
    if (memstat.state !== 'healthy') return syncResult('no-sample', { memstatState: memstat.state });
    let document: unknown;
    try {
      document = JSON.parse(memstat.text);
    } catch {
      return syncResult('no-sample', { memstatState: 'degraded' });
    }
    const sample = parseSwapoutSample(document, nowMs);
    if (sample === null) return syncResult('no-sample', { memstatState: 'healthy' });
    if (opts.signal?.aborted) {
      return syncResult('no-sample', { memstatState: 'healthy', sampledAt: sample.sampledAt });
    }

    // The ledger gates the append: without a readable seen-set a write
    // could append a second row for an already-recorded sample, so an
    // unreadable or non-file ledger skips recording. 'missing' is a clean
    // empty ledger.
    const ledger: LedgerTailRead = opts.ledgerText !== undefined
      ? { state: 'read', text: opts.ledgerText, truncated: false }
      : await readLedgerTail(ledgerPath, SWAPOUT_LEDGER_TAIL_BYTES);
    if (ledger.state !== 'read' && ledger.state !== 'missing') {
      return syncResult('ledger-blocked', {
        memstatState: 'healthy', ledgerState: ledger.state, sampledAt: sample.sampledAt,
      });
    }
    const seen = new Set<string>();
    if (ledger.state === 'read') {
      for (const line of ledger.text.split('\n')) {
        if (!line.trim()) continue;
        let value: unknown;
        try { value = JSON.parse(line); } catch { continue; }
        const at = sampledAtOf(value);
        if (at !== null) seen.add(at);
      }
    }
    const ledgerState = ledger.state;
    const ledgerTruncated = ledger.state === 'read' && ledger.truncated;
    if (seen.has(sample.sampledAt)) {
      return syncResult('ok', {
        memstatState: 'healthy', ledgerState, ledgerTruncated,
        sampledAt: sample.sampledAt, duplicate: true,
      });
    }
    const maxAppend = Math.max(0, opts.maxAppend ?? SWAPOUT_SYNC_MAX_APPEND);
    if (maxAppend === 0 || opts.signal?.aborted) {
      return syncResult('ok', {
        memstatState: 'healthy', ledgerState, ledgerTruncated, sampledAt: sample.sampledAt,
      });
    }
    const row = {
      schema: SWAPOUT_SAMPLE_SCHEMA,
      sampled_at: sample.sampledAt,
      free_pct: sample.freePct,
      swap_gb: sample.swapGb,
      swapouts_per_min: sample.swapoutsPerMin,
    };
    await mkdir(dirname(ledgerPath), { recursive: true });
    await appendFile(ledgerPath, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
    return syncResult('ok', {
      memstatState: 'healthy', ledgerState, ledgerTruncated,
      sampledAt: sample.sampledAt, appended: 1,
    });
  } catch {
    return syncResult('error');
  }
}

// ---------------------------------------------------------------------------
// Evidence read-back for `phm fleet vitals`
// ---------------------------------------------------------------------------

export interface SwapoutRateEvidence {
  /** readSource state of the ledger; 'missing' when no file exists yet. */
  source: Source;
  /** 'known' once at least one structurally valid sample was read. */
  state: 'known' | 'unknown';
  /** Valid samples inside the retained tail window. */
  samples: number;
  /** Lines that were not a swapout-sample row; ignored, never guessed. */
  invalidRows: number;
  /** Sample-time bounds across the valid rows; null when none parsed. */
  oldestAt: string | null;
  newestAt: string | null;
  /** Samples carrying a recorded free_pct, its min and mean (null mean when none recorded). */
  freePctKnown: number;
  freePctMin: number | null;
  freePctMean: number | null;
  /** Samples carrying a recorded swap_gb and its max. */
  swapGbKnown: number;
  swapGbMax: number | null;
  /** Samples carrying a recorded swapouts_per_min: mean, max and the above-zero count. */
  swapoutsKnown: number;
  swapoutsMean: number | null;
  swapoutsMax: number | null;
  swapoutsPositive: number;
  /**
   * How often each supplied memory-guard condition would have fired across
   * the recorded samples — the calibration evidence the constants'
   * "tune from metrics/swapout-rate.jsonl" note asks for. Each share is a
   * fraction (0..1) over the samples carrying that input; null when the
   * field was never measured or no guard was supplied. Advisory only:
   * nothing here changes routing.
   */
  memoryGuard: SwapoutMemoryGuard | null;
}

/** The four lane-autopilot MEMORY_GUARD thresholds, injected by the caller. */
export interface SwapoutGuardThresholds {
  raiseFreePct: number;
  lowFreePct: number;
  growingSwapoutsPerMin: number;
  swapBackstopGb: number;
}

export interface SwapoutMemoryGuard {
  /** The guard constants the shares measure against, echoed for self-contained JSON. */
  constants: SwapoutGuardThresholds;
  /** Samples carrying each input — the denominators of the matching shares. */
  freePctKnown: number;
  swapGbKnown: number;
  swapoutsKnown: number;
  /** Share of free_pct samples below lowFreePct (a raise-blocking condition in memoryAllowsRaise). */
  freeBelowLowShare: number | null;
  /** Share of free_pct samples above raiseFreePct (the headroom a raise needs). */
  freeAboveRaiseShare: number | null;
  /** Share of swapouts_per_min samples at or above growingSwapoutsPerMin. */
  swapoutsGrowingShare: number | null;
  /** Share of swap_gb samples above swapBackstopGb. */
  swapAboveBackstopShare: number | null;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round4 = (v: number): number => Math.round(v * 10000) / 10000;
/** Share of `known` samples; null when the field was never measured — unknown stays unknown. */
const share = (hits: number, known: number): number | null => (known > 0 ? round4(hits / known) : null);

/**
 * Bounded tail read of `<runs>/metrics/swapout-rate.jsonl`; aggregates the
 * sample distribution the MEMORY_GUARD constants should be tuned against.
 * Missing or unreadable evidence stays unknown, never zeroed; malformed
 * lines count as invalidRows and degrade the source without erasing valid
 * rows. Never throws.
 */
export async function readSwapoutRateEvidence(
  runsDir: string,
  opts: { guard?: SwapoutGuardThresholds } = {},
): Promise<SwapoutRateEvidence> {
  const guard = opts.guard ?? null;
  const empty: SwapoutRateEvidence = {
    source: 'missing', state: 'unknown', samples: 0, invalidRows: 0,
    oldestAt: null, newestAt: null,
    freePctKnown: 0, freePctMin: null, freePctMean: null,
    swapGbKnown: 0, swapGbMax: null,
    swapoutsKnown: 0, swapoutsMean: null, swapoutsMax: null, swapoutsPositive: 0,
    memoryGuard: null,
  };
  const source = await readSource(join(runsDir, SWAPOUT_RATE_LEDGER_RELATIVE), SWAPOUT_LEDGER_TAIL_BYTES, true);
  if (source.state === 'missing') return empty;
  let samples = 0;
  let invalidRows = 0;
  let oldestMs = Number.POSITIVE_INFINITY;
  let newestMs = Number.NEGATIVE_INFINITY;
  let freeKnown = 0, freeMin = Number.POSITIVE_INFINITY, freeSum = 0;
  let swapKnown = 0, swapMax = Number.NEGATIVE_INFINITY;
  let outKnown = 0, outSum = 0, outMax = Number.NEGATIVE_INFINITY, outPositive = 0;
  let freeBelowLow = 0, freeAboveRaise = 0, swapoutsGrowing = 0, swapAboveBackstop = 0;
  for (const line of source.text.split(/\r?\n/).filter(Boolean)) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { invalidRows += 1; continue; }
    const row = parseSwapoutRow(value);
    if (row === null) { invalidRows += 1; continue; }
    samples += 1;
    const ms = Date.parse(row.sampledAt);
    oldestMs = Math.min(oldestMs, ms);
    newestMs = Math.max(newestMs, ms);
    if (row.freePct !== null) {
      freeKnown += 1; freeMin = Math.min(freeMin, row.freePct); freeSum += row.freePct;
      if (guard !== null) {
        if (row.freePct < guard.lowFreePct) freeBelowLow += 1;
        if (row.freePct > guard.raiseFreePct) freeAboveRaise += 1;
      }
    }
    if (row.swapGb !== null) {
      swapKnown += 1; swapMax = Math.max(swapMax, row.swapGb);
      if (guard !== null && row.swapGb > guard.swapBackstopGb) swapAboveBackstop += 1;
    }
    if (row.swapoutsPerMin !== null) {
      outKnown += 1; outSum += row.swapoutsPerMin; outMax = Math.max(outMax, row.swapoutsPerMin);
      if (row.swapoutsPerMin > 0) outPositive += 1;
      if (guard !== null && row.swapoutsPerMin >= guard.growingSwapoutsPerMin) swapoutsGrowing += 1;
    }
  }
  return {
    source: invalidRows > 0 ? 'degraded' : source.state,
    state: samples > 0 ? 'known' : 'unknown',
    samples,
    invalidRows,
    oldestAt: samples > 0 ? new Date(oldestMs).toISOString() : null,
    newestAt: samples > 0 ? new Date(newestMs).toISOString() : null,
    freePctKnown: freeKnown,
    freePctMin: freeKnown > 0 ? round2(freeMin) : null,
    freePctMean: freeKnown > 0 ? round2(freeSum / freeKnown) : null,
    swapGbKnown: swapKnown,
    swapGbMax: swapKnown > 0 ? round2(swapMax) : null,
    swapoutsKnown: outKnown,
    swapoutsMean: outKnown > 0 ? round2(outSum / outKnown) : null,
    swapoutsMax: outKnown > 0 ? round2(outMax) : null,
    swapoutsPositive: outPositive,
    memoryGuard: guard === null ? null : {
      constants: guard,
      freePctKnown: freeKnown,
      swapGbKnown: swapKnown,
      swapoutsKnown: outKnown,
      freeBelowLowShare: share(freeBelowLow, freeKnown),
      freeAboveRaiseShare: share(freeAboveRaise, freeKnown),
      swapoutsGrowingShare: share(swapoutsGrowing, outKnown),
      swapAboveBackstopShare: share(swapAboveBackstop, swapKnown),
    },
  };
}

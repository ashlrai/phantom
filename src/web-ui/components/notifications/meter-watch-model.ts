/**
 * components/notifications/meter-watch-model.ts — the pure memory behind the
 * stuck-meter watch. The resource ledger is a snapshot: it can say a lane is
 * at 40 % and running 5 jobs, but not that the meter has BEEN at 40 % for
 * hours — on Oct 31 a lane sat at one percent while the fleet believed it
 * was busy, and nobody noticed. This log is Phantom's own record of what the
 * meter said and when: "verify each meter actually drops within the hour;
 * if not, treat it as an incident."
 *
 * METER_WATCH_MAX_SAMPLES and METER_WATCH_MAX_AGE_MS bound the log, and
 * METER_WATCH_SAMPLE_GAP_MS keeps them compatible: the ledger polls ~every
 * 60 s, so recording every poll would exhaust 48 samples in 47 minutes and
 * the log could never span the 60-minute stuck threshold. Identical
 * consecutive readings fold into the previous sample until the gap passes;
 * a changed reading is always recorded immediately.
 */
import type { ResourceLedgerV1 } from '../../routes/verse/usage/fleet-ledger-model.js';

/** One observed reading of a lane's usage meter. */
export interface MeterSample {
  at: number;
  usedPct: number | null;
  creditsRemaining: number | null;
}

/** Per-lane sample history keyed by ledger lane id, oldest-first. */
export type MeterWatchLog = Record<string, MeterSample[]>;

/** Never keep more than this many samples for one lane. */
export const METER_WATCH_MAX_SAMPLES = 48;
/** Never keep a sample older than this. */
export const METER_WATCH_MAX_AGE_MS = 6 * 60 * 60_000;
/** Identical readings are folded until this much time has passed. */
export const METER_WATCH_SAMPLE_GAP_MS = 5 * 60_000;
/** A lane is 'stuck' only when identical readings span at least this long. */
export const METER_WATCH_STUCK_SPAN_MS = 60 * 60_000;

/**
 * Fold each ledger lane's current reading into the log. Pure: returns a new
 * object and never mutates `log`. Lanes absent from this ledger are dropped —
 * once a lane leaves the ledger its history can never produce a notification
 * again, and keeping it would grow storage without bound.
 */
export function recordMeterSample(log: MeterWatchLog, ledger: ResourceLedgerV1 | null, nowMs: number): MeterWatchLog {
  if (!ledger) return log;
  const next: MeterWatchLog = {};
  const cutoff = nowMs - METER_WATCH_MAX_AGE_MS;
  for (const row of ledger.lanes) {
    const kept = (log[row.lane] ?? []).filter((s) => s.at >= cutoff);
    const last = kept[kept.length - 1];
    if (!last || nowMs - last.at >= METER_WATCH_SAMPLE_GAP_MS
      || last.usedPct !== row.usedPct || last.creditsRemaining !== row.creditsRemaining) {
      kept.push({ at: nowMs, usedPct: row.usedPct, creditsRemaining: row.creditsRemaining });
    }
    next[row.lane] = kept.slice(-METER_WATCH_MAX_SAMPLES);
  }
  return next;
}

export interface MeterStall {
  lane: string;
  state: 'moving' | 'stuck' | 'unknown';
  /** Minutes the newest unchanged run of readings spans; set only when 'stuck'. */
  stuckMinutes: number | null;
}

/**
 * Judge every ledger lane against its remembered samples. A lane is 'stuck'
 * when it is running jobs now (running >= 1, not held) and the newest run of
 * identical readings spans at least METER_WATCH_STUCK_SPAN_MS — the meter
 * demonstrably has not moved for an hour while the lane is busy. 'moving'
 * covers held or idle lanes (nothing is expected to move) and lanes whose
 * meter changed within the remembered window. 'unknown' covers everything
 * that cannot be judged: no running count, no meter reading, or not enough
 * history yet — the watch stays silent rather than crying incident on a
 * guess.
 */
export function meterStalls(log: MeterWatchLog, ledger: ResourceLedgerV1 | null, nowMs: number): MeterStall[] {
  if (!ledger) return [];
  const cutoff = nowMs - METER_WATCH_MAX_AGE_MS;
  return ledger.lanes.map((row) => {
    const judge = (state: MeterStall['state'], stuckMinutes: number | null = null): MeterStall =>
      ({ lane: row.lane, state, stuckMinutes });
    // Held or idle: nothing is expected to move, so a still meter is healthy.
    if (row.held === true || row.running === 0) return judge('moving');
    // No running count means the "while busy" precondition cannot be checked.
    if (row.running === null || row.running < 1) return judge('unknown');
    if (row.usedPct === null && row.creditsRemaining === null) return judge('unknown');
    const samples = (log[row.lane] ?? []).filter((s) => s.at >= cutoff)
      .sort((a, b) => a.at - b.at);
    const newest = samples[samples.length - 1];
    if (!newest || (newest.usedPct === null && newest.creditsRemaining === null)) return judge('unknown');
    let runStart = samples.length - 1;
    while (runStart > 0 && samples[runStart - 1]!.usedPct === newest.usedPct
      && samples[runStart - 1]!.creditsRemaining === newest.creditsRemaining) {
      runStart -= 1;
    }
    const stillMs = newest.at - samples[runStart]!.at;
    if (stillMs >= METER_WATCH_STUCK_SPAN_MS) return judge('stuck', Math.floor(stillMs / 60_000));
    return judge(runStart > 0 ? 'moving' : 'unknown');
  });
}

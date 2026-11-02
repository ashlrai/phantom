/**
 * routes/verse/ops/ops-lane-model.ts : the pure derivations behind
 * OpsLaneConsole — chip text, credit tones, countdown phrases and the
 * source-health footer for a fleet.lanes.v1 snapshot. `now` is injectable
 * so every phrase is unit-testable. A null cell is "—", never a zero.
 */
import type { FleetLaneCreditView, FleetLaneSnapshot, FleetLaneView } from '../../../data/api-types.js';

/** "12 s" / "3 min" / "2 h" / "4 d" — spaced units, rounded the way formatAge does. */
export function durationText(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** The three stat chips on a lane row: `live N` (good while jobs run), `queued N`, `merges/h X.X`. */
export function laneChipText(lane: FleetLaneView): { text: string; tone?: 'good' }[] {
  return [
    { text: `live ${lane.liveJobs ?? '—'}`, tone: (lane.liveJobs ?? 0) > 0 ? 'good' : undefined },
    { text: `queued ${lane.queueDepth ?? '—'}` },
    { text: `merges/h ${lane.mergesPerHour === null ? '—' : lane.mergesPerHour.toFixed(1)}` },
  ];
}

/** Bar tone: bad under 10% left, warn under 25%, good above. Null reading → no bar at all. */
export function creditTone(remainingPct: number | null): 'good' | 'warn' | 'bad' | null {
  if (remainingPct === null) return null;
  if (remainingPct < 10) return 'bad';
  if (remainingPct < 25) return 'warn';
  return 'good';
}

/** "runs out in 2 h" for a future exhaustion, "ran out 5 min ago" for a past one, null when unreadable. */
export function exhaustionText(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const diff = then - now;
  return diff > 0 ? `runs out in ${durationText(diff)}` : `ran out ${durationText(-diff)} ago`;
}

/** "resets in 2 h" / "resets now" for a reset-pending credit; null for every other state. */
export function resetText(credit: FleetLaneCreditView, now: number = Date.now()): string | null {
  if (credit.state !== 'reset-pending') return null;
  const then = credit.resetAt ? Date.parse(credit.resetAt) : NaN;
  if (!Number.isFinite(then)) return 'reset pending';
  return then - now <= 0 ? 'resets now' : `resets in ${durationText(then - now)}`;
}

/** The credit half of a lane row: label verbatim, "no reading" for unknown, countdown phrases after. */
export function creditLine(lane: FleetLaneView, now: number = Date.now()): string {
  const credit = lane.credit;
  const head = credit.state === 'unknown' ? 'no reading'
    : credit.state === 'reset-pending' ? resetText(credit, now) ?? 'reset pending'
    : credit.label;
  const tail = exhaustionText(credit.projectedExhaustionAt, now);
  return tail ? `${head} · ${tail}` : head;
}

/** Spoken form of the bar — budget-ledger percent is a weekly window, usage-journal's length is unreported. */
export function creditBarLabel(lane: FleetLaneView): string | null {
  const pct = lane.credit.remainingPct;
  if (pct === null || lane.credit.state === 'unknown') return null;
  const window = lane.credit.source === 'budget-ledger' ? 'weekly window' : 'window';
  return `${lane.lane}: ${Math.round(pct)}% of ${window} left`;
}

/** "updated 12 s ago" for the snapshot's generatedAt; null when it cannot be parsed. */
export function updatedText(iso: string, now: number = Date.now()): string | null {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const diff = now - then;
  return diff < 1000 ? 'updated just now' : `updated ${durationText(diff)} ago`;
}

/**
 * Footer notes: one entry per source whose state is not 'healthy', written
 * as `queue: missing (ready.tsv)`. Files are basenames — all the snapshot
 * carries, so a note never claims a path it cannot show.
 */
export function sourceNotes(snapshot: FleetLaneSnapshot): string[] {
  const s = snapshot.sources;
  const sources: [label: string, state: string, file?: string][] = [
    ['queue', s.queue.state, s.queue.file],
    ['queue state', s.queueState.state, s.queueState.file],
    ['ledger', s.ledger.state, s.ledger.file],
    ['usage', s.usage.state, s.usage.files.join(', ') || undefined],
    ['budgets', s.budgets.state, undefined],
  ];
  return sources.filter(([, state]) => state !== 'healthy')
    .map(([label, state, file]) => `${label}: ${state}${file ? ` (${file})` : ''}`);
}

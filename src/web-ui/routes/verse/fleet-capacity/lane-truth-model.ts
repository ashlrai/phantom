import type { LaneVerdict } from '../../../../core/fleet/lane-truth.js';
import type { LaneTruthLane } from './lane-truth-queries.js';

const format = (n: number) => Number(n.toFixed(1)).toLocaleString();
const shortDate = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isFinite(at.getTime())
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(at)
    : null;
};

/** bad: the fleet is wasting capacity. warn: a reset may have freed it. */
export function verdictTone(verdict: LaneVerdict): 'bad' | 'warn' | null {
  if (verdict === 'held_with_capacity' || verdict === 'idle_with_work') return 'bad';
  if (verdict === 'reset_detected') return 'warn';
  return null;
}

export function verdictText(row: LaneTruthLane): string | null {
  const meter = row.meter;
  switch (row.verdict) {
    case 'ok':
      return null;
    case 'held_with_capacity': {
      if (!meter || meter.usedPercent === null) return `Held with capacity: ${row.lane} is held while its meter has room.`;
      const resets = shortDate(meter.resetAt);
      return `Held with capacity: ${row.lane} is held while its meter shows ${format(meter.usedPercent)}% used${resets ? ` (resets ${resets})` : ''}.`;
    }
    case 'reset_detected': {
      const reading = meter && meter.usedPercent !== null
        ? ` Meter now shows ${format(meter.usedPercent)}% used${shortDate(meter.resetAt) ? ` (resets ${shortDate(meter.resetAt)})` : ''}.`
        : '';
      return `Reset detected: ${row.lane}'s meter dropped or its reset moved later.${reading}`;
    }
    case 'idle_with_work':
      return `Idle with work: ${row.running ?? 0} of ${row.target ?? '—'} running, ${row.queued ?? 0} queued.`;
    case 'unknown':
      return 'Lane truth unknown: slots.json or the meter is older than 15 min.';
  }
}

const ATTENTION_LABELS: Record<Exclude<LaneVerdict, 'ok'>, string> = {
  held_with_capacity: 'held with capacity',
  reset_detected: 'reset detected',
  idle_with_work: 'idle with work',
  unknown: 'truth unknown',
};

export function truthHeadline(rows: readonly LaneTruthLane[]): string | null {
  const flagged = rows.filter((row) => row.verdict !== 'ok');
  if (!flagged.length) return null;
  const list = flagged.map((row) => `${row.lane} ${ATTENTION_LABELS[row.verdict as Exclude<LaneVerdict, 'ok'>]}`).join(', ');
  return `${flagged.length} ${flagged.length === 1 ? 'lane needs' : 'lanes need'} attention: ${list}.`;
}

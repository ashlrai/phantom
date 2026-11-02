/** Summarize the latest eight valid finishes per lane, ordered by finish time. */
export interface LaneDeadSignal {
  lane: string;
  lastFinishes: number;
  emptyFailures: number;
  state: 'ok' | 'suspect' | 'dead';
}

export function laneDeadSignals(rows: readonly unknown[]): { lanes: LaneDeadSignal[]; malformedRows: number } {
  const finishes = new Map<string, { time: number; failed: boolean; order: number }[]>();
  let malformedRows = 0;
  rows.forEach((row, order) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { malformedRows++; return; }
    const value = row as Record<string, unknown>;
    if (typeof value.event !== 'string') { malformedRows++; return; }
    if (value.event !== 'finish') return;
    const time = typeof value.ts === 'string' ? Date.parse(value.ts) : NaN;
    if (typeof value.lane !== 'string' || !value.lane || typeof value.empty !== 'boolean' ||
        typeof value.exit_code !== 'number' || !Number.isSafeInteger(value.exit_code) || !Number.isFinite(time)) {
      malformedRows++; return;
    }
    const lane = finishes.get(value.lane) ?? [];
    lane.push({ time, failed: value.empty && value.exit_code !== 0, order });
    finishes.set(value.lane, lane);
  });
  const lanes = [...finishes].map(([lane, values]): LaneDeadSignal => {
    const latest = values.sort((a, b) => b.time - a.time || b.order - a.order).slice(0, 8);
    const firstSuccess = latest.findIndex(value => !value.failed);
    const emptyFailures = firstSuccess < 0 ? latest.length : firstSuccess;
    return { lane, lastFinishes: latest.length, emptyFailures, state: emptyFailures >= 8 ? 'dead' : emptyFailures >= 4 ? 'suspect' : 'ok' };
  });
  return { lanes, malformedRows };
}

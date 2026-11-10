export interface ResetReading {
  label: string;
  windows: { resetsAt: string | null; usedPercent: number | null }[];
}

export interface ResetRow {
  label: string;
  resetAt: string;
  hoursLeft: number;
  percentLeft: number | null;
  useIt: boolean;
}

/** Pick the next usable reset per resource; expired resets are not predictions. */
export function resetsTimeline(readings: ResetReading[], nowMs: number): { rows: ResetRow[]; noReading: string[] } {
  const rows: ResetRow[] = [];
  const noReading: string[] = [];
  for (const reading of readings) {
    const next = reading.windows
      .map(window => ({ window, time: window.resetsAt === null ? NaN : Date.parse(window.resetsAt) }))
      .filter(item => Number.isFinite(item.time) && item.time > nowMs)
      .sort((a, b) => a.time - b.time)[0];
    if (!next || next.window.resetsAt === null) {
      noReading.push(reading.label);
      continue;
    }
    const used = next.window.usedPercent;
    const percentLeft = used !== null && Number.isFinite(used) && used >= 0 && used <= 100 ? 100 - used : null;
    const hoursLeft = (next.time - nowMs) / 3_600_000;
    rows.push({ label: reading.label, resetAt: next.window.resetsAt, hoursLeft, percentLeft,
      useIt: hoursLeft < 12 && percentLeft !== null && percentLeft >= 25 });
  }
  rows.sort((a, b) => Date.parse(a.resetAt) - Date.parse(b.resetAt));
  return { rows, noReading };
}

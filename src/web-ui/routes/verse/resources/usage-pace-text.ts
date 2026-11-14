export interface PaceTextRow { pool?: string; projectedPercent?: unknown; hoursLeft?: unknown; unusedPercent?: unknown }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Forecast wording for one pool. Unknown evidence stays "unknown"; no reserve is implied. */
export function paceForecastText(row: PaceTextRow | null, fresh = true): string {
  const pct = row?.projectedPercent;
  const hours = row?.hoursLeft;
  if (!fresh || !finite(pct) || pct < 0 || pct > 100 || !finite(hours) || hours <= 0) return 'unknown';
  const base = `on pace to use ${pct}% before reset (${hours} h left)`;
  const unused = finite(row?.unusedPercent) ? row.unusedPercent : Math.round(100 - pct);
  return unused >= 5 ? `${base} · about ${unused}% unused at reset` : `${base} · on track to use it all`;
}

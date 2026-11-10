export type DiskRunwayView = {
  status: 'projected' | 'reached' | 'not-falling' | 'unknown';
  advice: 'ok' | 'avoid-large-writes' | 'unknown';
  freeGb: number | null;
  gbPerHour: number | null;
  hoursUntilThreshold: number | null;
  crossingAt: string | null;
};
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
export function narrowDiskRunway(raw: unknown): DiskRunwayView | null {
  if (!object(raw) || raw.v !== 1 || !object(raw.forecast)) return null;
  const f = raw.forecast;
  if (f.status !== 'projected' && f.status !== 'reached' && f.status !== 'not-falling' && f.status !== 'unknown') return null;
  const advice = raw.advice === 'ok' || raw.advice === 'avoid-large-writes' || raw.advice === 'unknown' ? raw.advice : 'unknown';
  const crossingAt = typeof f.crossingAt === 'string' && Number.isFinite(Date.parse(f.crossingAt)) ? f.crossingAt : null;
  const hours = num(f.hoursUntilThreshold);
  if (f.status === 'projected' && (hours === null || crossingAt === null)) return null;
  return { status: f.status, advice, freeGb: num(f.freeGb), gbPerHour: num(f.consumptionGbPerHour), hoursUntilThreshold: hours, crossingAt };
}
const pad = (n: number) => String(n).padStart(2, '0');
export function diskRunwayLine(view: DiskRunwayView): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  const tone = view.advice === 'avoid-large-writes' ? 'warn' : view.status === 'unknown' ? 'muted' : 'ok';
  switch (view.status) {
    case 'projected': {
      const at = new Date(view.crossingAt as string);
      const h = Math.max(0, Math.round(view.hoursUntilThreshold as number));
      return { text: `About ${h} h of disk left before 150 GB (at ${pad(at.getHours())}:${pad(at.getMinutes())})`, tone };
    }
    case 'reached': return { text: 'Below 150 GB free now', tone };
    case 'not-falling': return { text: 'Free disk is not falling', tone };
    default: return { text: 'Not enough disk samples yet', tone };
  }
}
export function diskRunwayDetail(view: DiskRunwayView): string | null {
  const parts: string[] = [];
  if (view.freeGb !== null) parts.push(`${view.freeGb.toFixed(1)} GB free`);
  if (view.gbPerHour !== null) parts.push(`${view.gbPerHour.toFixed(1)} GB/h`);
  return parts.length ? parts.join(' · ') : null;
}

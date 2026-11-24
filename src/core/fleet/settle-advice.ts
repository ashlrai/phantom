const HOUR = 3_600_000;
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Load-only advice, never an admission verdict or a config write. Hourly peaks
 * avoid weighting busy sampling periods more heavily than quiet ones. */
export function settleAdvice(text: string | null, now: number) {
  const hours = new Map<number, number>();
  let samples = 0, latest = -Infinity, earliest = Infinity;
  for (const line of (text ?? '').split('\n')) {
    try {
      const row = record(JSON.parse(line));
      const ts = typeof row.ts === 'number' ? row.ts * 1000 : typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
      const signal = record(row.signals);
      const load = number(signal.load1), cpus = number(signal.ncpu);
      const age = now - ts;
      if (!Number.isFinite(age) || age < 0 || age >= 24 * HOUR || load === null || cpus === null || !Number.isSafeInteger(cpus) || cpus < 1) continue;
      const hour = Math.floor(age / HOUR);
      hours.set(hour, Math.max(hours.get(hour) ?? 0, load / cpus));
      samples++; latest = Math.max(latest, ts); earliest = Math.min(earliest, ts);
    } catch { /* Malformed observations supply no evidence. */ }
  }
  const complete = hours.size === 24 && now - latest <= 300_000 && earliest <= now - 24 * HOUR + 300_000;
  const peaks = [...hours.values()].sort((a, b) => a - b);
  const p95 = complete ? peaks[Math.ceil(peaks.length * 0.95) - 1]! : null;
  const pressure = Math.max(0, Math.min(1, (p95 ?? 0) - 1));
  return {
    windowHours: 24, samples, hoursCovered: hours.size, loadPerCpuP95: p95,
    recommendedSeconds: complete ? Math.ceil(30 + 270 * pressure * pressure * (3 - 2 * pressure)) : null,
    reason: complete ? 'Load-only advice: 95th percentile of hourly peak host load per CPU; 30–300 seconds. Review memory and other gates before changing settle.'
      : 'Need fresh load observations covering all 24 hours; keep the current settle value.',
  };
}

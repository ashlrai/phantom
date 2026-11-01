type Merges = {
  count: number | null;
  perHour?: number | null;
  medianOpenToMergeMs?: number | null;
  items: Array<{ number: number; openToMergeMs?: number | null }>;
};

const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function duration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`;
  return `${Math.floor(ms / 3_600_000)} h ${Math.floor(ms / 60_000) % 60} min`;
}

/** Format observed merge facts without deriving missing measurements. */
export function mergeSpeedLine(merges: Merges, _nowMs: number): string | null {
  if (!valid(merges.count)) return null;
  const parts = [`Merges: ${merges.count} in the last hour`];
  if (valid(merges.perHour)) parts.push(`${merges.perHour}/h`);
  if (valid(merges.medianOpenToMergeMs)) parts.push(`median open→merge ${duration(merges.medianOpenToMergeMs)}`);
  let slowest: { number: number; openToMergeMs: number } | null = null;
  for (const item of merges.items) {
    if (valid(item.number) && valid(item.openToMergeMs) && (slowest === null || item.openToMergeMs > slowest.openToMergeMs)) {
      slowest = { number: item.number, openToMergeMs: item.openToMergeMs };
    }
  }
  if (slowest !== null) parts.push(`slowest #${slowest.number} (${duration(slowest.openToMergeMs)})`);
  return parts.join(' · ');
}

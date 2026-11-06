const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const duration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function mergeSpeedReading(mergesLastHour: unknown): { text: string; tone: 'ok' | 'warn' | 'neutral' } {
  const merges = record(mergesLastHour);
  const count = merges?.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return { text: '—', tone: 'neutral' };
  if (count === 0) return { text: '0/h — nothing merged in the last hour', tone: 'warn' };

  let median = merges?.medianOpenToMergeMs;
  if (!duration(median) && Array.isArray(merges?.items)) {
    const values = merges.items.map((item: unknown) => record(item)?.openToMergeMs).filter(duration).sort((a: number, b: number) => a - b);
    const middle = Math.floor(values.length / 2);
    median = values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
  }
  if (!duration(median)) return { text: `${count}/h`, tone: 'ok' };
  const minutes = median / 60_000;
  const elapsed = minutes < 90 ? `${Math.round(minutes)}m` : `${Math.round(minutes / 60 * 10) / 10}h`;
  return { text: `${count}/h · open→merge ${elapsed}`, tone: 'ok' };
}

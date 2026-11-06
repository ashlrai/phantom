type MergeSpeedLine = { text: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const duration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function medianFromItems(items: unknown): number | null {
  if (!Array.isArray(items)) return null;
  const values = items
    .map((item: unknown) => record(item) ? item['openToMergeMs'] : null)
    .filter(duration)
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle]! : values[middle - 1]! / 2 + values[middle]! / 2;
}

export function mergeSpeedLines(runs: unknown, _nowMs: number): MergeSpeedLine[] {
  if (!record(runs)) return [];
  const merges = runs['mergesLastHour'];
  if (!record(merges) || !Number.isSafeInteger(merges['count']) || (merges['count'] as number) < 0) {
    return [{ text: 'merge count unavailable', tone: 'neutral' }];
  }
  const count = merges['count'] as number;
  if (count === 0) {
    const published = Array.isArray(runs['publishesLastHour']) ? runs['publishesLastHour'].length : 0;
    return published >= 3
      ? [{ text: `0 merged, ${published} published in the last hour — merge gate stalled`, tone: 'danger' }]
      : [{ text: '0 merged in the last hour', tone: 'warn' }];
  }
  const lines: MergeSpeedLine[] = [{ text: `${count} merged in the last hour`, tone: 'ok' }];
  const median = duration(merges['medianOpenToMergeMs'])
    ? merges['medianOpenToMergeMs'] : medianFromItems(merges['items']);
  if (median !== null) {
    const time = median < 90 * 60_000 ? `${Math.round(median / 60_000)}m` : `${(median / 3_600_000).toFixed(1)}h`;
    lines.push({ text: `open→merge median ${time}`, tone: 'neutral' });
  }
  return lines;
}

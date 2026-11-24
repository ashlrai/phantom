export function formatAsOf(
  source: string,
  observedAt: string,
  now: Date,
  staleAfterMs = 15 * 60_000,
): string {
  const labelSource = source.trim() || 'unknown source';
  const observed = new Date(observedAt);
  if (Number.isNaN(observed.getTime())) return `as of unknown from ${labelSource}`;

  const timestamp = observed.toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z');
  const stale = now.getTime() - observed.getTime() > staleAfterMs;
  return `as of ${timestamp} from ${labelSource}${stale ? ' (stale, background only)' : ''}`;
}

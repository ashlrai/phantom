/** Browser-safe (no node: imports) so the console can share it with the CLI. */
export function formatAge(ms: number | null): string {
  if (ms === null) return 'never';
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

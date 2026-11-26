export const SHORT_VALUE_MAX = 80;

export function formatAge(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

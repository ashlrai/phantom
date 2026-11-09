/** Age of a captured usage reading; unknown timestamps never become zero. */
export function readingAge(at: string | null, now = Date.now()): string {
  const time = at === null ? NaN : Date.parse(at);
  if (!Number.isFinite(time) || time > now) return 'Reading age unknown';
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return 'read just now';
  if (minutes < 60) return `read ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `read ${hours} h ago`;
  return `read ${Math.floor(hours / 24)} days ago`;
}

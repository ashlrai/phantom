function compactDuration(seconds: number): string {
  const whole = Math.floor(Math.max(0, seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

export function elapsedTime(seconds: number, style: 'compact' | 'spaced' | 'words' = 'compact'): string {
  if (!Number.isFinite(seconds)) return 'time unknown';
  const duration = compactDuration(seconds);
  const labels = { s: 'second', m: 'minute', h: 'hour', d: 'day' } as const;
  return style === 'words' ? duration.replace(/(\d+)([smhd])/g, (_, n: string, unit: keyof typeof labels) => `${n} ${labels[unit]}${n === '1' ? '' : 's'}`)
    : style === 'spaced' ? duration.replace(/(\d+)m/g, '$1 min').replace(/(\d+)([shd])/g, '$1 $2') : duration;
}

export function ageInSeconds(seconds: number, style: 'compact' | 'spaced' | 'words' = 'compact'): string {
  return Number.isFinite(seconds) ? `${elapsedTime(seconds, style)} ago` : 'time unknown';
}

export function relativeTime(value: unknown, now = Date.now()) {
  const date = new Date(typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN);
  const at = date.getTime();
  if (!Number.isFinite(at) || !Number.isFinite(now) || at > now) return null;
  const seconds = Math.floor((now - at) / 1000);
  return { seconds, text: ageInSeconds(seconds), dateTime: date.toISOString() };
}

import { relativeTime } from '../../lib/relative-time.js';

export function RelativeTime({ value, now, fallback = 'time unknown', prefix = '', recentSeconds = 0 }: {
  value: unknown; now?: number; fallback?: string; prefix?: string; recentSeconds?: number;
}) {
  const reading = relativeTime(value, now);
  return reading ? <time dateTime={reading.dateTime} title={reading.dateTime}>{prefix}{reading.seconds < recentSeconds ? 'just now' : reading.text}</time> : <>{fallback}</>;
}

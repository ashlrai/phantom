import { relativeTime, ageInSeconds } from '../../../lib/relative-time.js';
/** Age of a captured usage reading; unknown timestamps never become zero. */
export function readingAge(at: string | null, now = Date.now()): string {
  const reading = relativeTime(at, now);
  return reading ? `read ${reading.seconds < 60 ? 'just now' : ageInSeconds(reading.seconds, 'spaced')}` : 'Reading age unknown';
}

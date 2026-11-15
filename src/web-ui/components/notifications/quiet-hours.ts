export interface QuietHours { start: string; end: string }
export const QUIET_HOURS_KEY = 'ashlr.notifications.quietHours.v1'; // gitleaks:allow -- public preference key

function minutes(value: unknown): number | null {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

export function isWithinQuietHours(now: Date, window: QuietHours | null): boolean {
  if (!window) return false;
  const start = minutes(window.start), end = minutes(window.end);
  if (start === null || end === null || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function summarizeHeld(count: number): string {
  return `${count} ${count === 1 ? 'update' : 'updates'} while quiet`;
}

export function loadQuietHours(): QuietHours | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(QUIET_HOURS_KEY) ?? 'null');
    if (value && typeof value === 'object' && 'start' in value && 'end' in value
      && minutes(value.start) !== null && minutes(value.end) !== null) {
      return { start: value.start as string, end: value.end as string };
    }
  } catch { /* best-effort */ }
  return null;
}

export function saveQuietHours(value: QuietHours | null): void {
  try {
    if (value) localStorage.setItem(QUIET_HOURS_KEY, JSON.stringify(value));
    else localStorage.removeItem(QUIET_HOURS_KEY);
  } catch { /* best-effort */ }
  window.dispatchEvent(new Event('quiet-hours-change'));
}

const KEY = 'phantom.timeline.group-by-lane.v1';

export function readGroupByLane(): boolean {
  try { return localStorage.getItem(KEY) === 'true'; } catch { return false; }
}

export function writeGroupByLane(value: boolean): void {
  try { localStorage.setItem(KEY, String(value)); } catch { /* Storage can be unavailable. */ }
}

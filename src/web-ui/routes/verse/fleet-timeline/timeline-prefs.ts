const KEY = 'phantom.timeline.group-by-lane.v1';

export function readGroupByLane(): boolean {
  try { return localStorage.getItem(KEY) === 'true'; } catch { return false; }
}

export function writeGroupByLane(value: boolean): void {
  try { localStorage.setItem(KEY, String(value)); } catch { /* Storage can be unavailable. */ }
}

const CI_KEY = 'phantom.timeline.show-ci.v1';

export function readShowCi(): boolean {
  try { return localStorage.getItem(CI_KEY) !== 'false'; } catch { return true; }
}

export function writeShowCi(value: boolean): void {
  try { localStorage.setItem(CI_KEY, String(value)); } catch { /* Storage can be unavailable. */ }
}

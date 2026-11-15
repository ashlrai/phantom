import { NOTE_MAX_CHARS } from './steer-action.js';

const KEY = 'phantom.fleetSteer.noteDraft.v1';

export function loadSteerNote(storage: Storage | null): string {
  try { return (storage?.getItem(KEY) ?? '').slice(0, NOTE_MAX_CHARS); } catch { return ''; }
}

export function saveSteerNote(storage: Storage | null, text: string): void {
  try {
    if (!text.trim()) storage?.removeItem(KEY);
    else storage?.setItem(KEY, text.slice(0, NOTE_MAX_CHARS));
  } catch { /* Storage may be unavailable or full. */ }
}

export function clearSteerNote(storage: Storage | null): void {
  try { storage?.removeItem(KEY); } catch { /* Storage may be unavailable. */ }
}

import { useSyncExternalStore } from 'react';

export type HintChord = 'ctrl-alt-h' | 'ctrl-shift-h';
export interface HintSettings { enabled: boolean; chord: HintChord }
const KEY = 'phantom.keyboard-hints.v1';
const CHANGE = 'phantom:keyboard-hints-settings';
const DEFAULT: HintSettings = { enabled: false, chord: 'ctrl-alt-h' };
let cached = DEFAULT;
let raw: string | null | undefined;

function read(): HintSettings {
  try {
    const value = localStorage.getItem(KEY);
    if (raw === value) return cached;
    raw = value;
    const parsed = value ? JSON.parse(value) as Partial<HintSettings> : {};
    cached = { enabled: parsed.enabled === true, chord: parsed.chord === 'ctrl-shift-h' ? 'ctrl-shift-h' : 'ctrl-alt-h' };
  } catch { cached = DEFAULT; }
  return cached;
}
function subscribe(update: () => void): () => void {
  window.addEventListener(CHANGE, update);
  window.addEventListener('storage', update);
  return () => { window.removeEventListener(CHANGE, update); window.removeEventListener('storage', update); };
}
export function useHintSettings(): HintSettings { return useSyncExternalStore(subscribe, read, () => DEFAULT); }
export function setHintSettings(next: HintSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { return; }
  window.dispatchEvent(new Event(CHANGE));
}
export function matchesHintChord(event: KeyboardEvent, chord: HintChord): boolean {
  return (event.code === 'KeyH' || (!event.code && event.key.toLowerCase() === 'h')) && event.ctrlKey && !event.metaKey &&
    (chord === 'ctrl-alt-h' ? event.altKey && !event.shiftKey : event.shiftKey && !event.altKey) && !event.getModifierState('AltGraph');
}

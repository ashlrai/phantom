import { closeVerseOverlay, setVerseSection } from '../verse-ui-store.js';

export interface ActiveElementState { editable: boolean; text: string; steer: boolean }

export function shouldFocusSteer(active: ActiveElementState): 'focus' | 'blocked' {
  return active.editable && !active.steer && active.text.length > 0 ? 'blocked' : 'focus';
}

let pending = false;
const listeners = new Set<() => void>();

export function subscribeSteerFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function takeSteerFocus(): boolean {
  if (!pending) return false;
  pending = false;
  return true;
}

export function requestSteerFocus(fromPalette = false, blocked: () => void = () => {}): void {
  const active = document.activeElement;
  const editable = active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'range', 'file'].includes(active.type)) ||
    (active instanceof HTMLElement && active.isContentEditable);
  const text = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.value : active?.textContent ?? '';
  if (!fromPalette && shouldFocusSteer({ editable, text, steer: active?.hasAttribute('data-steer-box') ?? false }) === 'blocked') {
    blocked();
    return;
  }
  // Let open dialogs process their normal dismissal before moving focus.
  if (document.querySelector('[aria-modal="true"]')) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  closeVerseOverlay();
  pending = true;
  setVerseSection('fleet');
  requestAnimationFrame(() => { for (const listener of [...listeners]) listener(); });
}

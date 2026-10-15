/** Explicit semantic targets only. No text contents, field values, coordinates clicks or generic button discovery. */
export const HINT_ALPHABET = 'asdfghjkl';
export const MAX_HINT_TARGETS = 200;
export interface HintBounds { left: number; top: number; width: number; height: number }
export interface HintTarget { id: string; label: string; action: 'focus' | 'press'; element: HTMLElement; bounds: HintBounds; semanticState: string }

/** Equal-length labels are prefix-free, including at alphabet size boundaries. */
export function hintLabels(count: number): string[] {
  if (!Number.isInteger(count) || count < 0 || count > MAX_HINT_TARGETS) return [];
  let width = 1;
  while (HINT_ALPHABET.length ** width < count) width++;
  return Array.from({ length: count }, (_, index) => {
    let label = '';
    for (let digit = 0; digit < width; digit++) {
      label = HINT_ALPHABET[index % HINT_ALPHABET.length]! + label;
      index = Math.floor(index / HINT_ALPHABET.length);
    }
    return label;
  });
}
const MODALS = 'dialog[open], [role="dialog"], [aria-modal="true"], [role="menu"], [aria-haspopup="menu"][aria-expanded="true"]';
export function hintModalOpen(): boolean {
  // A partially visible dialog still owns input. Target eligibility is stricter
  // than modal detection; clipping must never allow hints behind a visible modal.
  return Array.from(document.querySelectorAll<HTMLElement>(MODALS)).some((el) => renderedHintRegion(el) !== null);
}

function renderedHintRegion(element: HTMLElement): { rect: DOMRect; left: number; right: number; top: number; bottom: number } | null {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return null;
  const rect = element.getBoundingClientRect();
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  let left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.right);
  let top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const css = getComputedStyle(ancestor);
    if (css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' || css.opacity === '0') return null;
    if (ancestor === element) continue;
    const clipX = /^(auto|scroll|hidden|clip)$/.test(css.overflowX || css.overflow);
    const clipY = /^(auto|scroll|hidden|clip)$/.test(css.overflowY || css.overflow);
    if (clipX || clipY) {
      const clip = ancestor.getBoundingClientRect();
      if (clipX) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
      if (clipY) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
    }
  }
  return left < right && top < bottom ? { rect, left, right, top, bottom } : null;
}
export function visibleHintBounds(element: HTMLElement): HintBounds | null {
  if (element.closest('[disabled], [aria-disabled="true"], [data-secure-input="true"]')) return null;
  const region = renderedHintRegion(element);
  if (!region) return null;
  const { rect, left, right, top, bottom } = region;
  // Fully visible targets only: a clipped control must be revealed before selection.
  if (left > rect.left || top > rect.top || right < rect.right || bottom < rect.bottom) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

const SEMANTIC_ATTRIBUTES = ['role', 'type', 'tabindex', 'readonly', 'aria-haspopup', 'aria-expanded', 'aria-pressed', 'aria-selected'];
function semanticState(element: HTMLElement): string {
  // Compare capabilities/state only; never read field values, titles or target text.
  return JSON.stringify(SEMANTIC_ATTRIBUTES.map((name) => element.getAttribute(name)));
}
// The existing shell supplies stable app-owned identities/structure. Keep this
// adapter in the optional hint chunk instead of adding startup JSX attributes.
// Selectors never examine text contents, field values or arbitrary buttons.
const SHELL_RAIL = 'nav[data-rail] button[data-section], nav[data-rail] button[data-gear], nav[data-rail] button[data-needs-you]';
const SHELL_MODES = '#main-content > div:first-child > nav > button[aria-pressed]';
const SHELL_REVIEW = '#main-content > div:first-child > button[aria-haspopup="menu"]';
const CHAT_COMPOSER = '#main-content [data-surface="chat"] form[aria-describedby] > div > textarea';
const SELECTORS = `[data-phantom-hint], ${SHELL_RAIL}, ${SHELL_MODES}, ${SHELL_REVIEW}, ${CHAT_COMPOSER}`;

function semanticIdentity(element: HTMLElement): { id?: string; action?: string } {
  if (element.hasAttribute('data-phantom-hint')) return { id: element.dataset.phantomHint, action: element.dataset.phantomHintAction };
  if (element.matches(SHELL_RAIL)) {
    if (element.hasAttribute('data-gear')) return { id: 'rail.settings', action: 'press' };
    if (element.hasAttribute('data-needs-you')) return { id: 'rail.needs-you', action: 'press' };
    const section = element.dataset.section;
    return ['command', 'fleet', 'growth', 'mind', 'chat', 'agents'].includes(section ?? '') ? { id: `rail.${section}`, action: 'press' } : {};
  }
  if (element.matches(SHELL_MODES)) {
    const modes = document.querySelectorAll(SHELL_MODES);
    if (modes.length !== 2) return {};
    return { id: `mode.${modes[0] === element ? 'with-me' : 'for-me'}`, action: 'press' };
  }
  if (element.matches(SHELL_REVIEW) && document.querySelectorAll(SHELL_REVIEW).length === 1) return { id: 'shell.review', action: 'press' };
  if (element.matches(CHAT_COMPOSER)) return { id: 'chat.composer', action: 'focus' };
  return {};
}

export function discoverHintTargets(): HintTarget[] {
  // This registry is app-owned; refuse unexpectedly large registries instead of scanning without a bound.
  const elements = document.querySelectorAll<HTMLElement>(SELECTORS);
  if (elements.length > MAX_HINT_TARGETS) return [];
  const ids = new Set<string>();
  const targets: Omit<HintTarget, 'label'>[] = [];
  for (const element of elements) {
    const { id, action } = semanticIdentity(element);
    if (!id) continue;
    if (ids.has(id)) return []; // Ambiguous identity fails closed.
    ids.add(id);
    if (action !== 'focus' && action !== 'press') continue;
    if (action === 'press' && !(element instanceof HTMLButtonElement && element.type === 'button')) continue;
    if (action === 'focus' && (element.matches('input[type="password"]') || !(element.matches('textarea, input:not([type="hidden"])') || element.hasAttribute('tabindex')))) continue;
    const bounds = visibleHintBounds(element);
    if (bounds) targets.push({ id, action, element, bounds, semanticState: semanticState(element) });
  }
  targets.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const labels = hintLabels(targets.length);
  return targets.map((target, i) => ({ ...target, label: labels[i]! }));
}
export function sameHintTargets(before: HintTarget[], after: HintTarget[]): boolean {
  return before.length === after.length && before.every((target, i) => {
    const other = after[i];
    return other && target.id === other.id && target.element === other.element && target.action === other.action && target.semanticState === other.semanticState &&
      (['left', 'top', 'width', 'height'] as const).every((key) => Math.abs(target.bounds[key] - other.bounds[key]) < 0.5);
  });
}

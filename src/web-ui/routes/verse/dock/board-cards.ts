/**
 * routes/verse/dock/board-cards.ts — moving between the cards of a resource
 * board from the keyboard.
 *
 * A board marks each of its cards (a pool, an account, a lane, a model, a
 * seat in the try order) with `data-board-card`. The switcher above the board
 * reads those marks, so every board answers the same four keys without a
 * handler of its own: J next, K previous, G first, Shift+G last. A card that
 * is not on screen (inside a `hidden` element) is not a stop.
 *
 * DOM reads only; nothing here fetches or decides anything about the fleet.
 */

export const BOARD_CARD = '[data-board-card]';

export type CardMove = 'next' | 'prev' | 'first' | 'last';

/** The move a plain key press asks for; null for any other key. Shift is read from the modifier, not the letter's case, so Caps Lock does not turn G into "last". */
export function cardMove(event: { key: string; shiftKey: boolean }): CardMove | null {
  const key = event.key.toLowerCase();
  if (key === 'g') return event.shiftKey ? 'last' : 'first';
  if (event.shiftKey) return null;
  return key === 'j' ? 'next' : key === 'k' ? 'prev' : null;
}

/** The board's cards in reading order. */
export function boardCards(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(BOARD_CARD)].filter((card) => card.closest('[hidden]') === null);
}

/** The card that holds `element` (the card itself, or one a focused control sits in); null outside every card. */
export function cardOf(root: Element, element: Element | null): HTMLElement | null {
  const card = element?.closest<HTMLElement>(BOARD_CARD) ?? null;
  return card !== null && root.contains(card) ? card : null;
}

/**
 * Where a move lands. From a card it steps or jumps and stops at the ends (null when already there). With no card
 * held, J and K both start at the first card still below `edge` (the bottom of the sticky switcher), so the keyboard
 * picks up where the eye is instead of scrolling back to the top.
 */
export function cardTarget(cards: readonly HTMLElement[], current: HTMLElement | null, move: CardMove, edge = 0): HTMLElement | null {
  if (cards.length === 0) return null;
  const at = current === null ? -1 : cards.indexOf(current);
  let target: HTMLElement | undefined;
  if (move === 'first') target = cards[0];
  else if (move === 'last') target = cards[cards.length - 1];
  else if (at < 0) target = cards.find((card) => card.getBoundingClientRect().bottom > edge) ?? cards[0];
  else target = cards[at + (move === 'next' ? 1 : -1)];
  return target === undefined || target === current ? null : target;
}

/** Puts the keyboard on a card and brings it into view. A card is focusable from code only: Tab still goes to its controls. */
export function focusCard(card: HTMLElement): void {
  if (!card.hasAttribute('tabindex')) card.tabIndex = -1;
  card.focus({ preventScroll: true });
  card.scrollIntoView?.({ block: 'nearest' });
}

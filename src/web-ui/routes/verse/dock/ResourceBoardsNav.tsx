/**
 * routes/verse/dock/ResourceBoardsNav.tsx — the switcher the dock draws above
 * every resource board (Pools, Usage, Router, Models, Lanes, Capacity,
 * Supply), so they read as one surface instead of seven tabs to hunt for.
 *
 * Choosing a board puts it in the place of the one on screen (the dock keeps
 * one tab), unless that board already has a tab of its own, which is then
 * brought forward. It is one Tab stop: Left and Right move along the row,
 * Home and End jump to the ends, and [ and ] do the same from anywhere in the
 * board that is not a text field.
 *
 * Every name can carry a live reading, so the row is the status line of the
 * whole surface: pools running empty early or behind, accounts at a limit,
 * kinds of work with no seat, models the router refuses, lanes held or slots
 * running, the share of target slots filled, and opening slots with no job
 * waiting. Each comes from the read its own board draws from and is shared
 * with it through the cache (use-board-readings.ts lists the reads). A board
 * with nothing worth a word, or whose read has not answered or last failed,
 * shows its name alone.
 *
 * Inside a board, J and K step through its cards (a pool, an account, a seat,
 * a model, a lane), G and Shift+G jump to the first and last; the row shows
 * which card holds the keyboard ("3 of 9"). The cards are the elements a
 * board marks `data-board-card` (board-cards.ts), so no board handles a key.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { boardCards, cardMove, cardOf, cardTarget, focusCard } from './board-cards.js';
import { getPane, usePanes } from '../panes/pane-registry.js';
import { swapDockPane } from './dock-store.js';
import { RESOURCE_BOARD_GROUPS, neighbourBoard, resourceBoards } from './resource-boards.js';
import { useBoardReadings } from './use-board-readings.js';
import styles from './ResourceBoardsNav.module.css';

/** The board a keyboard move just opened: its switcher takes focus back, so the next key lands in the same place. */
let focusAfterSwitch: string | null = null;

function typingIn(target: Element): boolean {
  return target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}

export interface ResourceBoardsNavProps {
  /** The board this switcher sits above. */
  current: string;
  /** False while the board is behind another tab. */
  visible: boolean;
  /** The dock's main pane: it also answers [ and ] when nothing on the page has focus. */
  primary: boolean;
}

export function ResourceBoardsNav({ current, visible, primary }: ResourceBoardsNavProps) {
  usePanes(); // a board registered or removed later joins or leaves the row
  const boards = resourceBoards(getPane);
  const navRef = useRef<HTMLElement>(null);
  const listed = boards.some((board) => board.id === current) && boards.length > 1;
  const readings = useBoardReadings(boards.map((board) => board.id), visible && listed);

  function go(target: string | null, keyboard: boolean): void {
    if (target === null || target === current) return;
    focusAfterSwitch = keyboard ? target : null;
    swapDockPane(current, target);
  }
  const step = (delta: number) => go(neighbourBoard(boards, current, delta), true);

  useEffect(() => {
    if (!visible || !listed) return;
    const link = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    link?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (focusAfterSwitch === current) { focusAfterSwitch = null; link?.focus(); }
  }, [visible, listed, current]);

  useEffect(() => {
    if (!visible || !listed) return;
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const board = event.key === '[' || event.key === ']';
      const move = board ? null : cardMove(event);
      if (!board && move === null) return;
      const target = event.target instanceof Element ? event.target : null;
      const root = navRef.current?.parentElement ?? null;
      const inBoard = target !== null && root?.contains(target) === true;
      if (!(inBoard || (primary && target === document.body)) || (target !== null && typingIn(target))) return;
      if (board) { event.preventDefault(); step(event.key === ']' ? 1 : -1); return; }
      if (root === null || move === null) return;
      const cards = boardCards(root);
      if (cards.length === 0) return;
      // The key is the board's even at an end, where nothing moves: it must not fall through to another handler.
      event.preventDefault();
      const card = cardTarget(cards, cardOf(root, document.activeElement), move, navRef.current?.getBoundingClientRect().bottom ?? 0);
      if (card) focusCard(card);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  // Which card holds the keyboard, counted when focus moves: a card, or a control inside one.
  const [held, setHeld] = useState<{ index: number; count: number } | null>(null);
  useEffect(() => {
    const root = navRef.current?.parentElement ?? null;
    if (!visible || !listed || root === null) { setHeld(null); return; }
    const board = root;
    function read(focused: EventTarget | null): void {
      const card = cardOf(board, focused instanceof Element ? focused : null);
      const cards = card === null ? [] : boardCards(board);
      const index = card === null ? -1 : cards.indexOf(card);
      setHeld((was) => index < 0 ? null : was?.index === index + 1 && was.count === cards.length ? was : { index: index + 1, count: cards.length });
    }
    const onFocusIn = (event: FocusEvent) => read(event.target);
    const onFocusOut = (event: FocusEvent) => read(event.relatedTarget);
    board.addEventListener('focusin', onFocusIn);
    board.addEventListener('focusout', onFocusOut);
    read(document.activeElement);
    return () => { board.removeEventListener('focusin', onFocusIn); board.removeEventListener('focusout', onFocusOut); };
  }, [visible, listed, current]);

  if (!listed) return null;

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.key === 'ArrowRight' ? neighbourBoard(boards, current, 1)
      : event.key === 'ArrowLeft' ? neighbourBoard(boards, current, -1)
        : event.key === 'Home' ? boards[0]!.id
          : event.key === 'End' ? boards[boards.length - 1]!.id : undefined;
    if (target === undefined) return;
    event.preventDefault();
    go(target, true);
  }

  return (
    <nav ref={navRef} className={styles.nav} aria-label="Resource boards" onKeyDown={onKeyDown}>
      <ul className={styles.list}>
        {boards.map((board) => {
          const reading = readings.get(board.id);
          return (
            <li key={board.id} className={styles.item} data-group={board.group} data-group-start={board.startsGroup || undefined}>
              <button type="button" className={styles.link} aria-current={board.id === current ? 'page' : undefined}
                tabIndex={board.id === current ? 0 : -1}
                title={`${reading ? `${reading.detail} ` : ''}${RESOURCE_BOARD_GROUPS[board.group]}${board.description ? `. ${board.description}` : ''}`}
                onClick={() => go(board.id, false)}>
                {board.title}
                {reading ? <span className={styles.reading} data-tone={reading.tone}>{reading.text}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <span className={styles.keys} data-keys="cards" title="J and K move to the next and previous card of this board. G goes to the first, Shift+G to the last.">
        {held ? <span className={styles.position} data-card-position><span className="visually-hidden">Card </span>{held.index} of {held.count}</span> : null}
        <kbd>J</kbd><kbd>K</kbd><span className="visually-hidden">Press J or K for the next or previous card, G for the first, Shift+G for the last.</span>
      </span>
      <span className={styles.keys} title="[ and ] move to the previous and next resource board"><kbd>[</kbd><kbd>]</kbd><span className="visually-hidden">Press [ or ] for the previous or next board.</span></span>
    </nav>
  );
}

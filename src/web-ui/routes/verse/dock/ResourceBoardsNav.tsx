/**
 * routes/verse/dock/ResourceBoardsNav.tsx — the switcher the dock draws above
 * every resource board (Pools, Usage, Router, Models, Lanes, Capacity,
 * Supply), so they read as one surface instead of seven tabs to hunt for.
 *
 * Choosing a board puts it in the place of the one on screen (the dock keeps
 * one tab), unless that board already has a tab of its own, which is then
 * brought forward. It is one Tab stop: Left and Right move along the row,
 * Home and End jump to the ends, and [ and ] do the same from anywhere in the
 * board that is not a text field. It only navigates and reads no fleet data.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { getPane, usePanes } from '../panes/pane-registry.js';
import { swapDockPane } from './dock-store.js';
import { RESOURCE_BOARD_GROUPS, neighbourBoard, resourceBoards } from './resource-boards.js';
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
      if (event.key !== '[' && event.key !== ']') return;
      const target = event.target instanceof Element ? event.target : null;
      const inBoard = target !== null && navRef.current?.parentElement?.contains(target) === true;
      if (!(inBoard || (primary && target === document.body)) || (target !== null && typingIn(target))) return;
      event.preventDefault();
      step(event.key === ']' ? 1 : -1);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

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
        {boards.map((board) => (
          <li key={board.id} className={styles.item} data-group={board.group} data-group-start={board.startsGroup || undefined}>
            <button type="button" className={styles.link} aria-current={board.id === current ? 'page' : undefined}
              tabIndex={board.id === current ? 0 : -1}
              title={`${RESOURCE_BOARD_GROUPS[board.group]}${board.description ? `. ${board.description}` : ''}`}
              onClick={() => go(board.id, false)}>
              {board.title}
            </button>
          </li>
        ))}
      </ul>
      <span className={styles.keys} title="[ and ] move to the previous and next resource board"><kbd>[</kbd><kbd>]</kbd><span className="visually-hidden">Press [ or ] for the previous or next board.</span></span>
    </nav>
  );
}

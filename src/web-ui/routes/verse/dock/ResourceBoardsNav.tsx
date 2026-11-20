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
 * Three names carry a live reading, each from the read its own board draws
 * from and shared with it through the cache: Pools says how many pools run
 * empty early or are behind (GET /api/app/pools, `phm pools`), Usage how many
 * accounts a provider flags at a limit (GET /api/verse/accounts, counted as
 * `phm usage limits` counts them) and Lanes how many lanes are held or how many slots are running
 * (GET /api/verse/fleet/runs, `phm fleet runs`). A read that has not answered
 * or last failed shows no reading.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { fleetPoolsQuery } from '../fleet-pools/pools-query.js';
import { isFleetRuns } from '../ops/ops-runs-model.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { getPane, usePanes } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { swapDockPane } from './dock-store.js';
import { rowsFromAccounts } from '../fleet-usage/usage-pane-model.js';
import { projectAccountsSnapshot } from '../usage/usage-contract.js';
import { verseAccountsQuery } from '../usage/usage-queries.js';
import { lanesReading, poolsReading, usageReading, type BoardReading } from './resource-board-readings.js';
import { RESOURCE_BOARD_GROUPS, neighbourBoard, resourceBoards } from './resource-boards.js';
import styles from './ResourceBoardsNav.module.css';

/** The board a keyboard move just opened: its switcher takes focus back, so the next key lands in the same place. */
let focusAfterSwitch: string | null = null;

function typingIn(target: Element): boolean {
  return target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}

/** Long enough that a recent read by the board itself, or by Home, is reused instead of asked for again. */
const READING_POLL_MS = 30_000;
/** The Usage board's own interval: the accounts read asks the providers, so the row must not ask more often. */
const ACCOUNTS_POLL_MS = 60_000;

/** The readings to draw, by board id. Only asked for while the row is on screen and lists that board. */
function useBoardReadings(ids: readonly string[], on: boolean): ReadonlyMap<string, BoardReading> {
  const wantPools = on && ids.includes('fleet-pools'), wantLanes = on && ids.includes('fleet-lanes'), wantUsage = on && ids.includes('fleet-usage');
  const pools = useQuery(fleetPoolsQuery, { enabled: wantPools, freshMs: READING_POLL_MS });
  const runs = useQuery(opsRunsQuery, { enabled: wantLanes, freshMs: READING_POLL_MS });
  usePollWhileVisible(useRefetch(fleetPoolsQuery), READING_POLL_MS, { enabled: wantPools, refreshOnShow: false });
  usePollWhileVisible(useRefetch(opsRunsQuery), READING_POLL_MS, { enabled: wantLanes, refreshOnShow: false });
  const accounts = useQuery(verseAccountsQuery, { enabled: wantUsage, freshMs: ACCOUNTS_POLL_MS });
  usePollWhileVisible(useRefetch(verseAccountsQuery), ACCOUNTS_POLL_MS, { enabled: wantUsage, refreshOnShow: false });
  const out = new Map<string, BoardReading>();
  // An accounts read the server could not answer, or a body that is not the accounts snapshot, is no reading.
  const snapshot = accounts.status === 'error' || accounts.data?.available !== true ? null : projectAccountsSnapshot(accounts.data.raw);
  const usageNow = snapshot === null ? null : usageReading(rowsFromAccounts(snapshot));
  if (usageNow) out.set('fleet-usage', usageNow);
  // A failed refresh keeps the last data in the cache; a count from it must not read as current. The cache entries
  // are shared by key with other readers, so the shape is checked here too: anything else is no reading.
  const poolsNow = pools.status === 'error' || !Array.isArray(pools.data?.pools) ? null : poolsReading(pools.data);
  const lanesNow = runs.status === 'error' || !isFleetRuns(runs.data) ? null : lanesReading(runs.data);
  if (poolsNow) out.set('fleet-pools', poolsNow);
  if (lanesNow) out.set('fleet-lanes', lanesNow);
  return out;
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
      <span className={styles.keys} title="[ and ] move to the previous and next resource board"><kbd>[</kbd><kbd>]</kbd><span className="visually-hidden">Press [ or ] for the previous or next board.</span></span>
    </nav>
  );
}

/**
 * routes/control/board/FleetBoardView.tsx — the Leader-as-CEO board
 * (RQ-SWE3-BOARDUI-1): lanes, READY queue depth by tier, merges in the last
 * hour, the conflicting-PR trend and what is blocked on Mason — the same
 * `coordination/leader-board.json` recording `phm fleet board` prints,
 * served by GET /api/verse/fleet/board in the identical envelope.
 *
 * The board is a recording, not a live query: the header prints the tick's
 * own `generatedAt` as its age, and every section renders the recorded
 * fields — a null the tick could not measure prints 'unknown', never a 0.
 * Live updates arrive two ways: the 'fleet-board' SSE event (the server
 * stats the file every poll tick) and this view's own 15 s visibility-gated
 * refetch, so a scoped console without the event stream stays current too.
 */
import { useEffect, useRef } from 'react';
import { fleetBoardQuery } from '../../../data/queries.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useScrollRestore } from '../../../hooks/useScrollRestore.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { StatTile, StatTileSkeleton } from '../../../components/charts/StatTile.js';
import type { FleetBoardV1 } from '../../../data/api-types.js';
import { TierDepth } from './TierDepth.js';
import { LanesTable } from './LanesTable.js';
import { NeedsMasonPanel } from './NeedsMasonPanel.js';
import styles from './FleetBoardView.module.css';

/** Refetch cadence while the view is visible — the file moves at Leader-tick pace, never faster. */
const BOARD_POLL_MS = 15_000;

function num(value: number | null): string {
  return value === null ? 'unknown' : String(value);
}

function formatAge(ageSeconds: number | null): string {
  if (ageSeconds === null) return 'unrecorded';
  if (ageSeconds < 5) return 'just now';
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function StatTiles({ board }: { board: FleetBoardV1 }) {
  const depth = board.queueDepthByTier;
  const totalReady = depth === null ? null : Object.values(depth).reduce((sum, n) => sum + n, 0);
  const needs = board.needsMason;
  return (
    <div className={styles.tiles}>
      <StatTile
        label="Queue depth"
        value={num(totalReady)}
        caption={depth === null ? 'ready.tsv unreadable' : `READY across ${Object.keys(depth).length || 'no'} tiers`}
      />
      <StatTile
        label="Merges · last hour"
        value={num(board.mergesLastHour)}
        caption={board.sources.queueCounts === 'ok' ? 'unique merges, all lanes' : 'merge ledger unavailable'}
      />
      <StatTile
        label="Conflicting PRs"
        value={num(board.conflictingPrs.count)}
        delta={board.conflictingPrs.delta === null
          ? null
          : { value: board.conflictingPrs.delta, goodWhenPositive: false, unit: 'PRs', versus: 'prior sample' }}
        trend={board.conflictingPrs.history.map((s) => s.count)}
        trendLabel="Conflicting PRs over recorded ticks"
        describeTrend={(v) => `${v} PR${v === 1 ? '' : 's'}`}
        caption={board.conflictingPrs.trend === 'unknown' ? 'no trend yet' : `${board.conflictingPrs.trend} across recorded ticks`}
      />
      <StatTile
        label="Needs Mason"
        value={String(needs.count)}
        caption={needs.status === 'available' ? `open item${needs.count === 1 ? '' : 's'}` : `needs-Mason ${needs.status}`}
      />
    </div>
  );
}

function BoardBody({ board }: { board: FleetBoardV1 }) {
  return (
    <>
      <StatTiles board={board} />

      <section className={styles.section} aria-labelledby="board-queue-depth">
        <h2 id="board-queue-depth" className={styles.sectionTitle}>Queue depth by tier</h2>
        <div className={styles.panel}>
          <TierDepth depth={board.queueDepthByTier} />
        </div>
      </section>

      <section className={styles.section} aria-labelledby="board-lanes">
        <h2 id="board-lanes" className={styles.sectionTitle}>Lanes</h2>
        <LanesTable lanes={board.lanes} />
      </section>

      <section className={styles.section} aria-labelledby="board-needs">
        <h2 id="board-needs" className={styles.sectionTitle}>Needs Mason</h2>
        <NeedsMasonPanel needsMason={board.needsMason} />
      </section>

      <footer className={styles.sources}>
        ready.tsv {board.sources.readyTsv} · queue counts {board.sources.queueCounts} · needs-mason {board.sources.needsMason}
      </footer>
    </>
  );
}

export function FleetBoardView() {
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollRestore('/control/board', containerRef);

  const query = useQuery(fleetBoardQuery, { freshMs: 0 });
  const refetch = useRefetch(fleetBoardQuery);

  // The 'fleet-board' SSE event is the fast path; this poll keeps the view
  // honest on surfaces without the shared event stream, and only while
  // visible — the file only moves once per Leader tick.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      refetch();
    };
    const timer = window.setInterval(refresh, BOARD_POLL_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [refetch]);

  const response = query.data;
  const board = response?.board ?? null;

  return (
    <div ref={containerRef} className={styles.view}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>CONTROL</p>
          <h1 className={styles.title}>Fleet Board</h1>
        </div>
        <div className={styles.freshness} aria-live="polite">
          {query.status === 'refreshing' ? <RefreshIndicator /> : null}
          {board ? (
            <span className={styles.freshnessLabel} title={`Recorded ${board.generatedAt}`}>
              Recorded {formatAge(response?.ageSeconds ?? null)}
            </span>
          ) : null}
        </div>
      </header>

      {query.status === 'loading' ? (
        <>
          <div className={styles.tiles}>
            <StatTileSkeleton /><StatTileSkeleton /><StatTileSkeleton /><StatTileSkeleton />
          </div>
          <SkeletonLine width="55%" />
          <SkeletonLine width="80%" />
        </>
      ) : query.status === 'error' && board === null ? (
        <div className={styles.error} role="alert">
          {query.error?.message ?? 'Failed to load the fleet board.'}
        </div>
      ) : response?.status === 'unavailable' ? (
        <div className={styles.error} role="alert">
          Leader board is unreadable — the last recording could not be parsed.
        </div>
      ) : board === null ? (
        <div className={styles.notice}>
          <p className={styles.noticeTitle}>No Leader board yet</p>
          <p className={styles.noticeBody}>
            The Leader records a board each tick to coordination/leader-board.json — nothing has been written yet.
          </p>
        </div>
      ) : (
        <BoardBody board={board} />
      )}
    </div>
  );
}

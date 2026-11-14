/**
 * routes/verse/fleet-board/FleetBoardPane.tsx — the Leader-as-CEO board
 * (RQ-SWE3-BOARDUI-1 recut): lanes, READY queue depth by tier, merges in the
 * last hour, the conflicting-PR trend and what is blocked on Mason — the same
 * `coordination/leader-board.json` recording `phm fleet board` prints,
 * served by GET /api/verse/fleet/board in the identical envelope.
 *
 * Recut of the routes/control/board FleetBoardView as a dock pane: same
 * recorded-reading honesty — the header prints the tick's own `generatedAt`
 * age, a field the tick could not measure prints 'unknown', never 0, and a
 * missing/unreadable recording is a designed state, not a fake empty board.
 */
import { fleetBoardQuery } from '../../../data/queries.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { StatTile } from '../../../components/charts/StatTile.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { CHART_NEUTRAL, seriesColor } from '../../../components/charts/colors.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import type { FleetBoardV1 } from '../../../data/api-types.js';
import { CoordAnswerStrip } from './CoordAnswerStrip.js';
import { WorkBoardSection } from './work-board-section.js';
import styles from './fleet-board.module.css';

function num(value: number | null): string {
  return value === null ? 'unknown' : String(value);
}

function formatAge(ageSeconds: number | null): string {
  if (ageSeconds === null) return 'unrecorded';
  if (ageSeconds < 5) return 'just now';
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** Whole seconds to a compact wait ("45s", "3m", "2h", "1d"); unknown stays unknown. */
function formatWait(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'unknown';
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Router tier order (queuegen's `tier=` contract); recorded extras sort after, 'unknown' last. */
const TIER_ORDER: readonly string[] = ['frontier', 'work', 'mid', 'fast'];
const TIER_SLOT: Readonly<Partial<Record<string, number>>> = { frontier: 0, work: 1, mid: 2, fast: 3 };

function orderTierDepth(depth: Record<string, number>): { tier: string; count: number; color: string }[] {
  const names = Object.keys(depth);
  const known = TIER_ORDER.filter((t) => names.includes(t));
  const extra = names.filter((t) => !TIER_ORDER.includes(t) && t !== 'unknown').sort((a, b) => a.localeCompare(b));
  const ordered = [...known, ...extra, ...(names.includes('unknown') ? ['unknown'] : [])];
  return ordered.map((tier, i) => ({
    tier,
    count: depth[tier] ?? 0,
    color: tier === 'unknown' ? CHART_NEUTRAL : seriesColor(TIER_SLOT[tier] ?? 4 + (i - known.length)),
  }));
}

function BoardBody({ board }: { board: FleetBoardV1 }) {
  const depth = board.queueDepthByTier;
  const totalReady = depth === null ? null : Object.values(depth).reduce((sum, n) => sum + n, 0);
  const needs = board.needsMason;
  return (
    <>
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
          caption={board.conflictingPrs.trend === 'unknown' ? 'no trend yet' : `${board.conflictingPrs.trend} across recorded ticks`}
        />
        <StatTile
          label="Needs Mason"
          value={String(needs.count)}
          caption={needs.status === 'available' ? `open item${needs.count === 1 ? '' : 's'}` : `needs-Mason ${needs.status}`}
        />
      </div>

      <section className={styles.section} aria-labelledby="fb-tier">
        <h3 id="fb-tier" className={styles.sectionTitle}>Queue depth by tier</h3>
        {depth === null ? (
          <p className={styles.note}>Queue depth by tier: unknown — the recording tick could not read ready.tsv.</p>
        ) : orderTierDepth(depth).reduce((sum, r) => sum + r.count, 0) === 0 ? (
          <p className={styles.note}>No READY rows recorded — the queue is empty.</p>
        ) : (
          <ul className={styles.tiers}>
            {orderTierDepth(depth).map((row) => (
              <li key={row.tier} className={styles.tier}>
                <span className={styles.tierChip} style={{ background: row.color }} />
                <span className={styles.mono}>{row.tier}</span>
                <span className={styles.numeric}>{row.count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="fb-lanes">
        <h3 id="fb-lanes" className={styles.sectionTitle}>Lanes</h3>
        {board.lanes.length === 0 ? (
          <p className={styles.note}>No lanes observed by the last recorded tick.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Lane</th><th scope="col">Ready</th><th scope="col">Parked</th>
                <th scope="col">Running</th><th scope="col">Merges/h</th><th scope="col">Oldest wait</th>
              </tr>
            </thead>
            <tbody>
              {[...board.lanes].sort((a, b) => a.lane.localeCompare(b.lane)).map((lane) => (
                <tr key={lane.lane}>
                  <td className={styles.mono}>{lane.lane}</td>
                  <td className={styles.numeric}>{num(lane.ready)}</td>
                  <td className={styles.numeric}>{num(lane.parked)}</td>
                  <td className={styles.numeric}>{num(lane.running)}</td>
                  <td className={styles.numeric}>{num(lane.mergesLastHour)}</td>
                  <td className={styles.numeric}>{formatWait(lane.oldestWaitSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={styles.section} aria-labelledby="fb-needs">
        <h3 id="fb-needs" className={styles.sectionTitle}>Needs Mason</h3>
        {needs.status === 'missing' ? (
          <p className={styles.note}>NEEDS-MASON.md not found — nothing has been recorded as needing Mason.</p>
        ) : needs.status === 'unavailable' ? (
          <p className={styles.note}>The needs-Mason file could not be read — open items may exist.</p>
        ) : needs.items.length === 0 ? (
          <p className={styles.note}>Nothing needs Mason right now.</p>
        ) : (
          <ul className={styles.needs}>
            {needs.items.map((item) => (
              <li key={item.id} className={styles.need}>
                <span className={styles.needId}>{item.id}</span>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className={styles.sources}>
        ready.tsv {board.sources.readyTsv} · queue counts {board.sources.queueCounts} · needs-mason {board.sources.needsMason}
      </footer>
    </>
  );
}

export function FleetBoardPane({ visible }: PaneProps) {
  const query = useQuery(fleetBoardQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(fleetBoardQuery);
  // The file only moves once per Leader tick — a slow visibility-gated poll
  // keeps the pane honest on surfaces without the fleet-board SSE event.
  usePollWhileVisible(refetch, 15_000, { enabled: visible });

  const response = query.data;
  const board = response?.board ?? null;

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <h2 className={styles.title}>Fleet Board</h2>
        {board ? (
          <span className={styles.freshness} title={`Recorded ${board.generatedAt}`}>
            Recorded {formatAge(response?.ageSeconds ?? null)}
          </span>
        ) : null}
      </header>

      <CoordAnswerStrip visible={visible} />

      {query.status === 'loading' || query.status === 'idle' ? (
        <>
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
          <p>
            The Leader records a board each tick to coordination/leader-board.json — nothing has been written yet.
          </p>
        </div>
      ) : (
        <BoardBody board={board} />
      )}

      <WorkBoardSection visible={visible} />
    </div>
  );
}

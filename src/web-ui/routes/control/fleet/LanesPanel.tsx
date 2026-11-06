/**
 * routes/control/fleet/LanesPanel.tsx — RQ-PHANTOM-ENG-CONSOLE: the
 * per-lane engineering console (GET /api/fleet/lanes → fleet.lanes.v1).
 *
 * One row per router lane: credit left (budget ledger / usage journal),
 * ready-queue depth and live jobs (ready.tsv / queue.v1.json), and merges
 * per hour over the trailing window (jobs.jsonl). Every cell may be null —
 * the backend reports per-source health in `sources`, so a missing queue
 * directory renders honest "—" cells plus the source line, never invented
 * zeros.
 */
import { fleetLanesQuery } from '../../../data/queries.js';
import { useQuery } from '../../../data/hooks.js';
import type { FleetLaneSnapshot, FleetLaneView } from '../../../data/api-types.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { readFailureReason } from '../../../data/client.js';
import styles from './LanesPanel.module.css';

function formatReset(resetAt: string | null): string {
  if (!resetAt) return '—';
  const diffMs = Date.parse(resetAt) - Date.now();
  if (!Number.isFinite(diffMs)) return resetAt;
  if (diffMs <= 0) return 'now';
  const m = Math.floor(diffMs / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function formatBurn(view: FleetLaneView): string {
  const burn = view.credit.burnPerHour;
  if (burn === null) return '—';
  const unit = view.credit.creditsUnit === 'acus' ? ' ACU'
    : view.credit.creditsUnit === 'credits' ? ' cr'
    : view.credit.creditsUnit === 'capacity' ? ' cap' : '%';
  return `${(Math.round(burn * 100) / 100).toString()}${unit}/h`;
}

function cell(value: number | null): string {
  return value === null ? '—' : String(value);
}

function sourceSummary(snapshot: FleetLaneSnapshot): string {
  const s = snapshot.sources;
  const detail = (src: { state: string }, text: string): string =>
    src.state === 'healthy' || src.state === 'degraded' ? `${src.state} (${text})` : src.state;
  return [
    `ready.tsv ${detail(s.queue, `${s.queue.rows} rows`)}`,
    `queue.v1.json ${detail(s.queueState, `${s.queueState.jobs} jobs`)}`,
    `jobs.jsonl ${detail(s.ledger, `${s.ledger.events} events`)}`,
    `usage ${s.usage.state}${s.usage.pools ? ` (${s.usage.pools} pools)` : ''}`,
    `budgets ${s.budgets.state}`,
  ].join(' · ');
}

function LaneRow({ lane }: { lane: FleetLaneView }) {
  const credit = lane.credit;
  const known = credit.state === 'observed' || credit.state === 'reset-pending';
  return (
    <tr>
      <th scope="row" className={styles.lane}>{lane.lane}</th>
      <td>
        <span data-credit={credit.state}>{known ? credit.label : 'unknown'}</span>
        {credit.state === 'reset-pending' ? <small> · reset pending</small> : null}
      </td>
      <td className={styles.numeric}>{formatBurn(lane)}</td>
      <td className={styles.numeric}>{formatReset(credit.resetAt)}</td>
      <td className={styles.numeric}>{cell(lane.queueDepth)}</td>
      <td className={styles.numeric}>{cell(lane.liveJobs)}</td>
      <td className={styles.numeric}>{lane.mergesPerHour === null ? '—' : lane.mergesPerHour.toString()}</td>
    </tr>
  );
}

export function LanesPanel() {
  const query = useQuery(fleetLanesQuery);
  const snapshot = query.data;
  const lanes = snapshot?.lanes ?? [];

  return (
    <section className={styles.section} aria-label="Engineering lanes">
      <h2 className={styles.sectionTitle}>Engineering lanes</h2>
      {query.status === 'loading' && !snapshot ? (
        <SkeletonLine width="70%" />
      ) : query.status === 'error' && !snapshot ? (
        <p className={styles.error} role="alert">
          {readFailureReason(query.error)}
        </p>
      ) : snapshot ? (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.caption}>
                Per-lane credit, ready queue, live jobs and merges per hour.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Lane</th>
                  <th scope="col">Credit left</th>
                  <th scope="col">Burn</th>
                  <th scope="col">Resets</th>
                  <th scope="col">Queue</th>
                  <th scope="col">Live</th>
                  <th scope="col">Merges/h</th>
                </tr>
              </thead>
              <tbody>
                {lanes.length === 0 ? (
                  <tr>
                    <td colSpan={7} className={styles.empty}>
                      No lanes observed — every source is missing or empty.
                    </td>
                  </tr>
                ) : (
                  lanes.map((lane) => <LaneRow key={lane.lane} lane={lane} />)
                )}
              </tbody>
            </table>
          </div>
          <p className={styles.sources}>
            sources: {snapshot.sources ? sourceSummary(snapshot) : 'unknown'}
          </p>
        </>
      ) : null}
    </section>
  );
}

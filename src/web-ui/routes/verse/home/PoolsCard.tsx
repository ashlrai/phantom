/** Home's resource bar. Home and phone share the existing phm pool runway JSON; missing readings stay unknown.
 * One tile per pool: the provider's mark and the pool's name, the share left as the figure, how long it lasts and when it resets,
 * how it ends its window at the measured burn, and a bar along the tile's bottom edge split the same way (hatched for an unread pool, never empty).
 * A tile opens that pool's running jobs and the runway's advice for it under the bar. */
import { useId, useState } from 'react';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { isRunwaySnapshot, type PoolRunway, type RunwaySnapshot } from '../../../../core/usage/runway.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { JOB_ID_RE } from '../fleet-job-log/job-id.js';
import { fleetRunsQuery } from '../mobile/runs-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { PoolEndingBar, PoolEndingKey } from './PoolEndingBar.js';
import { endingSummary, poolEnding, poolHours as hours } from './pool-ending-model.js';
import ending from './pool-ending.module.css';
import styles from './home.module.css';
import bar from './pools-card.module.css';

export const poolsQuery: QueryDef<RunwaySnapshot> = { key: 'home-pool-runway', fetch: async signal => {
  const raw = await apiGet<unknown>('/api/usage/runway', signal);
  if (!isRunwaySnapshot(raw)) throw new Error('Pool readings unavailable.');
  return raw;
} };
/** Local has no quota window: no share left, no reset, no bar. */
const LOCAL = 'codex-local';
const POOLS = [['claude', 'Claude'], ['codex-personal', 'Personal Codex'], ['codex-cmp', 'CMP Codex'], ['zai', 'Z.ai'],
  ['grok', 'Grok'], ['devin', 'Devin'], [LOCAL, 'Local'], ['claude-api', 'Claude API gift']] as const;
type PoolName = readonly [pool: string, name: string];
const measured = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export interface PoolParts {
  /** Whole percent left in the window; null when there is no usage reading. */
  leftPercent: number | null;
  runway: string;
  reset: string;
  /** At the measured burn the pool is empty before it resets. */
  early: boolean;
}
/** One pool's reading in three plain parts. Nothing is inferred: a missing reading is the word unknown. */
export function poolParts(row?: PoolRunway): PoolParts {
  const used = row?.usedPercent, empty = row?.hoursToEmpty, reset = row?.hoursToReset;
  return {
    leftPercent: measured(used) ? Math.max(0, Math.round(100 - used)) : null,
    runway: measured(used) && used >= 100 ? 'used up' : measured(empty) ? `runs out in about ${hours(empty)}`
      : row?.burnPerHour === 0 ? 'nothing using it' : 'runway unknown',
    reset: measured(reset) ? `resets in ${hours(reset)}` : 'reset unknown',
    early: measured(empty) && measured(reset) && empty < reset,
  };
}
export function poolLine(row?: PoolRunway): { text: string; early: boolean } {
  const parts = poolParts(row);
  return { text: `${parts.leftPercent === null ? 'usage unknown' : `${parts.leftPercent}% left`}, ${parts.runway}, ${parts.reset}`, early: parts.early };
}

const clockTime = (iso: string): string | null => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
/** The line under the title: which pools will not last, how many have no reading, the soonest reset and when the readings were taken.
 *  Counts only the pools on the bar that have a window (not Local). */
export function poolsSummary(snapshot: RunwaySnapshot, pools: readonly PoolName[], timeOf: (iso: string) => string | null = clockTime): string[] {
  const rows = pools.filter(([pool]) => pool !== LOCAL).map(([pool, name]) => ({ name, row: snapshot.pools.find(row => row.pool === pool) }));
  const known = rows.filter(({ row }) => measured(row?.usedPercent));
  const early = rows.filter(({ row }) => poolParts(row).early);
  const out: string[] = [];
  if (known.length === 0) out.push('No pool has a usage reading');
  else {
    out.push(early.length === 0 ? 'Every measured pool lasts to its reset' : early.length === 1 ? `${early[0]!.name} will not last to its reset` : `${early.length} will not last to their reset`);
    if (known.length < rows.length) out.push(`${rows.length - known.length} without a usage reading`);
  }
  let next: { name: string; hours: number } | null = null;
  for (const { name, row } of rows) {
    const reset = row?.hoursToReset;
    if (measured(reset) && reset > 0 && (next === null || reset < next.hours)) next = { name, hours: reset };
  }
  out.push(next ? `Next reset: ${next.name} in ${hours(next.hours)}` : 'Next reset unknown');
  const at = snapshot.asOf === null ? null : timeOf(snapshot.asOf);
  out.push(at ? `Read ${at}` : 'Read time unknown');
  return out;
}

export function PoolsCard({ visible = true, onOpenJob, onOpenPools }: {
  visible?: boolean; onOpenJob: (job: string) => void;
  /** Opens the full Pools board. Home passes it; the phone has no dock, so it leaves it out and gets no button. */
  onOpenPools?: () => void;
}) {
  const id = useId();
  const [selected, select] = useState<string | null>(null);
  const read = useQuery(poolsQuery, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(poolsQuery);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const jobs = useQuery(fleetRunsQuery, { enabled: visible && selected !== null, freshMs: 0 });
  const refreshJobs = useRefetch(fleetRunsQuery);
  usePollWhileVisible(refreshJobs, 15_000, { enabled: visible && selected !== null });
  const snapshot = read.status !== 'error' && isRunwaySnapshot(read.data) ? read.data : null;
  const rows: PoolName[] = [...POOLS, ...(snapshot?.pools.filter(row => !POOLS.some(([pool]) => pool === row.pool)).map(row => [row.pool, row.pool] as const) ?? [])];
  const selectedName = rows.find(([pool]) => pool === selected)?.[1] ?? null;
  const workers = jobs.data?.workers?.filter(worker => worker.lane === selected) ?? [];
  // The runway's own sentence for the open pool. Local has no window, so there is none to give.
  const advice = selected === null || selected === LOCAL ? '' : snapshot?.pools.find(row => row.pool === selected)?.advice ?? '';
  return <section className={styles.card} aria-label="Pools"><h3>Pools</h3>
    {snapshot ? <div className={bar.summary}>{poolsSummary(snapshot, rows).map(part => <span key={part}>{part}</span>)}</div> : null}
    {read.status === 'error' ? <p role="status">Pool readings unavailable; usage and times are unknown.</p> : null}
    <ul className={bar.tiles}>{rows.map(([pool, name]) => {
      const local = pool === LOCAL;
      const reading = snapshot?.pools.find(row => row.pool === pool);
      const parts = poolParts(reading);
      const end = poolEnding(reading);
      const open = selected === pool;
      return <li key={pool} className={bar.tile} data-selected={open || undefined}>
        {/* The label is the whole reading in one sentence; the tile lays the same words out for the eye. */}
        <button type="button" className={bar.pool} data-warn={(!local && parts.early) || undefined}
          aria-label={`${name}: ${local ? 'free, limited by memory' : poolLine(reading).text}`}
          aria-expanded={open} aria-controls={open ? `${id}-jobs` : undefined} onClick={() => select(open ? null : pool)}>
          <span className={bar.who}><ProviderBadge of={pool} iconOnly size={14} /><span className={bar.name}>{name}</span></span>
          {local ? <span className={bar.figure}>free</span>
            : parts.leftPercent === null ? <span className={bar.figure} data-unknown>usage unknown</span>
              : <span className={bar.figure}>{parts.leftPercent}%<span className={bar.unit}>left</span></span>}
          <span className={bar.detail} data-runway>{local ? 'limited by memory' : parts.runway}</span>
          {local ? null : <span className={bar.detail}>{parts.reset}</span>}
          {/* How the window ends at this burn, in the server's own verdict; an unread pool has nothing more to say. */}
          {local || end.words === null ? null : <span className={bar.detail} data-ending={end.kind}>{end.words}</span>}
        </button>
        {local ? null : <PoolEndingBar name={name} ending={end} />}
      </li>;
    })}</ul>
    {snapshot ? <PoolEndingKey summary={endingSummary(rows.filter(([pool]) => pool !== LOCAL).map(([pool]) => snapshot.pools.find(row => row.pool === pool)))} /> : null}
    {selected !== null && selectedName !== null ? <div id={`${id}-jobs`} role="region" aria-label={`${selectedName} running jobs`} className={bar.jobs}>
      {advice ? <p className={ending.advice}>Runway advice: {advice}</p> : null}
      <span className={bar.jobsTitle}>Running on {selectedName}</span>
      {jobs.status === 'error' || (jobs.data && !Array.isArray(jobs.data.workers)) ? <p>Running jobs unknown.</p> : !jobs.data ? <p>Reading jobs…</p> : workers.length === 0 ? <p>No running jobs.</p>
        : <ul className={bar.jobList}>{workers.map(worker => <li key={worker.job}><button type="button" className={styles.action}
          disabled={!JOB_ID_RE.test(worker.job)} onClick={() => onOpenJob(worker.job)}>{worker.job}</button></li>)}</ul>}
    </div> : <span className={bar.hint}>Choose a pool to see its running jobs.</span>}
    {onOpenPools ? <button type="button" className={styles.action} onClick={onOpenPools}>Open Pools</button> : null}
  </section>;
}

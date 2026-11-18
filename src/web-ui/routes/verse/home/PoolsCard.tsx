/** Home and phone share the existing phm pool runway JSON; missing readings stay unknown. */
import { useId, useState } from 'react';
import { isRunwaySnapshot, type PoolRunway, type RunwaySnapshot } from '../../../../core/usage/runway.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { JOB_ID_RE } from '../fleet-job-log/job-id.js';
import { fleetRunsQuery } from '../mobile/runs-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './home.module.css';

export const poolsQuery: QueryDef<RunwaySnapshot> = { key: 'home-pool-runway', fetch: async signal => {
  const raw = await apiGet<unknown>('/api/usage/runway', signal);
  if (!isRunwaySnapshot(raw)) throw new Error('Pool readings unavailable.');
  return raw;
} };
const POOLS = [['claude', 'Claude'], ['codex-personal', 'Personal Codex'], ['codex-cmp', 'CMP Codex'], ['zai', 'Z.ai'],
  ['grok', 'Grok'], ['devin', 'Devin'], ['codex-local', 'Local'], ['claude-api', 'Claude API gift']] as const;
const measured = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const hours = (n: number) => n < 1 ? `${Math.max(1, Math.round(n * 60))} min` : `${Math.round(n)} h`;
export function poolLine(row?: PoolRunway): { text: string; early: boolean } {
  const used = row?.usedPercent, empty = row?.hoursToEmpty, reset = row?.hoursToReset;
  const early = measured(empty) && measured(reset) && empty < reset;
  const left = measured(used) ? `${Math.max(0, Math.round(100 - used))}% left` : 'usage unknown';
  const runway = measured(used) && used >= 100 ? 'used up' : measured(empty) ? `runs out in about ${hours(empty)}`
    : row?.burnPerHour === 0 ? 'nothing using it' : 'runway unknown';
  return { text: `${left}, ${runway}, ${measured(reset) ? `resets in ${hours(reset)}` : 'reset unknown'}`, early };
}

export function PoolsCard({ visible = true, onOpenJob }: { visible?: boolean; onOpenJob: (job: string) => void }) {
  const id = useId();
  const [selected, select] = useState<string | null>(null);
  const read = useQuery(poolsQuery, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(poolsQuery);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const jobs = useQuery(fleetRunsQuery, { enabled: visible && selected !== null, freshMs: 0 });
  const refreshJobs = useRefetch(fleetRunsQuery);
  usePollWhileVisible(refreshJobs, 15_000, { enabled: visible && selected !== null });
  const snapshot = read.status !== 'error' && isRunwaySnapshot(read.data) ? read.data : null;
  const rows = [...POOLS, ...(snapshot?.pools.filter(row => !POOLS.some(([pool]) => pool === row.pool)).map(row => [row.pool, row.pool] as const) ?? [])];
  return <section className={styles.card} aria-label="Pools"><h3>Pools</h3><p>Choose a pool to see its running jobs.</p>
    {read.status === 'error' ? <p role="status">Pool readings unavailable; usage and times are unknown.</p> : null}
    <ul>{rows.map(([pool, name]) => {
      const line = poolLine(snapshot?.pools.find(row => row.pool === pool));
      const workers = jobs.data?.workers?.filter(worker => worker.lane === pool) ?? [];
      return <li key={pool}><button type="button" className={styles.poolAction} data-warn={line.early || undefined}
        aria-expanded={selected === pool} aria-controls={`${id}-${pool}`} onClick={() => select(selected === pool ? null : pool)}>
        {name}: {pool === 'codex-local' ? 'free, limited by memory' : line.text}</button>
        {selected === pool ? <div id={`${id}-${pool}`} role="region" aria-label={`${name} running jobs`}>
          {jobs.status === 'error' ? <p>Running jobs unknown.</p> : !jobs.data ? <p>Reading jobs…</p> : workers.length === 0 ? <p>No running jobs.</p>
            : <ul>{workers.map(worker => <li key={worker.job}><button type="button" className={styles.action}
              disabled={!JOB_ID_RE.test(worker.job)} onClick={() => onOpenJob(worker.job)}>{worker.job}</button></li>)}</ul>}
        </div> : null}</li>;
    })}</ul>
  </section>;
}

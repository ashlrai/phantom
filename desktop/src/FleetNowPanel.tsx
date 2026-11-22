import { useId } from 'react';
import type { CompactLeaderBrief } from '../../src/core/fleet/leader-compact-brief.js';
import { apiGet } from '../../src/web-ui/data/client.js';
import { useQuery, useRefetch } from '../../src/web-ui/data/hooks.js';
import type { QueryDef } from '../../src/web-ui/data/queries.js';
import { usePollWhileVisible } from '../../src/web-ui/routes/verse/shell/section-visibility.js';
import styles from './FleetNowPanel.module.css';

export const fleetNowQuery: QueryDef<CompactLeaderBrief | { state: 'no data' }> = {
  key: 'verse-fleet-now', fetch: signal => apiGet('/api/verse/fleet/runs/leader-brief', signal),
};
const count = (n: number | null) => n === null ? 'unknown' : String(n);
const pct = (n: number | null) => n === null ? 'spend unknown' : `${n.toFixed(0)}% used`;
const pace = (p: CompactLeaderBrief['pools'][number]) => p.verdict === 'over' ? 'spending too fast'
  : p.verdict === 'ok' ? p.burnPerHour === 0 ? 'unused' : 'on pace' : 'pace unknown';

export function FleetNowPanel({ visible = true }: { visible?: boolean }) {
  const id = useId(), read = useQuery(fleetNowQuery, { enabled: visible, freshMs: 30_000 });
  const refresh = useRefetch(fleetNowQuery);
  usePollWhileVisible(refresh, 30_000, { enabled: visible });
  const b = read.data && 'lanes' in read.data && read.data.schema === 'leader.compact-brief.v1' && read.data.state === 'ready' ? read.data : null;
  return <article className={styles.panel} aria-labelledby={id}>
    <h2 id={id}>Fleet now</h2>
    {!b ? <p>{read.status === 'error' ? 'Fleet brief could not be read.' : 'No fleet data yet.'}</p> : <>
      <p>{b.headline ?? 'Running job counts are missing.'}</p>
      <p className={styles.updated}>{read.status === 'error' ? 'Could not refresh; showing the last reading. ' : ''}
        Updated <time dateTime={b.at}>{new Date(b.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
        {b.omitted ? ` · ${b.omitted} readings omitted.` : ''}</p>
      <div className={styles.grid}>
        <div><h3>Lanes</h3>{!b.lanes.length ? <p>Lane readings are missing.</p> : b.lanes.map(l => <div key={l.lane}>
          <p>{l.lane}: {count(l.running)} running / {count(l.target)} target · {count(l.queued)} queued{l.held ? ' · held' : ''}</p>
          {l.running !== null && l.target !== null && l.target > 0 ? <meter aria-label={`${l.lane} running of target`} min={0} max={l.target} value={Math.min(l.running, l.target)} /> : <p>Lane target or running count is missing.</p>}
        </div>)}</div>
        <div><h3>Pool spend</h3>{!b.pools.length ? <p>Pool readings are missing.</p> : b.pools.map(p => <p key={p.pool}>
          {p.pool}: {pct(p.usedPct)} · {p.hoursToReset === null ? 'reset time unknown' : `resets in ${Math.max(0, p.hoursToReset).toFixed(1)} h`} · {pace(p)}
        </p>)}</div>
        <div><h3>Main health</h3>{!b.main.length ? <p>Main health readings are missing.</p> : b.main.map(m => <p key={m.repo} data-health={m.stale ? 'unknown' : m.state}>
          {m.repo}: {m.stale ? 'unknown; reading is old' : m.state === 'unknown' ? 'health unknown' : m.state}
        </p>)}</div>
        <div><h3>Last 5 merged PRs</h3>{!b.mergedPrs?.length ? <p>{b.sources.ledger === 'healthy' && b.mergedPrs ? 'No merged PRs recorded.' : 'Recent merge readings are missing.'}</p>
          : <ol>{b.mergedPrs.slice(0, 5).map(pr => <li key={pr.url}>{/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pr.url)
            ? <a href={pr.url} target="_blank" rel="noopener noreferrer">{pr.repo} #{pr.number}{pr.title ? ` · ${pr.title}` : ''}</a> : <span>{pr.repo} #{pr.number}</span>}</li>)}</ol>}</div>
      </div>
    </>}
  </article>;
}

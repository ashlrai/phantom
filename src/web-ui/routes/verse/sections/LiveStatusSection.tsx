import type { FleetDoctorReport } from '../../../../cli/fleet-doctor.js';
import { useEffect } from 'react';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch, warmQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { ResourceView } from '../../../../core/fabric/resource-view.js';
import type { MergePaceReport } from '../../../../core/fleet/merge-pace.js';
import type { LandedClosesReport } from '../../../../core/fleet/landed-closes-read.js';
import { projectLiveStatus } from '../../../../core/fleet/live-status.js';
import { safeHref } from '../cloud/cloud-model.js';

type SlowPrsReport = { known?: boolean; repos?: { repo: string; count: number; urls: string[] }[] };
type LiveHome = ReturnType<typeof projectLiveStatus> & { mergePace?: MergePaceReport | null; landedCloses?: LandedClosesReport | null; slowPrs?: SlowPrsReport | null; doctor: FleetDoctorReport | null };
const mergeMinutes = (s: number | null) => s === null ? 'unknown' : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;

const query: QueryDef<LiveHome> = {
  key: 'verse-live-home',
  fetch: async signal => {
    const [live, resources, mergePace, landedCloses, slowPrs, doctor] = await Promise.all([
      apiGet<FleetLiveSnapshotV1>('/api/verse/fleet/live', signal),
      apiGet<ResourceView>('/api/resource', signal),
      // A merge-pace failure is unknown, never a blank view.
      apiGet<MergePaceReport>('/api/verse/fleet/merge-pace', signal).catch(() => null),
      apiGet<LandedClosesReport>('/api/verse/fleet/landed-closes', signal).catch(() => null),
      apiGet<SlowPrsReport>('/api/verse/fleet/slow-prs', signal).catch(() => null),
      apiGet<FleetDoctorReport>('/api/verse/fleet/doctor', signal).catch(() => null),
    ]);
    return { ...projectLiveStatus(live, resources), mergePace, landedCloses, slowPrs, doctor };
  },
};
/** Called by app/verse-first-paint.ts once the session exists, while the shell is still mounting. */
export function warmOpeningData(): void {
  warmQuery(query);
}
export function LiveStatusSection() {
  const result = useQuery(query);
  const refresh = useRefetch(query);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const data = result.data;
  return <section aria-label="Live fleet" style={{ padding: 24, overflow: 'auto' }}>
    <h1>Live fleet</h1>
    <button onClick={refresh}>Refresh</button>
    {result.status === 'error' && <p role="alert">Live status unavailable. Retry with Refresh. Previous readings may be stale.</p>}
    {!data ? <p role="status">Loading live status…</p> : <>
      <p>{data.state} · {data.reason} · Updated <time dateTime={data.generatedAt}>{new Date(data.generatedAt).toLocaleString()}</time></p>
      {data.summary && <p>Running: {data.summary.building ?? 'unknown'} · Queued: {data.summary.queued ?? 'unknown'} · Parked: {data.summary.parked ?? 'unknown'}</p>}
      <h2>Lanes</h2>
      {!data.lanes ? <p>Lane readings unavailable</p> : <ul>{data.lanes.map(row => <li key={row.lane}>{row.lane}: {row.busy} busy / {row.slots} slots{row.capReason ? ` · ${row.capReason}` : ''}</li>)}{!data.lanes.length && <li>None recorded</li>}</ul>}
      <h2>Repositories</h2>
      {!data.repos ? <p>Repository readings unavailable</p> : <ul>{data.repos.map(row => <li key={row.repo}>{row.repo}: {row.openFleetPrs ?? 'unknown'} open fleet PRs · Post-merge green {row.greenPct7d === null ? 'unknown' : `${row.greenPct7d}%`}</li>)}{!data.repos.length && <li>None recorded</li>}</ul>}
      <h2>Fleet health</h2>
      {!data.doctor ? <p>Unknown</p> : data.doctor.level === 'ok' ? <p>All checks ok</p> : <ul>{[...(data.doctor.checks ?? [])]
        .sort((a, b) => ({ red: 0, warn: 1, ok: 2 }[a.level] - { red: 0, warn: 1, ok: 2 }[b.level]))
        .map(check => <li key={check.name} style={check.level === 'red' ? { color: '#b3261e' } : undefined}>{`${check.level} ${check.name}: ${check.reason}`}</li>)}</ul>}
      <h2>Running</h2>
      {data.running === null ? <p>Unknown</p> : <ul>{data.running.map(run => <li key={run.id}>{run.repo}: {run.title} · {run.phase}</li>)}{!data.running.length && <li>None</li>}</ul>}
      <h2>Merged (24h)</h2>
      {data.merged === null ? <p>Unknown</p> : <ul>{data.merged.map(row => <li key={row.id}>{row.repo} #{row.prNumber} · {new Date(row.landedAt).toLocaleString()}</li>)}{!data.merged.length && <li>None</li>}</ul>}
      <h2>Merge pace (6h)</h2>
      {data.mergePace === undefined ? null : !data.mergePace?.known || !data.mergePace.rows ? <p>Unknown</p> : <ul>{data.mergePace.rows.map(row => <li key={row.repo}>{row.repo}: {row.merges} merges · {row.merges_per_hour.toFixed(1)}/h · median {mergeMinutes(row.median_ttm_s)}</li>)}</ul>}
      <h2>Slow PRs</h2>
      {data.slowPrs === undefined ? null : !data.slowPrs?.known || !data.slowPrs.repos ? <p>Unknown</p> : !data.slowPrs.repos.length ? <p>None open over 30 min.</p> : <ul>{data.slowPrs.repos.map(group => <li key={group.repo}>{group.repo}: {group.count} open over 30 min{group.urls.slice(0, 10).map(url => {
        const number = /\/pull\/(\d+)$/.exec(url)?.[1];
        const href = safeHref(url, 'github.com');
        return number && href ? <span key={url}> <a href={href} target="_blank" rel="noopener noreferrer">#{number}</a></span> : null;
      })}{group.urls.length > 10 ? ` +${group.urls.length - 10} more` : ''}</li>)}</ul>}
      <h2>Stale PRs cleared (24h)</h2>
      {data.landedCloses === undefined ? null : !data.landedCloses?.known || !data.landedCloses.rows ? <p>Unknown</p> : <>
        <p>{data.landedCloses.closed} closed · {data.landedCloses.skipped} skipped · {data.landedCloses.failed} failed</p>
        <ul>{data.landedCloses.rows.map(row => <li key={`${row.pr}-${row.at}`} style={row.outcome === 'failed' ? { color: '#b3261e' } : undefined}>#{row.pr} · {row.outcome} · {new Date(row.at).toLocaleString()}{row.outcome !== 'closed' && row.reason ? ` · ${row.reason}` : ''}</li>)}</ul>
      </>}
      <h2>Blocked</h2>
      {data.blocked === null ? <p>Unknown</p> : <ul>{data.blocked.map((row, index) => <li key={index}>{row.repo}: {row.reason} · Until {row.until ?? 'cleared'}</li>)}{!data.blocked.length && <li>None recorded</li>}</ul>}
      <h2>Spent</h2>
      <ul>{data.spent.map(row => <li key={row.pool}>{row.pool}: {row.pctUsed === null ? 'unknown' : `${row.pctUsed}% used`} · Reset {row.resetAt ? new Date(row.resetAt).toLocaleString() : 'unknown'}</li>)}</ul>
    </>}
  </section>;
}

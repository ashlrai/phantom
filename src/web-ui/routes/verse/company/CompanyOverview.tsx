import type { CompanyOrgView } from '../../../../core/org/company-view.js';
import type { FleetSessionsV1 } from '../../../data/api-types.js';
import type { QueryEntry } from '../../../data/cache.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { fleetSessionsQuery, type QueryDef } from '../../../data/queries.js';
import { fleetLiveQuery } from '../command/surface-data.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { recordedAt } from './company-model.js';
import styles from './company.module.css';

const count = (value: unknown): string => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : 'unknown';
const etDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric' });
function isToday(value: unknown): boolean {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  const now = Date.now();
  return Number.isFinite(time) && time <= now && etDay.format(time) === etDay.format(now);
}
const orgQuery: QueryDef<CompanyOrgView> = {
  key: 'company-org', fetch: async signal => {
    const value = await apiGet<CompanyOrgView>('/api/verse/fleet/control/org', signal);
    if (!value || value.schema !== 'company.org.v1' || !value.sources ||
      !['available', 'missing', 'unavailable', 'invalid'].includes(value.sources.org) ||
      !['available', 'missing', 'unavailable', 'invalid'].includes(value.sources.joins)) throw new Error('Unsupported organization observation');
    return value;
  },
};

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className={styles.overviewTile}><dt>{label}</dt><dd>{value}</dd><small>{note}</small></div>;
}

export function CompanyOverview({ enabled, sessions }: { enabled: boolean; sessions: QueryEntry<FleetSessionsV1> }) {
  const org = useQuery(orgQuery, { enabled });
  const fleet = useQuery(fleetLiveQuery, { enabled });
  const refreshOrg = useRefetch(orgQuery), refreshFleet = useRefetch(fleetLiveQuery), refreshSessions = useRefetch(fleetSessionsQuery);
  usePollWhileVisible(refreshOrg, 15_000, { enabled });
  usePollWhileVisible(refreshFleet, 15_000, { enabled });
  const membership = org.data?.sources.org === 'available';
  const contributions = membership && ['available', 'missing'].includes(org.data!.sources.joins);
  const jobs = sessions.data;
  const running = jobs?.schema === 'fleet.sessions.v1' && jobs.sourceState === 'healthy' ? count(jobs.counts?.running) : 'unknown';
  const live = fleet.data?.available ? fleet.data.value : null;
  const orgNote = `Org metadata · ${recordedAt(org.data?.generatedAt)}`;
  return <section className={styles.panel} aria-label="Company at a glance">
    <header><h3>Company at a glance</h3><button type="button" disabled={!enabled} onClick={() => { refreshOrg(); refreshFleet(); refreshSessions(); }}>Refresh overview</button></header>
    <p>Shared org metadata and fleet totals. Private member activity and account usage stay private.</p>
    <dl className={styles.overview}>
      <Tile label="Members" value={membership ? count(org.data?.members) : 'unknown'} note={orgNote} />
      <Tile label="Contributing members" value={contributions ? count(org.data?.contributingMembers) : 'unknown'} note="Members with a recorded positive lane opt-in" />
      <Tile label="Lanes contributed" value={contributions ? count(org.data?.contributingLanes) : 'unknown'} note="Distinct lanes with a recorded positive opt-in" />
      <Tile label="Fleet jobs running" value={`${running !== 'unknown' && jobs?.truncated ? '≥ ' : ''}${running}`} note={`Shared fleet · ${recordedAt(jobs?.generatedAt)}`} />
      <Tile label="Fleet merges today (ET)" value={isToday(live?.generatedAt) ? count(live?.summary.mergedToday) : 'unknown'} note={`Shared fleet · ${recordedAt(live?.generatedAt)}`} />
    </dl>
    {org.data === undefined && org.status !== 'error' && <p role="status">Loading organization…</p>}
    {org.status === 'error' && <p role="alert">Organization refresh failed.{org.data ? ' Last reading retained; it may be stale.' : ' Membership and contributions are unknown.'}</p>}
    {org.data && !membership && <p>Organization metadata unavailable. No org membership reading; configure org metadata with phm org.</p>}
    {membership && !contributions && <p>Lane opt-in records unavailable; contributions are unknown.</p>}
    {contributions && org.data?.contributingLanes === 0 && <p>No lane contributions recorded. Each member opts in on their own machine with phm org join.</p>}
    {sessions.status === 'error' && <p role="alert">Fleet jobs refresh failed. Any retained reading may be stale.</p>}
    {fleet.data && !fleet.data.available && <p>Fleet merge totals unavailable.</p>}
    {fleet.status === 'error' && <p role="alert">Fleet merge totals refresh failed. Any retained reading may be stale.</p>}
  </section>;
}

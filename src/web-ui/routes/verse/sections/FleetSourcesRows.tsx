import { StatusBadge } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { SettingRow } from './SettingRow.js';
import { readFleetSources } from './fleet-sources-model.js';
import { fleetSourcesQuery } from './fleet-sources-query.js';

export function FleetSourcesRows() {
  const read = useQuery(fleetSourcesQuery);
  const refetch = useRefetch(fleetSourcesQuery);
  usePollWhileVisible(refetch, 15_000);
  if (read.error instanceof ApiError && read.error.status === 404) {
    return <SettingRow label="Live runs not in this build"><StatusBadge status="Not in build" tone="neutral" /></SettingRow>;
  }
  const { rows, freshness, claudeLane } = readFleetSources(read.error ? undefined : read.data, Date.now());
  const freshnessText = freshness.ageSeconds === null ? '—' : freshness.stale ? 'Snapshot stale' : `Snapshot ${freshness.ageSeconds} s old`;
  return <>
    {rows.map(row => <SettingRow key={row.id} label={row.label} description={row.remedy}>
      <StatusBadge status={row.word} tone={row.tone} />
    </SettingRow>)}
    <SettingRow label="Snapshot" description={claudeLane ? `Claude lane: ${claudeLane}` : undefined}>{freshnessText}</SettingRow>
  </>;
}

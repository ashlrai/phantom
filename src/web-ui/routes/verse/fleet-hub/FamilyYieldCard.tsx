import type { FamilyYieldReport } from '../../../../core/fleet/family-yield.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import styles from './fleet-hub.module.css';

export const familyYieldQuery: QueryDef<FamilyYieldReport> = { key: 'fleet-family-yield', fetch: async signal => {
  const report = await apiGet<FamilyYieldReport>('/api/verse/fleet/yield', signal);
  if (report?.schema !== 'fleet.family-yield.v1' || !Array.isArray(report.launch_families)) throw new Error('Yield unavailable');
  return report;
} };

export function FamilyYieldCard({ visible = true }: { visible?: boolean }) {
  const documentVisible = useDocumentVisible();
  const enabled = visible && documentVisible;
  const sectionVisible = useSectionVisible();
  const read = useQuery(familyYieldQuery, { enabled: enabled && sectionVisible, freshMs: 60_000 });
  const refresh = useRefetch(familyYieldQuery);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const report = read.status === 'error' ? null : read.data;
  return <section className={styles.notRunning} aria-label="Launch yield">
    <strong>Launch yield · last 24 hours</strong>
    {!report?.known ? <p>Launch yield unknown{read.status === 'error' ? ': could not refresh' : ''}.</p>
      : !report.launch_families.length ? <p>No launches in the last 24 hours.</p>
        : <><p>Lowest share merged</p><ul>{report.launch_families.slice(0, 5).map(row => <li key={row.family}>{row.sentence}</li>)}</ul></>}
  </section>;
}

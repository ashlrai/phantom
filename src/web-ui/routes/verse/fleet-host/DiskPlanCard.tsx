import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { diskPlanQuery } from './disk-plan-query.js';
import styles from './fleet-host.module.css';

/** The disk plan sentence, as `phm disk --plan` prints it. Read-only: the card never removes anything. */
export function DiskPlanCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(diskPlanQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetch = useRefetch(diskPlanQuery);
  // Folder scans are slow; poll gently.
  usePollWhileVisible(refetch, 300_000, { enabled: visible, refreshOnShow: false });
  const data = read.data;
  if (!data) return null;
  const { report } = data;
  return <section className={styles.section} aria-label="Disk plan" title="GET /api/verse/fleet/memory/disk-plan · phm disk --plan --json">
    <h3 className={styles.title}>Disk plan</h3>
    {read.status === 'error' ? <p className={styles.muted} role="status">Disk plan could not refresh. Showing the last reading.</p> : null}
    <p className={styles.metric} data-tone={report.plan.count > 0 ? 'warn' : 'ok'}>{data.sentence}</p>
    <p className={styles.muted}>
      {report.notSure.length} not sure, kept · {report.unpublished.length} with unpublished work, recover first · reads only, removes nothing
      {data.gaps.length > 0 ? ` · ${data.gaps[0]}` : ''}</p>
  </section>;
}

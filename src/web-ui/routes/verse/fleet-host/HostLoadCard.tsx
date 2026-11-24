import type { HostLoadGroupId } from '../../../../core/fleet/host-load.js';
import { CHART_NEUTRAL, seriesColor } from '../../../components/charts/colors.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { hostLoadQuery } from './host-load-query.js';
import styles from './fleet-host.module.css';

/** One fixed colour per group, so a group keeps its colour between readings. */
const COLOR: Record<HostLoadGroupId, string> = {
  'fleet-workers': seriesColor(0), 'local-models': seriesColor(1), 'desktop-apps': seriesColor(2), system: seriesColor(3), other: CHART_NEUTRAL,
};

/** What is loading this computer: one stacked bar of CPU share by group under the plain-words top line. */
export function HostLoadCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(hostLoadQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetch = useRefetch(hostLoadQuery);
  usePollWhileVisible(refetch, 15_000, { enabled: visible, refreshOnShow: false });
  const report = read.data;
  if (!report) return null;
  const groups = report.groups.filter(group => group.cpuPercent > 0);
  return <section className={styles.section} aria-label="Host">
    <h3 className={styles.title}>Host</h3>
    {read.status === 'error' ? <p className={styles.muted} role="status">Host load could not refresh. Showing the last reading.</p> : null}
    <p className={styles.line}>{report.owners?.summary ?? report.summary}</p>
    {report.owners ? <p className={styles.line}>Next: {report.owners.nextStep}</p> : null}
    {groups.length === 0 ? <p className={styles.muted}>{report.state === 'unknown' ? report.gaps[0] ?? 'Unknown' : 'Nothing is using the processor.'}</p> : <>
      <div className={styles.loadBar} role="img" aria-label={`Processor share: ${groups.map(group => `${group.name} ${Math.round((100 * group.cpuPercent) / report.cpuPercent)}%`).join(', ')}`}>
        {groups.map(group => <span key={group.id} data-group={group.id} title={group.name} style={{ flexGrow: group.cpuPercent, background: COLOR[group.id] ?? CHART_NEUTRAL }} />)}
      </div>
      <ul className={styles.loadLegend}>{groups.map(group => <li className={styles.line} key={group.id}>
        <span className={styles.loadKey} style={{ background: COLOR[group.id] ?? CHART_NEUTRAL }} aria-hidden="true" />
        {group.name}: {group.loadPoints === null ? '' : `${group.loadPoints} load · `}{group.cpuPercent}% CPU · {group.rssMb} MB · {group.processes} processes
        {group.items[0] ? <span className={styles.muted}> · top: {group.items.slice(0, 3).map(row => row.name).join(', ')}</span> : null}
      </li>)}</ul>
      {report.state === 'partial' ? <p className={styles.muted}>{report.gaps[0]}</p> : null}
    </>}
  </section>;
}

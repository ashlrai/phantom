import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { diskRunwayQuery } from './disk-runway-query.js';
import styles from './fleet-host.module.css';

const hours = (h: number) => (h < 10 ? h.toFixed(1) : String(Math.round(h)));

export function DiskRunwayCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(diskRunwayQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetch = useRefetch(diskRunwayQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  const data = read.data;
  if (!data) return null;
  const { forecast, lines } = data;
  const free = forecast.freeGb;
  const rate = forecast.consumptionGbPerHour;
  const tone = free === null ? 'warn' : free < lines.reuseOnlyGb ? 'bad' : 'ok';
  const headline = free === null ? 'Disk: free space unknown' : `Disk: ${Math.round(free)} GB free`;
  const verdict = free === null ? null : free < lines.hardStopGb ? 'no launches'
    : free < lines.reuseOnlyGb ? 'new jobs are held (reuse-only)' : null;
  const h = data.hoursToReuseOnly;
  const runway = free !== null && free < lines.reuseOnlyGb ? null
    : h !== null ? `~${hours(h)} h until new jobs are held`
    : rate !== null && rate <= 0 ? 'not falling' : 'unknown';
  return <section className={styles.section} aria-label="Disk runway">
    <h3 className={styles.title}>Disk runway</h3>
    {read.status === 'error' ? <p className={styles.muted} role="status">Disk runway could not refresh. Showing the last reading.</p> : null}
    <p className={styles.metric} data-tone={tone} data-severe={free !== null && free < lines.hardStopGb ? 'true' : undefined}>
      {headline}{verdict ? ` · ${verdict}` : ''}</p>
    {runway ? <p className={styles.line}>{runway}</p> : null}
    <p className={styles.muted}>
      {forecast.observedFrom && forecast.observedTo ? `Sample window ${forecast.observedFrom} to ${forecast.observedTo}` : 'Sample window unknown'}
      {rate === null ? '' : ` · ${rate.toFixed(1)} GB/h`} · lines {lines.reuseOnlyGb} GB (reuse-only), {lines.hardStopGb} GB (no launches)</p>
  </section>;
}

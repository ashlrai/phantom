import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { parseSurfaceOwners, surfaceOwnerLine, type SurfaceOwnerRow } from './surface-owner-model.js';
import { surfaceOwnerQuery } from './surface-owner-query.js';
import styles from './fleet-host.module.css';

export function SurfaceOwnerBody({ rows }: { rows: SurfaceOwnerRow[] }) {
  return <>
    <h3 className={styles.title}>Owners</h3>
    <p className={styles.muted}>Claims are advisory; landed history never makes an owner.</p>
    {rows.length === 0 ? <p className={styles.muted}>Owners unknown: report unavailable</p> : null}
    <ul className={styles.peerList}>{rows.map((row, i) => <li className={styles.peerRow} key={`${i}:${row.surface}`}>
      <span className={styles.badge}>{row.surface}</span>
      <span>{surfaceOwnerLine(row)}</span>
      {row.lastLanded ? <span className={styles.muted}>
        last landed {row.lastLanded.jobId} {row.lastLanded.pr === null ? 'PR unknown' : `PR #${row.lastLanded.pr}`} {row.lastLanded.date}
      </span> : null}
    </li>)}</ul>
  </>;
}

export function SurfaceOwnerCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(surfaceOwnerQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 60_000 });
  const refetch = useRefetch(surfaceOwnerQuery);
  usePollWhileVisible(refetch, 60_000, { enabled: visible, refreshOnShow: false });
  return <section className={styles.section} aria-label="Owners">
    {read.status === 'error' ? <p className={styles.muted}>Owners unknown: read failed</p>
      : read.data === null ? <p className={styles.muted}>The surface owner API has not landed in this build yet.</p>
      : read.data === undefined ? <p className={styles.muted} role="status">Reading owners…</p>
      : <SurfaceOwnerBody rows={parseSurfaceOwners(read.data)} />}
  </section>;
}

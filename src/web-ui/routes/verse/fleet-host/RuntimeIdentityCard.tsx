import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { formatAge, type RuntimeIdentityView } from './runtime-identity-model.js';
import { runtimeIdentityQuery } from './runtime-identity-query.js';
import styles from './fleet-host.module.css';

export function RuntimeIdentityBody({ view }: { view: RuntimeIdentityView | null }) {
  if (!view) return <p className={styles.muted}>Runtime identity not available on this build</p>;
  const { fleetState: fs } = view;
  return <>
    <dl className={styles.identity}>
      <dt>Host</dt><dd>{view.host} ({view.platform})</dd>
      <dt>Build</dt>
      <dd>{view.installedVersion} installed / {view.sourceVersion} source{' '}
        {view.versionDrift ? <span className={styles.badge} data-tone="warn">drift</span> : null}</dd>
      <dt>Tailnet</dt><dd>{view.tailnetName}</dd>
      <dt>Fleet state</dt>
      <dd>{formatAge(fs.ageSeconds)}{' '}
        {fs.stale === true ? <span className={styles.badge} data-tone="warn">stale</span> : null}
        {fs.stale === 'unknown' ? <span className={styles.muted}>stale: unknown</span> : null}</dd>
    </dl>
    {view.reasons.length ? <ul className={styles.switches}>{view.reasons.map((r, i) =>
      <li className={styles.muted} key={`${i}:${r}`}>{r}</li>)}</ul> : null}
  </>;
}

export function RuntimeIdentityCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(runtimeIdentityQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 30_000 });
  const refetch = useRefetch(runtimeIdentityQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  return <section className={styles.section} aria-label="Runtime">
    <RuntimeIdentityBody view={read.status === 'error' ? null : read.data ?? null} />
  </section>;
}

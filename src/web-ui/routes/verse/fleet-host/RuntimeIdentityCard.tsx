import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { formatRelative } from '../autonomy/format.js';
import { formatAge, type RuntimeIdentityView } from './runtime-identity-model.js';
import { executionLine, type ExecutionLine } from './runtime-execution-line.js';
import { runtimeIdentityQuery } from './runtime-identity-query.js';
import { coordinationLine, runtimeSnapshotQuery, type CoordinationLine } from './runtime-snapshot-query.js';
import { NodeReachList } from '../runtime/NodeReachList.js';
import styles from './fleet-host.module.css';

// 3 poll intervals (30 s each): older than this the reading no longer counts as live.
const STALE_READING_MS = 90_000;
const CLOCK_SKEW_MS = 60_000;

export function RuntimeIdentityBody({ view, coordination, execution, nowMs = Date.now() }: { view: RuntimeIdentityView | null; coordination?: CoordinationLine; execution?: ExecutionLine; nowMs?: number }) {
  if (!view) return <p className={styles.muted}>Runtime identity not available on this build</p>;
  const { fleetState: fs } = view;
  const readMs = Date.parse(view.generatedAt);
  const readValid = !Number.isNaN(readMs);
  const skewed = readValid && readMs - nowMs > CLOCK_SKEW_MS;
  const stale = readValid && nowMs - readMs > STALE_READING_MS;
  const evidence = view.asOf !== 'unknown' && view.asOf !== view.generatedAt && !Number.isNaN(Date.parse(view.asOf));
  return <>
    <dl className={styles.identity}>
      <dt>Read</dt>
      <dd>{readValid ? <time dateTime={view.generatedAt}>{formatRelative(view.generatedAt, nowMs)}</time> : 'unknown'}
        {evidence ? <> · evidence <time dateTime={view.asOf}>{formatRelative(view.asOf, nowMs)}</time></> : null}{' '}
        {skewed ? <span className={styles.badge} data-tone="warn" title="clock skew">stale reading</span>
          : stale ? <span className={styles.badge} data-tone="warn">stale reading</span> : null}</dd>
      <dt>Host</dt><dd>{view.host} ({view.platform})</dd>
      <dt>Build</dt>
      <dd>{view.installedVersion} installed / {view.sourceVersion} source{' '}
        {view.versionDrift ? <span className={styles.badge} data-tone="warn">drift</span> : null}</dd>
      <dt>Tailnet</dt><dd>{view.tailnetName}</dd>
      <dt>Fleet state</dt>
      <dd>{formatAge(fs.ageSeconds)}{' '}
        {fs.stale === true ? <span className={styles.badge} data-tone="warn">stale</span> : null}
        {fs.stale === 'unknown' ? <span className={styles.muted}>stale: unknown</span> : null}</dd>
      {coordination ? <>
        <dt>Coordination</dt>
        <dd className={coordination.tone === 'unknown' ? styles.muted : undefined}>{coordination.text}</dd>
      </> : null}
      {execution ? <>
        <dt>Execution</dt>
        <dd className={execution.tone === 'unknown' ? styles.muted : undefined}
          data-tone={execution.tone === 'warn' ? 'warn' : undefined}>{execution.text}</dd>
      </> : null}
    </dl>
    {view.reasons.length ? <ul className={styles.switches}>{view.reasons.map((r, i) =>
      <li className={styles.muted} key={`${i}:${r}`}>{r}</li>)}</ul> : null}
  </>;
}

export function RuntimeIdentityCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const enabled = visible && sectionVisible && documentVisible;
  const read = useQuery(runtimeIdentityQuery, { enabled, freshMs: 30_000 });
  const refetch = useRefetch(runtimeIdentityQuery);
  const snapshot = useQuery(runtimeSnapshotQuery, { enabled, freshMs: 30_000 });
  const snapshotRefetch = useRefetch(runtimeSnapshotQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  usePollWhileVisible(snapshotRefetch, 30_000, { enabled: visible, refreshOnShow: false });
  return <section className={styles.section} aria-label="Runtime">
    <RuntimeIdentityBody view={read.data ?? null}
      coordination={coordinationLine(snapshot.data, snapshot.error)}
      execution={executionLine(snapshot.data, snapshot.error)} />
    <NodeReachList visible={enabled} />
    {read.status === 'error' && read.data ? <p className={styles.muted}>Last refresh failed</p> : null}
  </section>;
}

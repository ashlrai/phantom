import { StatusBadge } from '../../../components/primitives/index.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { releasePrQuery } from '../fleet/release-pr-query.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { releaseStrip } from './release-strip-model.js';
import styles from './release-strip.module.css';

export function ReleaseStrip({ visible }: { visible: boolean }) {
  const read = useQuery(releasePrQuery, { enabled: visible });
  const refetch = useRefetch(releasePrQuery);
  usePollWhileVisible(refetch, 60_000, { enabled: visible });
  if (read.status === 'error') return <div className={styles.strip} role="status"><StatusBadge status="Release train unavailable" tone="warning" /></div>;
  if (read.data?.kind === 'notInBuild') return null;
  const view = releaseStrip(read.data, Date.now());
  if (!view) return null;
  return <div className={styles.strip} aria-label="Release train">
    <div className={styles.line}><strong>Release train</strong> <StatusBadge status={view.text} tone={view.tone === 'ok' ? 'success' : view.tone} />
      {view.href && <a href={view.href} target="_blank" rel="noopener noreferrer">Open PR</a>}
    </div>
    {view.checks.length > 0 && <details><summary>Checks ({view.checks.length})</summary><ul className={styles.checks}>
      {view.checks.map((check, index) => <li key={`${check.name}:${index}`}>
        {check.url ? <a href={check.url} target="_blank" rel="noopener noreferrer">{check.name}</a> : check.name} · {check.state}
      </li>)}
    </ul></details>}
  </div>;
}

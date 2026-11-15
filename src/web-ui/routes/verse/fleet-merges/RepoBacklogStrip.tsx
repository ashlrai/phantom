import { useMemo } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { repoBacklogView } from './repo-backlog-model.js';
import { repoBacklogQuery } from './repo-backlog-queries.js';
import styles from './release-strip.module.css';

const STATE_TEXT = { ok: '', 'not-enrolled': 'not enrolled', unavailable: 'unavailable' } as const;

/** Read-only open/DIRTY/BEHIND backlog for every enrolled repo. Rows are not clickable: the stuck-PR table below is fixed to Phantom. */
export function RepoBacklogStrip({ visible }: { visible: boolean }) {
  const read = useQuery(repoBacklogQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(repoBacklogQuery);
  usePollWhileVisible(refetch, 120_000, { enabled: visible });
  const view = useMemo(() => read.data ? repoBacklogView(read.data, Date.now()) : null, [read.data]);
  if (!view) return <div className={styles.strip} aria-label="Repo backlog" role="status">{read.status === 'error' ? 'Repo backlog unavailable' : 'Reading repo backlog…'}</div>;
  return <div className={styles.strip} aria-label="Repo backlog">
    <p><strong>Repo backlog</strong> · {view.headline}{read.status === 'error' && ' · refresh failed, showing last reading'}</p>
    {view.rows.length > 0 && <table>
      <thead><tr><th scope="col">Repo</th><th scope="col">Open</th><th scope="col">DIRTY</th><th scope="col">BEHIND</th><th scope="col">Oldest DIRTY</th></tr></thead>
      <tbody>{view.rows.map(row => <tr key={row.repo}>
        <th scope="row">{row.repo}</th>
        {row.state === 'ok' ? <>
          <td>{row.open}</td><td>{row.dirty}</td><td>{row.behind}</td><td>{row.oldestDirtyText}</td>
        </> : <td colSpan={4}>{STATE_TEXT[row.state]}</td>}
      </tr>)}</tbody>
    </table>}
  </div>;
}

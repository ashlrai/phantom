import { useState } from 'react';
import type { IdeasReport } from '../../../../core/fleet/ideas.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { Card, CardNote } from '../command/Surface.js';
import { JobDetailSheet } from '../fleet/JobDetailSheet.js';
import styles from './ideas.module.css';

const query: QueryDef<IdeasReport> = { key: 'ideas', fetch: signal => apiGet<IdeasReport>('/api/ideas', signal) };

export function NextIdeas({ visible }: { visible: boolean }) {
  const result = useQuery(query, { enabled: visible, freshMs: 30_000 });
  const refetch = useRefetch(query);
  usePollWhileVisible(() => { refetch(); }, 30_000, { enabled: visible });
  const [job, setJob] = useState<string | null>(null);
  return <Card title="Next bets">
    {result.data === undefined ? <CardNote>{result.status === 'error' ? 'Could not read ideas.' : 'Loading ideas…'}</CardNote> : <>
      {result.data.missing.length > 0 && <CardNote>Some idea sources are unavailable.</CardNote>}
      {result.data.ideas.length === 0 ? <CardNote>No ideas yet.</CardNote> : <ol className={styles.list}>
        {result.data.ideas.map(idea => <li key={idea.id} className={styles.row}>
          <span className={styles.title}>{idea.goal}</span>
          <span className={styles.meta}>{idea.id} · {idea.repo ?? 'Unknown repo'} · {idea.lane ?? 'Unknown lane'}</span>
          <button type="button" className={styles.toggle} onClick={() => setJob(idea.id)}>Open job</button>
        </li>)}
      </ol>}
    </>}
    {job && <JobDetailSheet job={job} onClose={() => setJob(null)} />}
  </Card>;
}

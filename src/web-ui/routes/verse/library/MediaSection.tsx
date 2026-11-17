import { useEffect } from 'react';
import { useMutationHold, useQuery, useRefetch } from '../../../data/hooks.js';
import { CardNote } from '../command/Surface.js';
import { ThreadScreenshot } from '../leader-thread/ThreadScreenshot.js';
import { leaderFileAge, leaderFileSize } from './library-leader-files-model.js';
import { libraryMediaQuery as query } from './library-queries.js';
import styles from './library.module.css';

export function MediaSection({ visible }: { visible: boolean }) {
  const { hasHold } = useMutationHold();
  const media = useQuery(query, { enabled: visible, freshMs: 30_000 });
  const refetch = useRefetch(query);
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(refetch, 30_000);
    return () => clearInterval(timer);
  }, [visible, refetch]);
  return <section className={styles.section} aria-label="Media">
    <h2>Media</h2>
    {media.error && !media.data ? <CardNote tone="danger">Screenshots are unavailable right now.</CardNote>
      : !media.data ? <CardNote>Loading screenshots…</CardNote>
      : media.data.state === 'unavailable' ? <CardNote tone="danger">Screenshots are unavailable right now.</CardNote>
      : media.data.state === 'absent' ? <CardNote>No screenshot folder yet. Paste one into the Leader box.</CardNote>
      : media.data.items.length === 0 ? <CardNote>No screenshots yet. Paste one into the Leader box.</CardNote>
      : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '1rem' }}>
        {media.data.items.map(item => <div key={item.name}>
          {/* Retry after unlock; discard loaded bytes when the hold expires. */}
          <ThreadScreenshot key={`${item.name}:${hasHold}`} name={item.name} raw={item.name} />
          <p className={styles.meta}>{leaderFileAge(item.modifiedAt, Date.now())} · {leaderFileSize(item.bytes)}</p>
        </div>)}
      </div>}
  </section>;
}

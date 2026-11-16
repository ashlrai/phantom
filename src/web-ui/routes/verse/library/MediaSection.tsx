import { useEffect } from 'react';
import { getMutationToken } from '../../../data/auth-store.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { isRemoteMobileMode } from '../../../data/remote-mode.js';
import { CardNote } from '../command/Surface.js';
import { ThreadScreenshot } from '../leader-thread/ThreadScreenshot.js';
import { leaderFileAge, leaderFileSize } from './library-leader-files-model.js';
import { narrowMedia, type MediaList } from './library-media-model.js';
import styles from './library.module.css';

const query: QueryDef<MediaList> = {
  key: 'verse-leader-attachments',
  fetch: async (signal) => {
    const token = getMutationToken();
    if (!token || isRemoteMobileMode()) throw new Error('Attachments unavailable');
    const response = await fetch('/api/verse/leader/attachments', { credentials: 'same-origin', headers: { 'x-ashlr-token': token }, signal });
    if (!response.ok) throw new Error('Attachments unavailable');
    const body = narrowMedia(await response.json());
    if (!body) throw new Error('Invalid attachments response');
    return body;
  },
};

export function MediaSection({ visible }: { visible: boolean }) {
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
          <ThreadScreenshot name={item.name} raw={item.name} />
          <p className={styles.meta}>{leaderFileAge(item.modifiedAt, Date.now())} · {leaderFileSize(item.bytes)}</p>
        </div>)}
      </div>}
  </section>;
}

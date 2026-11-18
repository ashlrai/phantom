import { useState } from 'react';
import { refetchQuery } from '../../../../data/cache.js';
import { useQuery } from '../../../../data/hooks.js';
import { findLibraryItems, libraryItemsQuery } from '../../library/library-items.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { Button, Screen, SkeletonList } from '../ui.js';
import { ui } from '../ui-parts.js';
import styles from './LibraryScreen.module.css';

export function LibraryScreen() {
  const [search, setSearch] = useState('');
  const data = useQuery(libraryItemsQuery, { freshMs: 30_000 });
  const refresh = () => refetchQuery(libraryItemsQuery.key, () => libraryItemsQuery.fetch(), true);
  usePollWhileVisible(() => { void refresh(); }, 30_000);
  const items = findLibraryItems(data.data ?? [], search);
  return <Screen title="Library" large label="Library" onRefresh={refresh}
    trailing={<Button variant="plain" onClick={() => void refresh()}>Refresh</Button>}>
    <input type="search" className={ui.input} aria-label="Search Library" placeholder="Search Library"
      value={search} onChange={event => setSearch(event.target.value)} />
    {data.error ? <p role="status">Library unavailable. Try Refresh.</p> : null}
    {!data.data && !data.error ? <SkeletonList label="Loading Library" /> : items.length === 0
      ? <p role="status">{search ? 'No matching items.' : 'Your Library is empty.'}</p>
      : <ul className={styles.items} aria-label="Library items">
        {items.map(item => <li key={item.id}>
          <details className={styles.item}>
            <summary><strong>{item.title}</strong><span className={ui.faint}>{item.kind}{item.content === null ? ' · unavailable' : ''}</span></summary>
            <p className={styles.content}>{item.content === null ? 'unavailable' : item.content || 'Empty item.'}</p>
          </details>
        </li>)}
      </ul>}
  </Screen>;
}

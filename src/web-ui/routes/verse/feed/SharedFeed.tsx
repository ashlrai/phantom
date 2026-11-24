/**
 * routes/verse/feed/SharedFeed.tsx — the Feed as `phm feed` sees it: cards built
 * only from GET /api/feed (core/feed.ts), newest first, each with a kind icon, a
 * relative time and one link; a burst of merges is one card with its list one tap away. The kind filter and "Load more" ask the same route
 * again (`kind`, `limit`), so the pane never knows more than the CLI does.
 * Text is untrusted and stays plain.
 */
import { useRef, useState, type MouseEvent } from 'react';
import { FEED_KINDS, FEED_MAX_LIMIT, type FeedGroupEntry, type FeedKind, type FeedReport } from '../../../../core/feed-schema.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { formatRelative } from '../autonomy/format.js';
import { CardNote } from '../command/Surface.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { LeaderBetsCard } from './LeaderBetsCard.js';
import { isSharedFeedReport, sharedLink } from './feed-model.js';
import styles from './feed.module.css';
import compact from '../../../components/layout/compact-view.module.css';

export const FEED_PAGE = 30;
const LABEL: Record<FeedKind, string> = { merged: 'Merged', released: 'Released', failed: 'Failed', lane: 'Lanes', incident: 'Incidents', leader: 'Leader' };
const ICON: Record<FeedKind, string> = { merged: '✓', released: '★', failed: '✕', lane: '⏸', incident: '!', leader: '✎' };
const SOURCE: Record<string, string> = { jobs: 'jobs', events: 'fleet events', leader: 'Leader replies', merges: 'merges', releases: 'releases', main: 'main status' };
const PANE = '/verse/?pane=';

const feedQuery = (kind: FeedKind | 'all', limit: number): QueryDef<FeedReport> => kind === 'all' && limit === FEED_PAGE
  // The default view shares its cache key with the nav badge and the pane's own read.
  ? { key: 'shared-feed', fetch: signal => apiGet<FeedReport>('/api/feed', signal) }
  : { key: `shared-feed:${kind}:${limit}`, fetch: signal => apiGet<FeedReport>(`/api/feed?limit=${limit}${kind === 'all' ? '' : `&kind=${kind}`}`, signal) };

export function SharedFeed({ visible, now, openPane, openJob }: {
  visible: boolean; now: number; openPane: (id: string) => void; openJob: (job: string) => void;
}) {
  const [kind, setKind] = useState<FeedKind | 'all'>('all');
  const [limit, setLimit] = useState(FEED_PAGE);
  const def = feedQuery(kind, limit);
  const read = useQuery(def, { enabled: visible, freshMs: 15_000 });
  usePollWhileVisible(useRefetch(def), 15_000, { enabled: visible && def.key !== 'shared-feed' });
  // Keep the last good list on screen while a new filter or page loads.
  const last = useRef<FeedReport | null>(null);
  if (isSharedFeedReport(read.data)) last.current = read.data;
  const report = last.current;
  if (!report) return <CardNote>Loading the feed…</CardNote>;
  const unknown = Object.entries(report.sources).filter(([, state]) => state === 'unknown').map(([name]) => SOURCE[name] ?? name);
  // Network data: a row with an unknown kind or time is dropped; a link outside the allowlist is not rendered.
  const items = report.items.filter(item => item && Object.hasOwn(LABEL, item.kind) && typeof item.text === 'string'
    && Number.isFinite(Date.parse(item.at)) && typeof item.id === 'string');
  const allDown = unknown.length === Object.keys(report.sources).length && items.length === 0;
  const choose = (next: FeedKind | 'all') => { setKind(next); setLimit(FEED_PAGE); };
  const follow = (event: MouseEvent, href: string, job: string | null) => {
    if (!href.startsWith(PANE)) return;
    event.preventDefault();
    if (job && href === `${PANE}worker-log`) openJob(job); else openPane(href.slice(PANE.length));
  };

  const link = (href: string, text: string, job: string | null) => sharedLink(href)
    ? <a href={href} target={href.startsWith('https://') ? '_blank' : undefined} rel="noopener noreferrer" onClick={event => follow(event, href, job)}>{text}</a>
    : <span>{text}</span>;
  // A burst's list is network data too: only well-formed rows are shown.
  const groupOf = (group: unknown): FeedGroupEntry[] => Array.isArray(group)
    ? group.filter((entry): entry is FeedGroupEntry => Boolean(entry) && typeof entry.text === 'string' && typeof entry.href === 'string') : [];

  return <div className={`${styles.root} ${compact.view}`}>
    <LeaderBetsCard visible={visible} />
    <div className={styles.filters} role="group" aria-label="Filter the feed">
      {(['all', ...FEED_KINDS] as const).map(id => <button key={id} type="button" className={styles.chip} aria-pressed={kind === id} onClick={() => choose(id)}>
        {id === 'all' ? 'All' : LABEL[id]}
      </button>)}
    </div>
    {allDown ? <CardNote tone="unknown">The Feed is unavailable: none of its sources answered. It retries on its own.</CardNote>
      : unknown.length ? <CardNote tone="unknown">Some updates are unavailable: {unknown.join(', ')}. The feed will retry.</CardNote> : null}
    {read.error ? <CardNote tone="unknown">Feed updates could not be refreshed. Showing the last successful read.</CardNote> : null}
    {!allDown && items.length === 0 ? <CardNote>{kind === 'all'
      ? 'Nothing new yet. Merges, releases, failures, lane pauses, incidents and Leader replies appear here.'
      : <>No {LABEL[kind].toLowerCase()} events in the last 7 days. <button type="button" className={styles.dismiss} onClick={() => choose('all')}>Show all</button></>}</CardNote> : null}
    {items.length ? <ol className={styles.list} aria-label="Feed">
      {items.map(item => <li key={item.id} data-kind={item.kind} className={styles.card}>
        <span className={styles.icon} data-kind={item.kind} role="img" aria-label={LABEL[item.kind]}>{ICON[item.kind]}</span>
        <div className={styles.cardBody}>
          {link(item.href, item.text, item.job)}
          {typeof item.detail === 'string' && item.detail ? <span className={styles.meta}>{item.detail}</span> : null}
          <span className={styles.meta}>
            <time dateTime={item.at} title={new Date(item.at).toLocaleString('en-US')}>{formatRelative(item.at, now)}</time>
            {typeof item.count === 'number' && item.count > 1 ? <span> · {item.count} times</span> : null}
          </span>
          {groupOf(item.group).length ? <details className={styles.group}>
            <summary>Show all {groupOf(item.group).length}</summary>
            <ul>{groupOf(item.group).map(entry => <li key={`${entry.href} ${entry.at}`}>{link(entry.href, entry.text, null)}</li>)}</ul>
          </details> : null}
        </div>
      </li>)}
    </ol> : null}
    {report.more && limit < FEED_MAX_LIMIT ? <button type="button" className={styles.more} onClick={() => setLimit(l => Math.min(FEED_MAX_LIMIT, l + FEED_PAGE))}>Load more</button> : null}
  </div>;
}

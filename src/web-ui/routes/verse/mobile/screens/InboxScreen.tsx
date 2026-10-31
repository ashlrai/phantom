/**
 * routes/verse/mobile/screens/InboxScreen.tsx — everything Mason has sent
 * the leaders, from every channel, newest first on the phone.
 *
 *   Reads  GET /api/verse/fleet/runs/inbox?limit=100 — the read route the
 *          Mac landed in #1612 (inbox-read-query.ts). A 404 is "not in
 *          this build yet": its own state, never an error and never a zero.
 *
 * The source chips are built from the sources present and filter
 * client-side — the query already holds the whole page. `sourceState` and
 * `dropped` stay honest on screen, and a long message clamps to six lines
 * behind a "Show more" rather than flooding the list.
 */
import { useId, useState } from 'react';
import { refetchQuery } from '../../../../data/cache.js';
import { readFailureReason } from '../../../../data/client.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import { ago } from '../../command/ladder-model.js';
import { INBOX_NOT_IN_THIS_BUILD, INBOX_READ_LIMIT, inboxReadQuery, type FleetInboxReadEntry } from '../inbox-read-query.js';
import { useMobile } from '../mobile-context.js';
import { cx, Screen, SkeletonList } from '../ui.js';
import { Badge, Banner, EmptyState, ErrorState, ui, type Tone } from '../ui-parts.js';
import styles from './InboxScreen.module.css';

/** Roughly the characters six lines hold in the entry column — the "Show more" cutoff. */
const SIX_LINE_CHARS = 6 * 54;

/** Pull-to-refresh: force the read fresh. */
export function refreshInboxScreen(): Promise<unknown> {
  const query = inboxReadQuery(INBOX_READ_LIMIT);
  return refetchQuery(query.key, () => query.fetch(), true);
}

function priorityTone(priority: string): Tone {
  if (priority === 'P0') return 'danger';
  if (priority === 'P1') return 'warning';
  return 'neutral';
}

/** One entry: the channel, the priority when the sender set one, the time, then the words. */
function InboxEntry({ entry, now }: { entry: FleetInboxReadEntry; now: number }) {
  const textId = useId();
  const [expanded, setExpanded] = useState(false);
  const long = entry.text.split('\n').length > 6 || entry.text.length > SIX_LINE_CHARS;
  // The wire's `at` is wall-clock ET ("2026-10-31 11:59") or a heading the
  // server could not read; only a parseable one earns a dateTime attribute.
  const stamp = Number.isFinite(Date.parse(entry.at)) ? entry.at : undefined;
  return (
    <article className={styles.entry}>
      <header className={styles.entryHead}>
        <Badge>{entry.source}</Badge>
        {entry.priority ? <Badge tone={priorityTone(entry.priority)}>{entry.priority}</Badge> : null}
        <time className={styles.entryTime} dateTime={stamp} title={entry.at}>{ago(entry.at, now)}</time>
      </header>
      <p id={textId} className={cx(styles.entryText, long && !expanded && styles.entryClamped)}>{entry.text}</p>
      {long ? (
        <button type="button" className={cx(ui.btn, ui.plain, styles.moreToggle)} aria-expanded={expanded} aria-controls={textId} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </article>
  );
}

/** The sources present, first-seen order, deduped ignoring case (the server's filter is case-insensitive too). */
function sourcesPresent(entries: readonly FleetInboxReadEntry[]): string[] {
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const entry of entries) {
    const key = entry.source.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(entry.source);
  }
  return sources;
}

export function InboxScreen() {
  const { navigate } = useMobile();
  const query = inboxReadQuery(INBOX_READ_LIMIT);
  const inbox = useQuery(query);
  const refetch = useRefetch(query);
  const [source, setSource] = useState<string | null>(null);

  const data = inbox.data;

  let body;
  if (data === undefined) {
    body = inbox.status === 'error'
      ? <ErrorState title="Couldn’t load the inbox" reason={readFailureReason(inbox.error)} onRetry={refetch} />
      : <SkeletonList rows={4} label="Loading the inbox" />;
  } else if (data === null) {
    body = <ErrorState title={INBOX_NOT_IN_THIS_BUILD} reason="Update Phantom on your Mac to read it here." />;
  } else {
    const now = Date.now();
    const sources = sourcesPresent(data.entries);
    // A chip whose source dropped out of the latest read falls back to All.
    const active = source !== null && sources.some((s) => s.toLowerCase() === source.toLowerCase()) ? source : null;
    const shown = active === null ? data.entries : data.entries.filter((e) => e.source.toLowerCase() === active.toLowerCase());
    body = (
      <>
        {data.sourceState !== 'healthy' ? (
          <Banner>
            {data.sourceState === 'missing'
              ? 'The inbox file is missing on your Mac — this may not be everything.'
              : 'The inbox read is degraded — this may not be everything.'}
          </Banner>
        ) : null}
        {data.entries.length === 0 ? (
          <EmptyState title="Nothing yet." body="Use the box on Live runs." />
        ) : (
          <>
            {sources.length > 1 ? (
              <div className={ui.chips} role="group" aria-label="Filter by source">
                <button type="button" className={ui.chip} aria-pressed={active === null} onClick={() => setSource(null)}>All</button>
                {sources.map((s) => (
                  <button key={s} type="button" className={ui.chip} aria-pressed={active !== null && s.toLowerCase() === active.toLowerCase()} onClick={() => setSource(s)}>{s}</button>
                ))}
              </div>
            ) : null}
            {shown.length === 0 ? <EmptyState title="Nothing from this source." /> : (
              <div className={ui.group}>
                {shown.map((entry, i) => <InboxEntry key={`${entry.at}-${i}`} entry={entry} now={now} />)}
              </div>
            )}
          </>
        )}
        {data.dropped > 0 ? (
          <p className={cx(ui.faint, styles.dropped)}>{data.dropped === 1 ? '1 older entry not shown' : `${data.dropped} older entries not shown`}</p>
        ) : null}
      </>
    );
  }

  return (
    <Screen title="Inbox" onBack={() => navigate({ screen: 'more' })} backLabel="More" onRefresh={refreshInboxScreen} label="Inbox">
      {body}
    </Screen>
  );
}

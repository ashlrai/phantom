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
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { sinceText } from '../connectivity.js';
import { inboxTailQuery } from '../inbox-tail-query.js';
import { dedupeInboxEntries } from '../inbox-dedupe.js';
import { inboxSeen, type InboxSeen } from '../inbox-seen-model.js';
import { inboxPending } from '../inbox-pending-model.js';
import { INBOX_NOT_IN_THIS_BUILD, INBOX_READ_LIMIT, inboxReadQuery, type FleetInboxReadEntry } from '../inbox-read-query.js';
import { useMobile } from '../mobile-context.js';
import { Button, cx, Screen, SkeletonList } from '../ui.js';
import { Badge, Banner, EmptyState, ErrorState, ui, type Tone } from '../ui-parts.js';
import styles from './InboxScreen.module.css';

/** Roughly the characters six lines hold in the entry column — the "Show more" cutoff. */
const SIX_LINE_CHARS = 6 * 54;

/** Pull-to-refresh: force the read fresh. */
export function refreshInboxScreen(): Promise<unknown> {
  const query = inboxReadQuery(INBOX_READ_LIMIT);
  return Promise.allSettled([refetchQuery(query.key, () => query.fetch(), true),
    refetchQuery(inboxTailQuery.key, () => inboxTailQuery.fetch(), true)]);
}

function priorityTone(priority: string): Tone {
  if (priority === 'P0') return 'danger';
  if (priority === 'P1') return 'warning';
  return 'neutral';
}

/** One entry: the channel, the priority when the sender set one, the time, then the words. */
function InboxEntry({ entry, now, seen, repeats, otherSources }: { entry: FleetInboxReadEntry; now: number; seen: InboxSeen; repeats: number; otherSources: string[] }) {
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
        {repeats > 1 ? <span data-testid="inbox-repeats"><Badge>×{repeats}</Badge>{otherSources.length > 0 ? <span className={ui.faint}> · also via {otherSources.join(', ')}</span> : null}</span> : null}
        {entry.priority ? <Badge tone={priorityTone(entry.priority)}>{entry.priority}</Badge> : null}
        <time className={styles.entryTime} dateTime={stamp} title={entry.at}>{ago(entry.at, now)}</time>
      </header>
      <Badge tone={seen.tone === 'ok' ? 'success' : seen.tone}>{seen.ackLabel}</Badge>
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
  const { navigate, reachability } = useMobile();
  const query = inboxReadQuery(INBOX_READ_LIMIT);
  const inbox = useQuery(query);
  const refetch = useRefetch(query);
  const snapshot = useQuery(inboxTailQuery);
  const refetchSnapshot = useRefetch(inboxTailQuery);
  const [, setClockTick] = useState(0);
  usePollWhileVisible(() => { setClockTick(tick => tick + 1); refetchSnapshot(); }, 20_000, { enabled: inbox.data != null && inbox.data.entries.length > 0 });
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
    const deduped = dedupeInboxEntries(shown);
    const seen = inboxSeen(deduped.map(({ entry }) => entry), snapshot.data?.snapshot, now);
    const pending = inboxPending(seen.entries, snapshot.data?.snapshot, now);
    body = (
      <>
        {reachability === 'unreachable' ? (
          <Banner>Can’t reach your Mac. Showing the last inbox read ({sinceText(inbox.updatedAt).toLowerCase()}).</Banner>
        ) : null}
        {data.sourceState !== 'healthy' ? (
          <Banner>
            {data.sourceState === 'missing'
              ? 'The inbox file is missing on your Mac — this may not be everything.'
              : 'The inbox read is degraded — this may not be everything.'}
          </Banner>
        ) : null}
        {shown.length > 0 ? <Banner tone={pending.tone === 'ok' ? 'info' : pending.tone}>{pending.text}</Banner> : null}
        {data.entries.length === 0 ? (
          <EmptyState title="Nothing yet." body="Use the box on Live runs." action={<Button variant="tinted" onClick={() => navigate({ screen: 'runs' })}>Go to Live runs</Button>} />
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
                {deduped.map(({ entry, repeats, otherSources }, i) => <InboxEntry key={`${entry.at}-${i}`} entry={entry} repeats={repeats} otherSources={otherSources} now={now} seen={seen.entries[i]!} />)}
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

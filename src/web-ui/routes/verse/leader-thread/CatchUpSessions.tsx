/**
 * "Ended while you were away", inside the Leader pane's "Since you last
 * looked" card: one row per session that finished or failed while the pane
 * was off screen, failed first. A row's name opens that session as a
 * conversation (beside the chat in the Leader pane: leader-reading.ts), so
 * "what happened to it" is one key away from the card that says it ended.
 *
 * Reads the list the Working now strip already reads
 * ('verse-fleet-live-sessions', one cache entry): no request of its own while
 * the strip is on screen, one read on mount without it.
 */
import { useEffect, useState } from 'react';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { liveSessionsQuery, SESSIONS_POLL_MS } from '../fleet-sessions/sessions-model.js';
import {
  AWAY_SESSIONS_MEMORY, awayOutcomeWords, awaySessionCounts, awaySessionsPartial, awaySessionsShown, awaySessionsUnknown, awayStateWord,
  endedWhileAway, mergeAwaySessions, type AwaySession,
} from './catchup-sessions-model.js';
import type { AwayWindow } from './leader-catchup-model.js';
import { openConversationFromLeader, useIsReading } from './leader-reading.js';
import styles from './catchup-sessions.module.css';

export interface AwaySessionsView {
  rows: readonly AwaySession[];
  /** Why the endings cannot be known, or null when the list answered (or is still being read). */
  unknown: string | null;
  /** True when the absence is longer than the list remembers. */
  partial: boolean;
}

const NONE: AwaySessionsView = { rows: [], unknown: null, partial: false };

/** The sessions that ended inside `away`, kept for as long as that window's card is up. */
export function useAwaySessions(away: AwayWindow | null): AwaySessionsView {
  const read = useQuery(liveSessionsQuery, { enabled: away !== null, freshMs: SESSIONS_POLL_MS });
  const [kept, setKept] = useState<{ since: number; rows: readonly AwaySession[] }>({ since: -1, rows: [] });
  const list = read.data;
  useEffect(() => {
    if (!away || !list) return;
    setKept(previous => {
      const same = previous.since === away.since;
      const rows = mergeAwaySessions(same ? previous.rows : [], endedWhileAway(list, away));
      return same && rows === previous.rows ? previous : { since: away.since, rows };
    });
  }, [away, list]);
  if (!away) return NONE;
  return {
    rows: kept.since === away.since ? kept.rows : [],
    unknown: awaySessionsUnknown(list, read.status === 'error'),
    partial: awaySessionsPartial(away),
  };
}

function Row({ row, now }: { row: AwaySession; now: number }) {
  const reading = useIsReading(row.session);
  const outcome = awayOutcomeWords(row);
  return <li className={styles.row} data-state={row.state} data-open={reading || undefined}>
    <span className={styles.dot} aria-hidden="true" />
    {row.lane !== 'unknown' ? <ProviderBadge of={row.lane} iconOnly size={14} /> : null}
    <button type="button" className={styles.door} data-conversation-door={row.session} aria-current={reading ? 'true' : undefined}
      aria-label={`Open the conversation with ${row.id}, ${awayStateWord(row)} ${formatRelative(row.endedAt, now)}`}
      title="What it was told, said and did" onClick={() => openConversationFromLeader(row.session)}>{row.id}</button>
    {row.kind === 'subagent' ? <span className={styles.kind}>helper</span> : null}
    <time className={styles.when} dateTime={row.endedAt} title={new Date(row.endedAt).toLocaleString('en-US')}>
      {awayStateWord(row)} {formatRelative(row.endedAt, now)}
    </time>
    {outcome !== null ? <span className={styles.outcome} data-unknown={row.outcome === null || undefined}>{outcome}</span> : null}
  </li>;
}

export function CatchUpSessions({ view, now }: { view: AwaySessionsView; now: number }) {
  const [all, setAll] = useState(false);
  const { rows } = view;
  if (rows.length === 0) {
    // Said only when the list could not answer; a list that answered "none" adds no line.
    return view.unknown === null ? null
      : <p className={styles.note} data-tone="unknown" data-away-sessions="unknown">Sessions that ended while you were away: unknown, {view.unknown}.</p>;
  }
  const shown = awaySessionsShown(rows, all);
  const hidden = rows.length - shown.length;
  return <div className={styles.root} data-away-sessions="known">
    <p className={styles.head}>
      <span className={styles.label}>Ended while you were away</span>
      <span className={styles.counts}>{awaySessionCounts(rows)}{view.partial ? ` in ${AWAY_SESSIONS_MEMORY}` : ''}</span>
      {all || hidden > 0 ? <button type="button" className={styles.more} aria-expanded={all} onClick={() => setAll(value => !value)}>
        {all ? 'Show fewer' : `Show all ${rows.length}`}
      </button> : null}
    </p>
    <ul className={styles.list} aria-label="Sessions that ended while you were away">
      {shown.map(row => <Row key={row.session} row={row} now={now} />)}
    </ul>
    {view.partial ? <p className={styles.note} data-tone="unknown">Sessions that ended before {AWAY_SESSIONS_MEMORY} are not in the session list.</p> : null}
    {view.unknown !== null ? <p className={styles.note} data-tone="unknown">This may be out of date: {view.unknown}.</p> : null}
  </div>;
}

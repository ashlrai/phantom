/**
 * The "Mentioned" row under a Leader message. Every job the message names is
 * one chip: a dot for its state now, its id (a button that opens the session
 * as a conversation, beside the chat in the Leader pane: leader-reading.ts),
 * what the session list says about it, the last thing it said while it is
 * working, and Log for its worker log. Pull requests stay plain links.
 *
 * The state comes from the list the Working now strip already reads
 * ('verse-fleet-live-sessions', one cache entry). The strip polls it while the
 * Leader pane is on screen, so the chips follow without a request of their
 * own; rendered without the strip they show the one read made on mount.
 */
import { useMemo } from 'react';
import { useQuery } from '../../../data/hooks.js';
import { JobRefs } from '../fleet/JobRefs.js';
import { liveSessionsQuery, SESSIONS_POLL_MS } from '../fleet-sessions/sessions-model.js';
import { useIsReading } from './leader-reading.js';
import { mentionedSessions, splitMentioned, type MentionedSession } from './mentioned-sessions-model.js';
import threadStyles from './leader-thread.module.css';
import styles from './mentioned-sessions.module.css';

interface Doors {
  onOpenLog: (job: string) => void;
  onOpenConversation: (job: string) => void;
}

function Chip({ row, onOpenLog, onOpenConversation }: { row: MentionedSession } & Doors) {
  const reading = useIsReading(row.job);
  return <li className={styles.chip} data-state={row.state} data-open={reading || undefined}>
    <span className={styles.dot} aria-hidden="true" />
    <button type="button" className={styles.door} aria-label={`Open the conversation with ${row.job}`} aria-current={reading ? 'true' : undefined}
      title={reading ? 'Open beside the chat' : 'Read this session as a conversation'}
      data-conversation-door={row.job} onClick={() => onOpenConversation(row.job)}>{row.job}</button>
    <span className={styles.words}>{row.words}</span>
    {row.said ? <span className={styles.said} title={row.said}>{row.said}</span> : null}
    <button type="button" className={styles.log} aria-label={`Open log for ${row.job}`} onClick={() => onOpenLog(row.job)}>Log</button>
  </li>;
}

export function MentionedSessions({ refs, onOpenLog, onOpenConversation }: { refs: readonly string[] } & Doors) {
  const { jobs, pulls } = useMemo(() => splitMentioned(refs), [refs]);
  const read = useQuery(liveSessionsQuery, { enabled: jobs.length > 0, freshMs: SESSIONS_POLL_MS });
  // A failed or malformed read is "could not be read", never an empty fleet.
  const list = read.data !== undefined ? read.data : read.status === 'error' ? null : undefined;
  const rows = useMemo(() => mentionedSessions(jobs, list), [jobs, list]);
  if (refs.length === 0) return null;
  return <div className={`${threadStyles.refs} ${styles.root}`} aria-label="Mentioned">
    {rows.length ? <ul className={styles.sessions} aria-label="Sessions named in this message">
      {rows.map(row => <Chip key={row.job} row={row} onOpenLog={onOpenLog} onOpenConversation={onOpenConversation} />)}
    </ul> : null}
    {pulls.length ? <p className={styles.pulls}>{rows.length ? 'Pull requests:' : 'Mentioned:'}{pulls.map(pull => <span key={pull}>
      {' '}<JobRefs text={pull.replace(/([^#])#/, '$1 #')} onOpenJob={onOpenLog} />
    </span>)}</p> : null}
  </div>;
}

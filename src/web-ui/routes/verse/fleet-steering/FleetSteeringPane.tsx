import { useMemo, useState } from 'react';
import { Button, SkeletonLine, Tag } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { fleetSteeringQuery } from './fleet-steering-queries.js';
import styles from './fleet-steering.module.css';
import { buildSteering, fleetSourceHealth, summarizeReaction, type SteeringEntry } from './steering-model.js';

const PREVIEW_CHARS = 160;

function reactionLine(entry: SteeringEntry): string {
  const summary = summarizeReaction(entry);
  const minutes = entry.firstReactionMinutes;
  if (minutes === null) return summary;
  return `${summary} · leaders reacted in ${minutes < 1 ? '<1' : Math.round(minutes)} min`;
}

function EntryRow({ entry }: { entry: SteeringEntry }) {
  const [open, setOpen] = useState(false);
  const preview = entry.text.length > PREVIEW_CHARS ? `${entry.text.slice(0, PREVIEW_CHARS)}…` : entry.text;
  return (
    <li className={styles.row}>
      <div className={styles.meta}>
        <time className={styles.time}>{entry.at}</time>
        <Tag size="sm">{entry.source}</Tag>
        <Button size="sm" variant="subtle" className={styles.toggle} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide events' : 'Events'}
        </Button>
      </div>
      {preview !== '' && <p className={styles.text}>{preview}</p>}
      <p className={styles.reaction}>{reactionLine(entry)}</p>
      {open && (entry.events.length > 0
        ? (
          <ol className={styles.events} aria-label={`Events after ${entry.at}`}>
            {entry.events.map((event, index) => (
              <li key={`${event.at}:${event.kind}:${index}`} className={styles.event}>
                <time className={styles.time}>{event.at.slice(11, 19)}</time>
                <Tag size="sm">{event.kind}</Tag>
                <span className={styles.eventText}>{event.text}</span>
              </li>
            ))}
          </ol>
        )
        : <p className={styles.reaction}>No dispatcher events in this window.</p>)}
    </li>
  );
}

export function FleetSteeringPane({ visible }: PaneProps) {
  const read = useQuery(fleetSteeringQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(fleetSteeringQuery);
  usePollWhileVisible(refetch, 10_000, { enabled: visible });
  const entries = useMemo(() => buildSteering(read.data), [read.data]);
  const missing = read.data === null || (read.error instanceof ApiError && read.error.status === 404);
  if (missing) return <p className={styles.message}>Live runs not in this build</p>;
  if (read.data === undefined) {
    return (
      <div className={styles.root} role="status">
        {read.status === 'error' ? 'Live runs are unavailable.' : <><span>Reading live runs…</span><SkeletonLine /><SkeletonLine /></>}
      </div>
    );
  }
  const sources = fleetSourceHealth(read.data);
  const degraded = sources.inbox !== 'healthy' || sources.runsDir !== 'healthy';
  return (
    <section className={styles.root} aria-label="Steering">
      {degraded && <p className={styles.notice} role="status">Inbox or dispatcher events may be incomplete.</p>}
      {read.status === 'error' && <p className={styles.notice} role="status">Live runs could not refresh. Showing the last reading.</p>}
      {entries.length === 0
        ? <p className={styles.message}>No orders yet. Use the interject box.</p>
        : (
          <ol className={styles.list} aria-label="Steering orders">
            {entries.map((entry, index) => <EntryRow key={`${entry.at}:${index}`} entry={entry} />)}
          </ol>
        )}
    </section>
  );
}

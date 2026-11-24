/**
 * The line a typed command leaves in the Leader conversation ("3 working now:
 * RQ-A (claude, spoke 2m ago) …"). It reads like the other system lines, and
 * every job it names is a button that opens that session as a conversation,
 * so `/who` is also the way into any of them: in the Leader pane it opens
 * beside the chat (leader-reading.ts). PR numbers link as they do in the
 * Leader's own messages.
 *
 * An answer of several lines (`/find`) is a headline over a list, a row a
 * line; a row that ends in a quoted line (“…”) shows the quote as what was said.
 */
import { Fragment, type ReactNode } from 'react';
import { clockTime } from '../leader/thread-model.js';
import { pullUrl, splitRefs } from '../fleet/job-refs.js';
import leaderStyles from '../leader/leader.module.css';
import { useIsReading } from './leader-reading.js';
import styles from './composer-result.module.css';

/** One named session; marked while its conversation is open in this Leader pane. */
function SessionButton({ id, onOpen }: { id: string; onOpen: (job: string) => void }) {
  const reading = useIsReading(id);
  return <button type="button" className={styles.session} aria-label={`Open the conversation with ${id}`} aria-current={reading ? 'true' : undefined}
    data-conversation-door={id} onClick={() => onOpen(id)}>{id}</button>;
}

function withRefs(text: string, onOpen: (job: string) => void): ReactNode {
  return splitRefs(text).map((segment, index) => {
    if (segment.kind === 'job') return <SessionButton key={index} id={segment.value} onOpen={onOpen} />;
    const href = segment.kind === 'pr' && segment.repo && segment.number ? pullUrl(segment.repo, segment.number) : null;
    if (href) return <a key={index} href={href} target="_blank" rel="noopener noreferrer">{segment.value}</a>;
    return <Fragment key={index}>{segment.value}</Fragment>;
  });
}

/** A row split where its quoted line starts; no quote when it does not end in one. */
const ROW_QUOTE = /^([\s\S]*?: )“([\s\S]+)”$/;

export function ComposerResultLine({ text, at, onOpenConversation }: {
  text: string;
  /** When the command answered, ms since the epoch. */
  at: number;
  onOpenConversation: (job: string) => void;
}) {
  const iso = Number.isFinite(at) ? new Date(at).toISOString() : null;
  const time = iso ? <> <time dateTime={iso}>{clockTime(iso)}</time></> : null;
  const [head = '', ...rows] = text.split('\n');
  if (rows.length === 0) return <p className={`${leaderStyles.system} ${styles.result}`} data-composer-result>{withRefs(text, onOpenConversation)}{time}</p>;
  return <div className={`${leaderStyles.system} ${styles.result} ${styles.block}`} data-composer-result data-rows={rows.length}>
    <p className={styles.head}>{withRefs(head, onOpenConversation)}{time}</p>
    <ul className={styles.rows}>{rows.map((row, index) => {
      const quoted = ROW_QUOTE.exec(row);
      return <li key={index} className={styles.row} data-quoted={quoted ? '' : undefined}>
        {quoted ? <>{withRefs(quoted[1]!, onOpenConversation)}<q className={styles.quote}>{withRefs(quoted[2]!, onOpenConversation)}</q></> : withRefs(row, onOpenConversation)}
      </li>;
    })}</ul>
  </div>;
}

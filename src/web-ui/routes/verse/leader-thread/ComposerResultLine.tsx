/**
 * The line a typed command leaves in the Leader conversation ("3 working now:
 * RQ-A (claude, spoke 2m ago) …"). It reads like the other system lines, and
 * every job it names is a button that opens that session as a conversation,
 * so `/who` is also the way into any of them. PR numbers link as they do in
 * the Leader's own messages.
 */
import { Fragment } from 'react';
import { clockTime } from '../leader/thread-model.js';
import { pullUrl, splitRefs } from '../fleet/job-refs.js';
import leaderStyles from '../leader/leader.module.css';
import styles from './composer-result.module.css';

export function ComposerResultLine({ text, at, onOpenConversation }: {
  text: string;
  /** When the command answered, ms since the epoch. */
  at: number;
  onOpenConversation: (job: string) => void;
}) {
  const iso = Number.isFinite(at) ? new Date(at).toISOString() : null;
  return <p className={`${leaderStyles.system} ${styles.result}`} data-composer-result>
    {splitRefs(text).map((segment, index) => {
      if (segment.kind === 'job') {
        return <button key={index} type="button" className={styles.session} aria-label={`Open the conversation with ${segment.value}`}
          onClick={() => onOpenConversation(segment.value)}>{segment.value}</button>;
      }
      const href = segment.kind === 'pr' && segment.repo && segment.number ? pullUrl(segment.repo, segment.number) : null;
      if (href) return <a key={index} href={href} target="_blank" rel="noopener noreferrer">{segment.value}</a>;
      return <Fragment key={index}>{segment.value}</Fragment>;
    })}
    {iso ? <> <time dateTime={iso}>{clockTime(iso)}</time></> : null}
  </p>;
}

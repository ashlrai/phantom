/**
 * "What the owner asked", above the Conversations wall: one button per message of
 * Mason's that a session on screen serves, newest first, with how much of its
 * routing is on screen and what state those sessions are in. Choosing one
 * leaves only its sessions on the wall; choosing it again, "Every session" or
 * Esc brings the rest back. A last button holds the sessions whose job cites
 * no message.
 *
 * It reads nothing of its own: the tie comes with each entry of the wall's
 * read (wall-requests-model.ts). Left and Right move along the row, Home and
 * End jump to its ends. The row is not drawn at all when no session on screen
 * serves a message, so a fleet running only standing work looks as it did.
 */
import { useMemo, type KeyboardEvent } from 'react';
import { STATE_WORD, WALL_STATES, type WallEntry } from './session-wall-model.js';
import { requestName, requestTime, requestWords, UNTIED, wallRequests } from './wall-requests-model.js';
import styles from './wall-requests.module.css';

export interface WallRequestsProps {
  /** The sessions on screen, after the find box and before any state button. */
  entries: readonly WallEntry[];
  /** The chosen message's key, UNTIED, or null for every session. */
  chosen: string | null;
  onChoose: (key: string | null) => void;
}

export function WallRequests({ entries, chosen, onChoose }: WallRequestsProps) {
  const { requests, untied } = useMemo(() => wallRequests(entries), [entries]);
  if (requests.length === 0) return null;
  const picked = chosen === UNTIED ? (untied > 0 ? UNTIED : null) : requests.find(request => request.key === chosen)?.key ?? null;
  const open = requests.find(request => request.key === picked) ?? null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape' && picked !== null) { event.preventDefault(); event.stopPropagation(); onChoose(null); return; }
    const all = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-request]')];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const to = event.key === 'ArrowRight' ? Math.min(at + 1, all.length - 1) : event.key === 'ArrowLeft' ? Math.max(at - 1, 0)
      : event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : -1;
    if (at < 0 || to < 0 || !all[to]) return;
    event.preventDefault();
    // The row is the list's own keys; the wall's J, K and arrows are for the cards.
    event.stopPropagation();
    all[to].focus();
  };

  return <section className={styles.requests} aria-label="What the owner asked">
    <h3 className={styles.title}>What the owner asked <span>{requests.length === 1 ? '1 message has' : `${requests.length} messages have`} sessions on screen</span></h3>
    <div className={styles.row} role="group" aria-label="Show the sessions serving one message" onKeyDown={onKeyDown}>
      {requests.map(request => <button key={request.key} type="button" className={styles.request} data-request={request.key} aria-pressed={picked === request.key}
        aria-label={`${requestName(request)} (${requestWords(request)})`} onClick={() => onChoose(picked === request.key ? null : request.key)}>
        <span className={styles.when}>{requestTime(request.at)}{request.source && <span> · {request.source}</span>}</span>
        <span className={styles.text} data-known={request.text !== null}>{request.text ?? 'Its words are not among the inbox messages this read holds.'}</span>
        <span className={styles.meta}>
          <span className={styles.pips} aria-hidden="true">
            {WALL_STATES.flatMap(state => Array.from({ length: Math.min(request.states[state], 12) }, (_, n) =>
              <span key={`${state}${n}`} className={styles.pip} data-state={state} title={STATE_WORD[state]} />))}
          </span>
          <span>{requestWords(request)}</span>
        </span>
      </button>)}
      {untied > 0 && <button type="button" className={styles.request} data-request={UNTIED} data-untied aria-pressed={picked === UNTIED}
        title="A job serves a message when its prompt cites it. These cite none: standing work, or work the Leader started on its own."
        aria-label={`No message cited: ${untied} session${untied === 1 ? '' : 's'}`} onClick={() => onChoose(picked === UNTIED ? null : UNTIED)}>
        <span className={styles.when}>No message cited</span>
        <span className={styles.text} data-known="false">Sessions whose job cites none of the owner's messages.</span>
        <span className={styles.meta}><span>{untied} session{untied === 1 ? '' : 's'}</span></span>
      </button>}
    </div>
    {picked !== null && <p className={styles.chosen} role="status">
      <span>{open ? <>Showing the {open.sessions.length === 1 ? 'session' : `${open.sessions.length} sessions`} serving the owner's message of {requestTime(open.at)}
        {open.jobs !== null && open.jobs > open.workers && `; ${open.jobs - open.workers} more of its jobs ${open.jobs - open.workers === 1 ? 'is' : 'are'} not on screen`}.
        {open.text && <> <q>{open.text}</q>{open.truncated && ' (cut short)'}</>}</>
        : <>Showing the {untied === 1 ? 'session' : `${untied} sessions`} whose job cites none of the owner's messages.</>}</span>
      <button type="button" className={styles.all} onClick={() => onChoose(null)}>Every session</button>
    </p>}
  </section>;
}

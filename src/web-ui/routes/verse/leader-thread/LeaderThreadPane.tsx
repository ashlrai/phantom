import { useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { VERSE_FLEET_RUNS_PATH } from '../../../../core/verse/fleet-runs-types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { hasMutationHold } from '../../../data/auth-store.js';
import { refetchQuery } from '../../../data/cache.js';
import { apiGet, readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { MessageMarkdown } from '../MessageMarkdown.js';
import { useNow } from '../autonomy/use-ticker.js';
import { ActionStatus, useSurfaceActions } from '../command/actions.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { JobRefs } from '../fleet/JobRefs.js';
import { DirectivesStrip } from '../leader/DirectivesStrip.js';
import { ChannelBadge } from '../leader/ThreadItems.js';
import { leaderDirectivesQuery, leaderThreadQuery, sendLeaderMessage } from '../leader/thread-data.js';
import { clockTime, dayLabel } from '../leader/thread-model.js';
import type { LeaderThreadMessage } from '../leader/thread-types.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import leaderStyles from '../leader/leader.module.css';
import styles from './leader-thread.module.css';
import { fleetInbox, lineChannel, lineSourceLabel, mergeThread, type MergedLine } from './thread-merge-model.js';
import { canSend, scrollTargetIndex, trimReply } from './thread-reply-model.js';
import { mentionedRefs } from './thread-refs.js';

/** Shared 'verse-fleet-runs' key so the pane rides the same cache and SSE invalidation as the other fleet panes. */
const fleetRunsQuery: QueryDef<unknown> = {
  key: 'verse-fleet-runs',
  fetch: signal => apiGet<unknown>(VERSE_FLEET_RUNS_PATH, signal),
};

const NO_MESSAGES: LeaderThreadMessage[] = [];
/** A thread scrolled within this of its end counts as "at the end" (new lines follow it down). */
const STICK_PX = 96;

/** One merged line: a system note stays the centered quiet line; the leaders' rows keep the conversation's look; Mason's get a left rule and a source chip. */
function LineView({ line }: { line: MergedLine }) {
  const leader = line.who === 'leader';
  const iso = Number.isFinite(line.at) ? new Date(line.at).toISOString() : null;
  const clock = iso ? clockTime(iso) : '—';
  if (line.source === 'system') {
    return <p className={leaderStyles.system}>{line.text}{iso ? <> <time dateTime={iso}>{clock}</time></> : null}</p>;
  }
  const channel = lineChannel(line.source);
  const label = lineSourceLabel(line.source);
  const refs = leader ? mentionedRefs(line.text) : [];
  return (
    <section className={leader ? leaderStyles.group : `${leaderStyles.group} ${styles.masonLine}`} data-from={line.who} data-source={line.source} aria-label={`${leader ? 'Leader' : 'You'}, ${clock}`}>
      <header className={leaderStyles.groupHead}>
        <span className={leaderStyles.avatar} data-from={line.who} aria-hidden="true">{leader ? 'L' : 'M'}</span>
        <span className={leaderStyles.who}>{leader ? 'Leader' : 'You'}</span>
        {leader && channel ? <ChannelBadge channel={channel} /> : <span className={leaderStyles.channel} data-channel={channel ?? undefined} title={`Sent via ${label}`}>{label}</span>}
        <time className={leaderStyles.time} dateTime={iso ?? undefined} title={iso ? new Date(line.at).toLocaleString('en-US') : 'Time unknown'}>{clock}</time>
      </header>
      <div className={leaderStyles.groupBody}>
        <div className={leaderStyles.entry}>
          {leader
            ? <div className={leaderStyles.leaderText}>
              <div className={leaderStyles.prose}><MessageMarkdown text={line.text} /></div>
              {refs.length ? <div className={styles.refs} aria-label="Mentioned">Mentioned: {refs.map((ref, index) => <span key={ref}>
                {index ? ' ' : null}<JobRefs text={ref.replace(/([^#])#/, '$1 #')} onOpenJob={job => { requestWorkerLogJob(job); openDockPane('worker-log'); }} />
              </span>)}</div> : null}
            </div>
            : <div className={leaderStyles.masonItem}><p className={leaderStyles.bubble}>{line.text}</p></div>}
        </div>
      </div>
    </section>
  );
}

export function LeaderThreadPane({ visible }: Pick<PaneProps, 'visible'>) {
  const thread = useQuery(leaderThreadQuery, { enabled: visible, freshMs: 5_000 });
  const runs = useQuery(fleetRunsQuery, { enabled: visible, freshMs: 5_000 });
  const directives = useQuery(leaderDirectivesQuery, { enabled: visible, freshMs: 30_000 });
  const refetchThread = useRefetch(leaderThreadQuery);
  const refetchRuns = useRefetch(fleetRunsQuery);
  const refetchDirectives = useRefetch(leaderDirectivesQuery);
  const actions = useSurfaceActions();
  const logRef = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const inFlight = useRef(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [scrollVersion, setScrollVersion] = useState(0);
  const [addingDirective, setAddingDirective] = useState(false);
  // Inbox wall times, the merge and the day labels want a coarse tick.
  const now = useNow(10_000);

  usePollWhileVisible(() => { refetchThread(); refetchRuns(); }, 5_000, { enabled: visible });
  usePollWhileVisible(refetchDirectives, 30_000, { enabled: visible });

  const read = thread.data;
  const messages = read?.value?.messages ?? NO_MESSAGES;
  const inbox = useMemo(() => fleetInbox(runs.data), [runs.data]);
  const merged = useMemo(() => mergeThread(messages, inbox, now), [messages, inbox, now]);

  // One row per line, keeping the conversation's day separators; undated lines go last.
  const items = useMemo(() => {
    const out: ({ type: 'day'; key: string; label: string } | { type: 'line'; key: string; line: MergedLine })[] = [];
    let day = '';
    for (const line of [...merged.lines, ...merged.undated]) {
      if (Number.isFinite(line.at)) {
        const d = new Date(line.at);
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        if (key !== day) {
          day = key;
          out.push({ type: 'day', key: `day-${key}`, label: dayLabel(d.toISOString(), now) });
        }
      }
      out.push({ type: 'line', key: line.id, line });
    }
    return out;
  }, [merged, now]);

  const lastKey = items.length ? items[items.length - 1]!.key : null;
  const forcedAt = useRef(scrollVersion);
  useLayoutEffect(() => {
    const el = logRef.current;
    const entries = el?.firstElementChild?.children;
    if (!el || !entries || scrollTargetIndex(entries) === -1) return;
    const force = scrollVersion !== forcedAt.current;
    forcedAt.current = scrollVersion;
    if (!force && !atEnd.current) return;
    atEnd.current = true;
    el.scrollTop = el.scrollHeight;
  }, [lastKey, scrollVersion]);

  async function send() {
    if (inFlight.current || !canSend(draft, sending) || actions.readOnly) return;
    if (!hasMutationHold()) {
      setUnlockOpen(true);
      return;
    }
    const text = trimReply(draft);
    inFlight.current = true;
    setSending(true);
    setFailure(null);
    try {
      await sendLeaderMessage(text);
      setDraft('');
      await refetchQuery(leaderThreadQuery.key, () => leaderThreadQuery.fetch(), true);
      setScrollVersion(version => version + 1);
    } catch (error) {
      setFailure(readFailureReason(error));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey) || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    event.stopPropagation();
    void send();
  }

  const threadMissing = read !== undefined && read.value === null;
  const empty = items.length === 0;
  const loading = read === undefined && runs.data === undefined && runs.error === undefined;
  let note: string | null = null;
  if (!empty && threadMissing) note = read!.reason ?? 'The Leader conversation is not available on this server.';
  else if (!empty && !inbox.length && runs.error !== undefined) note = 'The fleet inbox could not be reached.';
  else if (!empty && !inbox.length && runs.data !== undefined) note = 'Nothing in Mason’s inbox yet — posts from any channel join this conversation.';

  let body: ReactNode;
  if (loading) {
    body = <p className={leaderStyles.placeholder} aria-busy="true">Reading the conversation…</p>;
  } else if (empty) {
    body = <p className={leaderStyles.placeholder} data-tone={threadMissing ? 'unknown' : undefined}>
      {threadMissing ? (read!.reason ?? 'The Leader conversation did not answer.') : 'No conversation or interjections yet — reply below or post to the inbox from any channel.'}
    </p>;
  } else {
    body = items.map(item => item.type === 'day'
      ? <div key={item.key} className={leaderStyles.day} role="separator" aria-label={item.label}><span>{item.label}</span></div>
      : <LineView key={item.key} line={item.line} />);
  }

  return <div className={styles.root}>
    <ActionStatus actions={actions} />
    <DirectivesStrip read={directives.data} actions={actions} adding={addingDirective} onAddingChange={setAddingDirective} />
    <div ref={logRef} className={leaderStyles.log} role="log" aria-label="Conversation with the Leader" aria-live="polite" aria-relevant="additions" tabIndex={0}
      onScroll={() => {
        const el = logRef.current;
        if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
      }}>
      <div className={leaderStyles.logInner}>
        {body}
      </div>
    </div>
    {note ? <p className={styles.note} role="note">{note}</p> : null}
    <form className={styles.reply} onSubmit={onSubmit}>
      <div className={styles.replyRow}>
        <textarea aria-label="Reply to the Leader" placeholder="Reply to the Leader…" value={draft} maxLength={6000}
          disabled={sending || actions.readOnly} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown} />
        <button type="submit" disabled={!canSend(draft, sending) || actions.readOnly}>Send</button>
      </div>
      {failure ? <p className={styles.replyFailure} role="alert">{failure}</p> : null}
    </form>
    <MutationTokenDialog open={unlockOpen} onClose={() => setUnlockOpen(false)} onUnlocked={() => void send()}
      reason="Messaging the Leader requires the dispatch token." tokenHelp="the mutation token ashlr verse printed" />
    {actions.dialogs}
  </div>;
}

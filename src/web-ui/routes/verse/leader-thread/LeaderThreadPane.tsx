import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { hasMutationHold } from '../../../data/auth-store.js';
import { refetchQuery } from '../../../data/cache.js';
import { readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { ActionStatus, useSurfaceActions } from '../command/actions.js';
import { leaderQuery } from '../command/surface-data.js';
import { LeaderConversation } from '../leader/LeaderConversation.js';
import { leaderThreadQuery, sendLeaderMessage } from '../leader/thread-data.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { SectionVisibilityProvider, usePollWhileVisible } from '../shell/section-visibility.js';
import { canSend, scrollTargetIndex, trimReply } from './thread-reply-model.js';
import styles from './leader-thread.module.css';

export function LeaderThreadPane({ visible }: Pick<PaneProps, 'visible'>) {
  const leader = useQuery(leaderQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(leaderQuery);
  const actions = useSurfaceActions();
  const root = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [scrollVersion, setScrollVersion] = useState(0);
  usePollWhileVisible(refetch, 5_000, { enabled: visible });

  useLayoutEffect(() => {
    if (!scrollVersion) return;
    const log = root.current?.querySelector<HTMLElement>('[role="log"][aria-label="Conversation with the Leader"]');
    const entries = log?.firstElementChild?.children;
    if (log && entries && scrollTargetIndex(entries) !== -1) log.scrollTop = log.scrollHeight;
  }, [scrollVersion]);

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

  return <div ref={root} className={styles.root}>
    <ActionStatus actions={actions} />
    <SectionVisibilityProvider visible={visible}>
      <LeaderConversation leader={leader.data} actions={actions} dormant={!visible} />
    </SectionVisibilityProvider>
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

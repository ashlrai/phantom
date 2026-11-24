import { useEffect, useRef, useState } from 'react';
import { readChat, type ChatPage } from './chat-reader.js';
import styles from './AgentGroupChat.module.css';

/** Isolated consumption seam. Caller supplies an explicitly selected channel.
 * Do not infer a channel/outcome from card prose or union unrelated rosters.
 * No owner composer: local read access is not verified ingress authority. */
export function AgentGroupChat({ channel }: { channel: string }) {
  return <ChannelChat key={channel} channel={channel} />;
}
function ChannelChat({ channel }: { channel: string }) {
  const [thread, setThread] = useState('');
  const [threads, setThreads] = useState<ChatPage['threads']>([]);
  return <section className={styles.panel} aria-label="Agent group chat">
    <header><h2>Agent group chat</h2><p>Channel: {channel}</p></header>
    <label>Outcome or run <select value={thread} onChange={e => setThread(e.target.value)}>
      <option value="">Choose a thread</option>
      {threads.map(t => <option key={t.id} value={t.id}>{t.id}</option>)}
    </select></label>
    <ThreadChat key={`${channel}:${thread}`} channel={channel} thread={thread} onThreads={setThreads} />
  </section>;
}
function ThreadChat({ channel, thread, onThreads }: {
  channel: string; thread: string; onThreads: (threads: ChatPage['threads']) => void;
}) {
  const [page, setPage] = useState<ChatPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ append: boolean; cursor: number } | null>(null);
  const pending = useRef<AbortController | null>(null);
  const load = async (append = false, cursor = append ? page?.nextCursor ?? 0 : 0) => {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setFailed(null);
    try {
      const next = await readChat(channel, thread, cursor, controller.signal);
      if (controller.signal.aborted) return;
      setPage(old => append && old ? { ...next, messages: [...old.messages, ...next.messages].slice(-500) } : next);
      onThreads(next.threads);
    } catch { if (!controller.signal.aborted) setFailed({ append, cursor }); }
    finally { if (!controller.signal.aborted) { pending.current = null; setBusy(false); } }
  };
  useEffect(() => {
    void load();
    return () => { pending.current?.abort(); pending.current = null; };
    // Scope changes remount this component; no shared state survives navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <>
    <p className={styles.note}>Read-only · Retained local channel messages, not complete history. Presence is unknown.</p>
    <button type="button" disabled={busy} onClick={() => void load()}>Refresh</button>
    {busy ? <p role="status">Loading messages…</p> : null}
    {failed ? <p role="status">Chat unavailable. Previously loaded messages may be stale. <button type="button" onClick={() => void load(failed.append, failed.cursor)}>Retry</button></p> : null}
    {page ? <>
      <ul className={styles.roster} aria-label="Channel participants">
        {page.participants.map(p => <li key={p.agentId}>
          <span className={styles.avatar} style={{ borderColor: p.avatarColor }} aria-hidden="true">{p.displayName.slice(0, 1) || '?'}</span>
          <span>{p.displayName} · {p.engine ?? 'Engine unknown'} · Presence unknown</span>
        </li>)}
      </ul>
      {!thread ? <p>Select an outcome or run to read its messages.</p> : page.messages.length === 0 ? <p>No retained messages in this thread.</p> : null}
      <ol className={styles.messages} aria-label="Thread messages">
        {page.messages.map(m => <li key={m.id}>
          <header><strong>{page.participants.find(p => p.agentId === m.agentId)?.displayName ?? m.agentId}</strong>{' '}
            <time dateTime={new Date(m.receivedAt).toISOString()}>{new Date(m.receivedAt).toLocaleString()}</time>
            {m.kind === 'interjection' ? <span> · Human-labelled interjection (identity not verified here)</span> : null}</header>
          <p>{m.text}</p>
        </li>)}
      </ol>
      {page.messages.length >= 500 ? <p>Showing the latest 500 loaded messages.</p> : null}
      {thread && page.hasMore ? <button type="button" disabled={busy} onClick={() => void load(true)}>Load next messages</button> : null}
    </> : null}
  </>;
}

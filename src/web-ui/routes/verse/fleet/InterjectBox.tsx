import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { Tag } from '../../../components/primitives/Tag.js';
import { runQuery } from '../../../data/cache.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefresh } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { inboxTailQuery, postInterjection } from './interject-queries.js';
import { ackState, ackText, loadDraft, newestLeaderPassMs, parseInboxAt, saveDraft, sourceChip } from './interject-ack-model.js';
import styles from './InterjectBox.module.css';

const UNAVAILABLE = 'The inbox API is not in this build yet.';
const absent = (error: unknown) => error instanceof ApiError && (error.status === 404 || error.status === 503);

export function InterjectBox() {
  const id = useId();
  const read = useQuery(inboxTailQuery);
  usePollWhileVisible(() => { void runQuery(inboxTailQuery.key, () => inboxTailQuery.fetch()); }, 15_000);
  const refresh = useRefresh(inboxTailQuery);
  const [draft, setDraft] = useState(() => {
    try { return loadDraft(window.sessionStorage); } catch { return ''; }
  });
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const [unavailable, setUnavailable] = useState(false);
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  function updateDraft(text: string) {
    setDraft(text);
    try { saveDraft(window.sessionStorage, text); } catch { /* Storage can be unavailable. */ }
  }
  useEffect(() => {
    if (sent === null) return;
    const timer = setTimeout(() => setSent(null), 5_000);
    return () => clearTimeout(timer);
  }, [sent]);
  const missing = unavailable || absent(read.error);
  const canSend = !missing && !sending && draft.trim().length > 0 && draft.length <= 6_000;

  async function send() {
    if (!canSend || busy.current) return;
    busy.current = true;
    setSending(true);
    setMessage('');
    setSent(null);
    try {
      const result = await postInterjection(draft.trim());
      updateDraft('');
      setSent(result.at);
      refresh();
    } catch (error) {
      if (absent(error)) setUnavailable(true);
      else setMessage(error instanceof ApiError ? error.detail ?? error.message
        : error instanceof Error ? error.message : 'The message could not be sent.');
    } finally {
      busy.current = false;
      setSending(false);
    }
  }

  const now = Date.now();
  const generatedAtMs = Date.parse(read.data?.generatedAt ?? '');
  const newestPass = newestLeaderPassMs(read.data?.leaders, generatedAtMs);
  const entryTime = (at: string) => parseInboxAt(at, now);
  const entries = [...(read.data?.inbox ?? [])].sort((a, b) =>
    (entryTime(b.at) ?? Date.parse(b.at)) - (entryTime(a.at) ?? Date.parse(a.at))).slice(0, 5);
  return <section className={styles.panel} aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>Tell the leaders</h2>
    <form onSubmit={event => { event.preventDefault(); void send(); }}>
      <label htmlFor={id}>Prompt, thought or interjection</label>
      <textarea id={id} rows={3} maxLength={6_000} value={draft} disabled={sending}
        placeholder="Tell the leaders. Lands in MASON-INBOX.md; the next leader pass reads it."
        onChange={event => updateDraft(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Escape' || (event.key === 'Enter' && event.metaKey)) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Escape') updateDraft('');
            else void send();
          }
        }} />
      <div className={styles.row}>
        <span>⌘↵ send · Esc clear</span>
        <span aria-live="polite">{draft.length > 5_000 ? `${draft.length.toLocaleString('en-US')} / 6,000` : ''}</span>
        <Button type="submit" variant="primary" size="sm" disabled={!canSend}>{sending ? 'Sending…' : 'Send'}</Button>
      </div>
    </form>
    <p role="status" aria-live="polite">{missing ? UNAVAILABLE : message || (sent ? `Sent · ${new Date(sent).toLocaleTimeString()}` : '')}</p>
    <h3>Recent inbox entries</h3>
    {entries.length ? <ol className={styles.tail}>{entries.map((entry, index) => <li key={`${entry.at}-${index}`}>
      <div className={styles.meta}>{entry.at} · <Tag size="sm">{sourceChip(entry.source)}</Tag></div>
      <details className={styles.entry}>
        <summary aria-label={`Inbox entry ${index + 1}`}><span className={styles.preview}>{entry.text}</span><span className={styles.collapsed}>Expand</span><span className={styles.expanded}>Collapse</span></summary>
        <p>{entry.text}</p>
      </details>
      <div className={styles.ack}><span className={styles.dot} data-state={ackState(entryTime(entry.at), newestPass)} aria-hidden="true" />{ackText(ackState(entryTime(entry.at), newestPass))}</div>
    </li>)}</ol> : <p>{read.status === 'error' ? 'The inbox tail is unavailable.' : read.data ? 'Nothing in the inbox yet.' : 'Reading the inbox…'}</p>}
  </section>;
}

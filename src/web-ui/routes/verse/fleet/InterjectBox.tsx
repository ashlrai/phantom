import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { Tag } from '../../../components/primitives/Tag.js';
import { runQuery } from '../../../data/cache.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefresh } from '../../../data/hooks.js';
import { ordersTraceQuery } from '../fleet-inbox/fleet-inbox-queries.js';
import { narrowOrderTrace } from '../fleet-inbox/order-trace-model.js';
import { runsGraphQuery } from './runs-graph-queries.js';
import { insertMention, matchRunningJobs, mentionQuery, targetsOf } from './interject-target-model.js';
import { interjectOutcome } from './interject-outcome-model.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { inboxTailQuery, postInterjection, readInboxAck } from './interject-queries.js';
import { mintInterjectRequestId } from './interject-request.js';
import { interjectImageChip, interjectImageError, readInterjectImage, type InterjectImage } from './interject-image.js';
import { ackState, ackText, loadDraft, loadPendingAck, newestLeaderPassMs, parseInboxAt, saveDraft, savePendingAck, sourceChip } from './interject-ack-model.js';
import { loadHistory, pushHistory, recall } from './interject-history.js';
import { askCosTask, isCosRouteAbsent } from './cos-task-client.js';
import { CosTaskCard, lastCosTask } from './CosTaskCard.js';
import styles from './InterjectBox.module.css';

const UNAVAILABLE = 'The inbox API is not in this build yet.';
const ACK_POLL_MS = 15_000;
const ACK_GIVE_UP_MS = 20 * 60_000;
const ACK_TEXT = {
  waiting: 'Sent · waiting for the planner',
  acked: 'Planner acknowledged',
  skipped: 'Planner saw it · no reply route',
  expired: 'Not acknowledged yet · check the Inbox pane',
} as const;
const absent = (error: unknown) => error instanceof ApiError && (error.status === 404 || error.status === 503);

export function InterjectBox() {
  const id = useId();
  const read = useQuery(inboxTailQuery);
  usePollWhileVisible(() => { void runQuery(inboxTailQuery.key, () => inboxTailQuery.fetch()); }, 15_000);
  const refresh = useRefresh(inboxTailQuery);
  const orders = useQuery(ordersTraceQuery, { enabled: (read.data?.inbox.length ?? 0) > 0, freshMs: 10_000 });
  const trace = orders.error ? null : narrowOrderTrace(orders.data);
  const [draft, setDraft] = useState(() => {
    try { return loadDraft(window.sessionStorage); } catch { return ''; }
  });
  const [caret, setCaret] = useState(0);
  const [mentionClosed, setMentionClosed] = useState(false);
  const [selected, setSelected] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const query = mentionClosed ? null : mentionQuery(draft, caret);
  const running = useQuery(runsGraphQuery, { enabled: query !== null, freshMs: 15_000 });
  const matches = query === null ? [] : matchRunningJobs(query, running.data?.workers ?? []);
  const targets = targetsOf(draft);
  function chooseMention(job: string) {
    const next = insertMention(draft, caret, job);
    updateDraft(next.text);
    setCaret(next.caret);
    setMentionClosed(true);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(next.caret, next.caret); });
  }
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const cursor = useRef<number | null>(null);
  const liveDraft = useRef('');
  // One request id per composed message: a retry (double Enter, a slow
  // response, a reconnect) reposts it and the Hub replays the first write.
  const requestKey = useRef<{ text: string; id: string } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [asTask, setAsTask] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(lastCosTask);
  const [taskAck, setTaskAck] = useState('');
  const [image, setImage] = useState<InterjectImage | null>(null);
  function attachImage(file: File | null | undefined) {
    if (!file) return;
    const error = interjectImageError(file);
    if (error !== null) { setMessage(error); return; }
    setMessage('');
    void readInterjectImage(file).then(attached => {
      // A changed attachment is a different composed message: it earns its own
      // request id so a retry never collapses two sends into one.
      requestKey.current = null;
      setImage(attached);
    }, () => setMessage('The screenshot could not be read.'));
  }
  function removeImage() {
    requestKey.current = null;
    setImage(null);
  }
  function updateDraft(text: string) {
    setDraft(text);
    // An emptied box ends the composition: a retype — even of the same words —
    // is a new message and mints a new request id.
    if (!text.trim()) requestKey.current = null;
    try { saveDraft(window.sessionStorage, text); } catch { /* Storage can be unavailable. */ }
  }
  useEffect(() => {
    if (sent === null) return;
    const timer = setTimeout(() => setSent(null), 5_000);
    return () => clearTimeout(timer);
  }, [sent]);
  // A wait persisted by an earlier window (reload, restart, crash) resumes where it stopped.
  const sentAt = useRef<number | null>(null);
  const resumed = useRef(false);
  const [ackWait, setAckWait] = useState<{ id: string; state: keyof typeof ACK_TEXT } | null>(() => {
    try {
      const pending = loadPendingAck(window.localStorage, Date.now(), ACK_GIVE_UP_MS);
      if (!pending) return null;
      sentAt.current = pending.sentAtMs;
      resumed.current = true;
      return { id: pending.id, state: 'waiting' };
    } catch { return null; }
  });
  const waitingId = ackWait?.state === 'waiting' ? ackWait.id : null;
  useEffect(() => {
    if (waitingId === null) return;
    const controller = new AbortController();
    const finish = (state: keyof typeof ACK_TEXT) => {
      try { savePendingAck(window.localStorage, null); } catch { /* Storage can be unavailable. */ }
      setAckWait({ id: waitingId, state });
    };
    const check = () => {
      readInboxAck(waitingId, controller.signal).then(state => {
        if (controller.signal.aborted) return;
        if (state === 'acked' || state === 'skipped') finish(state);
      }, () => { /* A failed poll keeps waiting. */ });
    };
    // An ack that landed while the app was closed shows at once.
    if (resumed.current) { resumed.current = false; check(); }
    const interval = setInterval(check, ACK_POLL_MS);
    const remaining = sentAt.current === null ? ACK_GIVE_UP_MS : ACK_GIVE_UP_MS - (Date.now() - sentAt.current);
    const giveUp = setTimeout(() => finish('expired'), Math.max(0, remaining));
    return () => { controller.abort(); clearInterval(interval); clearTimeout(giveUp); };
  }, [waitingId]);
  const missing = unavailable || absent(read.error);
  const canSend = !missing && !sending && draft.trim().length > 0 && draft.length <= 6_000;

  async function send() {
    if (!canSend || busy.current) return;
    busy.current = true;
    setSending(true);
    setMessage('');
    setSent(null);
    setAckWait(null);
    try { savePendingAck(window.localStorage, null); } catch { /* Storage can be unavailable. */ }
    try {
      if (asTask) {
        const task = await askCosTask(draft.trim());
        try { pushHistory(window.localStorage, draft.trim()); } catch { /* Storage can be unavailable. */ }
        cursor.current = null;
        updateDraft('');
        setTaskAck(task.ack);
        setTaskId(task.id);
        return;
      }
      setTaskAck('');
      const text = draft.trim();
      if (requestKey.current?.text !== text) requestKey.current = { text, id: mintInterjectRequestId() };
      const result = await postInterjection(text, requestKey.current.id, image?.data);
      try { pushHistory(window.localStorage, text); } catch { /* Storage can be unavailable. */ }
      cursor.current = null;
      setImage(null);
      updateDraft('');
      setSent(result.at);
      if (result.id) {
        sentAt.current = Date.now();
        try { savePendingAck(window.localStorage, { id: result.id, sentAtMs: sentAt.current }); } catch { /* Storage can be unavailable. */ }
        setAckWait({ id: result.id, state: 'waiting' });
      }
      refresh();
    } catch (error) {
      if (asTask && isCosRouteAbsent(error)) setMessage('Tasks are not in this build yet');
      else if (absent(error)) setUnavailable(true);
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
    <form onSubmit={event => { event.preventDefault(); void send(); }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
      onDrop={event => {
        const file = event.dataTransfer.files?.[0];
        if (file) { event.preventDefault(); attachImage(file); }
      }}>
      <label htmlFor={id}>Prompt, thought or interjection</label>
      <textarea ref={textarea} id={id} rows={3} maxLength={6_000} value={draft} disabled={sending}
        placeholder="Tell the leaders. Lands in MASON-INBOX.md; the next leader pass reads it."
        onChange={event => { updateDraft(event.target.value); setCaret(event.target.selectionStart); setMentionClosed(false); setSelected(0); }}
        onSelect={event => setCaret(event.currentTarget.selectionStart)}
        onPaste={event => {
          const file = Array.from(event.clipboardData?.items ?? []).find(item => item.kind === 'file')?.getAsFile();
          if (file) { event.preventDefault(); attachImage(file); }
        }}
        aria-controls={query !== null && matches.length ? `${id}-mentions` : undefined}
        aria-activedescendant={query !== null && matches.length ? `${id}-mention-${Math.min(selected, matches.length - 1)}` : undefined}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (query !== null && matches.length && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab'].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
            event.preventDefault();
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') setSelected(index => (index + (event.key === 'ArrowUp' ? -1 : 1) + matches.length) % matches.length);
            else chooseMention(matches[Math.min(selected, matches.length - 1)]!.job);
            return;
          }
          if (event.key === 'Escape' && query !== null) { event.preventDefault(); event.stopPropagation(); setMentionClosed(true); return; }
          if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Escape') { cursor.current = null; setImage(null); updateDraft(''); }
            else void send();
          } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
            !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
            const { selectionStart, value } = event.currentTarget;
            const up = event.key === 'ArrowUp';
            const firstNewline = value.indexOf('\n');
            if (up ? firstNewline !== -1 && selectionStart > firstNewline : selectionStart <= value.lastIndexOf('\n')) return;
            try {
              const history = loadHistory(window.localStorage);
              const next = recall(history, cursor.current, up ? 'up' : 'down');
              if (next.cursor === null && cursor.current === null) return;
              if (cursor.current === null) liveDraft.current = draft;
              cursor.current = next.cursor;
              event.preventDefault();
              updateDraft(next.text ?? liveDraft.current);
            } catch { /* Storage can be unavailable. */ }
          }
        }} />
      {query !== null && matches.length ? <div id={`${id}-mentions`} role="listbox" aria-label="Running jobs">{matches.map((job, index) => <div id={`${id}-mention-${index}`} role="option" aria-selected={index === Math.min(selected, matches.length - 1)} key={`${job.job}-${index}`} onMouseDown={event => event.preventDefault()} onClick={() => chooseMention(job.job)}>{job.job} · {job.lane ?? 'Unknown lane'}</div>)}</div> : null}
      {targets.length ? <div>{targets.map(target => <Tag key={target} size="sm">Aimed at {target}</Tag>)}</div> : null}
      {image ? <div><Button type="button" variant="subtle" size="sm" onClick={removeImage}>{interjectImageChip(image)} ×</Button></div> : null}
      <label><input type="checkbox" checked={asTask} disabled={sending} onChange={event => setAsTask(event.target.checked)} /> Run as task</label>
      <div className={styles.row}>
        <span>⌘↵ or Ctrl↵ send · ↑ history · Esc clear</span>
        <span aria-live="polite">{draft.length > 5_000 ? `${draft.length.toLocaleString('en-US')} / 6,000` : ''}</span>
        <Button type="submit" variant="primary" size="sm" disabled={!canSend}>{sending ? 'Sending…' : 'Send'}</Button>
      </div>
    </form>
    <p role="status" aria-live="polite">{missing ? UNAVAILABLE : message || (sent ? `Sent · ${new Date(sent).toLocaleTimeString()}` : '')}</p>
    {taskAck && !message ? <p role="status" aria-live="polite">{taskAck}</p> : null}
    {taskId ? <CosTaskCard id={taskId} /> : null}
    {ackWait && !missing && !message ? <p role="status" aria-live="polite">{ACK_TEXT[ackWait.state]}</p> : null}
    <h3>Recent inbox entries</h3>
    {entries.length ? <ol className={styles.tail}>{entries.map((entry, index) => <li key={`${entry.at}-${index}`}>
      <div className={styles.meta}>{entry.at} · <Tag size="sm">{sourceChip(entry.source)}</Tag></div>
      <details className={styles.entry}>
        <summary aria-label={`Inbox entry ${index + 1}`}><span className={styles.preview}>{entry.text}</span><span className={styles.collapsed}>Expand</span><span className={styles.expanded}>Collapse</span></summary>
        <p>{entry.text}</p>
      </details>
      <div className={styles.ack}><span className={styles.dot} data-state={ackState(entryTime(entry.at), newestPass)} aria-hidden="true" />{ackText(ackState(entryTime(entry.at), newestPass))}</div>
      {(() => {
        const outcome = interjectOutcome(entry.at, ackState(entryTime(entry.at), newestPass) === 'seen', trace);
        return <div className={styles.ack} data-outcome={outcome.stage}>
          {outcome.href ? <a href={outcome.href} target="_blank" rel="noopener noreferrer">{outcome.text}</a> : outcome.text}
        </div>;
      })()}
    </li>)}</ol> : <p>{read.status === 'error' ? 'The inbox tail is unavailable.' : read.data ? 'Nothing in the inbox yet.' : 'Reading the inbox…'}</p>}
  </section>;
}

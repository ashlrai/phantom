import { useState } from 'react';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { useMutationHold, useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { CopyPill } from '../apps/CopyPill.js';
import { UNIFIED_INBOX_ALL_PATH, UNIFIED_INBOX_COMMAND, UNIFIED_INBOX_PATH, itemLine, readUnifiedInboxView, sourceProblems, sourceSummary } from './unified-inbox-model.js';
import { TEAMMATE_REPLY_PATH, teammateReplyOutcome, teammateRowid } from './teammate-reply-model.js';
import { NEEDS_YOU_RESOLVE_PATH, needsYouLedgerId, needsYouResolveOutcome } from './needs-you-resolve.js';
import { LINKEDIN_ANSWERED_PATH, linkedInAnsweredOutcome, linkedInMessageId } from './linkedin-answered.js';
import styles from './fleet-inbox.module.css';

const unifiedInboxQuery: QueryDef<unknown> = { key: 'verse-fleet-comms-unified-inbox', fetch: s => apiGet(UNIFIED_INBOX_PATH, s) };
const unifiedInboxAllQuery: QueryDef<unknown> = { key: 'verse-fleet-comms-unified-inbox-all', fetch: s => apiGet(UNIFIED_INBOX_ALL_PATH, s) };
const MAX_SHOWN = 8;

/** One-line reply under a teammate text. Typed text survives anything but a 200. */
function TeammateReply({ rowid, onSent }: { rowid: number; onSent: () => void }) {
  const { token, touch } = useMutationHold();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  async function send() {
    if (busy || !text.trim()) return;
    if (!token) { setNote('Unlock to send.'); return; }
    setBusy(true);
    try {
      const body = await apiPost<unknown>(TEAMMATE_REPLY_PATH, { rowid, text }, token);
      const status = typeof body === 'object' && body !== null && (body as { status?: unknown }).status === 'uncertain' ? 202 : 200;
      setNote(teammateReplyOutcome(status, body));
      touch();
      if (status === 200) { setText(''); onSent(); }
    } catch (reason) {
      setNote(teammateReplyOutcome(reason instanceof ApiError ? reason.status : 0, null));
    } finally { setBusy(false); }
  }
  return <form className={styles.unifiedReply} onSubmit={e => { e.preventDefault(); void send(); }}>
    <input className={styles.unifiedReplyInput} value={text} onChange={e => setText(e.target.value)} maxLength={4000}
      placeholder="Reply by iMessage" aria-label="Reply to this teammate" />
    <button type="submit" disabled={busy || !text.trim()}>{busy ? 'Sending' : 'Send'}</button>
    {note && <span className={styles.meta} role="status">{note}</span>}
  </form>;
}

function NeedsYouResolve({ itemId, onResolved }: { itemId: string; onResolved: () => void }) {
  const { token, touch } = useMutationHold();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  async function resolve() {
    if (busy) return;
    if (!token) { setNote('Unlock to resolve.'); return; }
    setBusy(true);
    try {
      const reply = text.trim();
      const body = await apiPost<unknown>(NEEDS_YOU_RESOLVE_PATH, reply ? { itemId, reply } : { itemId }, token);
      setNote(needsYouResolveOutcome(200, body));
      setText('');
      touch();
      onResolved();
    } catch (reason) {
      const status = reason instanceof ApiError ? reason.status : 0;
      setNote(needsYouResolveOutcome(status, null));
      if (status === 409) onResolved();
    } finally { setBusy(false); }
  }
  return <form className={styles.unifiedReply} onSubmit={e => { e.preventDefault(); void resolve(); }}>
    <input className={styles.unifiedReplyInput} value={text} onChange={e => setText(e.target.value)} maxLength={500}
      placeholder="Optional one-line reply" aria-label="Reply for this Needs-you item" />
    <button type="submit" disabled={busy}>{busy ? 'Resolving' : 'Resolve'}</button>
    {note && <span className={styles.meta} role="status">{note}</span>}
  </form>;
}

/** Clears a LinkedIn row by recording it answered locally. Nothing is sent to LinkedIn. */
function LinkedInAnswered({ id, onMarked }: { id: string; onMarked: () => void }) {
  const { token, touch } = useMutationHold();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  async function mark() {
    if (busy) return;
    if (!token) { setNote('Unlock to mark answered.'); return; }
    setBusy(true);
    try {
      await apiPost<unknown>(LINKEDIN_ANSWERED_PATH, { id }, token);
      touch();
      onMarked();
    } catch (reason) {
      setNote(linkedInAnsweredOutcome(reason instanceof ApiError ? reason.status : 0));
    } finally { setBusy(false); }
  }
  return <span>
    <button type="button" disabled={busy} onClick={() => { void mark(); }}>{busy ? 'Marking' : 'Mark answered'}</button>
    {note && <span className={styles.meta} role="status">{note}</span>}
  </span>;
}

export function UnifiedInboxCard({ visible }: { visible: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const inbox = useQuery(unifiedInboxQuery, { enabled: visible });
  const all = useQuery(unifiedInboxAllQuery, { enabled: visible && expanded });
  const refetchShort = useRefetch(unifiedInboxQuery);
  const refetchAll = useRefetch(unifiedInboxAllQuery);
  const refetch = () => { refetchShort(); if (expanded) refetchAll(); };
  usePollWhileVisible(refetch, 15_000, { enabled: visible });
  // Pane tests stub useQuery by key and return undefined for keys they do not know.
  const view = !inbox || inbox.error ? null : readUnifiedInboxView(inbox.data);
  if (view === null) return null;
  if (view.unavailable) return <p className={styles.meta}>Unified inbox unavailable</p>;
  const now = Date.now();
  const fullView = expanded && all && !all.error ? readUnifiedInboxView(all.data) : null;
  const full = fullView !== null && !fullView.unavailable ? fullView : null;
  const shown = full ? full.items : view.items.slice(0, MAX_SHOWN);
  const more = view.total - shown.length;
  const problems = sourceProblems(view.sources);
  const allHealthy = Object.values(view.sources).every(s => s !== null && s.state === 'healthy');
  return <section className={styles.cos} aria-label="Unified inbox">
    <h3 className={styles.day}>Waiting</h3>
    <p className={styles.meta}>{sourceSummary(view.sources)}</p>
    {problems.map(p => <p key={p.source} className={styles.meta}>
      {p.name}: {p.meaning} <CopyPill text={p.command} what={`the ${p.name} fix command`} />
    </p>)}
    {shown.length === 0 && allHealthy && <p className={styles.meta}>Nothing waiting</p>}
    {shown.map(item => {
      const line = itemLine(item, now);
      const rowid = teammateRowid(item);
      const ledgerId = needsYouLedgerId(item);
      const linkedInId = linkedInMessageId(item);
      return <div key={item.id} className={styles.unifiedItem} data-severity={item.severity}>
        <span className={styles.meta}>{line.label}</span>
        <span className={styles.unifiedTitle}>{item.title}</span>
        {item.detail !== undefined && <span className={styles.meta}>{item.detail}</span>}
        {line.age !== null && <span className={styles.meta}>{line.age}</span>}
        {item.blocking && <span className={styles.meta}>blocking</span>}
        {item.act[0] !== undefined && <CopyPill text={item.act[0]} what="the command for this item" />}
        {rowid !== null && <TeammateReply rowid={rowid} onSent={refetch} />}
        {linkedInId !== null && <LinkedInAnswered id={linkedInId} onMarked={refetch} />}
        {ledgerId !== null && <NeedsYouResolve itemId={ledgerId} onResolved={refetch} />}
      </div>;
    })}
    {!full && more > 0 && <p className={styles.meta}>+{more} more</p>}
    {full && full.omitted > 0 && <p className={styles.meta}>+{full.omitted} not loaded</p>}
    {(expanded || view.total > shown.length) && <p className={styles.meta}>
      <button type="button" onClick={() => setExpanded(e => !e)}>{expanded ? 'Show fewer' : `Show all (${view.total})`}</button>
    </p>}
    <p className={styles.meta}><CopyPill text={UNIFIED_INBOX_COMMAND} what="the full inbox command" /></p>
  </section>;
}

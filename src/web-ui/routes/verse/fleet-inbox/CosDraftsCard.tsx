import { useRef, useState } from 'react';
import { Button, Tag } from '../../../components/primitives/index.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import {
  COS_APPROVE_PATH, COS_DRAFTS_PATH, approveOutcomeText, cosChannelName, cosCheckNote, inFlightDrafts, pendingDrafts, readCosDrafts,
  type CosDraft,
} from './cos-drafts-model.js';
import styles from './fleet-inbox.module.css';

const cosDraftsQuery: QueryDef<unknown> = { key: 'verse-cos-drafts', fetch: s => apiGet(COS_DRAFTS_PATH, s) };

export function CosDraftsCard({ visible }: { visible: boolean }) {
  const drafts = useQuery(cosDraftsQuery, { enabled: visible });
  const refetch = useRefetch(cosDraftsQuery);
  usePollWhileVisible(refetch, 15_000, { enabled: visible });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ id: string; text: string } | null>(null);
  const busy = useRef(false);
  // Pane tests stub useQuery by key and return undefined for keys they do not know.
  const all = !drafts || drafts.error ? [] : readCosDrafts(drafts.data);
  const pending = pendingDrafts(all), waiting = inFlightDrafts(all);
  if (pending.length === 0 && waiting.length === 0 && !outcome) return null;

  async function approve(draft: CosDraft) {
    if (busy.current) return;
    busy.current = true;
    setBusyId(draft.id);
    setOutcome(null);
    let text: string;
    try {
      const token = getMutationToken();
      if (!token) { text = 'Unlock the desktop app to approve replies.'; }
      else {
        const body = await apiPost<unknown>(COS_APPROVE_PATH, { id: draft.id, digest: draft.digest }, token);
        touchMutationHold();
        text = approveOutcomeText(200, body, draft.channel);
      }
    } catch (error) {
      text = error instanceof ApiError ? approveOutcomeText(error.status, { code: error.code }, draft.channel)
        : 'The draft could not be approved. Refresh and try again.';
    } finally {
      busy.current = false;
      setBusyId(null);
    }
    setOutcome({ id: draft.id, text });
    refetch();
  }

  return <section className={styles.cos} aria-label="Reply drafts waiting for approval">
    <h3 className={styles.day}>Reply drafts waiting for you</h3>
    {pending.map(draft => <article className={styles.row} key={draft.id}>
      <div className={styles.meta}><Tag>{cosChannelName(draft.channel)}</Tag><span>To {draft.senderId}</span></div>
      <pre className={styles.cosText}>{draft.text}</pre>
      <Button size="sm" variant="primary" disabled={busyId !== null} onClick={() => void approve(draft)}
        aria-label={`Approve and send reply to ${draft.senderId}`}>{busyId === draft.id ? 'Sending…' : 'Approve and send'}</Button>
    </article>)}
    {waiting.map(draft => <article className={styles.row} key={draft.id}>
      <div className={styles.meta}><Tag>{cosChannelName(draft.channel)}</Tag><span>To {draft.senderId}</span></div>
      <pre className={styles.cosText}>{draft.text}</pre>
      <p>{cosCheckNote(draft.delivery)}</p>
    </article>)}
    {outcome && <p role="status">{outcome.text}</p>}
  </section>;
}

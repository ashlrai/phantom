import { useRef, useState } from 'react';
import { Button } from '../../../components/primitives/index.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import {
  EMAIL_APPROVE_PATH, EMAIL_DRAFTS_PATH, EMAIL_REJECT_PATH, emailDraftOutcome, readEmailDrafts, type EmailDraft,
} from './email-drafts-model.js';
import styles from './fleet-inbox.module.css';

const emailDraftsQuery: QueryDef<unknown> = { key: 'verse-comms-email-drafts', fetch: s => apiGet(EMAIL_DRAFTS_PATH, s) };

/** About twelve lines; longer bodies scroll inside the block. */
const BODY_STYLE = { maxHeight: '12lh', overflowY: 'auto' } as const;

export function EmailDraftsCard({ visible }: { visible: boolean }) {
  const query = useQuery(emailDraftsQuery, { enabled: visible });
  const refetch = useRefetch(emailDraftsQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const busy = useRef(false);
  // Pane tests stub useQuery by key and return undefined for keys they do not know.
  const drafts = !query || query.error ? [] : readEmailDrafts(query.data);
  if (drafts.length === 0 && !outcome) return null;

  async function decide(draft: EmailDraft, verb: 'approve' | 'reject') {
    if (busy.current) return;
    busy.current = true;
    setBusyId(draft.id);
    setOutcome(null);
    let text: string;
    try {
      const token = getMutationToken();
      if (!token) { text = 'Unlock the desktop app to decide on drafts.'; }
      else {
        const path = verb === 'approve' ? EMAIL_APPROVE_PATH : EMAIL_REJECT_PATH;
        const payload = verb === 'approve' ? { id: draft.id, digest: draft.digest } : { id: draft.id };
        const body = await apiPost<unknown>(path, payload, token);
        touchMutationHold();
        text = emailDraftOutcome(200, body);
      }
    } catch (error) {
      text = emailDraftOutcome(error instanceof ApiError ? error.status : 0, { code: error instanceof ApiError ? error.code : null });
    } finally {
      busy.current = false;
      setBusyId(null);
    }
    setOutcome(text);
    refetch();
  }

  return <section className={styles.cos} aria-label="Email drafts waiting for a decision">
    <h3 className={styles.day}>Email drafts</h3>
    {drafts.map(draft => <article className={styles.row} key={draft.id}>
      <div className={styles.meta}><span>To {draft.to}</span></div>
      <div><strong>{draft.subject}</strong></div>
      <pre className={styles.cosText} style={BODY_STYLE} tabIndex={0} aria-label={`Body of ${draft.subject}`}>{draft.body}</pre>
      {draft.truncated && <p className={styles.meta}>Too long to read here, so it cannot be approved here. Reject it or read it with phm drafts show.</p>}
      <div className={styles.meta}>
        <Button size="sm" variant="primary" disabled={busyId !== null || draft.truncated} onClick={() => void decide(draft, 'approve')}
          aria-label={`Approve email to ${draft.to}`}>Approve</Button>
        <Button size="sm" disabled={busyId !== null} onClick={() => void decide(draft, 'reject')}
          aria-label={`Reject email to ${draft.to}`}>Reject</Button>
      </div>
    </article>)}
    {outcome && <p role="status">{outcome}</p>}
  </section>;
}

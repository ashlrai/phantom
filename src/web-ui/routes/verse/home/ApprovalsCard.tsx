/**
 * The Decisions card on desktop Home and the phone's Home: one row per decision
 * only Mason can make, with one big button per option (Yes / No / Later for a
 * password, 2FA, device, payment or outreach ask; an agent's own options
 * otherwise). Built only on the `phm approvals` API (approvals.asks.v1 /
 * approvals.answer.v1), the same ledger and answer path as `phm decisions`.
 * Says "Nothing needs you" when nothing is waiting, and unknown when the
 * ledger could not be read. A tap
 * goes through the shared guard (the unlock prompt appears only if the hold
 * has lapsed), and the answer is only recorded: nothing is paid or sent.
 */
import { useState } from 'react';
import type { Approval, ApprovalAnswerResult, ApprovalsList } from '../../../../core/fleet/approvals.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { requestGuarded } from '../shell/guard-store.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './approvals.module.css';

export const APPROVALS_PATH = '/api/verse/agent-bus/needs-mason/approvals';
export const APPROVALS_ANSWER_PATH = `${APPROVALS_PATH}/answer`;
export const approvalAsksQuery: QueryDef<ApprovalsList> = { key: 'approval-asks', fetch: signal => apiGet(APPROVALS_PATH, signal) };
const KIND: Record<Approval['kind'], string> = { approval: '', password: 'Password', '2fa': '2FA code', device: 'Device approval', payment: 'Payment', outreach: 'Message outside the team', usage: 'Your usage number' };
export const DECISIONS_EMPTY = 'Nothing needs you';

const label = (option: string): string => option.charAt(0).toUpperCase() + option.slice(1);

export function ageText(seconds: number | null): string {
  if (seconds === null) return 'asked at an unknown time';
  if (seconds < 90) return 'asked just now';
  if (seconds < 90 * 60) return `asked ${Math.round(seconds / 60)} min ago`;
  if (seconds < 36 * 3600) return `asked ${Math.round(seconds / 3600)} h ago`;
  return `asked ${Math.round(seconds / 86400)} days ago`;
}

function expiryText(expires: string | null, asOf: string): string | null {
  if (!expires) return null;
  const minutes = Math.max(1, Math.round((Date.parse(expires) - Date.parse(asOf)) / 60_000));
  return minutes < 90 ? `expires in ${minutes} min` : minutes < 36 * 60 ? `expires in ${Math.round(minutes / 60)} h` : `expires in ${Math.round(minutes / 1440)} days`;
}

/** Only a well-formed approvals.asks.v1 payload is a list; anything else (an older server, an error body) hides the card. */
function listOf(data: unknown): ApprovalsList | null {
  if (data === null || typeof data !== 'object') return null;
  const list = data as Partial<ApprovalsList>;
  return list.schema === 'approvals.asks.v1' && Array.isArray(list.approvals) ? list as ApprovalsList : null;
}

export interface ApprovalsCardProps {
  visible?: boolean;
  /** Which of Mason's screens this is; recorded as the answer's channel. */
  from?: 'desktop' | 'phone';
  /** False on a read-only phone: rows show, buttons do not. */
  canAnswer?: boolean;
  /** Rows drawn at once (the phone keeps its numbers on the first screen); the rest surface as these are answered. */
  limit?: number;
  /** The plain line shown when nothing is waiting. */
  emptyNote?: string;
}

export function ApprovalsCard({ visible = true, from = 'desktop', canAnswer = true, limit, emptyNote = DECISIONS_EMPTY }: ApprovalsCardProps) {
  const read = useQuery(approvalAsksQuery, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(approvalAsksQuery);
  usePollWhileVisible(refresh, 30_000, { enabled: visible });
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const list = listOf(read.data);
  if (!list) return null;
  if (list.ledger === 'unavailable') {
    return <section className={styles.card} aria-label="Decisions"><h3>Decisions</h3><p data-unknown>Unknown: the needs-you ledger could not be read.</p></section>;
  }
  const open = list.approvals.filter(approval => !done.includes(approval.id));
  if (open.length === 0 && !note) {
    return <section className={styles.card} aria-label="Decisions"><h3>Decisions</h3><p className={styles.meta} role="status">{emptyNote}</p></section>;
  }
  const shown = limit === undefined ? open : open.slice(0, limit);

  function answer(approval: Approval, option: string) {
    if (busy) return;
    setNote('');
    requestGuarded({
      title: 'Answer', body: approval.question, confirmLabel: label(option), destructive: false, token: true, skipConfirm: true,
      tokenReason: 'Answering records your decision on your Mac and needs the mutation token `ashlr verse` printed.',
      run: async () => {
        setBusy(approval.id);
        try {
          const outcome = await apiPost<ApprovalAnswerResult>(APPROVALS_ANSWER_PATH, { id: approval.id, option, from }, getMutationToken() ?? '');
          touchMutationHold();
          setDone(previous => [...previous, approval.id]);
          setNote(outcome.status === 'already-answered' ? 'Already answered; nothing changed.' : `Sent: ${option}.`);
          refresh();
        } catch (reason) {
          // Gone or expired: drop the row so the card does not offer a dead button.
          if (reason instanceof ApiError && (reason.status === 404 || reason.status === 410)) setDone(previous => [...previous, approval.id]);
          setNote(reason instanceof ApiError && reason.detail ? reason.detail : 'Could not send the answer. Try again.');
        } finally { setBusy(''); }
      },
      onError: message => setNote(message),
    });
  }

  return <section className={styles.card} aria-label="Decisions">
    <h3>Decisions <span className={styles.count} aria-label={`${open.length} waiting`}>{open.length}</span></h3>
    {open.length > 0 && <ul className={styles.list}>
      {shown.map(approval => {
        const meta = [ageText(approval.ageSeconds), `by ${approval.askedBy ?? 'unknown'}`, expiryText(approval.expires, list.asOf),
          `reply “${approval.options[0]} ${approval.ref}” from your phone`].filter(Boolean).join(' · ');
        return <li key={approval.id} className={styles.ask} aria-label={approval.question}>
          <p className={styles.request}>{KIND[approval.kind] ? <strong>{KIND[approval.kind]} </strong> : null}{approval.question}</p>
          <p className={styles.meta}>{meta}</p>
          {canAnswer && <div className={styles.buttons} role="group" aria-label={`Answer: ${approval.question}`}>
            {approval.options.map((option, index) => <button key={option} type="button" className={styles.button} data-primary={index === 0 || undefined}
              disabled={busy !== ''} onClick={() => answer(approval, option)}>{label(option)}</button>)}
          </div>}
        </li>;
      })}
    </ul>}
    {open.length > shown.length && <p className={styles.meta}>{open.length - shown.length} more after these.</p>}
    {note && <p role="status" className={styles.meta}>{note}</p>}
  </section>;
}

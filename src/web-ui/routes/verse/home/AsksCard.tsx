/**
 * Home's Asks card: the few things only Mason can do, each with Yes, No and Done.
 * Built only on the `phm asks` API (asks.v1 / asks.answer.v1). Hidden when
 * nothing is asked; says unknown when the ledger could not be read.
 */
import { useState } from 'react';
import type { Ask, AskAnswer, AskAnswerResult, AsksList } from '../../../../core/fleet/asks.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { useMutationHold, useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './asks.module.css';

export const ASKS_PATH = '/api/verse/agent-bus/needs-mason/asks';
export const ASKS_ANSWER_PATH = `${ASKS_PATH}/answer`;
const query: QueryDef<AsksList> = { key: 'asks', fetch: signal => apiGet(ASKS_PATH, signal) };
const KIND: Record<Ask['kind'], string> = { password: 'Password', '2fa': '2FA code', device: 'Device approval', payment: 'Payment' };
const BUTTONS: Array<[AskAnswer, string]> = [['yes', 'Yes'], ['no', 'No'], ['done', 'Done']];

function age(seconds: number | null): string {
  if (seconds === null) return 'asked at an unknown time';
  if (seconds < 90) return 'asked just now';
  if (seconds < 90 * 60) return `asked ${Math.round(seconds / 60)} min ago`;
  if (seconds < 36 * 3600) return `asked ${Math.round(seconds / 3600)} h ago`;
  return `asked ${Math.round(seconds / 86400)} days ago`;
}

/** Only a well-formed asks.v1 payload is a list; anything else (an older server, an error body) hides the card. */
function asksOf(data: unknown): AsksList | null {
  if (data === null || typeof data !== 'object') return null;
  const list = data as Partial<AsksList>;
  return list.schema === 'asks.v1' && Array.isArray(list.asks) ? list as AsksList : null;
}

export function AsksCard({ visible = true }: { visible?: boolean }) {
  const read = useQuery(query, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 30_000, { enabled: visible });
  const { hasHold, token, touch } = useMutationHold();
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const list = asksOf(read.data);
  if (!list) return null;
  if (list.ledger === 'unavailable') {
    return <section className={styles.card} aria-label="Asks"><h3>Asks</h3><p data-unknown>Unknown: the needs-you ledger could not be read.</p></section>;
  }
  const asks = list.asks.filter(ask => !done.includes(ask.id));
  if (asks.length === 0 && !note) return null;

  async function answer(ask: Ask, word: AskAnswer) {
    if (!hasHold || !token || busy) { setNote('Unlock to answer.'); return; }
    setBusy(ask.id); setNote('');
    try {
      const outcome = await apiPost<AskAnswerResult>(ASKS_ANSWER_PATH, { id: ask.id, answer: word }, token);
      touch();
      setDone(previous => [...previous, ask.id]);
      setNote(outcome.status === 'already-answered' ? 'Already answered; nothing changed.' : `Sent: ${word}.`);
      refresh();
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 404 || reason.status === 403)) setDone(previous => [...previous, ask.id]);
      setNote(reason instanceof ApiError && reason.detail ? reason.detail : 'Could not send the answer. Try again.');
    } finally { setBusy(''); }
  }

  return <section className={styles.card} aria-label="Asks">
    <h3>Asks <span className={styles.count} aria-label={`${asks.length} waiting`}>{asks.length}</span></h3>
    {asks.length > 0 && <ul className={styles.list}>
      {asks.map(ask => <li key={ask.id} className={styles.ask} aria-label={`${KIND[ask.kind]}: ${ask.request}`}>
        <p className={styles.request}><strong>{KIND[ask.kind]}</strong> {ask.request}</p>
        <p className={styles.meta}>{age(ask.ageSeconds)} · reply “yes {ask.shortId}” from your phone</p>
        <div className={styles.buttons}>
          {BUTTONS.map(([word, label]) => <button key={word} type="button" className={styles.button}
            disabled={busy !== '' || !hasHold} title={hasHold ? undefined : 'Unlock to answer'}
            onClick={() => void answer(ask, word)}>{label}</button>)}
        </div>
      </li>)}
    </ul>}
    {!hasHold && asks.length > 0 && <p className={styles.meta}>Unlock to answer here.</p>}
    {note && <p role="status" className={styles.meta}>{note}</p>}
  </section>;
}

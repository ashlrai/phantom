import { useRef, useState } from 'react';
import { Button } from '../../../components/primitives/index.js';
import { canSendDirect, DIRECT_TARGET, sendDirect, type DirectResult } from './direct-box-model.js';
import styles from './fleet-direct.module.css';

/** One line to the leaders. Enter sends; the bus's own answer is shown, never assumed. */
export function DirectBox() {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<DirectResult | null>(null);
  const inFlight = useRef(false);
  const send = async () => {
    if (inFlight.current || !canSendDirect(text, sending)) return;
    inFlight.current = true; setSending(true); setResult(null);
    const sent = text;
    const outcome = await sendDirect(sent);
    inFlight.current = false; setSending(false); setResult(outcome);
    // Keep the line on failure so the owner can retry the exact same text.
    if (outcome.ok) setText(current => current === sent ? '' : current);
  };
  return <form className={styles.direct} onSubmit={event => { event.preventDefault(); void send(); }}>
    <input type="text" className={styles.line} aria-label={`Direct to ${DIRECT_TARGET}`} placeholder="Tell the leader something (wakes it at priority P0)"
      value={text} maxLength={6000} disabled={sending} onChange={event => setText(event.target.value)} />
    <Button size="sm" type="submit" disabled={!canSendDirect(text, sending)}>Send</Button>
    <p className={styles.notice} role="status" data-ok={result ? String(result.ok) : undefined}>{result?.message ?? ''}</p>
  </form>;
}

import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/primitives/index.js';
import { postBusEnvelope } from './agent-bus-post.js';
import { buildMasonEnvelope, canPost, postOutcomeText, trimPost, type PostOutcome } from './bus-post-model.js';
import styles from './fleet-bus.module.css';

export interface BusPostPrefill { to: string; replyTo: string; quote: string }
export function BusPostBox({ senders, prefill, onPosted }: {
  senders: readonly string[]; prefill: BusPostPrefill | null; onPosted: (cursor: number) => void;
}) {
  const [to, setTo] = useState('leaders');
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<string | undefined>();
  const [quote, setQuote] = useState('');
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<PostOutcome | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const attempt = useRef<ReturnType<typeof buildMasonEnvelope> | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    if (!prefill) return;
    setTo(prefill.to); setReplyTo(prefill.replyTo); setQuote(prefill.quote); setOutcome(null);
    textarea.current?.focus();
  }, [prefill]);
  const send = async () => {
    if (inFlight.current || !canPost(text, to, sending)) return;
    inFlight.current = true; setSending(true); setOutcome(null);
    const previous = attempt.current;
    const envelope = previous && previous.to === to && previous.body.text === trimPost(text) && previous.body.replyTo === replyTo
      ? previous : buildMasonEnvelope({ to, text, replyTo, now: Date.now() });
    attempt.current = envelope;
    const result = await postBusEnvelope(envelope);
    setOutcome(result); setSending(false); inFlight.current = false;
    if (result.status === 'posted') {
      setText(''); setReplyTo(undefined); setQuote('');
      if (result.cursor !== undefined) onPosted(result.cursor);
    }
  };
  const options = [...new Set(['leaders', ...senders, to])];
  return <div className={styles.root}>
    <label>To <select value={to} disabled={sending} onChange={event => { setTo(event.target.value); setReplyTo(undefined); setQuote(''); }}>
      {options.map(sender => <option key={sender} value={sender}>{sender}</option>)}
    </select></label>
    {replyTo && <p className={styles.message}>Replying to: {quote || replyTo}</p>}
    <label>Message <textarea ref={textarea} rows={3} maxLength={6000} value={text} disabled={sending} onChange={event => setText(event.target.value)} /></label>
    <div><Button size="sm" onClick={() => { void send(); }} disabled={!canPost(text, to, sending)}>Send</Button></div>
    <p className={styles.notice} role="status">{outcome ? postOutcomeText(outcome.status, outcome.cursor) : ''}</p>
  </div>;
}

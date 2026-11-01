import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/primitives/index.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { applyMention, busTargets, mentionCandidates } from './bus-targets-model.js';
import { postBusEnvelope } from './agent-bus-post.js';
import { buildMasonEnvelope, canPost, postOutcomeText, trimPost, type PostOutcome } from './bus-post-model.js';
import styles from './fleet-bus.module.css';

export interface BusPostPrefill { to: string; replyTo: string; quote: string }
export function BusPostBox({ senders, prefill, onPosted }: {
  senders: readonly string[]; prefill: BusPostPrefill | null; onPosted: (cursor: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const visible = sectionVisible && documentVisible && shown;
  const runs = useQuery(opsRunsQuery, { enabled: visible, freshMs: 15_000 }).data;
  const refetch = useRefetch(opsRunsQuery);
  usePollWhileVisible(refetch, 15_000, { enabled: visible });
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const update = () => setShown(!node.closest('[hidden], [inert]'));
    update();
    const observer = new MutationObserver(update);
    for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
      observer.observe(parent, { attributes: true, attributeFilter: ['hidden', 'inert'] });
    }
    return () => observer.disconnect();
  }, []);
  const [caret, setCaret] = useState(0);
  const [closed, setClosed] = useState(false);
  const [selected, setSelected] = useState(0);
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
  const options = busTargets({ senders: [...senders, to], runs });
  const candidates = closed ? null : mentionCandidates(text, caret, runs);
  const items = candidates?.items ?? [];
  const pick = (job: string) => {
    const next = applyMention(text, caret, job);
    setText(next.text); setCaret(next.caret); setClosed(true);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(next.caret, next.caret); });
  };
  return <div ref={root} className={styles.root}>
    <label>To <select value={to} disabled={sending} onChange={event => { setTo(event.target.value); setReplyTo(undefined); setQuote(''); }}>
      {options.filter(group => group.items.length).map(group => <optgroup key={group.group} label={group.group}>
        {group.items.map(item => <option key={item} value={item}>{item}</option>)}
      </optgroup>)}
    </select></label>
    {replyTo && <p className={styles.message}>Replying to: {quote || replyTo}</p>}
    <label>Message <textarea ref={textarea} rows={3} maxLength={6000} value={text} disabled={sending}
      aria-controls={items.length ? 'bus-mentions' : undefined} aria-activedescendant={items.length ? `bus-mention-${Math.min(selected, items.length - 1)}` : undefined}
      onChange={event => { setText(event.target.value); setCaret(event.target.selectionStart); setClosed(false); setSelected(0); }}
      onSelect={event => { const next = event.currentTarget.selectionStart; if (next !== caret) { setCaret(next); setClosed(false); setSelected(0); } }}
      onKeyDown={event => {
        if (!items.length) return;
        if (event.key === 'Escape') { event.preventDefault(); setClosed(true); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
        } else if (event.key === 'Enter') { event.preventDefault(); pick(items[Math.min(selected, items.length - 1)]); }
      }} /></label>
    {items.length > 0 && <ul id="bus-mentions" role="listbox" aria-label="Running jobs">
      {items.map((job, index) => <li id={`bus-mention-${index}`} role="option" aria-selected={index === Math.min(selected, items.length - 1)} key={job}
        onMouseDown={event => event.preventDefault()} onClick={() => pick(job)}>{job}</li>)}
    </ul>}
    <div><Button size="sm" onClick={() => { void send(); }} disabled={!canPost(text, to, sending)}>Send</Button></div>
    <p className={styles.notice} role="status">{outcome ? postOutcomeText(outcome.status, outcome.cursor) : ''}</p>
  </div>;
}

import { useRef, useState } from 'react';
import { readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { envelopeRows } from '../fleet-bus/agent-bus-model.js';
import { postBusEnvelope } from '../fleet-bus/agent-bus-post.js';
import { buildMasonEnvelope, canPost, postOutcomeText, recentSenders, type PostOutcome } from '../fleet-bus/bus-post-model.js';
import { busTargets } from '../fleet-bus/bus-targets-model.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { mobileAgentBusPageQuery } from './agent-bus-page-query.js';
import { runMobileAction } from './mobile-actions.js';
import { canShowActions, useMobile } from './mobile-context.js';
import { Button } from './ui.js';
import { Badge, EmptyState, ErrorState, Row, Section, ui } from './ui-parts.js';

export function AgentBusMessages() {
  const { permissions, reachability } = useMobile();
  const query = useQuery(mobileAgentBusPageQuery);
  const refetch = useRefetch(mobileAgentBusPageQuery);
  usePollWhileVisible(refetch, 10_000, { enabled: query.data !== null });
  const [showAll, setShowAll] = useState(false);
  const [to, setTo] = useState('leaders');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<PostOutcome | null>(null);
  const inFlight = useRef(false);
  const rows = envelopeRows(query.data?.messages ?? [], Date.now()).slice(0, 20);
  const targets = busTargets({ senders: recentSenders(rows), runs: null });
  const disabled = !canShowActions(permissions) || reachability === 'offline' || reachability === 'unreachable';
  const send = () => {
    if (inFlight.current || disabled || !canPost(text, to, sending)) return;
    const envelope = buildMasonEnvelope({ to, text, now: Date.now(), channel: 'phone' });
    runMobileAction({ title: 'Message the bus', consequences: 'Posts your words to the shared agent bus.', confirmLabel: 'Send', confirm: false,
      run: async () => {
        if (inFlight.current) return;
        inFlight.current = true; setSending(true); setOutcome(null);
        try {
          const result = await postBusEnvelope(envelope);
          setOutcome(result);
          if (result.status === 'posted' || result.status === 'duplicate') {
            setText('');
            refetch();
          }
        } finally { inFlight.current = false; setSending(false); }
      },
    });
  };
  return <Section title="Messages" flat>
    {query.data === null ? <p>Durable bus is not reachable from this phone yet</p>
      : query.data === undefined ? query.status === 'error'
        ? <ErrorState title="Couldn’t load messages" reason={readFailureReason(query.error)} onRetry={refetch} />
        : <p role="status">Loading messages…</p>
      : <>
        <div className={ui.group}>
          {rows.slice(0, showAll ? undefined : 5).map(row => <Row key={row.cursor} title={`${row.from} → ${row.to}`}
            subtitle={row.excerpt} trailing={row.ageText} leading={row.from === 'mason' ? <Badge tone="info">you</Badge> : undefined} />)}
          {rows.length > 5 ? <Button variant="tinted" aria-expanded={showAll} onClick={() => setShowAll(value => !value)}>
            {showAll ? 'Show fewer' : `Show all ${rows.length} messages`}
          </Button> : null}
        </div>
        {rows.length === 0 ? <EmptyState title="No messages yet." /> : null}
        <div className={ui.field}>
          <label className={ui.label}>To <select value={to} disabled={sending} onChange={event => setTo(event.target.value)}>
            {targets.filter(group => group.items.length).map(group => <optgroup key={group.group} label={group.group}>
              {group.items.map(target => <option key={target} value={target}>{target}</option>)}
            </optgroup>)}
          </select></label>
          <label className={ui.label}>Message <textarea className={ui.textarea} rows={3} maxLength={6000} value={text}
            disabled={sending || disabled} onChange={event => setText(event.target.value)} /></label>
          <Button variant="primary" disabled={disabled || !canPost(text, to, sending)} onClick={send}>Send</Button>
          <p role="status">{outcome ? postOutcomeText(outcome.status, outcome.cursor) : ''}</p>
        </div>
      </>}
  </Section>;
}

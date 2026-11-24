import { useMemo, useState } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { pullUrl } from '../fleet/job-refs.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { agentNames, byAgent, groupConversations, who, type AgentMessage } from './messages-model.js';
import { showMessagePair, useMessagePair } from './messages-pair.js';
import { agentMessagesQuery, PAIR_LIMIT, pairMessagesQuery } from './messages-query.js';
import styles from './fleet-messages.module.css';

const POLL_MS = 10_000;
const time = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function prHref(pr: string): string | null {
  const m = /^(?:([^#\s]+\/[^#\s]+))?#(\d+)$/.exec(pr);
  return m ? pullUrl(m[1] ?? 'ashlrai/phantom', Number(m[2])) : null;
}

function Message({ message, onOpenJob }: { message: AgentMessage; onOpenJob: (job: string) => void }) {
  const href = message.pr ? prHref(message.pr) : null;
  const inner = <>
    <span className={styles.time}>{time(message.ts)}</span>
    <span className={styles.kind} data-kind={message.kind}>{message.kind}</span>
    <span className={styles.body}>
      <span className={styles.who}>{who(message.from)} → {who(message.to)}: </span>{message.summary}
      {message.job && <span className={styles.refs}> · {message.job}</span>}
    </span>
  </>;
  return <li>
    {message.job
      ? <button type="button" className={styles.message} aria-label={`Open job ${message.job}: ${message.summary}`} onClick={() => onOpenJob(message.job!)}>{inner}</button>
      : <div className={styles.message}>{inner}</div>}
    {href && <a className={styles.refs} href={href} target="_blank" rel="noopener noreferrer">PR {message.pr}</a>}
  </li>;
}

export function MessagesPane({ visible, host }: PaneProps) {
  // A message line selected on the map narrows this pane to that pair's last 20 messages.
  const pair = useMessagePair();
  const query = useMemo(() => pair ? pairMessagesQuery(pair) : agentMessagesQuery, [pair]);
  const read = useQuery(query, { enabled: visible, freshMs: 5_000 });
  const refetch = useRefetch(query);
  usePollWhileVisible(refetch, POLL_MS, { enabled: visible });
  const [agent, setAgent] = useState('');
  const data = read.data;
  const all = useMemo(() => data?.messages ?? [], [data]);
  const conversations = useMemo(() => groupConversations(byAgent(all, pair ? '' : agent)), [all, agent, pair]);
  const names = useMemo(() => agentNames(all), [all]);
  const openJob = (job: string) => { requestWorkerLogJob(job); host.openPane('worker-log'); };

  if (data === undefined && !read.error) return <div className={styles.root} role="status">Reading agent messages…</div>;
  if (!data || data.source === 'unavailable') return <div className={styles.root}><p className={styles.notice} role="status">Agent messages unknown: the agent bus could not be read.</p></div>;
  return <section className={styles.root} aria-label="Agent messages">
    <div className={styles.bar}>
      <h2 className={styles.headline}>{conversations.length} conversation{conversations.length === 1 ? '' : 's'}</h2>
      {pair ? <><span>{pair[0]} ↔ {pair[1]} · last {PAIR_LIMIT} messages</span><button type="button" onClick={() => showMessagePair(null)}>Show all</button></>
        : names.length > 0 && <label>Agent{' '}
        <select value={agent} onChange={event => setAgent(event.target.value)}>
          <option value="">All agents</option>
          {names.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>}
    </div>
    <p className={styles.notice}>Messages as of {read.updatedAt === null ? 'unknown' : <time dateTime={new Date(read.updatedAt).toISOString()}>{new Date(read.updatedAt).toISOString()}</time>}.</p>
    {read.error && <p className={styles.notice} role="status">Refresh failed; showing the last messages, which may be stale.</p>}
    {pair && data.matched > all.length && <p className={styles.notice}>{data.matched - all.length} older messages not read.</p>}
    {data.skipped > 0 && <p className={styles.notice} role="status">Skipped {data.skipped} damaged bus record{data.skipped === 1 ? '' : 's'}.</p>}
    {conversations.length === 0
      ? <p className={styles.quiet}>{pair ? `No messages between ${pair[0]} and ${pair[1]}.` : agent ? `No messages to or from ${agent}.` : 'No agent messages yet. When agents ask, reply or hand off work, it shows here.'}</p>
      : <ul className={styles.conversations}>{conversations.map(c => <li key={c.id} className={styles.conversation} aria-label={`Conversation: ${c.agents.map(a => a.name).join(', ')}`}>
        <h3 className={styles.title}>{c.agents.map(who).join(' ↔ ')} · {c.messages.length} message{c.messages.length === 1 ? '' : 's'}{c.job ? ` · ${c.job}` : ''}</h3>
        <ol className={styles.messages}>{c.messages.map(m => <Message key={m.id} message={m} onOpenJob={openJob} />)}</ol>
      </li>)}</ul>}
  </section>;
}

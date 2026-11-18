/**
 * The Map pane's side panel: the messages between the two nodes on one line.
 * Built only on GET /api/verse/agent-bus/messages, the `phm messages` read, so
 * summaries arrive already scrubbed and nothing here reads the bus itself.
 */
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { Message } from '../fleet-messages/MessagesPane.js';
import type { AgentMessage } from '../fleet-messages/messages-model.js';
import { talkingNowQuery } from '../fleet-messages/messages-query.js';
import messageStyles from '../fleet-messages/fleet-messages.module.css';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { MAP_POLL_MS, pairMessages, type MessagePair } from './map-model.js';
import type { FleetLiveMap } from '../../../../core/fleet/live-map.js';
import styles from './fleet-map.module.css';

/** `more` counts matching messages the read left out; unknown is never shown as empty. */
export type EdgeRead = { state: 'loading' } | { state: 'unknown' } | { state: 'ready'; messages: AgentMessage[]; more: number };

export interface EdgePanelProps { a: string; b: string; minutes: number; read: EdgeRead; onClose: () => void; onOpenJob: (job: string) => void }

export function EdgePanel({ a, b, minutes, read, onClose, onOpenJob }: EdgePanelProps) {
  const n = read.state === 'ready' ? read.messages.length : null;
  return <aside className={styles.panel} aria-label={`Messages between ${a} and ${b}`}>
    <div className={styles.panelHead}>
      <h3 className={styles.headline}>{a} ↔ {b}{n === null ? '' : ` · ${n} message${n === 1 ? '' : 's'}`}</h3>
      {/* The panel opens on a click, so focus follows it. */}
      <button type="button" className={styles.close} onClick={onClose} autoFocus>Close</button>
    </div>
    {read.state === 'loading' && <p className={styles.notice} role="status">Reading messages…</p>}
    {read.state === 'unknown' && <p className={styles.notice} role="status">Messages unknown: the agent bus could not be read.</p>}
    {read.state === 'ready' && (read.messages.length === 0
      ? <p className={styles.notice}>No messages between them in the last {minutes} minutes.</p>
      : <ol className={messageStyles.messages} aria-label="Newest first">
        {read.messages.map(message => <Message key={message.id} message={message} onOpenJob={onOpenJob} />)}
      </ol>)}
    {read.state === 'ready' && read.more > 0 && <p className={styles.notice}>{read.more} older message{read.more === 1 ? '' : 's'} in the window not read; some may belong here.</p>}
    <p className={styles.notice}>Same list for agents: <code>phm messages --since {minutes}m</code></p>
  </aside>;
}

/** The panel wired to the read. It only fetches while a line is open. */
export function EdgeMessages({ map, pair, visible, onClose, onOpenJob }: {
  map: FleetLiveMap; pair: MessagePair; visible: boolean; onClose: () => void; onOpenJob: (job: string) => void;
}) {
  const query = useQuery(talkingNowQuery, { enabled: visible, freshMs: MAP_POLL_MS });
  const refetch = useRefetch(talkingNowQuery);
  usePollWhileVisible(refetch, MAP_POLL_MS, { enabled: visible });
  const data = query.data;
  const read: EdgeRead = data === undefined && !query.error ? { state: 'loading' }
    : !data || data.source === 'unavailable' ? { state: 'unknown' }
      : { state: 'ready', messages: pairMessages(data.messages, map, pair), more: Math.max(0, data.matched - data.messages.length) };
  const label = (id: string) => map.nodes.find(node => node.id === id)?.label ?? 'unknown';
  return <EdgePanel a={label(pair.a)} b={label(pair.b)} minutes={map.windowMinutes} read={read} onClose={onClose} onOpenJob={onOpenJob} />;
}

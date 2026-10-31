import { Button, SkeletonLine } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { requestInboxChannel } from '../fleet-inbox/inbox-source-request.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { channelPresenceLine, deriveChannelPresence, leaderPassMs, presenceForChannel } from './channel-last-seen.js';
import { KNOWN_CHANNELS, rollupChannels } from './fleet-channels-model.js';
import { fleetChannelsQuery } from './fleet-channels-queries.js';
import styles from './fleet-channels.module.css';

export function FleetChannelsPane({ visible, host }: PaneProps) {
  const read = useQuery(fleetChannelsQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(fleetChannelsQuery);
  usePollWhileVisible(refetch, 15_000, { enabled: visible });
  const nowMs = Date.now();
  const data = rollupChannels(read.data, nowMs);

  if (read.data === null || (read.error instanceof ApiError && read.error.status === 404)) return <p className={styles.message}>Live runs not in this build</p>;
  if (read.data === undefined) return <div className={styles.root} role="status">{read.status === 'error' ? 'Live runs are unavailable.' : <><span>Reading live runs…</span><SkeletonLine /><SkeletonLine /></>}</div>;
  if (!data) return <p className={styles.message} role="status">Live runs are unavailable.</p>;
  const heard = KNOWN_CHANNELS.length - data.silent.length;
  const last24hTotal = data.rows.reduce((sum, row) => sum + row.last24h, 0);
  const snapshot = read.data && typeof read.data === 'object' && !Array.isArray(read.data) ? read.data as Record<string, unknown> : null;
  const presence = deriveChannelPresence(snapshot?.inbox, snapshot?.leaders, snapshot?.generatedAt, nowMs, KNOWN_CHANNELS);
  const passMs = leaderPassMs(snapshot?.leaders, snapshot?.generatedAt);
  return <section className={styles.root} aria-label="Channels overview">
    <p className={styles.header}>{heard} of {KNOWN_CHANNELS.length} channels heard from · {last24hTotal} messages in 24 h</p>
    {data.sourceState !== 'healthy' && <p className={styles.notice} role="status">Inbox data may be incomplete.</p>}
    {read.status === 'error' && <p className={styles.notice} role="status">Live runs could not refresh. Showing the last reading.</p>}
    <ul className={styles.list} aria-label="Channels">{data.rows.map(row => <li className={styles.row} key={row.key}>
      <div className={styles.meta}><strong>{row.label}</strong>{' '}<span>{row.lastAt ? <>last <time dateTime={row.lastAt} title={new Date(row.lastAt).toLocaleString()}>{formatRelative(row.lastAt)}</time></> : 'never'}</span></div>
      <span className={styles.counts}>{row.lastHour} / 1 h · {row.last24h} / 24 h</span>
      <p className={styles.presence}>{channelPresenceLine(presenceForChannel(presence, row.key, KNOWN_CHANNELS), passMs)}</p>
      {row.preview !== null && <p className={styles.preview}>{row.preview}</p>}
      <Button size="sm" onClick={() => { requestInboxChannel(row.key); host.openPane('fleet-inbox'); }}>Open inbox</Button>
    </li>)}</ul>
    {data.silent.length > 0 && <p className={styles.message}>Silent: {data.silent.join(', ')}</p>}
  </section>;
}

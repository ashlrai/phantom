/**
 * routes/verse/channels/ChannelsPane.tsx — one card per messaging channel the
 * owner reaches the Leader on, failing first. Rows, order, wording and the
 * masked addresses all come from GET /api/channels (phantom.channels.v1) —
 * the same view `phm channels --json` prints — so the pane decides nothing
 * an agent cannot read. 'unknown' stays 'unknown'.
 */
import {
  CHANNELS_OVERVIEW_SCHEMA,
  CHANNELS_PATH,
  type ChannelOverviewRow,
  type ChannelOverviewState,
  type ChannelsOverview,
} from '../../../../core/fleet/channels-schema.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { CopyPill } from '../apps/CopyPill.js';
import { formatRelative } from '../autonomy/format.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { RulesCard } from './RulesCard.js';
import styles from './channels.module.css';

export const channelsQuery: QueryDef<ChannelsOverview> = {
  key: 'channels-overview',
  fetch: async (signal) => {
    const data = await apiGet<ChannelsOverview>(CHANNELS_PATH, signal);
    // A drifted payload is loud, not a blank list.
    if (data?.schema !== CHANNELS_OVERVIEW_SCHEMA || !Array.isArray(data.channels)) throw new Error(`Expected ${CHANNELS_OVERVIEW_SCHEMA}`);
    return data;
  },
};

const STATE_LABEL: Record<ChannelOverviewState, string> = {
  connected: 'Connected', 'not-set-up': 'Not set up', failing: 'Failing', unknown: 'Unknown',
};

function when(value: string | null | 'unknown', nowMs: number): string {
  if (value === null) return 'never';
  if (value === 'unknown') return 'unknown';
  return formatRelative(value, nowMs);
}

const count = (value: number | 'unknown'): string => (value === 'unknown' ? 'unknown' : String(value));

/** The first `code span` in a next step is the command to copy. */
function nextCommand(next: string): string | null {
  const m = /`([^`]+)`/.exec(next);
  return m ? m[1]! : null;
}

function ChannelCard({ row, nowMs }: { row: ChannelOverviewRow; nowMs: number }) {
  const command = row.next ? nextCommand(row.next) : null;
  return <li className={styles.card} data-state={row.state} aria-label={`${row.label}: ${STATE_LABEL[row.state]}`}>
    <div className={styles.head}>
      <strong className={styles.name}>{row.label}</strong>
      <span className={styles.badge}>{STATE_LABEL[row.state]}</span>
    </div>
    {row.reason ? <p className={styles.reason}>{row.state === 'unknown' ? `unknown: ${row.reason}` : row.reason}</p> : null}
    <dl className={styles.facts}>
      <div><dt>Last in</dt><dd>{when(row.lastInboundAt, nowMs)}</dd></div>
      <div><dt>Last out</dt><dd>{when(row.lastOutboundAt, nowMs)}</dd></div>
      <div><dt>Last 24 h</dt><dd>{count(row.messages24h)}</dd></div>
      <div><dt>Verified</dt><dd>{row.verifiedSenders === null ? 'built in' : count(row.verifiedSenders)}</dd></div>
      {row.address ? <div className={styles.wide}><dt>Address</dt><dd className={styles.mono}>{row.address}</dd></div> : null}
    </dl>
    {row.next ? <p className={styles.next} data-testid="channel-next">
      <span>Next: {row.next.replace(/`/g, '')}</span>
      {command ? <CopyPill text={command} label="Copy" what={`the ${row.label} next step`} /> : null}
    </p> : null}
  </li>;
}

function headline(view: ChannelsOverview): string {
  const { connected, failing, unknown } = view.counts;
  const notSetUp = view.counts['not-set-up'];
  const parts = [`${connected} connected`];
  if (failing) parts.push(`${failing} failing`);
  if (unknown) parts.push(`${unknown} unknown`);
  if (notSetUp) parts.push(`${notSetUp} not set up`);
  return `${parts.join(' · ')}.`;
}

export function ChannelsPane({ visible }: PaneProps) {
  const read = useQuery(channelsQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(channelsQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible });
  const view = read.data;
  if (!view) return <p className={styles.message} role="status">{read.status === 'error' ? 'Channels are unavailable.' : 'Reading channels…'}</p>;
  const nowMs = Date.now();
  return <section className={styles.root} aria-label="Channels">
    <p className={styles.headline}>{headline(view)}</p>
    {read.status === 'error' ? <p className={styles.message} role="alert">Could not refresh. Showing the last reading.</p> : null}
    <ul className={styles.grid}>{view.channels.map((row) => <ChannelCard key={row.channel} row={row} nowMs={nowMs} />)}</ul>
    <p className={styles.message}>Addresses are masked. Same data: <code>phm channels --json</code>.</p>
    <RulesCard visible={visible} />
  </section>;
}

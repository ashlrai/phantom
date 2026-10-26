import type { AgentCard } from '../../../core/verse/agents/types.js';
import { useQuery, useRefresh, useRefetch } from '../../data/hooks.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { agentsBoardQuery, AGENTS_POLL_MS } from '../verse/agents/agents-queries.js';
import { usePollWhileVisible } from '../verse/shell/section-visibility.js';
import styles from './ControlRoom.module.css';

/** Aggregate only: PostHog credentials, event properties and raw responses stay outside the view. */
export interface PostHogMergeCost {
  source: 'posthog';
  spentUsd: number;
  mergedPrs: number;
  from: string;
  to: string;
}

export function mergeCostLabel(metric: PostHogMergeCost | null): string {
  if (!metric || metric.source !== 'posthog' || !Number.isFinite(metric.spentUsd) || metric.spentUsd < 0 ||
      !Number.isSafeInteger(metric.mergedPrs) || metric.mergedPrs <= 0 ||
      !Number.isFinite(Date.parse(metric.from)) || !Number.isFinite(Date.parse(metric.to)) ||
      Date.parse(metric.from) >= Date.parse(metric.to)) return 'Unavailable';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(metric.spentUsd / metric.mergedPrs);
}

const BLOCKED: Readonly<Partial<Record<AgentCard['reason'], string>>> = {
  failed: 'Turn failed',
  'plan-ready': 'Plan approval needed',
  'spend-cap': 'Spend cap reached',
  'setup-failed': 'Setup failed',
  'ci-failed': 'CI failed',
  'merge-blocked': 'Merge blocked',
};

export function ControlRoomRoster({ cards, metric = null }: { cards: readonly AgentCard[]; metric?: PostHogMergeCost | null }) {
  const live = cards.filter((card) => !card.archived && card.column !== 'done');
  const cost = mergeCostLabel(metric);
  return (
    <div className={styles.body}>
      <p>{live.length} live agents · {live.filter((card) => BLOCKED[card.reason]).length} blocked</p>
      <dl className={styles.metric}>
        <dt>$ per merged PR · PostHog</dt>
        <dd>{cost}</dd>
      </dl>
      {cost === 'Unavailable' ? <p className={styles.note}>No verified PostHog merge-cost aggregate is connected.</p> : metric ? (
        <p className={styles.note}>{metric.mergedPrs} merged PRs · {new Date(metric.from).toISOString().slice(0, 10)} – {new Date(metric.to).toISOString().slice(0, 10)}</p>
      ) : null}
      {live.length === 0 ? <p>No live agents.</p> : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <caption className={styles.note}>Active agents and their assigned seats</caption>
            <thead><tr><th scope="col">Agent</th><th scope="col">Pool / seat</th><th scope="col">State</th></tr></thead>
            <tbody>{live.map((card) => (
              <tr key={card.id}>
                <th scope="row">{card.title}</th>
                <td>{card.seatId ?? 'Unassigned'}</td>
                <td>{BLOCKED[card.reason] ? <strong className={styles.blocked}>Blocked · {BLOCKED[card.reason]}</strong> : card.status === 'running' ? 'Running' : 'Waiting'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ControlRoom() {
  const read = useQuery(agentsBoardQuery);
  const poll = useRefetch(agentsBoardQuery);
  const refresh = useRefresh(agentsBoardQuery);
  usePollWhileVisible(poll, AGENTS_POLL_MS);
  return (
    <section className={styles.panel} aria-labelledby="control-room-title">
      <header className={styles.header}>
        <h2 id="control-room-title">Control room</h2>
        {read.status === 'refreshing' ? <RefreshIndicator /> : null}
        <button type="button" onClick={refresh}>Refresh agents</button>
      </header>
      {read.error ? <p role="alert" className={styles.body}>Agent roster unavailable{read.data ? '; showing the last received roster.' : '.'}</p> : null}
      {read.data ? <ControlRoomRoster cards={read.data.cards} /> : read.status !== 'error' ? <p role="status" className={styles.body}>Loading agents…</p> : null}
    </section>
  );
}

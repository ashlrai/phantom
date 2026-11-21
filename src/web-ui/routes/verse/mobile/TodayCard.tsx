/**
 * "Today": the phone's first answer to "is it working?". Four blocks, top to bottom: one plain sentence, what is running
 * now (tap a lane to open Live runs), the pools that are empty and when they come back, and the open asks with their
 * one-tap replies. Everything comes from buildToday (`phm today --json` prints the same); the asks block is AsksCard,
 * which posts through the existing verified-Mason answer route, so there is no new auth or send path.
 */
import type { HomeSummary } from '../../../../core/fleet/home.js';
import { buildToday } from '../../../../core/fleet/today.js';
import { useQuery } from '../../../data/hooks.js';
import { fleetPoolsQuery } from '../fleet-pools/pools-query.js';
import { AsksCard } from './AsksCard.js';
import { asksBatchQuery } from './asks-card-queries.js';
import { useMobile } from './mobile-context.js';
import { SkeletonList } from './ui.js';
import { Badge, Row, Section } from './ui-parts.js';

/** `home` is Home's own read (`phm home`), passed in so the screen reads it once. */
export function TodayCard({ home }: { home: HomeSummary | null }) {
  const { navigate } = useMobile();
  const pools = useQuery(fleetPoolsQuery);
  const asks = useQuery(asksBatchQuery);

  const loading = [pools, asks].every((q) => q.status === 'loading' || q.status === 'idle');
  if (loading && home === null) return <Section title="Today"><SkeletonList rows={3} label="Loading today" /></Section>;
  const today = buildToday({ home, pools: pools.data ?? null, asks: asks.data ?? null }, Date.now());
  return (
    <div>
      <Section title="Today">
        <Row title={today.sentence} />
      </Section>
      <Section title="Running now">
        {today.running.lanes.length === 0 ? <Row title={today.running.total === null ? 'Running jobs unknown' : 'Nothing is running'} /> : today.running.lanes.map((lane) => (
          <Row key={lane.lane} title={lane.lane} trailing={<Badge tone={lane.running > 0 ? 'success' : 'neutral'}>{lane.running}</Badge>}
            onClick={() => navigate({ screen: 'runs' })} label={`Open Live runs for ${lane.lane}`} />
        ))}
      </Section>
      <Section title="Empty pools">
        {today.emptyPools === null ? <Row title="Pools unknown right now" />
          : today.emptyPools.length === 0 ? <Row title="Every pool has room." />
          : today.emptyPools.map((pool) => <Row key={pool.id} title={pool.label} trailing={<Badge tone="warning">{pool.returns}</Badge>} />)}
      </Section>
      <AsksCard />
    </div>
  );
}

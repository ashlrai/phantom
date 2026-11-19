import { useQuery, useRefetch } from '../../../data/hooks.js';
import { fleetPoolsQuery } from '../fleet-pools/pools-query.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { poolPaceLines } from './pool-pace-model.js';
import { Badge, Row, Section } from './ui-parts.js';

/** Home: one plain line per pool that needs a decision (slow down, add work). Quiet when every pool is on pace. */
export function PoolPaceCard() {
  const query = useQuery(fleetPoolsQuery);
  const refetch = useRefetch(fleetPoolsQuery);
  usePollWhileVisible(refetch, 60_000);
  const lines = poolPaceLines(query.data);
  if (lines.length === 0) return null;
  return (
    <Section title="Pool pace" footer="Same words as phm pools.">
      {lines.map(line => <Row key={line.id} title={line.words} trailing={<Badge tone={line.tone}>{line.tone === 'danger' ? 'Slow down' : line.tone === 'warning' ? 'Add work' : 'Waiting'}</Badge>} />)}
    </Section>
  );
}

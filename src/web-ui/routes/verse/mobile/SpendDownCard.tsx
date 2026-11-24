import { useQuery, useRefetch } from '../../../data/hooks.js';
import { SpendDownChart, paceQuery, spendDownQuery } from '../resources/SpendDownChart.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { Section } from './ui-parts.js';

/** Home: every plan's usage spent down before it resets. Same JSON as `phm pools spenddown`; quiet while unread or empty. */
export function SpendDownCard() {
  const query = useQuery(spendDownQuery);
  const refetch = useRefetch(spendDownQuery);
  const pace = useQuery(paceQuery);
  const refetchPace = useRefetch(paceQuery);
  usePollWhileVisible(() => { refetch(); refetchPace(); }, 60_000);
  if (!query.data || query.data.pools.length === 0) return null;
  return <Section title="Pools" footer="Same readings as phm pools spenddown and phm fleet pace."><SpendDownChart data={query.data} pace={pace.data} /></Section>;
}

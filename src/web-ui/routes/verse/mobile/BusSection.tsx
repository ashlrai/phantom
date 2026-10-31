import { useState } from 'react';
import { readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { ago } from '../command/ladder-model.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { BusRefs } from './BusRefs.js';
import { busLiteQuery } from './bus-query.js';
import { useMobile } from './mobile-context.js';
import { Button } from './ui.js';
import { Badge, EmptyState, ErrorState, Row, Section, ui } from './ui-parts.js';

export function BusSection() {
  const { navigate } = useMobile();
  const query = useQuery(busLiteQuery);
  const refetch = useRefetch(busLiteQuery);
  const [showAll, setShowAll] = useState<boolean>(false);
  usePollWhileVisible(refetch, 10_000, { enabled: query.data !== null });
  if (query.data === null || (query.data === undefined && query.status !== 'error')) return null;
  if (query.data === undefined) {
    return <Section title="Bus" flat><ErrorState title="Couldn’t load bus activity" reason={readFailureReason(query.error)} onRetry={refetch} /></Section>;
  }
  const data = query.data;
  const unavailable = (['hops', 'events'] as const).filter((name) => data.sources[name] !== 'healthy');
  const footer = unavailable.length ? `Some bus data may be incomplete: ${unavailable.map((name) => `${name} ${data.sources[name]}`).join(', ')}.` : undefined;
  const count = (n: number | null) => n === null ? '—' : n.toLocaleString();
  const now = Date.now();
  return (
    <Section title="Bus" flat footer={footer}>
      <div className={ui.group}>
        <Row title={`${count(data.hops)} hops · in ${count(data.inputTokens)} / out ${count(data.outputTokens)} tokens`} />
        {data.events.slice(0, showAll ? undefined : 25).map((event, i) => (
          <Row key={`${event.at}-${i}`} leading={<Badge tone={event.kind === 'inbox' ? 'info' : 'neutral'}>{event.kind === 'inbox' ? 'You' : event.kind}</Badge>}
            title={<BusRefs text={event.text} onOpenJob={(job) => navigate({ screen: 'worker', job })} />} trailing={ago(event.at, now)} />
        ))}
        {data.events.length > 25 ? (
          <Button variant="tinted" aria-expanded={showAll} onClick={() => setShowAll(v => !v)}>
            {showAll ? 'Show fewer' : `Show all ${data.events.length} events`}
          </Button>
        ) : null}
      </div>
      {data.events.length === 0 ? <EmptyState title="No bus activity yet." /> : null}
    </Section>
  );
}

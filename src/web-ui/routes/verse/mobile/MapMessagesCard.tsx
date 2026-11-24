import { readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { fleetMapMessagesQuery } from '../../control/fleet/fleet-map-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { ErrorState, Row, Section } from './ui-parts.js';
import { SkeletonList } from './ui.js';

export const PHONE_MESSAGE_LINES = 10;

/** The last 10 agent-to-agent messages as plain lines: "claude to codex (ask): short summary". */
export function MapMessagesCard() {
  const query = useQuery(fleetMapMessagesQuery);
  const refetch = useRefetch(fleetMapMessagesQuery);
  usePollWhileVisible(refetch, 15_000);
  const rows = query.data?.messages.slice(0, PHONE_MESSAGE_LINES);
  return (
    <Section title="Agent messages">
      {rows ? (rows.length === 0 ? <Row title="No agent messages lately" /> : rows.map((m) => (
        <Row key={m.id} title={`${m.from} to ${m.to} (${m.kind})`} subtitle={m.summary} trailing={m.at.slice(11, 16)} />
      ))) : query.status === 'error' ? (
        <ErrorState title="Couldn’t read agent messages" reason={readFailureReason(query.error)} onRetry={refetch} />
      ) : <SkeletonList rows={2} label="Loading agent messages" />}
    </Section>
  );
}

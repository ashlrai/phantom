import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { readLeaderPasses } from './leader-passes-model.js';
import { leaderPassesQuery } from './leader-passes-query.js';
import { Badge, Row, Section } from './ui-parts.js';

export function LeaderPasses() {
  const query = useQuery(leaderPassesQuery, { freshMs: 15_000 });
  const refetch = useRefetch(leaderPassesQuery);
  usePollWhileVisible(refetch, 15_000);
  if (query.status === 'error' && query.error instanceof ApiError && query.error.status === 404) {
    return <Section title="Leader passes on the Mac"><Row title="Live runs not in this build" /></Section>;
  }
  const failed = query.status === 'error';
  const view = readLeaderPasses(failed ? undefined : query.data, Date.now());
  const note = failed ? 'Live runs could not be refreshed.' : view.sourceState !== 'healthy' && query.data !== undefined ? 'Some live run sources are unavailable; showing what is known.' : undefined;
  return (
    <Section title="Leader passes on the Mac" footer={note}>
      <Row title={<Badge tone={view.tone}>{view.headline}</Badge>} />
      {view.passes.map((pass, index) => <Row key={`${pass.label}-${index}`} title={pass.label} trailing={<>{pass.age} · <span data-tone={pass.eta.kind === 'unknown' ? 'neutral' : pass.tone}><Badge tone={pass.eta.kind === 'unknown' ? 'neutral' : pass.tone === 'ok' ? 'success' : pass.tone}>{pass.dueText}</Badge></span></>} />)}
      <Row title="Orchestrator" trailing={view.agents === null ? '—' : `${view.agents} ${view.agents === 1 ? 'agent' : 'agents'}`} />
      <Row title="Last dispatcher tick" trailing={view.lastTick.text} />
      <Row title="Claude lane" trailing={view.claudeLane.down ? <Badge tone="danger">Claude lane down</Badge> : /^(healthy|up|ready|active|paused|held)$/i.test(view.claudeLane.text?.trim() ?? '') ? view.claudeLane.text?.trim() : '—'} />
    </Section>
  );
}

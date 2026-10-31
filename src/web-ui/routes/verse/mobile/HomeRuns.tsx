import { readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { homeRunsView } from './home-runs-model.js';
import { homeRunsQuery } from './home-runs-query.js';
import { mergeLabel, prUrl } from './merge-link.js';
import { useMobile } from './mobile-context.js';
import { SkeletonList } from './ui.js';
import { Badge, Row, Section, ui } from './ui-parts.js';

export function HomeRuns() {
  const { navigate } = useMobile();
  const query = useQuery(homeRunsQuery);
  const refetch = useRefetch(homeRunsQuery);
  usePollWhileVisible(refetch, 10_000);

  if (query.status !== 'error' && query.data === null) return null;
  const view = query.data ? homeRunsView(query.data, Date.now()) : null;
  return (
    <Section title="Fleet now" trailing={view?.incident ? <Badge tone="danger">{view.incident}</Badge> : undefined}>
      {query.status === 'error' ? (
        <Row title={<span className={ui.muted}>Fleet numbers unavailable: {readFailureReason(query.error)}</span>} />
      ) : !view ? (
        <SkeletonList rows={3} label="Loading fleet numbers" />
      ) : <>
        <Row title={view.headline} subtitle={view.tick} onClick={() => navigate({ screen: 'fleet' })} />
        {view.lanes.map((lane) => <Row key={lane.lane} title={lane.lane} subtitle={lane.tone === 'danger' ? (lane.heldReason ? `held: ${lane.heldReason.replace(/_/g, ' ')}` : undefined) : (lane.merged24h != null ? `${lane.merged24h} merged today` : undefined)} trailing={<Badge tone={lane.tone}>{lane.text}</Badge>} onClick={() => navigate({ screen: 'runs' })} label={`Open Live runs for ${lane.lane}`} />)}
        <Row title={view.merges} />
        {query.data?.mergesLastHour.items?.map((merge, i) => {
          const url = prUrl(merge);
          const row = <Row title={mergeLabel(merge)} />;
          return url ? <a key={i} href={url} target="_blank" rel="noopener noreferrer">{row}</a> : <div key={i}>{row}</div>;
        })}
        {view.codex ? <Row title={view.codex} /> : null}
      </>}
    </Section>
  );
}

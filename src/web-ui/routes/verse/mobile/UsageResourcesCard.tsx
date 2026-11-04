/**
 * routes/verse/mobile/UsageResourcesCard.tsx — the "Every resource" list in
 * pocket form (RQ-NIGHT-USAGE-1): the same twelve rows as the desktop panel,
 * one mobile Row each. A resource with no reader reads "No reader yet" —
 * never a number.
 */
import { readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { formatRelative } from '../autonomy/format.js';
import { narrowUsageResources, resourceRows, type ResourceRowView } from '../usage/usage-resources-model.js';
import { usageResourcesQuery } from '../usage/usage-queries.js';
import { Badge, ErrorState, Row, Section } from './ui-parts.js';
import { SkeletonList } from './ui.js';

function ResourceRow({ view }: { view: ResourceRowView }): React.ReactNode {
  if (view.state !== 'ok') {
    return (
      <Row
        title={view.label}
        subtitle={view.state === 'unavailable' ? `${view.stateText}${view.sourceText ? ` — ${view.sourceText}` : ''}` : view.stateText}
        trailing={null}
      />
    );
  }
  const facts = [
    view.resetText !== '—' ? view.resetText : null,
    view.sourceText,
    view.asOfText,
  ].filter(Boolean).join(' · ');
  return (
    <Row
      title={view.label}
      subtitle={facts || undefined}
      trailing={<Badge tone={view.percent !== null && view.percent >= 90 ? 'danger' : view.percent !== null && view.percent >= 70 ? 'warning' : 'neutral'}>{view.amountText ?? '—'}</Badge>}
      label={`${view.label}: ${view.amountText ?? 'unknown'}${view.resetText !== '—' ? `, resets ${view.resetText}` : ''}`}
    />
  );
}

export function UsageResourcesCard() {
  const query = useQuery(usageResourcesQuery);
  const refetch = useRefetch(usageResourcesQuery);
  usePollWhileVisible(refetch, 60_000);
  const now = Date.now();

  const wire = narrowUsageResources(query.data?.available ? query.data.raw : null);
  const footer = wire ? `as of ${formatRelative(wire.generatedAt, now)}` : undefined;

  return (
    <Section title="Every resource" footer={footer}>
      {query.status === 'idle' || query.status === 'loading' ? (
        <SkeletonList rows={3} label="Loading resources" />
      ) : query.status === 'error' ? (
        <ErrorState title="Couldn’t read resources" reason={readFailureReason(query.error)} onRetry={refetch} />
      ) : !wire ? (
        <Row title={query.data && !query.data.available ? (query.data.reason ?? 'Resources unavailable on this server') : 'Resources payload unreadable'} />
      ) : (
        resourceRows(wire, now).map((view) => <ResourceRow key={view.id} view={view} />)
      )}
    </Section>
  );
}

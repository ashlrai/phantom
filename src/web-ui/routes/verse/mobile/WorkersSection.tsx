import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { sinceText } from './connectivity.js';
import { Button } from './ui.js';
import { Badge, EmptyState, Row, Section, ui } from './ui-parts.js';
import { workerRows } from './workers-model.js';
import { workersQuery } from './workers-query.js';

export function WorkersSection() {
  const query = useQuery(workersQuery);
  const refetch = useRefetch(workersQuery);
  const refresh = useRefresh(workersQuery);
  usePollWhileVisible(refetch, 15_000, { enabled: query.data !== null });

  if (query.data === null || (query.data === undefined && query.status !== 'error')) return null;
  const view = query.data ? workerRows(query.data, Date.now()) : null;
  return (
    <Section title="Fleet workers" flat>
      <details open>
        <summary>{view?.summary ?? 'Workers unavailable'}</summary>
        {query.status === 'error' ? <p role="status">Couldn’t refresh workers. {sinceText(query.updatedAt)}.</p> : null}
        <Button variant="tinted" onClick={refresh}>Refresh</Button>
        {view && view.rows.length === 0 ? <EmptyState title="No workers running" /> : null}
        {view && view.rows.length > 0 ? <div className={ui.group}>
          {view.rows.slice(0, 20).map((worker, index) => (
            <Row key={`${worker.job}-${index}`} title={<code>{worker.job}</code>} subtitle={`${worker.lane} · ${worker.tier}`}
              trailing={<span data-tone={worker.tone}><Badge tone={worker.tone === 'bad' ? 'danger' : worker.tone === 'warn' ? 'warning' : worker.tone === 'ok' ? 'success' : 'neutral'}>{worker.ageText}</Badge></span>} />
          ))}
          {view.rows.length > 20 ? <Row title={`+${view.rows.length - 20} more`} /> : null}
        </div> : null}
      </details>
    </Section>
  );
}

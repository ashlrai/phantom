import { useState } from 'react';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useMobile } from './mobile-context.js';
import { sinceText } from './connectivity.js';
import { Button } from './ui.js';
import { Badge, EmptyState, Row, Section, ui } from './ui-parts.js';
import { stuckCount, workerRows } from './workers-model.js';
import { workersQuery } from './workers-query.js';

export function WorkersSection() {
  const { navigate } = useMobile();
  const query = useQuery(workersQuery);
  const refetch = useRefetch(workersQuery);
  const refresh = useRefresh(workersQuery);
  const [showAll, setShowAll] = useState<boolean>(false);
  usePollWhileVisible(refetch, 15_000, { enabled: query.data !== null });

  if (query.data === null || (query.data === undefined && query.status !== 'error')) return null;
  const view = query.data ? workerRows(query.data, Date.now()) : null;
  const stuck = view ? stuckCount(view.rows) : 0;
  return (
    <Section title="Fleet workers" flat>
      <details open>
        <summary><span>{view?.summary ?? 'Workers unavailable'}</span>{stuck > 0 ? <span>{` · ${stuck} look stuck`}</span> : null}</summary>
        {query.status === 'error' ? <p role="status">Couldn’t refresh workers. {sinceText(query.updatedAt)}.</p> : null}
        <Button variant="tinted" onClick={refresh}>Refresh</Button>
        {view && view.rows.length === 0 ? <EmptyState title="No workers running" /> : null}
        {view && view.rows.length > 0 ? <div className={ui.group}>
          {(showAll ? view.rows : view.rows.slice(0, 20)).map((worker, index) => (
            <Row key={`${worker.job}-${index}`} title={<code>{worker.job}</code>} label={`Open worker ${worker.job}${worker.ageNote ? `, ${worker.ageNote}` : ''}`} onClick={() => navigate({ screen: 'worker', job: worker.job })} subtitle={`${worker.lane} · ${worker.tier}`}
              trailing={<><span data-tone={worker.tone}><Badge tone={worker.tone === 'bad' ? 'danger' : worker.tone === 'warn' ? 'warning' : worker.tone === 'ok' ? 'success' : 'neutral'}>{worker.ageText}</Badge></span>{worker.ageState !== 'normal' ? <span title={worker.ageNote ?? undefined}><Badge tone={worker.ageState === 'stuck' ? 'danger' : 'warning'}>{worker.ageState}</Badge></span> : null}</>} />
          ))}
          {view.rows.length > 20 ? (
            <Button variant="tinted" aria-expanded={showAll} onClick={() => setShowAll(v => !v)}>
              {showAll ? 'Show fewer' : `Show all ${view.rows.length} workers`}
            </Button>
          ) : null}
        </div> : null}
      </details>
    </Section>
  );
}

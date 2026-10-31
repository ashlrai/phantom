import { useMemo } from 'react';
import { ApiError, readFailureReason } from '../../../../data/client.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import { isRemoteMobileMode } from '../../../../data/remote-mode.js';
import { metaLine, pollMs, prLabel, safePrUrl, stateTone } from '../../fleet-job-log/worker-log-model.js';
import { jobDetailQuery } from '../../fleet-job-log/worker-log-queries.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { homeRunsQuery } from '../home-runs-query.js';
import { useMobile } from '../mobile-context.js';
import { workerFromSnapshot } from '../worker-snapshot-model.js';
import { Screen, SkeletonList } from '../ui.js';
import { Badge, EmptyState, ErrorState, Row, Section, ui } from '../ui-parts.js';
import styles from './WorkerScreen.module.css';

export function WorkerScreen({ job }: { job: string }) {
  const { navigate } = useMobile();
  const def = useMemo(() => jobDetailQuery(job), [job]);
  const query = useQuery(def);
  const refetch = useRefetch(def);
  const detail = query.data;
  const failed = query.status === 'error';
  const gatewayUnavailable = (query.error instanceof ApiError && [401, 403].includes(query.error.status))
    || (isRemoteMobileMode() && (failed || detail === null));
  const snapshotQuery = useQuery(homeRunsQuery, { enabled: gatewayUnavailable || detail === null });
  const refetchSnapshot = useRefetch(homeRunsQuery);
  usePollWhileVisible(refetchSnapshot, 15_000, { enabled: gatewayUnavailable || detail === null });
  usePollWhileVisible(refetch, pollMs(detail), { enabled: detail !== null && !gatewayUnavailable });

  let body;
  if (gatewayUnavailable || detail === null) {
    const worker = workerFromSnapshot(snapshotQuery.data, job, Date.now());
    body = <>
      {worker ? <Section title="Worker (from the fleet snapshot)">
        <Row title="Repo" trailing={worker.repo ?? '—'} />
        <Row title="Lane" trailing={worker.lane ?? '—'} />
        <Row title="Tier" trailing={worker.tier ?? '—'} />
        <Row title="State" trailing={worker.mergedAs ? `${worker.state} · ${worker.mergedAs}` : worker.state} />
        <Row title="Age" trailing={worker.ageText ?? '—'} />
        <Row title="Pull request" trailing={worker.prUrl ? <a href={worker.prUrl} target="_blank" rel="noopener noreferrer">{prLabel(worker.prUrl)}</a> : '—'} />
      </Section> : snapshotQuery.status === 'idle' || snapshotQuery.status === 'loading'
        ? <SkeletonList rows={4} label="Loading fleet snapshot" />
        : snapshotQuery.status === 'error' && !snapshotQuery.data
          ? <ErrorState title="Couldn’t load fleet snapshot" reason={readFailureReason(snapshotQuery.error)} onRetry={refetchSnapshot} />
          : <EmptyState title="This job is not in the current fleet snapshot." />}
      {detail === null && !gatewayUnavailable ? <p className={ui.muted}>Job detail is not in this build yet</p> : null}
      <p className={ui.muted}>Worker logs are not available through this gateway yet. Open Phantom on your Mac.</p>
    </>;
  } else if (failed) {
    body = <ErrorState title="Couldn’t load worker" reason={readFailureReason(query.error)} onRetry={refetch} />;
  } else if (detail === undefined) {
    body = <SkeletonList rows={4} label="Loading worker" />;
  } else {
    const pr = safePrUrl(detail.publish?.prUrl);
    const tone = stateTone(detail.state);
    body = <>
      <Section title="Worker">
        <Row title="Lane" trailing={detail.lane ?? '—'} />
        <Row title="Tier" trailing={detail.tier ?? '—'} />
        <Row title="Model" trailing={detail.model ?? '—'} />
        <Row title="State" trailing={<Badge tone={tone === 'unknown' ? 'neutral' : tone}>{detail.state ?? 'unknown'}</Badge>} />
        <Row title="Launched / age" subtitle={metaLine(detail, Date.now())} />
        <Row title="Pull request" trailing={pr ? <a href={pr} target="_blank" rel="noopener noreferrer">{prLabel(pr)}</a> : '—'} />
      </Section>
      <Section title="Log tail" flat>
        <pre className={styles.tail} aria-label="Worker log tail">{detail.log?.tail?.length ? detail.log.tail.join('\n') : 'No log lines available yet.'}</pre>
      </Section>
    </>;
  }
  return <Screen title={job} onBack={() => navigate({ screen: 'runs' })} onRefresh={gatewayUnavailable || detail === null ? refetchSnapshot : refetch}>{body}</Screen>;
}

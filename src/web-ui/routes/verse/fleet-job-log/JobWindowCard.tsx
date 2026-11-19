import { useMemo } from 'react';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { buildJobWindow, safeJobPrUrl, UNKNOWN, type FleetJobWindowV1, type JobWindowState } from '../../../../core/fleet/job-window.js';
import { jobWindowQuery } from './job-window-query.js';
import type { FleetJobDetailV1 } from './worker-log-model.js';
import styles from './job-window-card.module.css';

const TONE: Record<JobWindowState, Tone> = {
  running: 'running', 'finished-pr': 'success', 'finished-empty': 'neutral', stopped: 'warning', unknown: 'unknown',
};

/** The same window from an older `fleet.job.v1` detail: repo and finish time stay unknown. */
function windowFromDetail(job: string, detail: FleetJobDetailV1): FleetJobWindowV1 {
  return buildJobWindow({
    job, detailState: detail.state, lane: detail.lane, model: detail.model, tier: detail.tier,
    startedAt: detail.launchedAt, prUrl: detail.publish?.prUrl,
  });
}

/**
 * The job window header shared by the desktop worker log and the phone
 * worker screen: one plain state line, the reason when known, then the facts.
 * Log lines stay in the panes, which already render the redacted tail.
 */
export function JobWindowCard({ job, detail, enabled, pollMs }: {
  job: string; detail?: FleetJobDetailV1 | null; enabled: boolean; pollMs?: number;
}) {
  const def = useMemo(() => jobWindowQuery(job), [job]);
  const query = useQuery(def, { enabled, freshMs: 0 });
  const refetch = useRefetch(def);
  const served = query.status !== 'error' && query.data ? query.data : null;
  // Older hubs answer null (404/403); stop asking them.
  usePollWhileVisible(refetch, pollMs ?? (served?.state === 'running' || detail?.state === 'running' ? 4_000 : 15_000),
    { enabled: enabled && query.data !== null, refreshOnShow: false });
  const settled = query.data === null || query.status === 'error';
  const view = served ?? (detail ? windowFromDetail(job, detail) : settled ? buildJobWindow({ job }) : null);
  if (!view) return null;
  const prUrl = safeJobPrUrl(view.prUrl);
  return <section aria-label="Job window" className={styles.card}>
    <p role="status" className={styles.state} data-state={view.state}>
      <StatusBadge status={view.state} tone={TONE[view.state]}>{view.stateLine}</StatusBadge>
    </p>
    {view.reason && <p className={styles.reason}>{view.reason}</p>}
    <dl className={styles.facts}>
      {view.facts.map(fact => <div key={fact.label} className={styles.fact}>
        <dt>{fact.label}</dt>
        <dd className={fact.value === UNKNOWN ? styles.unknown : undefined}>
          {fact.label === 'Pull request' && prUrl ? <a href={prUrl} target="_blank" rel="noopener noreferrer">{prUrl}</a> : fact.value}
        </dd>
      </div>)}
    </dl>
  </section>;
}

/**
 * The phone opens here. One glance — running, usage versus reset, merges,
 * main health, incidents — and a plain-language order. The words match
 * Telegram and email because they come from the same formatter.
 */
import { useMemo } from 'react';
import { buildOperatorGlance, formatOperatorGlance, type OperatorGlance } from '../../../../../core/fleet/operator-glance.js';
import { readFailureReason } from '../../../../data/client.js';
import { refetchQuery } from '../../../../data/cache.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { MobileInterject } from '../MobileInterject.js';
import { operatorGlanceQuery } from '../operator-glance-query.js';
import { isHomeFleetRuns } from '../home-runs-model.js';
import { homeRunsQuery } from '../home-runs-query.js';
import { Button, SkeletonList } from '../ui.js';
import { ui } from '../ui-parts.js';
import styles from './HomeScreen.module.css';

export function refreshOperatorGlance(): Promise<unknown> {
  return Promise.allSettled([
    refetchQuery(operatorGlanceQuery.key, () => operatorGlanceQuery.fetch(), true),
    refetchQuery(homeRunsQuery.key, () => homeRunsQuery.fetch(), true),
  ]);
}

function glanceFromRuns(runs: unknown, now: Date): OperatorGlance | null {
  if (!isHomeFleetRuns(runs)) return null;
  return buildOperatorGlance({
    now,
    lanes: runs.lanes.map((lane) => ({ running: lane.running, target: lane.target, merged24h: lane.merged24h ?? null })),
    switches: runs.switches,
    claudeLane: runs.claudeLane,
    usagePct: runs.codexPersonal?.usedPct ?? null,
    resetsAt: runs.codexPersonal?.resetsAt ?? null,
  });
}

function withUsage(glance: OperatorGlance, runs: unknown): OperatorGlance {
  if (!isHomeFleetRuns(runs) || glance.usagePct !== null) return glance;
  return buildOperatorGlance({
    now: new Date(glance.at),
    lanes: [{ running: glance.running, target: glance.target, merged24h: glance.mergesToday }],
    usagePct: runs.codexPersonal?.usedPct ?? null,
    resetsAt: runs.codexPersonal?.resetsAt ?? null,
    mainText: glance.main === 'unknown' ? null : `main: ${glance.main === 'up' ? 'up' : 'down'}`,
    incidentText: glance.incidents.map((line) => `- ${line}`).join('\n'),
    switches: [],
    claudeLane: null,
  });
}

export function OperatorGlance() {
  const glance = useQuery(operatorGlanceQuery);
  const runs = useQuery(homeRunsQuery);
  const refetchGlance = useRefetch(operatorGlanceQuery);
  const refetchRuns = useRefetch(homeRunsQuery);
  usePollWhileVisible(() => { refetchGlance(); refetchRuns(); }, 15_000);
  const view = useMemo(() => {
    const now = new Date();
    if (glance.data) return withUsage(glance.data, runs.data);
    return glanceFromRuns(runs.data, now);
  }, [glance.data, runs.data]);
  const at = view ? Date.parse(view.at) : NaN;
  const lines = view ? formatOperatorGlance(view, Number.isFinite(at) ? at : Date.now()).split('\n') : [];
  const loading = !view && (glance.status === 'loading' || glance.status === 'idle' || runs.status === 'loading' || runs.status === 'idle');
  const failed = !view && !loading;

  return (
    <>
      <section className={`${ui.card} ${styles.fleet}`} aria-label="Fleet">
        {loading ? <SkeletonList rows={4} label="Loading the fleet" /> : null}
        {failed ? (
          <p className={styles.fleetDetail}>
            Couldn’t read the fleet.{glance.error ? ` ${readFailureReason(glance.error)}` : ''}
            <Button variant="tinted" onClick={() => { refetchGlance(); refetchRuns(); }}>Try again</Button>
          </p>
        ) : null}
        {lines.length > 0 ? (
          <div className={styles.lines}>
            {lines.map((line) => (
              <p key={line} className={styles.line} data-tone={/needs you|unknown|Incident/.test(line) ? 'attention' : undefined}>{line}</p>
            ))}
          </div>
        ) : null}
      </section>
      <MobileInterject title="Order" placeholder="Tell the leaders in plain language." />
    </>
  );
}

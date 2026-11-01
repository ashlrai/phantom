import { useMemo, useState } from 'react';
import { BarStack } from '../../../components/charts/BarStack.js';
import { toneColor, type ChartTone } from '../../../components/charts/colors.js';
import { Button, SkeletonLine } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { ExecutionFeedbackOutcome } from '../../../../core/fleet/execution-feedback-types.js';
import { formatRelative } from '../autonomy/format.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { filterCases, outcomeChips, readCase, readOutcomes, wasteLine, wasteSummary, type OutcomesView } from './fleet-outcomes-model.js';
import { outcomeCaseQuery, outcomesQuery } from './fleet-outcomes-queries.js';
import styles from './fleet-outcomes.module.css';

// The server refreshes its own feedback reading every 30 s; polling faster
// would only re-serve the same snapshot.
const POLL_MS = 30_000;

const OUTCOME_TONE: Record<ExecutionFeedbackOutcome, ChartTone> = {
  'producer-succeeded': 'success', failed: 'danger', 'empty-diff': 'warning',
  cancelled: 'neutral', refused: 'warning', disabled: 'neutral', unknown: 'unknown',
};

const at = (iso: string | null) => {
  const valid = iso !== null && Number.isFinite(Date.parse(iso));
  return <time className={styles.dim} dateTime={valid ? iso! : undefined} title={valid ? new Date(iso!).toLocaleString() : undefined}>{formatRelative(iso)}</time>;
};

function countOf(data: OutcomesView, outcome: ExecutionFeedbackOutcome): number {
  const row = data.mix.find(item => item.outcome === outcome);
  return row ? row.total ?? row.observed : 0;
}

function CaseTimeline({ caseId, visible, onClose }: { caseId: string; visible: boolean; onClose: () => void }) {
  const query = useMemo(() => outcomeCaseQuery(caseId), [caseId]);
  const read = useQuery(query, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(query);
  usePollWhileVisible(refetch, POLL_MS, { enabled: visible });
  const detail = useMemo(() => readCase(read.data), [read.data]);
  return <section aria-label="Case timeline">
    <div className={styles.timelineHead}>
      <h3 className={styles.heading}>Case timeline</h3>
      <Button size="sm" variant="subtle" onClick={onClose}>Close</Button>
    </div>
    {read.data === undefined ? <div role="status"><span className={styles.message}>Reading the case…</span><SkeletonLine /></div>
      : detail === null || detail.state === 'unavailable' || detail.caseId === null
        ? <p className={styles.message}>Case detail is unavailable on this Mac.</p>
        : <>
          {detail.state === 'stale' && <p className={styles.notice} role="status">Showing the last reading.</p>}
          <p className={styles.header}>{detail.label} · ended {formatRelative(detail.endedAt)}</p>
          {detail.steps.length === 0 ? <p className={styles.message}>No timeline steps recorded.</p>
            : <ol className={styles.list} aria-label="Timeline steps">{detail.steps.map((step, index) =>
              <li key={`${step.stage}:${index}`} className={styles.row}>
                <span>{step.stageLabel}</span>
                <span className={styles.dim}>{step.result}</span>
                {step.ci ? <span className={styles.dim}>CI {step.ci}</span> : null}
                {step.suite ? <span className={styles.dim}>suite {step.suite}</span> : null}
                {at(step.at)}
                {step.href ? <a href={step.href} target="_blank" rel="noopener noreferrer">Open</a> : null}
              </li>)}</ol>}
        </>}
  </section>;
}

export function FleetOutcomesPane({ visible, host }: PaneProps) {
  const read = useQuery(outcomesQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(outcomesQuery);
  usePollWhileVisible(refetch, POLL_MS, { enabled: visible });
  const data = useMemo(() => readOutcomes(read.data), [read.data]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ExecutionFeedbackOutcome | 'all'>('all');

  if (read.data === null || (read.error instanceof ApiError && read.error.status === 404)) {
    return <p className={styles.message}>Outcomes not in this build</p>;
  }
  if (read.data === undefined) {
    return <div className={styles.root} role="status">{read.status === 'error' ? 'Outcomes are unavailable on this Mac.' : <><span>Reading outcomes…</span><SkeletonLine /><SkeletonLine /></>}</div>;
  }
  if (data === null || data.state === 'unavailable' || data.sourceState === null) {
    return <p className={styles.message}>Outcomes are unavailable on this Mac.</p>;
  }
  const chips = outcomeChips(data);
  // A later poll can drop the outcome a chip was filtering on; fall back to All.
  const chip = chips.find(item => item.outcome === outcome) ?? chips[0]!;
  const cases = filterCases(data, chip.outcome);
  const waste = wasteSummary(data.cases, Date.now());
  const line = wasteLine(waste);
  return <section className={styles.root} aria-label="Outcomes">
    <p className={styles.header}>{data.cases.length} cases since {formatRelative(data.since)} · {countOf(data, 'producer-succeeded')} produced · {countOf(data, 'failed')} failed{data.refreshedAt !== null ? ` · refreshed ${formatRelative(data.refreshedAt)}` : ''}</p>
    {line && <p className={styles.waste} data-tone={waste.wasted * 2 >= waste.finished ? 'bad' : waste.wasted * 4 >= waste.finished ? 'warn' : 'neutral'}>{line}</p>}
    {data.state === 'stale' && <p className={styles.notice} role="status">Showing the last reading.</p>}
    {read.status === 'error' && <p className={styles.notice} role="status">Outcomes could not refresh. Showing the last reading.</p>}
    {data.notes.map(note => <p key={note} className={styles.notice} role="status">{note}</p>)}
    {data.mix.length === 0 ? <p className={styles.message}>No ended jobs in the window.</p>
      : <BarStack title="Outcome mix" description="What happened to each job that ended"
          caveat={data.complete === false ? 'Observed counts are lower bounds; the window is still being read.' : undefined}
          categories={['Window']} height={160}
          segments={data.mix.map(row => ({ id: row.outcome, label: row.label, color: toneColor(OUTCOME_TONE[row.outcome]) }))}
          values={[data.mix.map(row => row.total ?? row.observed)]} />}
    <section>
      <div className={styles.filters} role="radiogroup" aria-label="Filter cases">
        {chips.map(item => <button key={item.outcome} type="button" role="radio" aria-checked={item.outcome === chip.outcome} onClick={() => setOutcome(item.outcome)}>{item.label} {item.count}</button>)}
      </div>
      <h3 className={styles.heading}>Cases</h3>
      {cases.length === 0 ? <p className={styles.message}>{data.cases.length === 0 ? 'No cases recorded in the window.' : `No ${chip.label.toLowerCase()} cases in the window.`}</p>
        : <ul className={styles.list} aria-label="Cases">{cases.map(item =>
          <li key={item.caseId}>
            <button type="button" className={styles.caseRow} title={item.caseId} aria-pressed={selectedCaseId === item.caseId}
              onClick={() => setSelectedCaseId(item.caseId)}>
              <span>{item.label}</span>
              {item.failureKind ? <span className={styles.dim}>· {item.failureKind}</span> : null}
              {at(item.endedAt)}
            </button>
            <span className={styles.dim}> · {item.prLink
              ? <a href={item.prLink.url} target="_blank" rel="noreferrer">{item.prLink.label}</a>
              : item.proposalRecorded ? 'PR recorded' : 'no PR'}</span>
            {item.jobId ? <Button size="sm" variant="subtle" onClick={() => {
              requestWorkerLogJob(item.jobId!);
              host.openPane('worker-log');
            }}>Open worker log</Button> : null}
          </li>)}</ul>}
    </section>
    {selectedCaseId ? <CaseTimeline caseId={selectedCaseId} visible={visible} onClose={() => setSelectedCaseId(null)} /> : null}
  </section>;
}

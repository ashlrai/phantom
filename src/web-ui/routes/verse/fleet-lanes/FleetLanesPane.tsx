import { useCallback, useEffect, useState } from 'react';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { openDockPane } from '../dock/dock-store.js';
import { JOB_ID_RE } from '../fleet-job-log/worker-log-model.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { burnLine, burnTotals, formatTokens, headline, isPhantomRepo, laneBars, repoMix, repoMixLine, repoShort, workerRows } from './fleet-lanes-model.js';
import { strayLine, strayTotals, strayTotalsLine } from './stray-slots-model.js';
import { straySlotsQuery } from './stray-slots-queries.js';
import { takeRequestedLane, useRequestedLane } from './lane-focus-request.js';
import { LanePauseButton } from './LanePauseButton.js';
import { LaneHoldReleaseButton } from './LaneHoldReleaseButton.js';
import { LaneTargetStepper } from './LaneTargetStepper.js';
import styles from './fleet-lanes.module.css';

function pullUrl(repo: string, number: number): string | null {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) || !Number.isSafeInteger(number) || number <= 0) return null;
  const [owner, name] = repo.split('/');
  if (owner === '.' || owner === '..' || name === '.' || name === '..') return null;
  return `https://github.com/${owner}/${name}/pull/${number}`;
}

export function FleetLanesPane({ visible }: Pick<PaneProps, 'visible'>) {
  const [showAll, setShowAll] = useState(false);
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const active = visible && sectionVisible && documentVisible;
  const read = useQuery(opsRunsQuery, { enabled: active, freshMs: 0 });
  const refetch = useRefetch(opsRunsQuery);
  const refresh = useRefresh(opsRunsQuery);
  usePollWhileVisible(refetch, 5_000, { enabled: visible, refreshOnShow: false });
  const data = read.data;
  const strays = useQuery(straySlotsQuery, { enabled: active && !!data });
  const refetchStrays = useRefetch(straySlotsQuery);
  // Strays are sticky host state, not tick-level data: 30 s is fresh enough
  // for a finished job's leftover processes without hammering ps/lsof.
  usePollWhileVisible(refetchStrays, 30_000, { enabled: visible && !!data, refreshOnShow: false });
  const straysTotalsLine = strayTotalsLine(strayTotals(strays.data));
  const workers = data ? workerRows(data) : [];
  const requested = useRequestedLane();
  const [focusedLane, setFocusedLane] = useState<string | null>(null);
  const scrollToLane = useCallback((el: HTMLLIElement | null) => {
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, []);
  useEffect(() => {
    if (!requested || !data || !laneBars(data).some((bar) => bar.lane === requested)) return;
    setFocusedLane(requested);
    takeRequestedLane();
  }, [requested, data]);

  function openLog(job: string): void {
    if (!JOB_ID_RE.test(job)) return;
    requestWorkerLogJob(job);
    openDockPane('worker-log');
  }

  return <div className={styles.pane} aria-label="Lanes">
    <header className={styles.header}>
      <p className={styles.headline}>{headline(data ?? null, Date.now())}</p>
      <button type="button" className={styles.refresh} onClick={refresh}>Refresh</button>
    </header>
    {straysTotalsLine ? <p className={styles.muted}>{straysTotalsLine}</p> : null}
    {data === null ? <p className={styles.muted}>The fleet runs API has not landed in this build yet.</p>
      : !data ? <p className={styles.muted} role="status">{read.status === 'error' ? 'Fleet runs are unavailable.' : 'Reading fleet runs…'}</p>
      : <>
        {read.status === 'error' ? <p className={styles.muted} role="status">Fleet runs could not refresh. Showing the last reading.</p> : null}
        {data.sources.runsDir !== 'healthy' ? <p className={styles.muted}>Runs directory: {data.sources.runsDir}</p> : null}
        <section className={styles.section} aria-labelledby="fleet-lanes-capacity">
          <h3 id="fleet-lanes-capacity" className={styles.title}>Lane capacity</h3>
          <p className={styles.burn}>{burnLine(burnTotals(data))}</p>
          {data.lanes.length === 0 ? <p className={styles.muted}>No lanes reported.</p> : <ul className={styles.list}>
            {laneBars(data).map((lane) => { const laneStrays = strayLine(lane.lane, strays.data); return <li key={lane.lane} className={styles.lane} ref={lane.lane === focusedLane ? scrollToLane : undefined} data-focused={lane.lane === focusedLane ? 'true' : undefined} aria-current={lane.lane === focusedLane ? 'true' : undefined}>
              <div className={styles.line}><strong>{lane.lane}</strong>{lane.held ? <span className={styles.badge} title={lane.heldReason ?? undefined}>Held</span> : null}<span className={styles.count}>{lane.running}/{lane.target} · {lane.queued} queued</span><LaneTargetStepper lane={lane.lane} /><LanePauseButton lane={lane.lane} /><LaneHoldReleaseButton lane={lane.lane} heldReason={lane.held ? lane.heldReason : null} heldUntil={null} /><span className={styles.burn}>· {formatTokens(lane.tokensLastHour)} tok/h · {lane.merged24h ?? '—'} merged/24 h</span></div>
              {lane.held ? <p className={styles.muted}>Held: {(lane.heldReason ?? 'reason not reported').replace(/_/g, ' ')}</p> : null}
              {laneStrays ? <p className={styles.muted}>{laneStrays}</p> : null}
              <div className={styles.track} role="img" aria-label={`${lane.lane}: ${lane.running} running of ${lane.target} target`}>
                {lane.fillPct !== null ? <div className={styles.fill} data-tone={lane.tone} style={{ width: `${lane.fillPct}%` }} /> : null}
              </div>
            </li>; })}
          </ul>}
        </section>
        <section className={styles.section} aria-labelledby="fleet-lanes-workers">
          <h3 id="fleet-lanes-workers" className={styles.title}>Workers</h3>
          <p className={styles.muted} aria-label="Repository mix">{repoMixLine(repoMix(data))}</p>
          {workers.length === 0 ? <p className={styles.muted}>No workers running.</p> : <ul className={styles.list}>
            {(showAll ? workers : workers.slice(0, 12)).map((worker, i) => <li key={`${worker.job}:${i}`} className={styles.worker} data-filler={isPhantomRepo(worker.repo) ? undefined : 'true'}><button type="button" className={styles.jobButton} onClick={() => openLog(worker.job)} aria-label={`Open log for ${worker.job}`}><code>{worker.job}</code></button><span title={repoShort(worker.repo) !== worker.repo ? worker.repo : undefined}>{repoShort(worker.repo)}</span><span>{worker.lane} · {worker.tier}</span><span>{worker.age}</span></li>)}
          </ul>}
          {workers.length > 12 ? <button type="button" className={styles.moreButton} aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show ${workers.length - 12} more`}</button> : null}
        </section>
        <section className={styles.section} aria-labelledby="fleet-lanes-merges">
          <h3 id="fleet-lanes-merges" className={styles.title}>Merged last hour</h3>
          {data.mergesLastHour.items.length === 0 ? <p className={styles.muted}>No merges reported.</p> : <ul className={styles.list}>
            {data.mergesLastHour.items.map((merge, i) => {
              const url = pullUrl(merge.repo, merge.number);
              const label = `${merge.repo} #${merge.number} ${merge.title}`;
              return <li className={styles.merge} key={`${merge.repo}:${merge.number}:${i}`}>{url ? <a href={url} target="_blank" rel="noreferrer">{label}</a> : label}</li>;
            })}
          </ul>}
        </section>
      </>}
  </div>;
}

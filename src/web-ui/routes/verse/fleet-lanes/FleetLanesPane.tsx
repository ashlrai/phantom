/**
 * routes/verse/fleet-lanes/FleetLanesPane.tsx — the Lanes board: how many slots are running against what was asked
 * for, one strip of every lane's slots, then a card per lane (provider mark, state, a square per slot, labelled
 * readings, the work line, target and pause controls), the workers and the last hour's merges. Everything comes from
 * GET /api/verse/fleet/runs, the read `phm fleet runs --json` prints, but the work line: jobs launched and PRs merged
 * on the lane hour by hour, from `phm throughput --by lane` (LaneWork.tsx).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { copyText } from '../../../components/primitives/clipboard.js';
import { Button } from '../../../components/primitives/index.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { openDockPane } from '../dock/dock-store.js';
import { JOB_ID_RE } from '../fleet-job-log/worker-log-model.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { claudeLaneFix, parseClaudeLane } from './claude-lane-state.js';
import { burnLine, burnTotals, isPhantomRepo, repoMix, repoMixLine, repoShort, workerRows } from './fleet-lanes-model.js';
import { boardHeadline, fleetStrip, laneCard, laneFacts, pulseLine } from './lanes-board-model.js';
import { FleetStrip, LaneSlots } from './LaneSlots.js';
import { LaneWorkHead, LaneWorkLine, useLaneWork } from './LaneWork.js';
import { strayLine, strayRows, strayTotals, strayTotalsLine } from './stray-slots-model.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { postStrayStop } from './stray-stop.js';
import { readFailureReason } from '../../../data/client.js';
import { straySlotsQuery } from './stray-slots-queries.js';
import { laneOutcomeLine } from './lane-outcomes-model.js';
import { laneOutcomesQuery } from './lane-outcomes-queries.js';
import { takeRequestedLane, useRequestedLane } from './lane-focus-request.js';
import { LanePauseButton } from './LanePauseButton.js';
import { LaneHoldReleaseButton } from './LaneHoldReleaseButton.js';
import { LaneTargetStepper } from './LaneTargetStepper.js';
import { LaunchStallBanner } from './LaunchStallBanner.js';
import styles from './fleet-lanes.module.css';

function pullUrl(repo: string, number: number): string | null {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) || !Number.isSafeInteger(number) || number <= 0) return null;
  const [owner, name] = repo.split('/');
  if (owner === '.' || owner === '..' || name === '.' || name === '..') return null;
  return `https://github.com/${owner}/${name}/pull/${number}`;
}

export function FleetLanesPane({ visible }: Pick<PaneProps, 'visible'>) {
  const [stopping, setStopping] = useState(false);
  const stopInFlight = useRef(false);
  const [stopError, setStopError] = useState<{ lane: string; message: string } | null>(null);
  async function stopRows(lane: string, rows: Array<{ job: string; pid: number }>) {
    if (stopInFlight.current) return;
    stopInFlight.current = true;
    setStopping(true);
    setStopError(null);
    try {
      for (const row of rows) {
        try { await postStrayStop(lane, row.job, row.pid); }
        finally { refetchStrays(); }
      }
    } catch (error) { setStopError({ lane, message: error instanceof VerseControlLockedError ? error.message : readFailureReason(error) }); }
    finally { stopInFlight.current = false; setStopping(false); }
  }
  const [showAll, setShowAll] = useState(false);
  const [copyState, setCopyState] = useState<'copied' | 'failed' | null>(null);
  useEffect(() => {
    if (!copyState) return;
    const timer = window.setTimeout(() => setCopyState(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [copyState]);
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
  // Yield per lane over the last day: finished jobs by what they produced, never by exit code. Same data: `phm fleet outcomes --lane <lane> --json`.
  const outcomes = useQuery(laneOutcomesQuery, { enabled: active && !!data });
  usePollWhileVisible(useRefetch(laneOutcomesQuery), 60_000, { enabled: visible && !!data, refreshOnShow: false });
  const straysTotalsLine = strayTotalsLine(strayTotals(strays.data));
  const workers = data ? workerRows(data) : [];
  const requested = useRequestedLane();
  const [focusedLane, setFocusedLane] = useState<string | null>(null);
  const scrollToLane = useCallback((el: HTMLLIElement | null) => {
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, []);
  useEffect(() => {
    if (!requested || !data || !data.lanes.some((lane) => lane.lane === requested)) return;
    setFocusedLane(requested);
    takeRequestedLane();
  }, [requested, data]);

  function openLog(job: string): void {
    if (!JOB_ID_RE.test(job)) return;
    requestWorkerLogJob(job);
    openDockPane('worker-log');
  }

  const now = Date.now();
  const claude = parseClaudeLane(data?.claudeLane, now);
  const cards = data ? data.lanes.map((lane) => laneCard(lane, claude.down)) : [];
  const strip = fleetStrip(cards);
  // When each lane worked, hour by hour: `phm throughput --by lane`, on the read Home and the Throughput pane share.
  const work = useLaneWork(cards.map((lane) => lane.lane), { read: active && !!data, poll: visible && !!data });

  return <div className={styles.pane} aria-label="Lanes">
    <header className={styles.header}>
      {/* Before the first reading there is no count to state: the heading names the pane, not a zero. */}
      <p className={styles.headline}>{data ? boardHeadline(data) : 'Lanes'}</p>
      <button type="button" className={styles.refresh} onClick={refresh}>Refresh</button>
    </header>
    {data ? <p className={styles.meta}>{pulseLine(data, now)}</p> : null}
    {strip ? <FleetStrip segments={strip.segments} label={strip.label} /> : null}
    {straysTotalsLine ? <p className={styles.muted}>{straysTotalsLine}</p> : null}
    {data === null ? <p className={styles.muted}>The fleet runs API has not landed in this build yet.</p>
      : !data ? <p className={styles.muted} role="status">{read.status === 'error' ? 'Fleet runs are unavailable.' : 'Reading fleet runs…'}</p>
      : <>
        {read.status === 'error' ? <p className={styles.muted} data-stale role="status">Fleet runs could not refresh. Showing the last reading.</p> : null}
        <LaunchStallBanner enabled={active} />
        {data.sources.runsDir !== 'healthy' ? <p className={styles.muted}>Runs directory: {data.sources.runsDir}</p> : null}
        <section className={styles.section} aria-labelledby="fleet-lanes-capacity">
          <h3 id="fleet-lanes-capacity" className={styles.title}>Lane capacity</h3>
          <p className={styles.burn}>{burnLine(burnTotals(data))}</p>
          {cards.length > 0 ? <LaneWorkHead work={work} /> : null}
          {cards.length === 0 ? <p className={styles.muted}>No lanes reported.</p> : <ul className={styles.list}>
            {cards.map((lane) => {
              const outcomeLine = laneOutcomeLine(lane.lane, outcomes.data);
              const laneStrays = strayLine(lane.lane, strays.data);
              const rows = strayRows(lane.lane, strays.data);
              const claudeDown = lane.state === 'down';
              const focused = lane.lane === focusedLane;
              return <li key={lane.lane} className={styles.lane} data-state={lane.state} ref={focused ? scrollToLane : undefined} data-focused={focused ? 'true' : undefined} aria-current={focused ? 'true' : undefined}>
                <div className={styles.line}>
                  <span className={styles.name}><ProviderBadge of={lane.lane} iconOnly size={14} /><strong>{lane.lane}</strong></span>
                  {claudeDown ? <span className={styles.badge} data-tone="danger">Down</span> : null}
                  {lane.held ? <span className={styles.badge} data-tone="warning" title={lane.heldReason ?? undefined}>Held</span> : null}
                  {/* The words carry the state; the mark before them only repeats it. */}
                  {lane.stateText ? <span className={styles.state}>{lane.stateText}</span> : null}
                </div>
                <div className={styles.slots}>
                  <LaneSlots card={lane} />
                  <span className={styles.count}>{lane.running}/{lane.target} · {lane.queued} queued</span>
                </div>
                <dl className={styles.facts}>{laneFacts(lane).map((fact) => <div key={fact.label} className={styles.fact}>
                  <dt>{fact.label}</dt>
                  <dd data-unknown={fact.value === null || undefined}>{fact.value ?? 'unknown'}</dd>
                </div>)}</dl>
                <LaneWorkLine lane={lane.lane} work={work} />
                <div className={styles.controls}>
                  <span className={styles.controlLabel}>Target</span>
                  <LaneTargetStepper lane={lane.lane} /><LanePauseButton lane={lane.lane} /><LaneHoldReleaseButton lane={lane.lane} heldReason={lane.held ? lane.heldReason : null} heldUntil={null} />
                </div>
                {claudeDown ? <>
                  <p className={styles.muted}>{[`${Math.max(0, lane.target - lane.running)} slots idle`, claude.reason, claude.sinceText].filter(Boolean).join(' · ')}</p>
                  <p className={styles.muted}>{claudeLaneFix()} <Button size="sm" onClick={() => { void copyText(claudeLaneFix().replace('Run on this Mac: ', '')).then((ok) => setCopyState(ok ? 'copied' : 'failed')); }}>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}</Button></p>
                </> : null}
                {outcomeLine ? <p className={styles.muted} data-lane-outcomes>{outcomeLine}</p> : null}
                {lane.held ? <p className={styles.muted}>Held: {(lane.heldReason ?? 'reason not reported').replace(/_/g, ' ')}</p> : null}
                {laneStrays ? <p className={styles.muted}>{laneStrays}</p> : null}
                {rows.map(row => <p className={styles.muted} key={`${row.job}:${row.pid}`}>
                  {row.label} <button type="button" className={styles.jobButton} disabled={stopping} aria-label={`Stop stray ${row.job}`} onClick={() => void stopRows(lane.lane, [row])}>Stop</button>
                </p>)}
                {rows.length >= 2 ? <button type="button" className={styles.jobButton} disabled={stopping} onClick={() => void stopRows(lane.lane, rows)}>Stop all {rows.length}</button> : null}
                {stopError?.lane === lane.lane ? <p className={styles.pauseError} role="status">{stopError.message}</p> : null}
              </li>;
            })}
          </ul>}
          {cards.length > 0 ? <p className={styles.muted}>Squares: one per slot, filled when a worker holds it. Same data: <code>phm fleet runs --json</code>.</p> : null}
        </section>
        <section className={styles.section} aria-labelledby="fleet-lanes-workers">
          <h3 id="fleet-lanes-workers" className={styles.title}>Workers</h3>
          <p className={styles.muted} aria-label="Repository mix">{repoMixLine(repoMix(data))}</p>
          {workers.length === 0 ? <p className={styles.muted}>No workers running.</p> : <ul className={styles.list}>
            {(showAll ? workers : workers.slice(0, 12)).map((worker, i) => <li key={`${worker.job}:${i}`} className={styles.worker} data-filler={isPhantomRepo(worker.repo) ? undefined : 'true'}><button type="button" className={styles.jobButton} onClick={() => openLog(worker.job)} aria-label={`Open log for ${worker.job}`}><code>{worker.job}</code></button><span title={repoShort(worker.repo) !== worker.repo ? worker.repo : undefined}>{repoShort(worker.repo)}</span><span className={styles.workerLane}><ProviderBadge of={worker.lane} iconOnly size={12} />{worker.lane} · {worker.tier}</span><span>{worker.age}</span></li>)}
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

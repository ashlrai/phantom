/**
 * The org as a tree, top down: leader, then its planners, then each lane, then the jobs under it. Every fact comes from the
 * `fleet.org.v1` tree `phm org` prints (GET /api/verse/fleet/control/map); this file reads nothing else.
 */
import { useState } from 'react';
import { fleetOrgTree, orgAgo, type FleetOrgTree, type OrgState, type OrgTreeJob, type OrgTreeLane, type OrgTreePlanner } from '../../../../core/fleet/org-tree.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { JobDetailSheet } from '../fleet/JobDetailSheet.js';
import { fleetOrgMapQuery } from '../fleet/org-map-query.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './fleet-org.module.css';

const STATE_LABEL: Record<OrgState, string> = { running: 'Running', idle: 'Idle', held: 'Held', done: 'Done', unknown: 'Unknown' };
const shown = (value: number | null) => value === null ? 'unknown' : String(value);
/** "12m" from seconds; "unknown" when no start was recorded. */
function age(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  return seconds < 60 ? 'under 1m' : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86_400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86_400)}d`;
}

function Planners({ planners, now }: { planners: OrgTreePlanner[]; now: number }) {
  return <ul className={styles.planners} aria-label="Planners">{planners.map(row => <li key={row.id} className={styles.planner} data-state={row.state} title={row.role}>
    <strong>{row.label}</strong> <State state={row.state} />
    <small>{row.doing} · last sign {orgAgo(row.lastActivityAt, now)}</small>
  </li>)}</ul>;
}

function State({ state }: { state: OrgState }) {
  return <span className={styles.state} data-state={state}><span className={styles.dot} aria-hidden="true" />{STATE_LABEL[state]}</span>;
}

function Lane({ lane, open, onToggle, onOpenJob, jobsKnown, now }: {
  lane: OrgTreeLane; open: boolean; onToggle: () => void; onOpenJob: (job: OrgTreeJob) => void; jobsKnown: boolean; now: number;
}) {
  const id = `org-lane-${lane.lane}`;
  return <li className={styles.lane} data-state={lane.state}>
    <button type="button" className={styles.laneHead} aria-expanded={open} aria-controls={id} onClick={onToggle}
      aria-label={`${lane.lane}, ${STATE_LABEL[lane.state]}, ${shown(lane.running)} of ${shown(lane.target)} running`}>
      <span className={styles.twist} aria-hidden="true">{open ? '▾' : '▸'}</span>
      <ProviderBadge of={lane.provider} iconOnly size={16} />
      <strong>{lane.lane}</strong>
      <State state={lane.state} />
      <span className={styles.counts}>{shown(lane.running)} of {shown(lane.target)} running · {lane.usage.usedPct === null ? 'pool use unknown' : `pool ${Math.round(lane.usage.usedPct)}% used`}</span>
      {(lane.state === 'held' || lane.state === 'idle') && <span className={styles.why}>{lane.doing}</span>}
    </button>
    {open && <div id={id} className={styles.laneBody}>
      <p className={styles.quiet}>{lane.doing} · {lane.model ?? 'model unknown'}{lane.queued ? ` · ${lane.queued} queued` : ''}</p>
      {lane.jobs.length ? <ul className={styles.jobs}>{lane.jobs.map(job => <li key={job.id}>
        <button type="button" className={styles.job} onClick={() => onOpenJob(job)} aria-label={`Open job ${job.id}`}>
          <strong>{job.id}</strong> <State state={job.state} />
          <span>{job.goal ?? job.doing}</span>
          <small><ProviderBadge of={job.provider} iconOnly /> {job.model ?? 'model unknown'} · {job.repo ?? 'repo unknown'} · {job.tier ?? 'tier unknown'} · age {age(job.ageSeconds)} · started {orgAgo(job.startedAt, now)}</small>
        </button>
      </li>)}</ul> : <p className={styles.quiet}>{jobsKnown ? 'No jobs.' : 'Jobs unknown.'}</p>}
    </div>}
  </li>;
}

/** Pure view of one tree. Running lanes start open; held, idle and unknown lanes start folded and say so on the row. */
export function OrgTreeView({ tree, now = Date.now() }: { tree: FleetOrgTree; now?: number }) {
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [selected, select] = useState<OrgTreeJob | null>(null);
  const isOpen = (lane: OrgTreeLane) => toggled[lane.lane] ?? lane.state === 'running';
  const allOpen = tree.lanes.every(isOpen);
  return <section className={styles.tree} aria-label="Org tree">
    <div className={styles.leader} data-state={tree.leader.state}>
      <strong>{tree.leader.label}</strong> <State state={tree.leader.state} />
      <span>{tree.leader.doing}</span>
      <small>{tree.leader.model ?? 'model unknown'} · dispatcher last tick {orgAgo(tree.leader.dispatcher.lastTick, now)}</small>
    </div>
    <div className={styles.leader} aria-label="Leader seat">
      <strong>Leader seat</strong>
      <span>{tree.leaderSeat?.current.lane ?? 'unknown'} · {tree.leaderSeat?.current.model ?? 'model unknown'}</span>
      <small>Last successful pass {orgAgo(tree.leaderSeat?.current.lastSuccessAt ?? null, now)}</small>
      <span>{tree.leaderSeat?.pick ? `Next seat: ${tree.leaderSeat.pick.lane} · ${tree.leaderSeat.pick.model}` : tree.leaderSeat?.reason ?? 'No seat: lane health is unknown.'}</span>
      {!!tree.leaderSeat?.fallbacks.length && <details><summary>Fallback lanes</summary><ol>{tree.leaderSeat.fallbacks.map(seat =>
        <li key={seat.lane}>{seat.lane} · {seat.model ?? 'model unknown'} · {seat.health} · {seat.headroomPct === null ? 'headroom unknown' : `${seat.headroomPct}% left`}{seat.reason ? ` · ${seat.reason}` : ''}</li>)}</ol></details>}
    </div>
    {tree.planners && <Planners planners={tree.planners} now={now} />}
    <button type="button" className={styles.all} onClick={() => setToggled(Object.fromEntries(tree.lanes.map(lane => [lane.lane, !allOpen])))}>{allOpen ? 'Collapse all' : 'Expand all'}</button>
    <ul className={styles.lanes}>{tree.lanes.map(lane => <Lane key={lane.lane} lane={lane} open={isOpen(lane)} jobsKnown={tree.jobsKnown} now={now}
      onToggle={() => setToggled(prev => ({ ...prev, [lane.lane]: !isOpen(lane) }))} onOpenJob={select} />)}</ul>
    <p className={styles.quiet}>Updated {orgAgo(tree.generatedAt, now)}. Same tree as <code>phm org</code>.</p>
    {selected && <JobDetailSheet job={selected.id} repo={selected.repo} onClose={() => select(null)} />}
  </section>;
}

const POLL_MS = 15_000;

export function OrgTree({ visible }: { visible: boolean }) {
  const read = useQuery(fleetOrgMapQuery, { enabled: visible, freshMs: 0 });
  usePollWhileVisible(useRefetch(fleetOrgMapQuery), POLL_MS, { enabled: visible });
  if (!read.data) return <p className={styles.quiet} role="status">{read.status === 'error' ? 'The organization could not be read.' : 'Reading the organization…'}</p>;
  return <>
    {read.status === 'error' && <p className={styles.notice} role="status">Refresh failed. This view may be out of date.</p>}
    <OrgTreeView tree={read.data.tree ?? fleetOrgTree(read.data)} />
  </>;
}

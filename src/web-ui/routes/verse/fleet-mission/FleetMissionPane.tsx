import { getReadClientProof } from '../../../data/auth-store.js';
import { ForumBoard } from '../fleet-forum/ForumBoard.js';
import { narrowForum } from '../fleet-forum/forum-view.js';
import { useEffect, useState } from 'react';
import { useQuery, useRefresh } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, useSectionVisible } from '../shell/section-visibility.js';
import { missionQuery, type MissionControl, type MissionDecision, type MissionHealth, type MissionJob, type MissionMain, type MissionResource } from './mission-queries.js';
import styles from './fleet-mission.module.css';

type Detail = 'jobs' | 'choices' | 'time' | 'mains' | 'incidents' | 'memory' | 'plan' | 'activity' | 'timeline' | 'forum' | 'log';

const DETAILS: ReadonlyArray<{ id: Detail; label: string }> = [
  { id: 'timeline', label: 'Merge timeline' },
  { id: 'activity', label: 'Agent activity' },
  { id: 'forum', label: 'Shared forum' },
  { id: 'log', label: 'Leader plan log' },
  { id: 'jobs', label: 'What is running' },
  { id: 'choices', label: 'Recent choices' },
  { id: 'time', label: 'Time left' },
  { id: 'mains', label: 'Main branches' },
  { id: 'incidents', label: 'What went wrong' },
  { id: 'memory', label: 'Memory' },
  { id: 'plan', label: 'The plan' },
];

function healthName(health: MissionHealth): MissionHealth {
  switch (health) {
    case 'clear':
    case 'watch':
    case 'attention':
    case 'unknown':
      return health;
    default: {
      const never: never = health;
      return never;
    }
  }
}

function pullHref(url: string): string | null {
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(url) ? url : null;
}

function resetPhrase(value: string | null): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value ?? '');
  return match ? `resets ${match[1]} ${match[2]} UTC` : null;
}

function timeLeft(row: MissionResource): string {
  const left = row.leftPct !== null ? `${row.leftPct}% left` : row.creditsLeft !== null ? `${row.creditsLeft} left` : 'unknown';
  const reset = resetPhrase(row.resetAt);
  return reset ? `${left} · ${reset}` : left;
}

function jobLine(job: MissionJob): string {
  const model = job.model ?? (job.running === 0 && job.queued > 0 ? 'not chosen yet' : 'unknown');
  const work = [job.running > 0 ? `${job.running} running` : '', job.queued > 0 ? `${job.queued} waiting` : ''].filter(Boolean).join(' · ');
  return `${job.label} · ${model} · ${work}`;
}

function choiceLine(row: MissionDecision): string {
  const when = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(row.at);
  const clock = when ? `${when[1]} ${when[2]}` : row.at;
  const who = [row.label, row.model].filter(Boolean).join(' · ');
  return who ? `${clock} · ${who}` : clock;
}

function mainLine(row: MissionMain): string {
  const health = row.health === 'green' ? 'green' : row.health === 'red' ? 'red' : 'unknown';
  const fixes = row.fixJobs.length ? ` · ${row.fixJobs.join(', ')}` : '';
  return `${row.repo} · ${health}${fixes}`;
}

function MissionForum({ data }: { data: MissionControl }) {
  const [channel, setChannel] = useState<string | null>(null);
  const forum = narrowForum(data.forum);
  if (!forum) return <p>unknown</p>;
  const filtered = channel ? { ...forum, posts: forum.posts.filter((post) => post.channelId === channel) } : forum;
  return <ForumBoard view={filtered} channel={channel} onChannel={setChannel} />;
}

function DetailView({ data, detail }: { data: MissionControl; detail: Detail }) {
  switch (detail) {
    case 'forum': return <MissionForum data={data} />;
    case 'log':
      return <p>{data.planLog?.points.join(' · ') || 'unknown'}</p>;
    case 'activity':
      return <ul>{data.activity?.length ? data.activity.map((row) => <li key={row.job}>{row.job} · {row.lane} · {row.at}</li>) : <li>unknown</li>}</ul>;
    case 'timeline':
      return <><ul>{data.timeline?.length ? data.timeline.map((row) => <li key={row.pr}>{row.at} · {row.pr}</li>) : <li>unknown</li>}</ul></>;
    case 'jobs':
      return data.jobs.length === 0 ? <p className={styles.quiet}>unknown</p>
        : <ul className={styles.rows}>{data.jobs.map((job) => <li className={styles.row} key={`${job.resource}:${job.model ?? ''}:${job.queued}`}>{jobLine(job)}</li>)}</ul>;
    case 'choices':
      return data.decisions.length === 0 ? <p className={styles.quiet}>unknown</p>
        : <ul className={styles.rows}>{data.decisions.map((row, index) => <li className={styles.row} key={`${row.at}:${index}`}><span>{choiceLine(row)}</span><span className={styles.meta}>{row.why || 'No reason recorded.'}</span></li>)}</ul>;
    case 'time':
      return data.resources.length === 0 ? <p className={styles.quiet}>unknown</p>
        : <ul className={styles.rows}>{data.resources.map((row) => <li className={styles.row} key={row.id}><span>{row.label}</span><span className={styles.meta}>{timeLeft(row)}</span></li>)}</ul>;
    case 'mains':
      return data.mains.length === 0 ? <p className={styles.quiet}>unknown</p>
        : <ul className={styles.rows}>{data.mains.map((row) => <li className={`${styles.row} ${styles.main}`} data-health={row.health} key={row.repo}><span>{mainLine(row)}</span>{row.note ? <span className={styles.meta}>{row.note}</span> : null}</li>)}</ul>;
    case 'incidents':
      return data.incidents.length === 0 ? <p className={styles.quiet}>unknown</p>
        : <ul className={styles.rows}>{data.incidents.map((row) => <li className={styles.row} key={row.id}><span>{row.title}</span><span className={styles.meta}>{row.what}</span>{row.applied ? <span className={styles.meta}>What they did: {row.applied}</span> : null}</li>)}</ul>;
    case 'memory':
      return <div className={styles.row}><span>{data.memory.note}</span>{data.memory.freePct !== null ? <span className={styles.meta}>{data.memory.freePct}% free</span> : null}{data.memory.stopped ? <span className={styles.meta}>{data.memory.stopped} jobs stopped</span> : null}</div>;
    case 'plan':
      return data.plan.points.length === 0 && !data.plan.title ? <p className={styles.quiet}>unknown</p>
        : <div className={styles.row}>{data.plan.title ? <h3>{data.plan.title}</h3> : null}<ul className={styles.rows}>{data.plan.points.map((point) => <li key={point}>{point}</li>)}</ul></div>;
    default: {
      const never: never = detail;
      return never;
    }
  }
}

function Merges({ data }: { data: MissionControl }) {
  const pulls = data.merges.flatMap((group) => group.pulls).slice(0, 6);
  if (!pulls.length) return null;
  return <ul className={styles.rows}>{pulls.map((pull) => {
    const href = pullHref(pull.url);
    const label = `${pull.repo} #${pull.number}`;
    return <li key={pull.url}>{href ? <a href={href} target="_blank" rel="noreferrer">{label}</a> : label}</li>;
  })}</ul>;
}

export function FleetMissionPane({ visible }: Pick<PaneProps, 'visible'>) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const active = visible && sectionVisible && documentVisible;
  const read = useQuery(missionQuery, { enabled: active, freshMs: 0 });
  const refresh = useRefresh(missionQuery);
  useEffect(() => {
    if (!active || typeof EventSource === 'undefined') return;
    const stream = new EventSource(`/api/verse/fleet/runs/mission/events?client=${encodeURIComponent(getReadClientProof())}`, { withCredentials: true });
    stream.addEventListener('mission', refresh);
    return () => stream.close();
  }, [active, refresh]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const data = read.data;
  const open = (id: Detail) => setDetail((current) => current === id ? null : id);

  return <section className={styles.pane} aria-label="Mission">
    <div className={styles.top}>
      <h2 className={styles.headline} data-health={data ? healthName(data.overview.health) : 'unknown'}>
        {data?.overview.headline ?? (read.status === 'error' ? 'The fleet could not be read.' : data === null ? 'This view is not in this build yet.' : 'Reading the fleet…')}
      </h2>
      <button type="button" className={styles.refresh} onClick={refresh}>Refresh</button>
    </div>
    {data ? <>
      {read.status === 'error' ? <p className={styles.quiet} role="status">Showing the last reading.</p> : null}
      <p className={styles.shipped}>{data.overview.shipped}</p>
      <p className={styles.quiet}>Cost per merged PR: {data.costPerMergedPrUsd == null ? 'unknown' : `$${data.costPerMergedPrUsd}`}</p>
      <p className={styles.quiet}>Merge queue: {data.mergeQueue ?? 'unknown'}</p>
      {data.overview.attention ? <p className={styles.quiet}>{data.overview.attention}</p> : null}
      {data.overview.items.length > 0 ? <ul className={styles.look}>{data.overview.items.map((item) => <li key={item.id}>{item.text}</li>)}</ul> : null}
      <Merges data={data} />
      <div className={styles.nav} role="toolbar" aria-label="More of the fleet">
        {DETAILS.map((item) => <button type="button" key={item.id} aria-expanded={detail === item.id} onClick={() => open(item.id)}>{item.label}</button>)}
      </div>
      {detail ? <div className={styles.detail}><DetailView data={data} detail={detail} /></div> : null}
    </> : null}
  </section>;
}

/**
 * The Computers pane: one card per computer (`phm nodes`), and on each card what that computer is running right now.
 * The job ids are the computer's own running claims from the nodes list; repo, lane, when it last spoke and its last
 * message are joined by job id from the same `phm sessions` list the Sessions pane reads (one cached read). Select a
 * job to open its messages in the Worker log, where pause and stop live. Read-only. A fact neither list holds reads
 * "unknown"; a job the sessions list does not hold says so instead of borrowing another job's facts.
 */
import { flatTree, spoke, type LiveSessionRow, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { SessionNode } from '../../../../core/fleet/session-tree.js';
import { Meter } from '../../../components/primitives/Meter.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { JOB_ID_RE } from '../fleet-job-log/job-id.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { liveSessionsQuery, SESSIONS_POLL_MS } from '../fleet-sessions/sessions-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { computersQuery, type ComputerCard, type ComputersView } from './computers-model.js';
import styles from './fleet-host.module.css';

/** A card is a glance; the Sessions pane holds the whole tree. */
export const COMPUTER_JOBS_LIMIT = 6;

const show = <T,>(value: T | 'unknown', known: (v: T) => string): string => (value === 'unknown' ? 'unknown' : known(value));
const many = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What the sessions list holds about a job: its tree node (message, when it spoke) and its running row (quiet). */
export interface JobFacts { node?: SessionNode; row?: LiveSessionRow }
/** Sessions by job id. `undefined` before the first read, `null` when the list cannot be read. */
export type SessionsRead = LiveSessionsV1 | null | undefined;
export function jobFacts(list: LiveSessionsV1): Map<string, JobFacts> {
  const facts = new Map<string, JobFacts>();
  for (const row of list.sessions) facts.set(row.job, { row });
  for (const { node } of flatTree(list.tree.roots)) if (node.jobId !== null && !facts.get(node.jobId)?.node) facts.set(node.jobId, { ...facts.get(node.jobId), node });
  return facts;
}

/** "5 jobs running on 2 computers", counting only computers whose claims are known and naming how many are not. */
export function runningLine(computers: readonly ComputerCard[]): string {
  const known = computers.filter((c): c is ComputerCard & { jobs: string[] } => c.jobs !== 'unknown');
  const unknown = computers.length - known.length;
  if (known.length === 0) return 'Jobs running: unknown.';
  const jobs = known.reduce((sum, c) => sum + c.jobs.length, 0);
  const busy = known.filter(c => c.jobs.length > 0).length;
  const line = jobs === 0 ? 'No jobs running' : `${many(jobs, 'job')} running on ${many(busy, 'computer')}`;
  return unknown ? `${line}; unknown for ${many(unknown, 'computer')}.` : `${line}.`;
}

function Job({ job, facts, sessions, onOpen }: { job: string; facts: JobFacts | undefined; sessions: SessionsRead; onOpen?: (job: string) => void }) {
  const { node, row } = facts ?? {};
  const quiet = row?.quiet === true;
  const lane = node?.lane ?? row?.lane ?? 'unknown';
  const repo = node?.repo ?? row?.repo ?? 'unknown';
  const body = <>
    <span className={styles.jobTop}>
      {lane !== 'unknown' && <ProviderBadge of={lane} iconOnly size={14} />}
      <strong className={styles.jobId}>{job}</strong>
      {facts ? <span className={styles.jobFact}>{repo === 'unknown' ? 'repo unknown' : repo}</span> : null}
      {/* The words carry the state; the mark beside them only repeats it. */}
      {node ? <span className={styles.jobWhen} data-state={quiet ? 'quiet' : 'running'}>{quiet ? 'quiet · ' : ''}{spoke(node)}</span> : null}
    </span>
    {node ? <span className={styles.jobSaid} data-unknown={node.lastMessage === null || undefined}>{node.lastMessage ?? 'Last message unknown'}</span>
      : facts ? null
        : sessions === undefined ? null
          : <span className={styles.jobSaid} data-unknown>{sessions === null ? 'Session details unknown: the sessions list could not be read.' : 'No session record for this job on this computer.'}</span>}
  </>;
  // An id the server would refuse opens nothing, so it is not a button.
  return onOpen && JOB_ID_RE.test(job)
    ? <button type="button" className={styles.job} data-state={quiet ? 'quiet' : undefined} aria-label={`Open messages for ${job}${quiet ? ', quiet' : ''}`} onClick={() => onOpen(job)}>{body}</button>
    : <div className={styles.job} data-state={quiet ? 'quiet' : undefined}>{body}</div>;
}

interface Opens { onOpenJob?: (job: string) => void; onOpenSessions?: () => void }

function Computer({ computer, facts, sessions, onOpenJob, onOpenSessions }: { computer: ComputerCard; facts: Map<string, JobFacts> | null; sessions: SessionsRead } & Opens) {
  const jobs = computer.jobs === 'unknown' ? [] : computer.jobs;
  // Running against running plus free: both are the server's own numbers, so the bar never assumes a slot count.
  const slots = computer.jobs !== 'unknown' && computer.freeSlots !== 'unknown' ? jobs.length + computer.freeSlots : null;
  const more = jobs.length - COMPUTER_JOBS_LIMIT;
  return <li className={styles.computer} data-state={computer.stateCode} aria-label={computer.name}>
    <p className={styles.line}>
      <span className={styles.peerDot} data-state={computer.stateCode} aria-hidden="true" />{' '}
      <span className={styles.peerName}>{computer.name}</span>
      {computer.isSelf ? <span className={styles.muted}> · this computer</span> : null}
    </p>
    <p className={styles.line}>{computer.state}</p>
    <dl className={styles.identity}>
      <dt>Memory free</dt><dd>{show(computer.freeMemoryBytes, (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`)}</dd>
      <dt>CPU free</dt><dd>{show(computer.cpuHeadroomPercent, (percent) => `${percent}%`)}</dd>
      <dt>Lanes</dt><dd>{show(computer.lanes, (lanes) => lanes.join(', ') || 'none')}</dd>
      <dt>Jobs running</dt><dd>{show(computer.jobsRunning, String)}</dd>
    </dl>
    {/* No bar when either number is missing or there are no slots at all: an empty bar would read as idle. */}
    {slots !== null && slots > 0 ? <div className={styles.slots}>
      <span className={styles.muted}>{jobs.length} running, {computer.freeSlots === 0 ? 'no free slots' : `${many(computer.freeSlots as number, 'free slot')}`}</span>
      <Meter variant="line" tone="accent" value={jobs.length} max={slots} aria-label={`${computer.name} job slots in use`} />
    </div> : null}
    {jobs.length > 0 ? <div className={styles.jobs} role="group" aria-label={`Running on ${computer.name}`}>
      {jobs.slice(0, COMPUTER_JOBS_LIMIT).map(job => <Job key={job} job={job} facts={facts?.get(job)} sessions={sessions} onOpen={onOpenJob} />)}
      {more > 0 ? onOpenSessions
        ? <button type="button" className={styles.jobsMore} onClick={onOpenSessions}>and {more} more in Sessions</button>
        : <span className={styles.muted}>and {more} more in Sessions</span> : null}
    </div> : null}
  </li>;
}

/** One card per computer, in the server's words. `view` is null when the list cannot be read. */
export function ComputersBody({ view, sessions, sessionsStale = false, onOpenJob, onOpenSessions }: { view: ComputersView | null | undefined; sessions?: SessionsRead; sessionsStale?: boolean } & Opens) {
  if (view === undefined) return <p className={styles.muted} role="status">Looking for your computers…</p>;
  if (!view || view.computers.length === 0) return <p className={styles.muted}>Computers are unavailable right now.</p>;
  const ready = view.computers.filter((c) => c.stateCode === 'ready').length;
  const facts = sessions ? jobFacts(sessions) : null;
  return <>
    <p className={styles.headline}>{ready} of {view.computers.length} ready for work</p>
    <p className={styles.line}>{runningLine(view.computers)}</p>
    {sessionsStale ? <p className={styles.line} data-tone="warn" role="status">Could not refresh the sessions list. Job details below are from the last read and may be stale.</p> : null}
    <ul className={styles.computers}>{view.computers.map((c, i) => <Computer computer={c} facts={facts} sessions={sessions} onOpenJob={onOpenJob} onOpenSessions={onOpenSessions} key={`${i}:${c.name}`} />)}</ul>
    {view.computers.length === 1
      ? <p className={styles.line}>This is your only computer so far. To add another, connect it to your Tailscale network and run <code>phm node join</code> on it.</p>
      : null}
    {view.reasons.map((reason, i) => <p className={styles.muted} key={`${i}:${reason}`}>{reason}</p>)}
  </>;
}

export function ComputersPane({ visible, host }: Pick<PaneProps, 'visible'> & Partial<Pick<PaneProps, 'host'>>) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(computersQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 15_000 });
  const refetch = useRefetch(computersQuery);
  usePollWhileVisible(refetch, 15_000, { enabled: visible, refreshOnShow: false });
  const view = read.status === 'error' ? null : read.data;
  // The sessions list is only read when some computer has a job to describe.
  const wanted = visible && sectionVisible && documentVisible && (view?.computers.some(c => c.jobs !== 'unknown' && c.jobs.length > 0) ?? false);
  const sessions = useQuery(liveSessionsQuery, { enabled: wanted, freshMs: SESSIONS_POLL_MS });
  const refetchSessions = useRefetch(liveSessionsQuery);
  usePollWhileVisible(refetchSessions, 15_000, { enabled: wanted, refreshOnShow: false });
  const failed = Boolean(sessions.error) || sessions.status === 'error';
  // A failed first read is "could not be read" (null); a failed refresh keeps the last list and says it may be stale.
  const list: SessionsRead = !wanted ? undefined : sessions.data ?? (failed || sessions.data === null ? null : undefined);
  return <div className={styles.pane} aria-label="Computers">
    <ComputersBody view={view} sessions={list} sessionsStale={failed && Boolean(sessions.data)}
      onOpenJob={host ? (job) => { requestWorkerLogJob(job); host.openPane('worker-log'); } : undefined}
      onOpenSessions={host ? () => host.openPane('fleet-sessions') : undefined} />
  </div>;
}

/**
 * The session-threads reader (server only): the session list, the bus, the Leader inbox, the order trace, the job control file and the leader's replies once, then each shown job's activity and each running job's last log lines, joined by session-threads.ts.
 * The same reads, taken for whole conversations, are what `readSessionFind` searches (session-find.ts).
 */
import { AGENT_MESSAGES_MAX_LIMIT, readAgentMessages, type AgentMessages } from './agent-messages.js';
import { readJobControlLedger } from './job-control.js';
import type { JobControlLedgerRow } from './job-control-types.js';
import type { LiveSessionsFilter, LiveSessionsV1 } from './live-sessions.js';
import { readLiveSessions } from './live-sessions-read.js';
import { readInboxEntries } from './mason-inbox.js';
import { readLeaderReplies, type LeaderRepliesV1 } from './mason-outbox.js';
import { readOrderTrace, type OrderTraceV1 } from './order-trace.js';
import { getFleetJobActivity, type FleetJobActivityV1 } from './runs-job-activity.js';
import { isFleetJobId } from './runs-job-detail.js';
import type { LeaderSessionFacts } from './session-tree.js';
import { buildSessionFind, findSessions, findWords, type SessionFindV1 } from './session-find.js';
import { THREAD_LIMITS, THREAD_OWNER_WINDOW, THREAD_REPLIES_SHOWN, type SessionThreadOutputRead, type SessionThreadOwnerRead } from './session-thread.js';
import { readSessionOutput } from './session-thread-read.js';
import { buildSessionThreads, threadSessions, type SessionThreadsParts, type SessionThreadsV1 } from './session-threads.js';
import type { FleetSessionMap } from './sessions-view.js';
import type { SubagentRecord } from '../subagent/spawn.js';
import { sanitizePublicJson } from '../util/public-json.js';

export interface SessionThreadsReadOptions extends Pick<LiveSessionsFilter, 'lane' | 'repo' | 'live'> {
  now?: number;
  /** The session map; a throw reads as "sessions unknown", never as "no sessions". */
  readMap?: (now: number) => Promise<FleetSessionMap>;
  readSubagents?: () => Promise<SubagentRecord[]>;
  readLeader?: (now: number) => Promise<LeaderSessionFacts | null>;
  readActivity?: (job: string) => Promise<FleetJobActivityV1>;
  readBus?: () => AgentMessages | Promise<AgentMessages>;
  /** The Leader inbox, newest first. Asked for once when the leader or a worker is shown, never for helpers alone. */
  readOwner?: () => Promise<SessionThreadOwnerRead>;
  readReplies?: () => Promise<LeaderRepliesV1>;
  /** The order trace (which jobs serve which of Mason's messages). Asked for once when the leader or a worker with a job is shown. */
  readOrders?: () => Promise<OrderTraceV1>;
  /** The end of one job's log. Asked only for the running sessions shown: a finished one's card ends with its outcome. */
  readOutput?: (job: string) => Promise<SessionThreadOutputRead>;
  /** The job control file, oldest first. Asked for once when a session with a job is shown. */
  readControls?: () => Promise<readonly JobControlLedgerRow[]>;
}

/** Job activity reads that run at once: each opens a handful of files in that job's run directory. */
const ACTIVITY_AT_ONCE = 8;
const guarded = <T>(read: () => T | Promise<T>): Promise<T | null> => Promise.resolve().then(read).catch(() => null);

/** The session list and everything read for the sessions picked from it, as both builders take them. */
export interface SessionThreadsPartsRead { list: LiveSessionsV1; parts: SessionThreadsParts; now: number }
type Picked = { id: string; jobId: string | null; kind: string; running?: boolean };

/**
 * Each read is guarded on its own: a failure is named in that thread's `gaps` (or the read's) and leaves the rest intact.
 * Only the sessions picked have their activity read. `whole` reads for whole conversations: the end of every picked
 * job's log, running or not, and as many leader replies as a full thread shows.
 */
async function readParts(options: SessionThreadsReadOptions, pick: (list: LiveSessionsV1) => Picked[], whole: boolean): Promise<SessionThreadsPartsRead> {
  const now = options.now ?? Date.now();
  const readMap = options.readMap ?? (async (at: number) => (await import('./sessions-view.js')).readFleetSessionMap({ now: at }));
  const map = await guarded(() => readMap(now));
  const list = await readLiveSessions({ now, lane: options.lane ?? null, repo: options.repo ?? null, ...(options.live ? { live: true } : {}),
    readSubagents: options.readSubagents, ...(options.readLeader ? { readLeader: options.readLeader } : {}),
    readMap: async () => { if (!map) throw new Error('session map unreadable'); return map; } });
  const activity = new Map<string, FleetJobActivityV1 | null>();
  if (map === null) return { list, parts: { sessionsRead: false, bus: null, activity }, now };

  const shown = pick(list);
  const jobs = [...new Set(shown.map(entry => entry.jobId).filter((job): job is string => job !== null && isFleetJobId(job)))];
  const readActivity = options.readActivity ?? ((job: string) => getFleetJobActivity(job));
  const readOutput = options.readOutput ?? readSessionOutput;
  const writing = new Set(shown.filter(entry => whole || entry.running).map(entry => entry.jobId));
  const output = new Map<string, SessionThreadOutputRead | null>();
  const activities = (async () => {
    for (let start = 0; start < jobs.length; start += ACTIVITY_AT_ONCE) {
      await Promise.all(jobs.slice(start, start + ACTIVITY_AT_ONCE).map(async job => {
        const [recorded, wrote] = await Promise.all([guarded(() => readActivity(job)), writing.has(job) ? guarded(() => readOutput(job)) : undefined]);
        activity.set(job, recorded);
        if (wrote !== undefined) output.set(job, wrote);
      }));
    }
  })();
  const [bus, owner, replies, orders, controls] = await Promise.all([
    guarded(options.readBus ?? (() => readAgentMessages({ limit: AGENT_MESSAGES_MAX_LIMIT }))),
    shown.some(entry => entry.kind !== 'subagent') ? guarded(options.readOwner ?? (() => readInboxEntries({ limit: THREAD_OWNER_WINDOW }))) : undefined,
    shown.some(entry => entry.kind === 'leader') ? guarded(options.readReplies ?? (() => readLeaderReplies({ limit: whole ? THREAD_LIMITS.full.replies : THREAD_REPLIES_SHOWN }))) : undefined,
    shown.some(entry => entry.kind === 'leader' || (entry.kind === 'worker' && entry.jobId !== null))
      ? guarded(options.readOrders ?? (() => readOrderTrace({ now: () => now }))) : undefined,
    jobs.length > 0 ? guarded(options.readControls ?? (() => readJobControlLedger())) : undefined,
    activities,
  ]);
  return { list, now, parts: { sessionsRead: true, bus, activity, output,
    ...(owner === undefined ? {} : { owner }), ...(replies === undefined ? {} : { replies }),
    ...(orders === undefined ? {} : { orders }), ...(controls === undefined ? {} : { controls }) } };
}

/** Every session as a short thread. Only the sessions shown have their activity read. */
export async function readSessionThreads(options: SessionThreadsReadOptions = {}): Promise<SessionThreadsV1> {
  const { list, parts, now } = await readParts(options, read => threadSessions(read).shown, false);
  // Sanitizing keeps the shape; it only rewrites home paths and secret-shaped strings.
  return sanitizePublicJson(buildSessionThreads(list, parts, now)) as SessionThreadsV1;
}

/** What a search looks through, read once: one of these serves any number of queries (the route shares it for a few seconds). */
export const readSessionFindParts = (options: SessionThreadsReadOptions = {}): Promise<SessionThreadsPartsRead> => readParts(options, read => findSessions(read).searched, true);

/** The sessions whose whole conversation holds every word of `query`. The builder scrubs each conversation before it is searched. */
export async function readSessionFind(query: string, options: SessionThreadsReadOptions = {}): Promise<SessionFindV1> {
  const { list, parts, now } = await readSessionFindParts(options);
  return buildSessionFind(list, parts, findWords(query), now);
}

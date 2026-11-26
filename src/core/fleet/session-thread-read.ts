/** The session-thread reader (server only): the session list, then only the reads that session needs (its log's last lines among them), joined by session-thread.ts. */
import { AGENT_MESSAGES_MAX_LIMIT, readAgentMessages, type AgentMessages } from './agent-messages.js';
import { readJobControlLedger } from './job-control.js';
import type { JobControlLedgerRow } from './job-control-types.js';
import { readLiveSessions } from './live-sessions-read.js';
import { readInboxEntries } from './mason-inbox.js';
import { readLeaderReplies, type LeaderRepliesV1 } from './mason-outbox.js';
import { readOrderTrace, type OrderTraceV1 } from './order-trace.js';
import { getFleetJobActivity, type FleetJobActivityV1 } from './runs-job-activity.js';
import { isFleetJobId, scanJobLog } from './runs-job-detail.js';
import { buildSessionThread, THREAD_LIMITS, THREAD_OWNER_WINDOW, type SessionThreadDepth, type SessionThreadOutputRead, type SessionThreadOwnerRead, type SessionThreadV1 } from './session-thread.js';
import type { FleetSessionMap } from './sessions-view.js';
import type { SubagentRecord } from '../subagent/spawn.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { readOwnerDisplayName } from '../owner-display-read.js';

export interface SessionThreadReadOptions {
  now?: number;
  /** `recent` unless told: the newest few of each record. `full` shows as much as the same reads hold. */
  depth?: SessionThreadDepth;
  /** The session map; a throw reads as "sessions unknown", never as "no such session". */
  readMap?: (now: number) => Promise<FleetSessionMap>;
  readSubagents?: () => Promise<SubagentRecord[]>;
  readActivity?: (job: string) => Promise<FleetJobActivityV1>;
  readBus?: () => AgentMessages | Promise<AgentMessages>;
  /** The Leader inbox, newest first. Asked for the leader and for a worker, never for a helper. */
  readOwner?: () => Promise<SessionThreadOwnerRead>;
  readReplies?: () => Promise<LeaderRepliesV1>;
  /** Which jobs serve which of Mason's messages. Asked for the leader and for a worker with a job, never for a helper. */
  readOrders?: () => Promise<OrderTraceV1>;
  /** The end of the session's job log. Asked for a session with a job. */
  readOutput?: (job: string) => Promise<SessionThreadOutputRead>;
  /** The job control file, oldest first. Asked for a session with a job. */
  readControls?: () => Promise<readonly JobControlLedgerRow[]>;
}

/** How much of the end of a job log a thread reads for the lines it shows: far less than the activity scan. */
const OUTPUT_BYTES = 24 * 1024, OUTPUT_LINES = 120;
/** The end of one job's log, through the same no-follow, scrubbed read the job detail uses. */
export const readSessionOutput = (job: string): Promise<SessionThreadOutputRead> => scanJobLog(job, { maxBytes: OUTPUT_BYTES, maxLines: OUTPUT_LINES });

const guarded = <T>(read: () => T | Promise<T>): Promise<T | null> => Promise.resolve().then(read).catch(() => null);

/**
 * One session's thread. Each read is guarded on its own: a failure names itself in `gaps` and `sources`
 * and leaves the rest of the thread intact. The session list is read first, so an unknown id costs one read.
 */
export async function readSessionThread(id: string, options: SessionThreadReadOptions = {}): Promise<SessionThreadV1> {
  const now = options.now ?? Date.now(), depth = options.depth ?? 'recent';
  const readMap = options.readMap ?? (async (at: number) => (await import('./sessions-view.js')).readFleetSessionMap({ now: at }));
  const map = await guarded(() => readMap(now));
  const sessionsRead = map !== null;
  const list = await readLiveSessions({ now, readSubagents: options.readSubagents, readMap: async () => { if (!map) throw new Error('session map unreadable'); return map; } });

  const found = buildSessionThread(list, id, { sessionsRead, bus: null }, now, depth);
  if (!found.session) return sanitizePublicJson(found) as SessionThreadV1;
  const { jobId, kind } = found.session;
  const job = jobId !== null && isFleetJobId(jobId) ? jobId : null;
  const [activity, bus, owner, replies, orders, output, controls, ownerName] = await Promise.all([
    job === null ? undefined : guarded(() => (options.readActivity ?? (name => getFleetJobActivity(name)))(job)),
    guarded(options.readBus ?? (() => readAgentMessages({ limit: AGENT_MESSAGES_MAX_LIMIT }))),
    kind === 'subagent' ? undefined : guarded(options.readOwner ?? (() => readInboxEntries({ limit: THREAD_OWNER_WINDOW }))),
    kind !== 'leader' ? undefined : // One more than is shown, so the thread can say an earlier reply exists.
    guarded(options.readReplies ?? (() => readLeaderReplies({ limit: THREAD_LIMITS[depth].replies + 1 }))),
    kind === 'leader' || (kind === 'worker' && jobId !== null) ? guarded(options.readOrders ?? (() => readOrderTrace({ now: () => now }))) : undefined,
    job === null ? undefined : guarded(() => (options.readOutput ?? readSessionOutput)(job)),
    job === null ? undefined : guarded(options.readControls ?? (() => readJobControlLedger())),
    kind === 'subagent' ? undefined : readOwnerDisplayName(),
  ]);
  // Sanitizing keeps the shape; it only rewrites home paths and secret-shaped strings.
  return sanitizePublicJson(buildSessionThread(list, id, { sessionsRead, activity, bus, owner, replies, orders, output, controls, ownerName }, now, depth)) as SessionThreadV1;
}

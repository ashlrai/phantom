/** The session-thread reader (server only): the session list, then only the reads that session needs, joined by session-thread.ts. */
import { AGENT_MESSAGES_MAX_LIMIT, readAgentMessages, type AgentMessages } from './agent-messages.js';
import { readLiveSessions } from './live-sessions-read.js';
import { readLeaderReplies, type LeaderRepliesV1 } from './mason-outbox.js';
import { getFleetJobActivity, type FleetJobActivityV1 } from './runs-job-activity.js';
import { isFleetJobId } from './runs-job-detail.js';
import { buildSessionThread, THREAD_REPLIES_SHOWN, type SessionThreadV1 } from './session-thread.js';
import type { FleetSessionMap } from './sessions-view.js';
import type { SubagentRecord } from '../subagent/spawn.js';
import { sanitizePublicJson } from '../util/public-json.js';

export interface SessionThreadReadOptions {
  now?: number;
  /** The session map; a throw reads as "sessions unknown", never as "no such session". */
  readMap?: (now: number) => Promise<FleetSessionMap>;
  readSubagents?: () => Promise<SubagentRecord[]>;
  readActivity?: (job: string) => Promise<FleetJobActivityV1>;
  readBus?: () => AgentMessages | Promise<AgentMessages>;
  readReplies?: () => Promise<LeaderRepliesV1>;
}

const guarded = <T>(read: () => T | Promise<T>): Promise<T | null> => Promise.resolve().then(read).catch(() => null);

/**
 * One session's thread. Each read is guarded on its own: a failure names itself in `gaps` and `sources`
 * and leaves the rest of the thread intact. The session list is read first, so an unknown id costs one read.
 */
export async function readSessionThread(id: string, options: SessionThreadReadOptions = {}): Promise<SessionThreadV1> {
  const now = options.now ?? Date.now();
  const readMap = options.readMap ?? (async (at: number) => (await import('./sessions-view.js')).readFleetSessionMap({ now: at }));
  const map = await guarded(() => readMap(now));
  const sessionsRead = map !== null;
  const list = await readLiveSessions({ now, readSubagents: options.readSubagents, readMap: async () => { if (!map) throw new Error('session map unreadable'); return map; } });

  const found = buildSessionThread(list, id, { sessionsRead, bus: null }, now);
  if (!found.session) return sanitizePublicJson(found) as SessionThreadV1;
  const { jobId, kind } = found.session;
  const job = jobId !== null && isFleetJobId(jobId) ? jobId : null;
  const [activity, bus, replies] = await Promise.all([
    job === null ? undefined : guarded(() => (options.readActivity ?? (name => getFleetJobActivity(name)))(job)),
    guarded(options.readBus ?? (() => readAgentMessages({ limit: AGENT_MESSAGES_MAX_LIMIT }))),
    kind !== 'leader' ? undefined : guarded(options.readReplies ?? (() => readLeaderReplies({ limit: THREAD_REPLIES_SHOWN }))),
  ]);
  // Sanitizing keeps the shape; it only rewrites home paths and secret-shaped strings.
  return sanitizePublicJson(buildSessionThread(list, id, { sessionsRead, activity, bus, replies }, now)) as SessionThreadV1;
}

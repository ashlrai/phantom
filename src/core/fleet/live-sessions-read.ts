/** The live-sessions reader (server only): the session map, projected by live-sessions.ts. */
import { basename, dirname, join } from 'node:path';
import { buildLiveSessions, type LiveSessionsFilter, type LiveSessionsV1 } from './live-sessions.js';
import { defaultRunsDir } from './landed-closes-read.js';
import { readLeaderLiveness } from './leader-liveness-evidence.js';
import { planLogPath, readLeaderReplies, replyTime } from './mason-outbox.js';
import type { LeaderSessionFacts } from './session-tree.js';
import { readFleetSessionMap, type FleetSessionMap } from './sessions-view.js';
import { readSubagentRecords, type SubagentRecord } from '../subagent/spawn.js';
import { sanitizePublicJson } from '../util/public-json.js';

/**
 * What the leader's own files record about its session, for its row in the
 * tree: when its last planning pass ended (the newest dated heading of the
 * plan log, the same evidence `readLeaderLiveness` reports) and the newest
 * reply it wrote to the owner (`leader.replies.v1`: the plan log plus the
 * MASON-OUTBOX beside it). Read only, bounded tails, never throws: a file that
 * is missing or unreadable leaves its fields null (unknown).
 *
 * The plan log is found the way `phm leader replies` finds it: `planLog`, else
 * PHANTOM_PLAN_LOG, else `comms.leaderPlanLogPath`, else the runs dir.
 */
export async function readLeaderSessionFacts(opts: { runsDir?: string; planLog?: string; now?: number } = {}): Promise<LeaderSessionFacts> {
  const now = opts.now ?? Date.now();
  const facts: LeaderSessionFacts = { lastPassAt: null, lastReplyAt: null, lastReply: null };
  let planLog = opts.planLog ?? (opts.runsDir ? join(opts.runsDir, 'leader', 'PLAN-LOG.md') : undefined);
  if (planLog === undefined) {
    try { planLog = (await import('../config.js')).loadConfigReadOnly().comms?.leaderPlanLogPath; } catch { /* The default path still answers. */ }
  }
  const path = planLogPath(undefined, planLog);
  // The liveness read takes the directory that holds leader/PLAN-LOG.md; a plan log kept elsewhere has no pass evidence there.
  const root = basename(path) === 'PLAN-LOG.md' && basename(dirname(path)) === 'leader' ? dirname(dirname(path)) : opts.runsDir ?? defaultRunsDir();
  const [liveness, replies] = await Promise.all([
    readLeaderLiveness(root, now).catch(() => null),
    readLeaderReplies({ limit: 1, planLog }).catch(() => null),
  ]);
  facts.lastPassAt = liveness?.as_of ?? null;
  const reply = replies?.replies[0];
  if (reply && reply.text.trim() !== '') {
    const at = replyTime(reply.at);
    facts.lastReply = reply.text;
    facts.lastReplyAt = Number.isFinite(at) ? new Date(at).toISOString() : null;
  }
  return facts;
}

/** The default reader: the same session map the Compute map reads. Any failure reads as "unknown", never as an empty fleet. */
export async function readLiveSessions(options: LiveSessionsFilter & {
  readMap?: (now: number) => Promise<FleetSessionMap>; readSubagents?: () => Promise<SubagentRecord[]>;
  /** The leader's row; defaults to `readLeaderSessionFacts`. A failure leaves the leader unknown. */
  readLeader?: (now: number) => Promise<LeaderSessionFacts | null>; now?: number;
} = {}): Promise<LiveSessionsV1> {
  const now = options.now ?? Date.now();
  const readMap = options.readMap ?? ((at: number) => readFleetSessionMap({ now: at }));
  const readLeader = options.readLeader ?? ((at: number) => readLeaderSessionFacts({ now: at }));
  const [map, subagents, leader] = await Promise.all([
    Promise.resolve().then(() => readMap(now)).catch(() => null),
    options.subagents !== undefined ? options.subagents : Promise.resolve().then(options.readSubagents ?? (() => readSubagentRecords())).catch(() => null),
    options.leader !== undefined ? options.leader : Promise.resolve().then(() => readLeader(now)).catch(() => null),
  ]);
  // Sanitizing keeps the shape; it only rewrites home paths and secret-shaped strings.
  return sanitizePublicJson(buildLiveSessions(map, now, { ...options, subagents, leader })) as LiveSessionsV1;
}

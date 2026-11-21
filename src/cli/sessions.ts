/**
 * `phm sessions`: the tree of every fleet agent session (no verb), one session's
 * live log (tail; cmdJobTail in job.ts), one session as a conversation (thread), every
 * session as a short conversation (threads), words looked for in every
 * session's whole conversation (find), MCP gateway
 * sessions (list, revoke) and resumable agent sessions (create, show, resume,
 * terminate; list shows both kinds). Thin handler: logic lives in
 * src/core/fleet/live-sessions.ts, src/core/gateway-sessions.ts and
 * src/core/agents/session.ts.
 */
import { parseArgs } from 'node:util';
import { listGatewaySessions, revokeGatewaySession } from '../core/gateway-sessions.js';
import {
  AgentSessionError, createAgentSession, getAgentSession, listAgentSessions, resumeAgentSession, terminateAgentSession,
  type AgentSession, type SessionErrorCode,
} from '../core/agents/session.js';
import { renderLiveSessionsText, SESSION_FILTER_RE } from '../core/fleet/live-sessions.js';
import { readLiveSessions } from '../core/fleet/live-sessions-read.js';
import { getFleetSessions } from '../core/fleet/runs-sessions.js';
import { renderSessionThreadText, SESSION_ID_RE, type SessionThreadDepth, type SessionThreadV1 } from '../core/fleet/session-thread.js';
import { readSessionThread } from '../core/fleet/session-thread-read.js';
import { renderSessionThreadsText, type SessionThreadsV1 } from '../core/fleet/session-threads.js';
import { readSessionFind, readSessionThreads } from '../core/fleet/session-threads-read.js';
import { FIND_QUERY_CHARS, findWords, renderSessionFindText, type SessionFindV1 } from '../core/fleet/session-find.js';
import { reconcileSessions, renderSessionReconciliation } from '../core/fleet/session-reconciliation.js';

const USAGE = `Usage:
  phm sessions [--lane <lane>] [--repo <repo>] [--json] [--live]
                                      Every agent session as one tree: leader, workers,
                                      subagents. Each row: model, repo, state, when it last
                                      spoke (quiet after 10 min) and its last message.
                                      Finished ones stay an hour; --live shows only running
                                      ones. Read only.
  phm sessions tail <id> [--follow] [--lines N] [--json]
                                      What one session is doing now: its last 200 log lines,
                                      redacted; --follow streams new ones (one JSON object
                                      per line with --json). Exit 2 for an unknown id.
  phm sessions thread <id> [--all] [--json]
                                      One session as a conversation: a summary, then its brief,
                                      recorded steps, commands, changed files, notes, the bus
                                      messages about it and its last message. The id is
                                      leader, a job id or a subagent id. It shows the newest
                                      few of each; --all shows the earlier ones the same
                                      records hold. Read only; exit 2 for an unknown id.
  phm sessions threads [--lane <lane>] [--repo <repo>] [--live] [--json]
                                      Every session as a short conversation on one screen:
                                      its summary and its newest 3 messages, yours included,
                                      leader first. Up to 40 sessions. Read only; exit 1
                                      when the session list could not be read.
  phm sessions find <words> [--lane <lane>] [--repo <repo>] [--live] [--json]
                                      The sessions whose whole conversation holds every
                                      word, with the messages that hold one. Looks through
                                      what thread <id> --all shows, in up to 120
                                      sessions. Read only; exit 1 when the session list
                                      could not be read.
  phm sessions list [--json]          Show gateway sessions and agent sessions
  phm sessions reconcile [--json]     Check local runs: live, finished or unknown. Read only.
  phm sessions revoke <id> [--json]   Block a gateway session's next tool call
  phm sessions create --agent <id> --agent-version <n> --environment <id> --job <queue-job-id> [--dir <queue-directory>] [--json]
                                      Start an agent session; the queue job is turn 1
  phm sessions show <sesn_id> [--json]
                                      Status, turns and the full event log
  phm sessions resume <sesn_id> [--scope <text>] [--acceptance <text>] [--json]
                                      Queue the next turn (--scope is required when idle;
                                      omit it to retry a blocked turn)
  phm sessions terminate <sesn_id> [--reason <text>] [--json]
                                      End an agent session; its queue jobs are untouched
Agent session statuses: idle, running, rescheduling, terminated. See docs/SESSIONS.md.
`;

const AGENT_VERBS: Record<string, string[]> = {
  create: ['agent', 'agent-version', 'environment', 'job', 'dir'],
  show: [],
  resume: ['scope', 'acceptance'],
  terminate: ['reason'],
};

function sessionLine(s: AgentSession): string {
  const last = s.turns.at(-1);
  return `${s.id}  ${s.status.padEnd(12)}  ${s.agent.id} v${s.agent.version}  env ${s.environmentId}  turn ${s.turns.length}${last ? ` ${last.jobId} ${last.queueStatus}` : ''}`;
}

const exitFor = (code: SessionErrorCode): number => (code === 'invalid-id' || code === 'invalid' ? 2 : 1);

async function runAgentVerb(verb: string, args: string[], json: boolean): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args, allowPositionals: true, strict: true,
      options: { json: { type: 'boolean' }, ...Object.fromEntries(AGENT_VERBS[verb].map(key => [key, { type: 'string' as const }])) },
    }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments'}\n${USAGE}`);
    return 2;
  }
  if (positionals.length !== (verb === 'create' ? 0 : 1)) { process.stderr.write(USAGE); return 2; }
  const str = (key: string): string | undefined => (typeof values[key] === 'string' ? values[key] as string : undefined);
  try {
    if (verb === 'create') {
      const missing = ['agent', 'agent-version', 'environment', 'job'].filter(key => !str(key)?.trim());
      if (missing.length) throw new AgentSessionError('invalid', `Required: ${missing.map(key => `--${key}`).join(' ')}`);
      const version = str('agent-version')!;
      const session = await createAgentSession({
        agentId: str('agent')!, agentVersion: /^\d+$/.test(version) ? Number(version) : NaN,
        environmentId: str('environment')!, jobId: str('job')!, queueDir: str('dir'),
      });
      if (json) console.log(JSON.stringify({ ok: true, session }));
      else console.log(`Created ${session.id} (${session.status}). Turn 1 is job ${session.turns[0].jobId}.`);
      return 0;
    }
    const id = positionals[0];
    if (verb === 'show') {
      const { session, events } = await getAgentSession(id);
      if (json) { console.log(JSON.stringify({ session, events })); return 0; }
      console.log(sessionLine(session));
      for (const turn of session.turns) console.log(`  turn ${turn.turn}  ${turn.jobId}  ${turn.queueStatus}  (${turn.source}, ${turn.queuedAt})`);
      if (session.terminatedAt) console.log(`  terminated ${session.terminatedAt}${session.terminationReason ? `: ${session.terminationReason}` : ''}`);
      if (session.queueError) console.log(`  queue unreadable, showing last observation: ${session.queueError}`);
      if (session.skippedLines) console.log(`  ${session.skippedLines} unreadable log line(s) skipped`);
      return 0;
    }
    if (verb === 'resume') {
      const { session, job } = await resumeAgentSession(id, { scope: str('scope'), acceptance: str('acceptance') });
      if (json) console.log(JSON.stringify({ ok: true, session, job }));
      else console.log(`Queued turn ${session.turns.length} of ${session.id} as job ${job.id}. Status: ${session.status}.`);
      return 0;
    }
    const { session, alreadyTerminated } = await terminateAgentSession(id, { reason: str('reason') });
    if (json) console.log(JSON.stringify({ ok: true, alreadyTerminated, session }));
    else console.log(alreadyTerminated ? `${session.id} was already terminated.` : `Terminated ${session.id}. Its queue jobs are unchanged.`);
    return 0;
  } catch (error) {
    const code: SessionErrorCode | 'error' = error instanceof AgentSessionError ? error.code : 'error';
    const message = error instanceof Error ? error.message : 'Agent session operation failed';
    if (json) console.log(JSON.stringify({ ok: false, reason: code, error: message }));
    else process.stderr.write(`${message}\n`);
    return code === 'error' ? 1 : exitFor(code);
  }
}

/** `phm sessions [--lane L] [--repo R] [--json] [--live]`: the session tree. The reader is injectable for tests. */
export async function cmdLiveSessions(args: string[], read: typeof readLiveSessions = readLiveSessions): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(USAGE); return 0; }
  let values: { json?: boolean; live?: boolean; lane?: string; repo?: string };
  try {
    ({ values } = parseArgs({ args, strict: true, allowPositionals: false,
      options: { json: { type: 'boolean' }, live: { type: 'boolean' }, lane: { type: 'string' }, repo: { type: 'string' } } }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments'}\n${USAGE}`);
    return 2;
  }
  for (const key of ['lane', 'repo'] as const) {
    if (values[key] !== undefined && !SESSION_FILTER_RE.test(values[key])) {
      process.stderr.write(`--${key} takes a ${key} name such as claude or phantom.\n${USAGE}`);
      return 2;
    }
  }
  const list = await read({ lane: values.lane ?? null, repo: values.repo ?? null, ...(values.live ? { live: true } : {}) });
  console.log(values.json ? JSON.stringify(list, null, 2) : renderLiveSessionsText(list));
  return 0;
}

/**
 * `phm sessions thread <id> [--all] [--json]`: one session as a conversation. `--all` asks for depth `full` (the read is
 * given a second argument only then). Exit 0 read, 1 sessions unreadable, 2 usage or unknown id.
 */
export async function cmdSessionThread(args: string[],
  read: (id: string, depth?: SessionThreadDepth) => Promise<SessionThreadV1> = (id, depth) => readSessionThread(id, { depth })): Promise<number> {
  let values: { json?: boolean; all?: boolean }, positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { json: { type: 'boolean' }, all: { type: 'boolean' } } }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments'}\n${USAGE}`);
    return 2;
  }
  const id = positionals[0];
  if (positionals.length !== 1 || id === undefined || !SESSION_ID_RE.test(id)) {
    process.stderr.write('Usage: phm sessions thread <id> [--all] [--json]. The id is leader, a job id or a subagent id from `phm sessions`.\n');
    return 2;
  }
  const thread = values.all ? await read(id, 'full') : await read(id);
  if (thread.session) { console.log(values.json ? JSON.stringify(thread, null, 2) : renderSessionThreadText(thread)); return 0; }
  const unreadable = thread.sources.sessions === 'unavailable';
  if (values.json) console.log(JSON.stringify(thread, null, 2));
  else process.stderr.write(`${thread.gaps.join('\n')}${unreadable ? '' : '\nSee every session: phm sessions'}\n`);
  return unreadable ? 1 : 2;
}

const THREADS_USAGE = 'Usage: phm sessions threads [--lane <lane>] [--repo <repo>] [--live] [--json]\n';

/** `phm sessions threads [--lane L] [--repo R] [--live] [--json]`: every session as a short conversation. Exit 0 read, 1 sessions unreadable, 2 usage. */
export async function cmdSessionThreads(args: string[],
  read: (filter: { lane: string | null; repo: string | null; live?: boolean }) => Promise<SessionThreadsV1> = filter => readSessionThreads(filter)): Promise<number> {
  let values: { json?: boolean; live?: boolean; lane?: string; repo?: string };
  try {
    ({ values } = parseArgs({ args, strict: true, allowPositionals: false,
      options: { json: { type: 'boolean' }, live: { type: 'boolean' }, lane: { type: 'string' }, repo: { type: 'string' } } }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments'}\n${THREADS_USAGE}`);
    return 2;
  }
  for (const key of ['lane', 'repo'] as const) {
    if (values[key] !== undefined && !SESSION_FILTER_RE.test(values[key])) {
      process.stderr.write(`--${key} takes a ${key} name such as claude or phantom.\n${THREADS_USAGE}`);
      return 2;
    }
  }
  const threads = await read({ lane: values.lane ?? null, repo: values.repo ?? null, ...(values.live ? { live: true } : {}) });
  const unreadable = threads.sources.sessions === 'unavailable';
  if (values.json) console.log(JSON.stringify(threads, null, 2));
  else if (unreadable) process.stderr.write(`${threads.gaps.join('\n')}\n`);
  else console.log(renderSessionThreadsText(threads));
  return unreadable ? 1 : 0;
}

const FIND_USAGE = 'Usage: phm sessions find <words> [--lane <lane>] [--repo <repo>] [--live] [--json]\n';

/**
 * `phm sessions find <words> [--lane L] [--repo R] [--live] [--json]`: the sessions whose whole conversation holds every word.
 * Exit 0 read (finding nothing is still a read), 1 sessions unreadable, 2 usage.
 */
export async function cmdSessionFind(args: string[],
  read: (query: string, filter: { lane: string | null; repo: string | null; live?: boolean }) => Promise<SessionFindV1> = (query, filter) => readSessionFind(query, filter)): Promise<number> {
  let values: { json?: boolean; live?: boolean; lane?: string; repo?: string }, positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args, strict: true, allowPositionals: true,
      options: { json: { type: 'boolean' }, live: { type: 'boolean' }, lane: { type: 'string' }, repo: { type: 'string' } } }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments'}\n${FIND_USAGE}`);
    return 2;
  }
  const query = positionals.join(' ');
  if (query.length > FIND_QUERY_CHARS || findWords(query).length === 0) {
    process.stderr.write(`Give the words to look for: each two characters or more, ${FIND_QUERY_CHARS} characters in all.\n${FIND_USAGE}`);
    return 2;
  }
  for (const key of ['lane', 'repo'] as const) {
    if (values[key] !== undefined && !SESSION_FILTER_RE.test(values[key])) {
      process.stderr.write(`--${key} takes a ${key} name such as claude or phantom.\n${FIND_USAGE}`);
      return 2;
    }
  }
  const found = await read(query, { lane: values.lane ?? null, repo: values.repo ?? null, ...(values.live ? { live: true } : {}) });
  const unreadable = found.sources.sessions === 'unavailable';
  if (values.json) console.log(JSON.stringify(found, null, 2));
  else if (unreadable) process.stderr.write(`${found.gaps.join('\n')}\n`);
  else console.log(renderSessionFindText(found));
  return unreadable ? 1 : 0;
}

export async function cmdReconcileSessions(args: string[], read: typeof getFleetSessions = getFleetSessions): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args, strict: true, allowPositionals: false, options: { json: { type: 'boolean' } } }));
  } catch { process.stderr.write(USAGE); return 2; }
  const report = reconcileSessions(await read());
  console.log(values.json ? JSON.stringify(report, null, 2) : renderSessionReconciliation(report));
  return 0;
}

export async function cmdSessions(args: string[]): Promise<number> {
  // No verb: the live list. `--json` alone stays the live list too; `list --json` is the gateway list.
  if (args[0] === undefined || args[0].startsWith('-')) return cmdLiveSessions(args);
  const json = args.includes('--json');
  const rest = args.filter(arg => arg !== '--json');
  const [sub, ...more] = rest;
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (more.includes('--help') || more.includes('-h')) { process.stdout.write(USAGE); return 0; }
  if (sub === 'reconcile') return cmdReconcileSessions(args.slice(1));
  if (sub === 'thread') return cmdSessionThread(args.slice(1));
  if (sub === 'threads') return cmdSessionThreads(args.slice(1));
  if (sub === 'find') return cmdSessionFind(args.slice(1));
  if (sub === 'tail') return (await import('./job.js')).cmdJobTail(args.slice(1), {}, 'session');

  if (sub === 'list' && more.length === 0) {
    const sessions = listGatewaySessions();
    const agent = await listAgentSessions().catch((error: unknown) => ({
      sessions: [] as AgentSession[], errors: [{ id: '*', error: error instanceof Error ? error.message : 'Agent sessions unreadable' }],
    }));
    if (json) { console.log(JSON.stringify({ sessions, agentSessions: agent.sessions, agentSessionErrors: agent.errors })); return 0; }
    if (sessions.length === 0) console.log('No gateway sessions yet. Start one with: phm mcp');
    for (const s of sessions) console.log(`${s.id}  ${s.status.padEnd(7)}  ${s.caller}  started ${s.startedAt}`);
    if (agent.sessions.length || agent.errors.length) {
      console.log('Agent sessions:');
      for (const s of agent.sessions) console.log(`  ${sessionLine(s)}`);
      for (const e of agent.errors) console.log(`  ${e.id}  unreadable: ${e.error}`);
    }
    return 0;
  }

  if (sub === 'revoke' && more.length === 1) {
    const result = revokeGatewaySession(more[0]);
    if (!result.ok) {
      const message = result.reason === 'invalid-id' ? `"${more[0].slice(0, 40)}" is not a session id (looks like gs_ plus 12 hex digits)` : `No session ${more[0]}. See: phm sessions list`;
      if (json) console.log(JSON.stringify({ ok: false, reason: result.reason }));
      else process.stderr.write(`${message}\n`);
      return result.reason === 'invalid-id' ? 2 : 1;
    }
    if (json) console.log(JSON.stringify({ ok: true, alreadyRevoked: result.alreadyRevoked, session: result.session }));
    else console.log(result.alreadyRevoked ? `${result.session.id} was already revoked.` : `Revoked ${result.session.id}. Its next tool call is blocked.`);
    return 0;
  }

  if (Object.hasOwn(AGENT_VERBS, sub)) return runAgentVerb(sub, rest.slice(1), json);

  process.stderr.write(USAGE);
  return 2;
}

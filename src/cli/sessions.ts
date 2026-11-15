/**
 * `phm sessions`: MCP gateway sessions (list, revoke) and resumable agent
 * sessions (create, show, resume, terminate; list shows both kinds).
 * Thin handler: logic lives in src/core/gateway-sessions.ts and
 * src/core/agents/session.ts.
 */
import { parseArgs } from 'node:util';
import { listGatewaySessions, revokeGatewaySession } from '../core/gateway-sessions.js';
import {
  AgentSessionError, createAgentSession, getAgentSession, listAgentSessions, resumeAgentSession, terminateAgentSession,
  type AgentSession, type SessionErrorCode,
} from '../core/agents/session.js';

const USAGE = `Usage:
  phm sessions list [--json]          Show gateway sessions and agent sessions
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

export async function cmdSessions(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const rest = args.filter(arg => arg !== '--json');
  const [sub, ...more] = rest;
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(USAGE);
    return sub === undefined ? 2 : 0;
  }
  if (more.includes('--help') || more.includes('-h')) { process.stdout.write(USAGE); return 0; }

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

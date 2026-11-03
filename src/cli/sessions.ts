/**
 * `phm sessions list|revoke <id>` — see running MCP gateway sessions and cut one off.
 * Thin handler: all logic lives in src/core/gateway-sessions.ts.
 */
import { listGatewaySessions, revokeGatewaySession } from '../core/gateway-sessions.js';

const USAGE = `Usage:
  phm sessions list [--json]          Show gateway sessions (id, caller, status)
  phm sessions revoke <id> [--json]   Block that session's next tool call
`;

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
    if (json) { console.log(JSON.stringify({ sessions })); return 0; }
    if (sessions.length === 0) { console.log('No gateway sessions yet. Start one with: phm mcp'); return 0; }
    for (const s of sessions) console.log(`${s.id}  ${s.status.padEnd(7)}  ${s.caller}  started ${s.startedAt}`);
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

  process.stderr.write(USAGE);
  return 2;
}

/**
 * Approval identity is never caller-supplied. It is derived from the
 * authenticated local OS user, optionally pinned by the owner config at
 * `$ASHLR_HOME/teams/owner.json` ({"human":"<name>"}). `--as`, PHM_TEAM_USER,
 * MCP arguments and any agent identity are ignored/rejected for decisions.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { ashlrHome } from '../cloud/store.js';
import type { TeamActor } from './protocol.js';
import { NON_OPERATOR_ENV_MARKERS } from '../authority/operator-context-markers.js';

/** Env markers set by agent runtimes; an approval from such a process is an agent approval. */
export const AGENT_ENV_MARKERS: readonly string[] = Object.freeze([...new Set([
  'PHM_AGENT_ID', 'ASHLR_AGENT_ID', 'ASHLR_AGENT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'GROK_BOT_AGENT', 'CURSOR_AGENT',
  ...NON_OPERATOR_ENV_MARKERS,
])]);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]/g, '');

export function ownerConfigPath(): string { return join(ashlrHome(), 'teams', 'owner.json'); }

export function localHumanActor(env: NodeJS.ProcessEnv = process.env): TeamActor {
  const marker = AGENT_ENV_MARKERS.find((k) => env[k] !== undefined && env[k] !== '');
  if (marker) throw new Error(`Approvals must come from the local human owner, not an agent process (${marker} is set).`);
  const osUser = norm(userInfo().username);
  let name = osUser;
  const p = ownerConfigPath();
  if (existsSync(p)) {
    const cfg = JSON.parse(readFileSync(p, 'utf8')) as { human?: unknown; osUser?: unknown };
    if (typeof cfg.osUser === 'string' && norm(cfg.osUser) !== osUser) throw new Error('This OS user is not the configured team owner.');
    if (typeof cfg.human === 'string' && norm(cfg.human)) name = norm(cfg.human);
  }
  if (!name || name.startsWith('agent')) throw new Error('Could not derive a human approval identity.');
  return { kind: 'human', id: `human:${name}` };
}

/** Throws unless `actor` is exactly the identity derived for this local process. */
export function assertLocalHuman(actor: TeamActor, env: NodeJS.ProcessEnv = process.env): TeamActor {
  if (actor.kind !== 'human' || actor.id.startsWith('agent:')) throw new Error('Only humans can decide approvals.');
  const local = localHumanActor(env);
  if (actor.id !== local.id) throw new Error(`Approval identity is derived locally (${local.id}); a caller-supplied identity (${actor.id}) is not accepted.`);
  return local;
}

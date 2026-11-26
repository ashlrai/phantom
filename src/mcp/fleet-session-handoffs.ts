/** Read-only fleet index of session-handoff checkpoints for the isolated fleet MCP server. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listSessionHandoffs } from '../core/agents/session-handoff.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const NOTE = 'Read-only index of this computer\'s session-handoff journals: every checkpointed job\'s latest revision, lane, model, tier, repo, signal, open-or-completed state and HEAD — the fleet-wide sibling of fleet_session_handoff, which still reads one job\'s full packet. Grants no claim, resume or dispatch authority. Takes no arguments: no caller root, path or cwd is accepted, and the tool never writes. Entries carry no goal, plan, decisions or context digest; per-job detail stays behind fleet_session_handoff. A missing store reports status missing; an unreadable one reports unavailable — never an invented empty index.';

export function parseFleetSessionHandoffsArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

export function readFleetSessionHandoffs(
  _args: Record<string, never>,
  deps: { runsDir?: string; list?: typeof listSessionHandoffs; now?: () => Date } = {},
) {
  const asOf = (deps.now ?? (() => new Date()))().toISOString();
  const base = { v: 1 as const, authority: 'none' as const, asOf, note: NOTE };
  try {
    const result = (deps.list ?? listSessionHandoffs)(deps.runsDir ?? join(homedir(), '.ashlr-runs'));
    return sanitizePublicJson({ ...base, status: result.status, handoffs: result.handoffs,
      unreadable: result.unreadable, truncated: result.truncated });
  } catch {
    return sanitizePublicJson({ ...base, status: 'unavailable' as const,
      reason: 'session-handoff-list-reader-failed', handoffs: null, unreadable: null, truncated: false });
  }
}

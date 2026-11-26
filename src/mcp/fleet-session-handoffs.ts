/** Read-only fleet index of session-handoff checkpoints for the isolated fleet MCP server. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listSessionHandoffs, parseSessionHandoffListArgs, type SessionHandoffListFilter } from '../core/agents/session-handoff.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const NOTE = 'Read-only index of this computer\'s session-handoff journals: every checkpointed job\'s latest revision, lane, model, tier, repo, signal, open-or-completed state and HEAD — the fleet-wide sibling of fleet_session_handoff, which still reads one job\'s full packet. Grants no claim, resume or dispatch authority. Optional filters narrow the journal-validated entries: state open|completed, job and lane ids, a repo owner/name slug (case-insensitive), a signal kind, pressure true|false (the same handoffPressure verdict planSessionFailover applies — rate-limit, quota-exhausted or a budget under its threshold), and since/before on the shared 15m/2h/1d/epoch-ms/ISO grammar composing into one [since, before) window on each entry\'s revision time; unknown keys and malformed values are refused before any store read. Entries carry no goal, plan, decisions or context digest; per-job detail stays behind fleet_session_handoff. Journals that fail validation land in unreadable by job id — only the job filter narrows that diagnostic list, since no other field is provable for a journal that cannot be read. A missing store reports status missing; an unreadable one reports unavailable — never an invented empty index.';

export function parseFleetSessionHandoffsArgs(args: Record<string, unknown>): SessionHandoffListFilter | null {
  const parsed = parseSessionHandoffListArgs(args);
  return parsed.ok ? (parsed.filter ?? {}) : null;
}

export function readFleetSessionHandoffs(
  args: SessionHandoffListFilter,
  deps: { runsDir?: string; list?: typeof listSessionHandoffs; now?: () => Date } = {},
) {
  const asOf = (deps.now ?? (() => new Date()))().toISOString();
  const base = { v: 1 as const, authority: 'none' as const, asOf, note: NOTE };
  try {
    const result = (deps.list ?? listSessionHandoffs)(deps.runsDir ?? join(homedir(), '.ashlr-runs'), args);
    return sanitizePublicJson({ ...base, status: result.status, handoffs: result.handoffs,
      unreadable: result.unreadable, truncated: result.truncated });
  } catch {
    return sanitizePublicJson({ ...base, status: 'unavailable' as const,
      reason: 'session-handoff-list-reader-failed', handoffs: null, unreadable: null, truncated: false });
  }
}

/** GET /api/verse/fleet/agent-roster. The Observe pane's roster feed. Read-only. */
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import { collectAgentRoster, ROSTER_SOURCES, type AgentRoster, type AgentRosterDeps } from '../fleet/agent-roster.js';
import { VERSE_AGENT_ROSTER_PATH } from './agent-roster-path.js';

export { VERSE_AGENT_ROSTER_PATH };

export interface AgentRosterApiDeps {
  collect?: (deps?: AgentRosterDeps) => Promise<AgentRoster>;
}

function unavailableRoster(observedAt: string): AgentRoster {
  return {
    schema: 'agent-roster.v1',
    observedAt,
    latencyMs: 0,
    sources: ROSTER_SOURCES.map((source) => ({
      source,
      ok: false,
      availability: 'unknown' as const,
      sessions: [],
      error: 'unavailable',
      observedAt,
      truncated: false,
    })),
    sessions: [],
    claims: { source: 'unavailable', items: [] },
  };
}

export function createAgentRosterApi(deps: AgentRosterApiDeps = {}): ApiModule {
  const collect = deps.collect ?? ((probeDeps?: AgentRosterDeps) => collectAgentRoster(probeDeps));
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_AGENT_ROSTER_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    try {
      sendJson(res, 200, await collect());
    } catch {
      sendJson(res, 200, unavailableRoster(new Date().toISOString()));
    }
    return true;
  };
}

export const handleAgentRosterApi: ApiModule = createAgentRosterApi();

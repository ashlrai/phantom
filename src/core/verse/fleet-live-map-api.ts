/**
 * GET /api/verse/fleet/control/live-map: the fleet.live-map.v1 graph behind
 * `phm map` and the desktop Map pane. Reads only what `phm org` and
 * `phm nodes` already read (core/fleet/live-map.ts joins them).
 *
 * Fast by construction: one graph build serves every caller for 5 seconds,
 * and callers that arrive while a build is running share it, so the map costs
 * at most one fleet read per 5 s however many panes or agents poll it.
 *
 * GET /api/verse/fleet/control/map-edges[?since=10m] is `phm map edges --json`
 * (fleet.map-edges.v1): who messaged whom, for the map's message lines. The
 * default window is throttled the same way; 503 carries the typed "unknown" body.
 *
 * GET /api/verse/fleet/control/agent-messages[?since=1h&limit=50] is
 * `phm agents messages --json` (agents.messages.v1): the recent messages with
 * map node ids and per-line counts and last 5 summaries, for the map's cards.
 *
 * GET /api/verse/fleet/control/map-replay[?since=6h&step=5m] is `phm map replay --json`
 * (fleet.map-replay.v1): the fleet one frame per step, for the Map pane's time slider.
 *
 * GET /api/verse/fleet/control/agent-conversations[?agent=claude&waiting=1&job=RQ-1] is
 * `phm agents conversations --json` (agents.conversations.v1): threads by reply
 * chain with their state, for the map's thread lines and the Conversations panel.
 */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { buildFleetLiveMap, LIVE_MAP_WINDOW_MINUTES, type FleetLiveMap } from '../fleet/live-map.js';
import { MAP_EDGES_DEFAULT_SINCE, readMapEdges, type MapEdges } from '../fleet/map-edges.js';
import { readAgentsMessages } from '../fleet/agents-messages.js';
import { readAgentConversations } from '../fleet/agent-conversations.js';
import { readMapReplay } from '../fleet/map-replay-build.js';
import { sanitizePublicJson } from '../util/public-json.js';

export const LIVE_MAP_PATH = '/api/verse/fleet/control/live-map';
export const MAP_EDGES_PATH = '/api/verse/fleet/control/map-edges';
export const AGENT_MESSAGES_PATH = '/api/verse/fleet/control/agent-messages';
export const MAP_REPLAY_PATH = '/api/verse/fleet/control/map-replay';
export const AGENT_CONVERSATIONS_PATH = '/api/verse/fleet/control/agent-conversations';
export const LIVE_MAP_MIN_INTERVAL_MS = 5_000;

/** Build the graph from the shared reads. Each source fails on its own into "unknown". */
export async function readFleetLiveMap(now = Date.now()): Promise<FleetLiveMap> {
  const [{ readFleetOrgSources }, { defaultNodesViewDeps, readNodesView }] = await Promise.all([
    import('./fleet-org-map-api.js'), import('../fleet/nodes-view.js')]);
  const org = await readFleetOrgSources(LIVE_MAP_WINDOW_MINUTES).catch(() => null);
  let computers = null;
  try { computers = readNodesView(defaultNodesViewDeps()); } catch { /* unknown, listed in gaps */ }
  // Sanitizing keeps the shape; it only rewrites home paths and secret-shaped strings.
  let lanes = null;
  try {
    const { getFleetLaneSnapshot } = await import('../fleet/lane-console.js');
    const { fleetLaneEmptyNotes } = await import('../fleet/lane-empty-notes.js');
    lanes = await getFleetLaneSnapshot({ emptyNotes: fleetLaneEmptyNotes });
  } catch { /* badges absent, listed nowhere: the map still draws */ }
  return sanitizePublicJson(buildFleetLiveMap({ org: org?.map ?? null, usage: org?.usage ?? null, computers, lanes, now })) as FleetLiveMap;
}

/** At most one `read` per interval; concurrent callers share the build in flight. A failed build is not kept. Also throttles the Sessions read. */
export function throttledLiveMap<T = FleetLiveMap>(read: () => Promise<T>, clock: () => number = Date.now, intervalMs = LIVE_MAP_MIN_INTERVAL_MS) {
  let last: { at: number; value: Promise<T> } | null = null;
  return (): Promise<T> => {
    const now = clock();
    if (last && now - last.at < intervalMs && now >= last.at) return last.value;
    const value = read();
    const entry = { at: now, value };
    last = entry;
    value.catch(() => { if (last === entry) last = null; });
    return value;
  };
}

export function createFleetLiveMapApi(read: () => Promise<FleetLiveMap> = throttledLiveMap(() => readFleetLiveMap()),
  edges: (since: string) => MapEdges | null = readMapEdges, messages: typeof readAgentsMessages = readAgentsMessages,
  conversations: typeof readAgentConversations = readAgentConversations, replay: typeof readMapReplay = readMapReplay): ApiModule {
  const defaultEdges = throttledLiveMap(async () => edges(MAP_EDGES_DEFAULT_SINCE));
  return async (ctx, req, res, path, method) => {
    if (path !== LIVE_MAP_PATH && path !== MAP_EDGES_PATH && path !== AGENT_MESSAGES_PATH && path !== AGENT_CONVERSATIONS_PATH && path !== MAP_REPLAY_PATH) return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= Date.now()) {
      sendJson(res, 401, { error: 'A current read session is required.' }); return true;
    }
    const params = new URL(req.url ?? path, 'http://localhost').searchParams;
    if (path === MAP_REPLAY_PATH) {
      if ([...params.keys()].some(key => key !== 'since' && key !== 'step') || params.getAll('since').length > 1 || params.getAll('step').length > 1) {
        sendJson(res, 400, { error: 'Use since and step only, once each.' }); return true;
      }
      try {
        const read = await replay(params.get('since') ?? undefined, params.get('step') ?? undefined);
        sendJson(res, read.ok ? 200 : 400, read.ok ? sanitizePublicJson(read.replay) : { error: read.error });
      } catch { sendJson(res, 503, { error: 'Map replay unavailable.' }); }
      return true;
    }
    if (path === AGENT_CONVERSATIONS_PATH) {
      const waiting = params.get('waiting'), agent = params.get('agent'), job = params.get('job');
      if ([...params.keys()].some(key => key !== 'agent' && key !== 'waiting' && key !== 'job')
        || params.getAll('agent').length > 1 || params.getAll('waiting').length > 1 || params.getAll('job').length > 1
        || (waiting !== null && waiting !== '1' && waiting !== '0') || agent === '' || job === '') {
        sendJson(res, 400, { error: 'Use agent (a name), waiting (1) and job (a job id) only, once each.' }); return true;
      }
      try {
        const result = conversations({ agent: agent ?? undefined, waitingOnly: waiting === '1', job: job ?? undefined });
        sendJson(res, result.source === 'unavailable' ? 503 : 200, result);
      } catch { sendJson(res, 503, { error: 'Agent conversations unavailable.' }); }
      return true;
    }
    if (path === AGENT_MESSAGES_PATH) {
      if ([...params.keys()].some(key => key !== 'since' && key !== 'limit') || params.getAll('since').length > 1 || params.getAll('limit').length > 1) {
        sendJson(res, 400, { error: 'Use since and limit only, once each.' }); return true;
      }
      try {
        const read = messages({ since: params.get('since') ?? undefined, limit: params.get('limit') ?? undefined });
        if (!read.ok) sendJson(res, 400, { error: read.error });
        else sendJson(res, read.result.source === 'unavailable' ? 503 : 200, read.result);
      } catch { sendJson(res, 503, { error: 'Agent messages unavailable.' }); }
      return true;
    }
    if (path === MAP_EDGES_PATH) {
      if ([...params.keys()].some(key => key !== 'since') || params.getAll('since').length > 1) { sendJson(res, 400, { error: 'Use since only, once.' }); return true; }
      try {
        const since = params.get('since'), result = since === null ? await defaultEdges() : edges(since);
        if (!result) sendJson(res, 400, { error: 'since takes 10m, 2h, 1d, epoch ms or an ISO time.' });
        else sendJson(res, result.source === 'unavailable' ? 503 : 200, result);
      } catch { sendJson(res, 503, { error: 'Map edges unavailable.' }); }
      return true;
    }
    if ([...params.keys()].length) { sendJson(res, 400, { error: 'The map takes no query.' }); return true; }
    try { sendJson(res, 200, await read()); }
    catch { sendJson(res, 503, { error: 'Fleet map unavailable.' }); }
    return true;
  };
}
export const handleFleetLiveMapApi = createFleetLiveMapApi();

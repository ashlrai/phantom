/**
 * GET /api/verse/fleet/control/live-map: the fleet.live-map.v1 graph behind
 * `phm map` and the desktop Map pane. Current jobs come from the reader that
 * publishes the leader brief's live-jobs feed; org and nodes supply structure.
 *
 * Fast by construction: one graph build serves every caller for 5 seconds,
 * and callers that arrive while a build is running share it, so the map costs
 * at most one fleet read per 5 s however many panes or agents poll it.
 *
 * GET /api/verse/fleet/control/map-edges[?since=10m&before=1h] is `phm map edges --json`
 * (fleet.map-edges.v1): who messaged whom, for the map's message lines. The
 * default window is throttled the same way; 503 carries the typed "unknown" body.
 *
 * GET /api/verse/fleet/control/agent-messages[?since=1h&before=2h&limit=50&kind=ask&from=claude&bodyKind=work.post] is
 * `phm agents messages --json` (agents.messages.v1): the recent messages with
 * map node ids and per-line counts and last 5 summaries, for the map's cards.
 * Every `phm messages` filter is a param of the same name (camelCase where the
 * flag is dashed), validated by the same parser.
 *
 * GET /api/verse/fleet/control/map-replay[?since=6h&step=5m] is `phm map replay --json`
 * (fleet.map-replay.v1): the fleet one frame per step, for the Map pane's time slider.
 *
 * GET /api/verse/fleet/control/agent-conversations[?agent=claude&with=peer-a&waiting=1&blocked=1&job=RQ-1&waitingOn=claude&since=1h&before=2h&contains=text&thread=label&bodyKind=work.post] is
 * `phm agents conversations --json` (agents.conversations.v1): threads by reply
 * chain with their state, for the map's thread lines and the Conversations panel.
 */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { buildFleetLiveMap, LIVE_MAP_WINDOW_MINUTES, type FleetLiveMap } from '../fleet/live-map.js';
import { MAP_EDGES_DEFAULT_SINCE, readMapEdges, type MapEdges } from '../fleet/map-edges.js';
import { readAgentsMessages } from '../fleet/agents-messages.js';
import { parseSince } from '../fleet/agent-messages.js';
import { readAgentConversations } from '../fleet/agent-conversations.js';
import { CONVERSATION_STATES, type ConversationState } from '../fleet/agent-conversation-model.js';
import { BUS_PRIORITIES, type BusPriority } from '../fleet/bus-envelope.js';
import { agentChannelNameSchema } from '../agents/bus-identity.js';
import { readMapReplay } from '../fleet/map-replay-build.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { readLiveJobs } from '../fleet/live-jobs.js';

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
  const jobs = await readLiveJobs({ now: () => now }).catch(() => null);
  let computers = null;
  try { computers = readNodesView(defaultNodesViewDeps()); } catch { /* unknown, listed in gaps */ }
  // Sanitizing keeps the shape; it only rewrites home paths and secret-shaped strings.
  let lanes = null;
  try {
    const { getFleetLaneSnapshot } = await import('../fleet/lane-console.js');
    const { fleetLaneEmptyNotes } = await import('../fleet/lane-empty-notes.js');
    lanes = await getFleetLaneSnapshot({ emptyNotes: fleetLaneEmptyNotes });
  } catch { /* badges absent, listed nowhere: the map still draws */ }
  return sanitizePublicJson(buildFleetLiveMap({ org: org?.map ?? null, jobs, usage: org?.usage ?? null, computers, lanes, now })) as FleetLiveMap;
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
  edges: (since: string, options?: { before?: string }) => MapEdges | null = readMapEdges, messages: typeof readAgentsMessages = readAgentsMessages,
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
      const waiting = params.get('waiting'), blocked = params.get('blocked'), agent = params.get('agent'), job = params.get('job'), waitingOn = params.get('waitingOn');
      const state = params.get('state'), limit = params.get('limit'), since = params.get('since'), before = params.get('before'), contains = params.get('contains');
      const inReplyTo = params.get('inReplyTo'), id = params.get('id'), channel = params.get('channel'), priority = params.get('priority');
      const from = params.get('from'), excludeFrom = params.get('excludeFrom'), withPeer = params.get('with');
      const thread = params.get('thread'), bodyKind = params.get('bodyKind');
      const sinceMs = since === null ? undefined : parseSince(since);
      const beforeMs = before === null ? undefined : parseSince(before);
      const KEYS = ['agent', 'waiting', 'blocked', 'job', 'waitingOn', 'state', 'limit', 'since', 'before', 'contains',
        'inReplyTo', 'id', 'channel', 'priority', 'from', 'excludeFrom', 'with', 'thread', 'bodyKind'];
      if ([...params.keys()].some(key => !KEYS.includes(key))
        || KEYS.some(key => params.getAll(key).length > 1)
        || (waiting !== null && waiting !== '1' && waiting !== '0') || (blocked !== null && blocked !== '1' && blocked !== '0')
        || (state !== null && !(CONVERSATION_STATES as readonly string[]).includes(state))
        || (limit !== null && (!/^[1-9][0-9]*$/.test(limit) || Number(limit) > 1024))
        || (contains !== null && (contains.trim() === '' || contains.length > 512))
        || (priority !== null && !(BUS_PRIORITIES as readonly string[]).includes(priority))
        || (channel !== null && !agentChannelNameSchema.safeParse(channel).success)
        || [agent, job, waitingOn, inReplyTo, id, from, excludeFrom, withPeer, thread, bodyKind].some(v => v !== null && !/^[\x21-\x7e]{1,128}$/.test(v))
        || sinceMs === null || beforeMs === null
        || [agent, job, waitingOn, since, before].some(v => v === '')) {
        sendJson(res, 400, { error: 'Use agent (a name), with (the other agent, needs agent), waiting (1), blocked (1), job (a job id), waitingOn (a name), state (waiting|answered|blocked|done), since (15m, 2h, 1d, epoch ms or an ISO time), before (15m, 2h, 1d, epoch ms or an ISO time), contains (text, at most 512 characters), inReplyTo (an envelope id), id (an envelope id), channel (a channel name), priority (P0..P3), from (a name), excludeFrom (a name), thread (a conversation bucket) and bodyKind (a body kind) and limit (1-1024) only, once each.' }); return true;
      }
      if (withPeer !== null && agent === null) {
        sendJson(res, 400, { error: 'with takes the other agent and needs agent.' }); return true;
      }
      try {
        const result = conversations({ agent: agent ?? undefined, waitingOnly: waiting === '1', blockedOnly: blocked === '1', job: job ?? undefined, waitingOn: waitingOn ?? undefined,
          state: state === null ? undefined : state as ConversationState, since: sinceMs ?? undefined, before: beforeMs ?? undefined, contains: contains ?? undefined,
          inReplyTo: inReplyTo ?? undefined, id: id ?? undefined, channel: channel ?? undefined, priority: priority === null ? undefined : priority as BusPriority,
          from: from ?? undefined, excludeFrom: excludeFrom ?? undefined, with: withPeer ?? undefined, thread: thread ?? undefined, bodyKind: bodyKind ?? undefined, limit: limit === null ? undefined : Number(limit) });
        sendJson(res, result.source === 'unavailable' ? 503 : 200, result);
      } catch { sendJson(res, 503, { error: 'Agent conversations unavailable.' }); }
      return true;
    }
    if (path === AGENT_MESSAGES_PATH) {
      // The same filter vocabulary `phm agents messages` and `phm messages`
      // share; dashed flags arrive camelCase, each param once.
      const keys = ['since', 'before', 'limit', 'agent', 'with', 'kind', 'priority', 'job', 'thread', 'channel', 'contains', 'from', 'excludeFrom', 'inReplyTo', 'id', 'bodyKind'];
      if ([...params.keys()].some(key => !keys.includes(key)) || keys.some(key => params.getAll(key).length > 1)) {
        sendJson(res, 400, { error: 'Use since, before, limit, agent, with, kind, priority, job, thread, channel, contains, from, excludeFrom, inReplyTo, id and bodyKind only, once each.' }); return true;
      }
      try {
        const pick = (key: string) => params.get(key) ?? undefined;
        const read = messages({ since: pick('since'), before: pick('before'), limit: pick('limit'), agent: pick('agent'), with: pick('with'),
          kind: pick('kind'), priority: pick('priority'), job: pick('job'), thread: pick('thread'), channel: pick('channel'),
          contains: pick('contains'), from: pick('from'), excludeFrom: pick('excludeFrom'), inReplyTo: pick('inReplyTo'), id: pick('id'),
          bodyKind: pick('bodyKind') });
        if (!read.ok) sendJson(res, 400, { error: read.error });
        else sendJson(res, read.result.source === 'unavailable' ? 503 : 200, read.result);
      } catch { sendJson(res, 503, { error: 'Agent messages unavailable.' }); }
      return true;
    }
    if (path === MAP_EDGES_PATH) {
      if ([...params.keys()].some(key => key !== 'since' && key !== 'before') || params.getAll('since').length > 1 || params.getAll('before').length > 1) {
        sendJson(res, 400, { error: 'Use since and before only, once each.' }); return true;
      }
      const rawBefore = params.get('before');
      if (rawBefore !== null && parseSince(rawBefore) === null) { sendJson(res, 400, { error: 'before takes 10m, 2h, 1d, epoch ms or an ISO time.' }); return true; }
      try {
        const since = params.get('since'), result = since === null && rawBefore === null ? await defaultEdges() : edges(since ?? MAP_EDGES_DEFAULT_SINCE, { before: rawBefore ?? undefined });
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

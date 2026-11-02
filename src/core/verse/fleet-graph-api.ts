/**
 * Fleet graph registry API — the graph.v1 registry (graph/registry.ts) plus
 * the optional graph-live join (fleet/graph-live.ts), served read-only to the
 * desktop console and to agents over the loopback Verse API. Mounted by
 * verse-api.ts (A10 id `fleet-graph`):
 *
 *   GET /api/verse/fleet/graph         → FleetGraphResponseV1 (registry only)
 *   GET /api/verse/fleet/graph?live=1  → adds live: GraphLiveProjection
 *
 * Inputs are the same evidence the graph pipeline reads in production
 * (fleet/graph-seed.ts):
 *
 *   fleet  — $ASHLR_HOME/fleet/fleet.json (fleetInventoryPath), the shared
 *            fleet document, read through the shared bounded never-throw
 *            readFleetInventory. The registry's fleet.v1 seed sections
 *            (agents, mcp, edges) live in that document beside the v:1
 *            inventory fields the seed builder reads.
 *   seats  — the PUBLIC `seats` half of discoverSeats(cfg), the same source
 *            seedFleetGraph uses. An exported snapshot file can be injected
 *            instead (deps.seatsPath), the same precedence the retired
 *            `phm graph status --seats` flag gave an explicit snapshot.
 *
 * Only the registry's allowlisted fields project — seat/engine account ids,
 * model ids, agent ids, MCP ids and declared relationships. Launcher
 * commands, environment, labels, notes and credential fields never reach the
 * response (registry.ts parses by allowlist, and sendJson sanitizes).
 *
 * A missing or invalid source is a STATE, not an error: the response still
 * carries whatever projected, with `complete:false`, the real source state
 * and the registry's issues. The route is read-only — GET only.
 */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import {
  fleetInventoryPath,
  readFleetInventory,
  type FleetInventoryRead,
} from '../fleet/graph-seed.js';
import { buildRegistryGraph } from '../graph/registry.js';
import type { GraphIssue, GraphSourceState, RegistryGraph } from '../graph/types.js';
import type { GraphLiveProjection, ReadGraphLiveOptions } from '../fleet/graph-live.js';
import type { AshlrConfig } from '../types.js';

export const VERSE_FLEET_GRAPH_PATH = '/api/verse/fleet/graph';

export interface FleetGraphResponseV1 {
  v: 1;
  generatedAt: string;
  graph: RegistryGraph;
  /** Present only when the request carried `?live=1`. */
  live?: GraphLiveProjection;
  /** The resolved per-source read states (the same states graph.sources reports). */
  sources: { fleet: GraphSourceState; seats: GraphSourceState };
}

interface Source { state: GraphSourceState; value?: unknown }

export interface FleetGraphApiDeps {
  /** fleet.json location; defaults to {@link fleetInventoryPath}. */
  fleetPath?: string;
  /** An explicit exported seat snapshot file; unset = live seat discovery. */
  seatsPath?: string;
  /** Bounded JSON file reader for either input file; defaults to readFleetInventory. */
  readSource?: (path: string) => FleetInventoryRead;
  /** The public seat inventory; defaults to `discoverSeats(cfg).seats`. */
  listSeats?: (cfg: AshlrConfig) => Promise<readonly unknown[]> | readonly unknown[];
  /** The live join; defaults to readGraphLive (lazy-loaded). */
  readLive?: (graph: RegistryGraph, options: ReadGraphLiveOptions) => GraphLiveProjection | Promise<GraphLiveProjection>;
  now?: () => number;
}

/** File read reason → wire state: bad JSON is `invalid`, an IO failure `unavailable`. */
function sourceFromRead(read: FleetInventoryRead): Source {
  if (read.ok) return { state: 'loaded', value: read.inventory };
  const state: GraphSourceState =
    read.reason === 'missing' ? 'missing' : read.reason === 'malformed' ? 'invalid' : 'unavailable';
  return { state };
}

/**
 * Overlay the true read states onto the projection. The registry itself
 * marks an unparsable input `invalid`; a missing or unreadable file reports
 * its own state — the same overlay the retired `phm graph status` reader ran.
 */
function applySourceStates(graph: RegistryGraph, fleet: Source, seats: Source): void {
  for (const [name, source] of [['fleet', fleet], ['seats', seats]] as const) {
    if (source.state === 'loaded') continue;
    graph.sources[name] = source.state;
    graph.issues = graph.issues.filter(issue => !(issue.source === name && issue.code === 'invalid'));
    graph.issues.push({ source: name, code: source.state as GraphIssue['code'] });
  }
  graph.issues.sort((a, b) => {
    const left = `${a.source}/${a.code}`; const right = `${b.source}/${b.code}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  graph.complete = graph.issues.length === 0;
}

/** Each handler owns its deps; the mounted production handler is a process singleton. */
export function createFleetGraphApi(deps: FleetGraphApiDeps = {}): ApiModule {
  const readSource = deps.readSource ?? readFleetInventory;
  const listSeats = deps.listSeats ?? (async (cfg: AshlrConfig) => {
    const { discoverSeats } = await import('./seats.js');
    return (await discoverSeats(cfg)).seats;
  });
  const readLive = deps.readLive ?? (async (graph: RegistryGraph, options: ReadGraphLiveOptions) => {
    const { readGraphLive } = await import('../fleet/graph-live.js');
    return readGraphLive(graph, options);
  });
  const now = deps.now ?? Date.now;

  const readFile = (path: string): Source => {
    try { return sourceFromRead(readSource(path)); }
    catch { return { state: 'unavailable' }; }
  };
  const readFleetSource = (): Source => readFile(deps.fleetPath ?? fleetInventoryPath());
  const readSeatsSource = async (cfg: AshlrConfig): Promise<Source> => {
    if (deps.seatsPath !== undefined) return readFile(deps.seatsPath);
    try { return { state: 'loaded', value: await listSeats(cfg) }; }
    catch { return { state: 'unavailable' }; }
  };

  return async (ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_GRAPH_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    let params: URLSearchParams;
    try {
      params = new URL(req.url ?? path, 'http://localhost').searchParams;
    } catch {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid query string' });
      return true;
    }
    let wantLive = false;
    for (const [key, value] of params) {
      if (key !== 'live') {
        sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown query parameter: ${key}` });
        return true;
      }
      if (value !== '1') {
        sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid query parameter: live' });
        return true;
      }
      wantLive = true;
    }
    try {
      const nowMs = now();
      const fleet = readFleetSource();
      const seats = await readSeatsSource(ctx.cfg);
      const graph = buildRegistryGraph(fleet.value, seats.value);
      applySourceStates(graph, fleet, seats);
      const body: FleetGraphResponseV1 = {
        v: 1,
        generatedAt: new Date(nowMs).toISOString(),
        graph,
        sources: { fleet: graph.sources.fleet, seats: graph.sources.seats },
      };
      if (wantLive) body.live = await readLive(graph, { cfg: ctx.cfg, nowMs });
      sendJson(res, 200, body);
    } catch {
      sendJson(res, 500, { code: 'fleet-graph-failed', error: 'the fleet graph request failed' });
    }
    return true;
  };
}

export const handleFleetGraphApi: ApiModule = createFleetGraphApi();

import type { MapFilter } from '../core/fleet/map-filter.js';

/** `phm map [--json]`: the whole fleet as one graph. Thin: core/fleet/live-map.ts builds it. `phm map edges`: core/fleet/map-edges.ts. */
export const MAP_USAGE = `Usage: phm map [--json] [--lane <lane>] [--repo <repo>] [--state <running|waiting|done|failed|unknown>]
       phm map edges [--json] [--since <10m|2h|1d|ISO>]

The whole fleet on one map: the leader, each lane, its running jobs, every
computer and the pools lanes draw on, with who reports to whom, what runs
where, which pool each lane uses and who messaged whom in the last 15 minutes.
--json prints the fleet.live-map.v1 graph (stable ids, stable order), with orgLayout:
the 3D position of every leader, group, lane and job, grouped by who it reports to.
Unknown facts read "unknown" and are listed as notes. Read only.

--lane, --repo and --state narrow the map to the agents (jobs) that match all
of them, plus their lane, computer and pool. Use the word "unknown" to find
agents whose lane or repo nobody reported. With a filter, --json adds
filter {lane,repo,state,matched,total}; no match prints "No agents match these
filters." and exits 0. The desktop and phone maps use the same filter.

map edges lists who messaged whom (default: the last 15 minutes): from agent,
to agent, count, last message time and the first 80 characters of the last
message, with each agent's org role (leader, lane, worker or unknown).
--json prints fleet.map-edges.v1. Exit 0 read, 1 bus unreadable, 2 bad usage.`;

async function cmdMapEdges(args: string[]): Promise<number> {
  let json = false, since: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--since' && since === undefined && args[i + 1] !== undefined) since = args[++i];
    else { console.error(MAP_USAGE); return 2; }
  }
  const { formatMapEdgesText, readMapEdges } = await import('../core/fleet/map-edges.js');
  const result = readMapEdges(since);
  if (!result) { console.error('--since takes 10m, 2h, 1d, epoch ms or an ISO time.'); return 2; }
  console.log(json ? JSON.stringify(result, null, 2) : formatMapEdgesText(result));
  return result.source === 'unavailable' ? 1 : 0;
}

export async function cmdMap(args: string[]): Promise<number> {
  if (args.some(arg => arg === '--help' || arg === '-h')) { console.log(MAP_USAGE); return 0; }
  if (args[0] === 'edges') return cmdMapEdges(args.slice(1));
  const filter: MapFilter = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, value = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if ((arg === '--lane' || arg === '--repo' || arg === '--state') && filter[arg.slice(2) as 'lane'] === undefined && value !== undefined) {
      (filter as Record<string, string>)[arg.slice(2)] = value; i++;
    } else { console.error(MAP_USAGE); return 2; }
  }
  const { filterLiveMap, mapFilterError } = await import('../core/fleet/map-filter.js');
  const bad = mapFilterError(filter);
  if (bad) { console.error(bad); return 2; }
  const [{ readFleetLiveMap }, { renderFleetLiveMapText }] = await Promise.all([
    import('../core/verse/fleet-live-map-api.js'), import('../core/fleet/live-map.js')]);
  const map = filterLiveMap(await readFleetLiveMap(), filter);
  console.log(json ? JSON.stringify(map, null, 2) : renderFleetLiveMapText(map));
  return 0;
}

/** `phm map [--json]`: the whole fleet as one graph. Thin: core/fleet/live-map.ts builds it. `phm map edges`: core/fleet/map-edges.ts. */
export const MAP_USAGE = `Usage: phm map [--json]
       phm map edges [--json] [--since <10m|2h|1d|ISO>]

The whole fleet on one map: the leader, each lane, its running jobs, every
computer and the pools lanes draw on, with who reports to whom, what runs
where, which pool each lane uses and who messaged whom in the last 15 minutes.
--json prints the fleet.live-map.v1 graph (stable ids, stable order).
Unknown facts read "unknown" and are listed as notes. Read only.

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
  if (args.some(arg => arg !== '--json')) { console.error(MAP_USAGE); return 2; }
  const [{ readFleetLiveMap }, { renderFleetLiveMapText }] = await Promise.all([
    import('../core/verse/fleet-live-map-api.js'), import('../core/fleet/live-map.js')]);
  const map = await readFleetLiveMap();
  console.log(args.includes('--json') ? JSON.stringify(map, null, 2) : renderFleetLiveMapText(map));
  return 0;
}

/** `phm map [--json]`: the whole fleet as one graph. Thin: core/fleet/live-map.ts builds it. */
export const MAP_USAGE = `Usage: phm map [--json]

The whole fleet on one map: the leader, each lane, its running jobs, every
computer and the pools lanes draw on, with who reports to whom, what runs
where, which pool each lane uses and who messaged whom in the last 15 minutes.
--json prints the fleet.live-map.v1 graph (stable ids, stable order).
Unknown facts read "unknown" and are listed as notes. Read only.`;

export async function cmdMap(args: string[]): Promise<number> {
  if (args.some(arg => arg === '--help' || arg === '-h')) { console.log(MAP_USAGE); return 0; }
  if (args.some(arg => arg !== '--json')) { console.error(MAP_USAGE); return 2; }
  const [{ readFleetLiveMap }, { renderFleetLiveMapText }] = await Promise.all([
    import('../core/verse/fleet-live-map-api.js'), import('../core/fleet/live-map.js')]);
  const map = await readFleetLiveMap();
  console.log(args.includes('--json') ? JSON.stringify(map, null, 2) : renderFleetLiveMapText(map));
  return 0;
}

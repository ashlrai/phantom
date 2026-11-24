import type { MapEdgesFlags } from '../core/fleet/map-edges.js';
import type { MapFilter } from '../core/fleet/map-filter.js';

/** `phm map [--json]`: the whole fleet as one graph. Thin: core/fleet/live-map.ts builds it. `phm map edges`: core/fleet/map-edges.ts. */
export const MAP_USAGE = `Usage: phm map [--json] [--lane <lane>] [--repo <repo>] [--state <running|waiting|done|failed|unknown>]
       phm map edges [--json] [--since <10m|2h|1d|ISO|epoch> | --minutes <n>] [--before <10m|2h|1d|ISO|epoch>] [--agent <name|lane>] [--with <name|lane>] [--kind <ask|reply|handoff|status|blocker>] [--priority <P0|P1|P2|P3>] [--job <id>] [--thread <label>] [--channel <name>] [--contains <text>] [--from <name|lane>] [--exclude-from <name|lane>] [--in-reply-to <id>] [--id <id>]
       phm map replay [--json] [--since <6h|90m|1d|ISO>] [--step <5m|1h>]

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
message, with each agent's org role (leader, lane, worker or unknown). Every
filter is the same vocabulary \`phm messages\` parses — --agent with --with
keeps only what those two said to each other; --kind keeps one classified
kind; --priority keeps one envelope band; --job keeps the traffic naming one
job; --thread keeps note/context bodies carrying that v2 thread label;
--channel keeps posts addressed to group:<name>:*; --contains keeps summaries
carrying that text; --from/--exclude-from keep or drop one sender's mail;
--in-reply-to keeps only envelopes citing that id and --id keeps only the
envelope whose own wire id equals it — so "who messaged whom about job X" is
one filtered read here too. --before keeps only messages received strictly
before its cutoff, so --since and --before read one closed [since, before)
window.
--json prints fleet.map-edges.v1. Exit 0 read, 1 bus unreadable, 2 bad usage.

map replay shows the fleet as it was, one frame per step (default: the last 6
hours, every 5 minutes): which jobs were running, launches, PRs opened, merges
and message lines. History nobody recorded reads "unknown", never an empty
fleet. --json prints fleet.map-replay.v1. The desktop Map pane has the same
frames on its time slider. Exit 0 read, 1 jobs and messages both unreadable,
2 bad usage.`;

const MAP_EDGES_FLAG_KEYS: Record<string, keyof MapEdgesFlags> = {
  '--since': 'since', '--before': 'before', '--agent': 'agent', '--with': 'with',
  '--kind': 'kind', '--priority': 'priority', '--job': 'job', '--thread': 'thread',
  '--channel': 'channel', '--contains': 'contains', '--from': 'from',
  '--exclude-from': 'excludeFrom', '--in-reply-to': 'inReplyTo', '--id': 'id',
};

async function cmdMapEdges(args: string[]): Promise<number> {
  let json = false, minutes: string | undefined;
  const values: MapEdgesFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, value = args[i + 1];
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--minutes') {
      if (minutes !== undefined || value === undefined) { console.error(MAP_USAGE); return 2; }
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
        console.error('--minutes takes a positive safe integer.'); return 2;
      }
      minutes = value; i++; continue;
    }
    const key = MAP_EDGES_FLAG_KEYS[arg];
    if (!key || values[key] !== undefined || value === undefined || value.startsWith('--')) {
      console.error(MAP_USAGE); return 2;
    }
    values[key] = value; i++;
  }
  if (minutes !== undefined) {
    if (values.since !== undefined) { console.error('--since and --minutes cannot be used together.'); return 2; }
    values.since = `${minutes}m`;
  }
  const { formatMapEdgesText, readMapEdges } = await import('../core/fleet/map-edges.js');
  const read = readMapEdges(values);
  if (!read.ok) { console.error(read.error); return 2; }
  const result = read.result;
  console.log(json ? JSON.stringify(result, null, 2) : formatMapEdgesText(result));
  return result.source === 'unavailable' ? 1 : 0;
}

async function cmdMapReplay(args: string[]): Promise<number> {
  let json = false, since: string | undefined, step: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--since' && since === undefined && args[i + 1] !== undefined) since = args[++i];
    else if (args[i] === '--step' && step === undefined && args[i + 1] !== undefined) step = args[++i];
    else { console.error(MAP_USAGE); return 2; }
  }
  const { formatMapReplayText } = await import('../core/fleet/map-replay.js');
  const { readMapReplay } = await import('../core/fleet/map-replay-build.js');
  const read = await readMapReplay(since, step);
  if (!read.ok) { console.error(read.error); return 2; }
  console.log(json ? JSON.stringify(read.replay, null, 2) : formatMapReplayText(read.replay));
  return read.replay.sources.jobs === 'unknown' && read.replay.sources.messages === 'unavailable' ? 1 : 0;
}

export async function cmdMap(args: string[]): Promise<number> {
  if (args.some(arg => arg === '--help' || arg === '-h')) { console.log(MAP_USAGE); return 0; }
  if (args[0] === 'edges') return cmdMapEdges(args.slice(1));
  if (args[0] === 'replay') return cmdMapReplay(args.slice(1));
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

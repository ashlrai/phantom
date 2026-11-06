/** `phm node join|beat|enqueue|plan|pull|renew|complete|status|leave`: thin handlers over DriveNodes. */
import type { NodesStore } from '../core/drive/nodes/index.js';
import { UsageError, parseNodeFleetFlags, runNodeFleet } from '../core/drive/nodes/commands.js';
import type { NodeAuth } from '../core/drive/nodes/state.js';

export interface NodeFleetDeps {
  store?: NodesStore;
  now?: () => number;
  probeAuth?: () => NodeAuth;
}


function text(verb: string, out: Record<string, unknown>): string {
  const routes = out['routes'] as { jobId: string; nodeId: string | null; fix?: string }[] | undefined;
  if (routes) return routes.length ? routes.map(r => `${r.jobId} -> ${r.nodeId ?? `nobody. ${r.fix}`}`).join('\n') : 'No routable jobs.';
  if (verb === 'status' || verb === 'list') {
    const nodes = out['nodes'] as { nodeId: string; live: boolean; usage: number; auth: string; caps: string[] }[];
    const jobs = out['jobs'] as { id: string; state: string }[];
    return [`Owner scope: ${(out['owners'] as string[]).join(',')}`,
      ...nodes.map(n => `node ${n.nodeId} ${n.live ? 'live' : 'expired'} usage=${n.usage} auth=${n.auth} caps=${n.caps.join(',') || '-'}`),
      ...jobs.map(j => `job ${j.id} ${j.state}`)].join('\n');
  }
  if (verb === 'pull') return out['pulled'] ? `Claimed ${(out['claim'] as { jobId: string }).jobId}. Renew before expiry; pass the token to every effect.` : 'No job for this node. Run: phm node plan';
  return Object.entries(out).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(',') : String(v)}`).join('\n');
}

export async function cmdNodeFleet(verb: string, args: string[], deps: NodeFleetDeps = {}): Promise<number> {
  let json = false;
  try {
    const flags = parseNodeFleetFlags(verb, args);
    json = flags.has('--json');
    if (!deps.store) {
      const { cmdNodePool, hasNodePool } = await import('./node-pool.js');
      if (hasNodePool()) return cmdNodePool(verb, args);
    }
    // Parsing happens first and the store modules load after it, so a usage error never touches (or creates) state.
    const [{ DriveNodes, LocalNodesStore }, { probeLocalAuth }, { ashlrHome }, { privateDirectory }, { join }] = await Promise.all([
      import('../core/drive/nodes/index.js'), import('../core/drive/nodes/auth-probe.js'),
      import('../core/cloud/store.js'), import('../core/universe/artifacts.js'), import('node:path')]);
    const store: NodesStore = deps.store ?? { transaction: fn => new LocalNodesStore(privateDirectory(join(ashlrHome(), 'nodes'))).transaction(fn) };
    const out = runNodeFleet(verb, flags, new DriveNodes(store, deps.now ? { now: deps.now } : {}), deps.probeAuth ?? probeLocalAuth);
    console.log(json ? JSON.stringify({ schemaVersion: 1, command: verb, ...out }) : text(verb, out));
    return 0;
  } catch (error) {
    const known = error instanceof UsageError;
    const message = known ? error.message : error instanceof Error && /^Invalid drive/.test(error.message) ? error.message : 'Node store unavailable or invalid.';
    const fix = known ? error.fix : /^Invalid drive/.test(message) ? 'Check ids (letters, digits, . _ : / -), caps (lowercase) and secret NAMES (UPPER_SNAKE). Run: phm node --help'
      : 'Check that ~/.ashlr/nodes is a private (0700) directory you own, and that no other process holds its lock.';
    const code = known ? error.code : 'rejected';
    if (json) console.log(JSON.stringify({ schemaVersion: 1, command: verb, error: { code, message, fix } }));
    else console.error(`${message} Fix: ${fix}`);
    return known ? error.exit : 1;
  }
}

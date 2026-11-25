/** `phm node join|beat|enqueue|plan|pull|renew|complete|status|leave`: thin handlers over DriveNodes. */
import type { NodesStore } from '../core/drive/nodes/index.js';
import { UsageError, parseNodeFleetFlags, runNodeFleet } from '../core/drive/nodes/commands.js';
import type { NodeAuth } from '../core/drive/nodes/state.js';
import { nodeErrorEnvelope } from './node-fleet-usage.js';

export interface NodeFleetDeps {
  store?: NodesStore;
  now?: () => number;
  probeAuth?: () => NodeAuth;
}


function text(verb: string, out: Record<string, unknown>): string {
  if (verb === 'plan') {
    const routes = out['routes'] as { jobId: string; nodeId: string | null; fix?: string }[];
    return routes.length ? routes.map(r => `${r.jobId} -> ${r.nodeId ?? `nobody. ${r.fix}`}`).join('\n') : 'No routable jobs.';
  }
  if (verb === 'status' || verb === 'list') {
    const nodes = out['nodes'] as { nodeId: string; live: boolean; usage: number | null; auth: string; caps: string[] }[];
    const jobs = out['jobs'] as { id: string; state: string }[];
    return [`Owner scope: ${(out['owners'] as string[]).join(',')}`,
      ...nodes.map(n => `node ${n.nodeId} ${n.live ? 'live' : 'expired'} usage=${n.usage ?? 'unknown'} auth=${n.auth} caps=${n.caps.join(',') || '-'}`),
      ...jobs.map(j => `job ${j.id} ${j.state}`)].join('\n');
  }
  if (verb === 'pull') return out['pulled'] ? `Claimed ${(out['claim'] as { jobId: string }).jobId}. Renew before expiry; pass the token to every effect.` : 'No job for this node. Run: phm node plan';
  return Object.entries(out).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(',') : String(v)}`).join('\n');
}

export async function cmdNodeFleet(verb: string, args: string[], deps: NodeFleetDeps = {}): Promise<number> {
  // `--json` is a boolean flag and a standalone `--json` token can never be a
  // flag value (values starting with `--` are refused), so argv alone proves
  // the caller asked for JSON even when flag parsing fails first.
  const json = args.includes('--json');
  try {
    const flags = parseNodeFleetFlags(verb, args);
    if (!deps.store) {
      const { cmdNodePool, hasNodePool } = await import('./node-pool.js');
      if (hasNodePool()) return cmdNodePool(verb, args);
    }
    // Parsing happens first and the store modules load after it, so a usage error never touches (or creates) state.
    const [{ DriveNodes, LocalNodesStore }, { probeLocalAuth }, { ashlrHome }, { canonicalPath, privateDirectory }, { join }] = await Promise.all([
      import('../core/drive/nodes/index.js'), import('../core/drive/nodes/auth-probe.js'),
      import('../core/cloud/store.js'), import('../core/universe/artifacts.js'), import('node:path')]);
    const store: NodesStore = deps.store ?? { transaction: fn => new LocalNodesStore(privateDirectory(canonicalPath(join(ashlrHome(), 'nodes')))).transaction(fn) };
    const out = runNodeFleet(verb, flags, new DriveNodes(store, deps.now ? { now: deps.now } : {}), deps.probeAuth ?? probeLocalAuth);
    console.log(json ? JSON.stringify({ schemaVersion: 1, command: verb, ...out }) : text(verb, out));
    return 0;
  } catch (error) {
    const known = error instanceof UsageError;
    // Validation, privacy and lock messages in this stack are fixed operator-facing
    // strings (no values echoed), so they are shown; anything else stays masked.
    const operatorMessage = /^(?:Invalid |Drive |Universe storage|Unsafe drive|Cannot create filesystem root)/;
    const message = error instanceof Error && (known || operatorMessage.test(error.message)) ? error.message : 'Node store unavailable or invalid.';
    const fix = known ? error.fix : /^Invalid drive/.test(message) ? 'Check ids (letters, digits, . _ : / -), caps (lowercase) and secret NAMES (UPPER_SNAKE). Run: phm node --help'
      : 'Check that ~/.ashlr/nodes is a private (0700) directory you own, and that no other process holds its lock.';
    const code = known ? error.code : 'rejected';
    if (json) console.log(JSON.stringify(nodeErrorEnvelope(verb, { code, message, fix })));
    else console.error(`${message} Fix: ${fix}`);
    return known ? error.exit : 1;
  }
}

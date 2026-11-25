/** `phm node self-update [--owner <scope>] [--target <x.y.z>] [--json]`: per-node phm version drift. Plan only. */
import type { NodeView } from '../core/drive/nodes/index.js';
import { localPhmVersion, planNodeSelfUpdate } from '../core/drive/nodes/phm-version.js';
import { validId } from '../core/drive/nodes/state.js';

export const SELF_UPDATE_USAGE = 'Usage: phm node self-update [--owner <scope>] [--target <x.y.z>] [--json]\n' +
  'Plan only: reports which pool nodes run a different phm build than --target (default: this machine). Never updates anything.\n' +
  'With --json every failure prints {"schemaVersion":1,"command":"self-update","error":{"code","message","fix"}} on stdout.';

export interface SelfUpdateDeps {
  /** Pool-visible nodes for an owner scope; defaults to the configured pool, else the local registry. */
  nodes?: (owner: string | null) => Promise<NodeView[]>;
  localVersion?: () => string | null;
}

async function defaultNodes(owner: string | null): Promise<NodeView[]> {
  const { readPoolConfig, callPool } = await import('../core/drive/nodes/pool-host.js');
  const pool = (await import('./node-pool.js')).hasNodePool() ? readPoolConfig() : null;
  const scope = owner ?? pool?.owner;
  if (!scope) throw new Error('--owner is required without a configured node pool');
  if (pool) return (callPool(pool, 'status', ['--owner', scope]).result['nodes'] as NodeView[] | undefined) ?? [];
  const [{ DriveNodes, LocalNodesStore }, { ashlrHome }, { canonicalPath, privateDirectory }, { join }] = await Promise.all([
    import('../core/drive/nodes/index.js'), import('../core/cloud/store.js'), import('../core/universe/artifacts.js'), import('node:path')]);
  return new DriveNodes({ transaction: fn => new LocalNodesStore(privateDirectory(canonicalPath(join(ashlrHome(), 'nodes')))).transaction(fn) }).view([scope]).nodes;
}

export async function cmdNodeSelfUpdate(args: string[], deps: SelfUpdateDeps = {}): Promise<number> {
  const json = args.includes('--json');
  const fail = (message: string): number => {
    if (json) console.log(JSON.stringify({ schemaVersion: 1, command: 'self-update',
      error: { code: 'usage', message, fix: 'Run: phm node self-update --help' } }));
    else console.error(`${message}\n${SELF_UPDATE_USAGE}`);
    return 2;
  };
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i]!.split(/=(.*)/s, 2) as [string, string | undefined];
    if (name === '--json' && inline === undefined) continue;
    if (name !== '--owner' && name !== '--target') return fail(`Unsupported flag for self-update: ${name}. It is plan-only.`);
    const value = inline ?? args[++i];
    if (value === undefined || value.startsWith('--') || values.has(name)) return fail(`${name} needs exactly one value.`);
    values.set(name, value);
  }
  const owner = values.get('--owner') ?? null;
  if (owner !== null && !validId(owner)) return fail('--owner is not a valid scope id.');
  const target = values.get('--target') ?? (deps.localVersion ?? localPhmVersion)();
  if (target !== null && !/^\d{1,9}\.\d{1,9}\.\d{1,9}(?:[-+][0-9A-Za-z.-]*)?$/.test(target)) return fail('--target must look like 3.30.34.');
  try {
    const nodes = await (deps.nodes ?? defaultNodes)(owner);
    const plan = planNodeSelfUpdate(nodes, target);
    if (json) console.log(JSON.stringify({ command: 'self-update', ...plan }));
    else {
      console.log(`target: ${plan.target ?? 'unknown'} (plan only)`);
      for (const n of plan.nodes) console.log(`node ${n.nodeId} ${n.live ? 'live' : 'expired'} version=${n.version ?? 'unreported'} slots=${n.slots ?? '-'} ${n.status}`);
      plan.steps.forEach((s, i) => console.log(`${i + 1}. ${s}`));
    }
    return 0;
  } catch (error) {
    // A missing --owner with no configured pool is bad usage (exit 2); a
    // registry or pool read failure is operational (exit 1, fixed message).
    const usageError = error instanceof Error && error.message.startsWith('--owner') ? error : null;
    const message = usageError?.message ?? 'Node registry unavailable. Check the pool config and SSH approvals.';
    if (json) console.log(JSON.stringify({ schemaVersion: 1, command: 'self-update',
      error: { code: usageError ? 'usage' : 'error', message,
        fix: usageError ? 'Add --owner <scope>, or configure a node pool first. Run: phm node self-update --help'
          : 'Check the pool config and SSH approvals.' } }));
    else console.error(usageError ? `${message}\n${SELF_UPDATE_USAGE}` : message);
    return usageError ? 2 : 1;
  }
}

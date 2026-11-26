/** Host wiring for the ready.tsv -> node-router bridge: config, router transport, daemon phase. */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ashlrHome } from '../../cloud/store.js';
import { runsRoot } from '../../metrics/loop-collect.js';
import { DriveNodes } from './index.js';
import { LocalNodesStore } from './local-store.js';
import { callPool, readPoolConfig } from './pool-host.js';
import { localBridgeRouter, poolBridgeRouter, runNodeBridge, type BridgeRouter, type NodeBridgeReport } from './ready-bridge.js';
import { validId } from './state.js';
import { traceBridgeSync, type BridgeTrace } from './ready-bridge-receipts.js';

export interface NodeBridgeConfig { enabled: boolean; owner: string | null; maxPerPass?: number; pendingTtlMs?: number }

/** `$ASHLR_HOME/node-bridge.json`. Missing means disabled; garbage is refused, never guessed. */
export function readNodeBridgeConfig(home: string = ashlrHome()): NodeBridgeConfig | 'invalid' {
  const path = join(home, 'node-bridge.json');
  if (!existsSync(path)) return { enabled: false, owner: null };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const int = (v: unknown, max: number) => v === undefined || (Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= max);
    if (!raw || typeof raw !== 'object' || typeof raw['enabled'] !== 'boolean' || !validId(raw['owner']) ||
        !int(raw['maxPerPass'], 32) || !int(raw['pendingTtlMs'], 24 * 3_600_000) ||
        Object.keys(raw).some(k => !['enabled', 'owner', 'maxPerPass', 'pendingTtlMs'].includes(k))) return 'invalid';
    return raw as unknown as NodeBridgeConfig;
  } catch { return 'invalid'; }
}

export interface NodeBridgeRunOptions { apply: boolean; owner?: string; signal?: AbortSignal; now?: number; trace?: BridgeTrace }

/** Resolve config, router and host, then run one pass. Apply needs `enabled: true`. */
export async function runConfiguredNodeBridge(opts: NodeBridgeRunOptions): Promise<NodeBridgeReport> {
  const config = traceBridgeSync(opts.trace, 'load-config', () => readNodeBridgeConfig());
  let pool: ReturnType<typeof readPoolConfig> = null;
  let poolInvalid = false;
  try { pool = traceBridgeSync(opts.trace, 'read-pool-config', () => readPoolConfig()); } catch { poolInvalid = true; }
  const owner = opts.owner ?? (config !== 'invalid' ? config.owner : null) ?? pool?.owner ?? null;
  let inert: string | null = config === 'invalid' ? 'bridge-config-invalid'
    : opts.apply && !config.enabled ? 'bridge-disabled' : poolInvalid ? 'pool-config-invalid' : null;
  let router: BridgeRouter | null = null;
  traceBridgeSync(opts.trace, 'resolve-router', () => {
    if (pool) {
      if (pool.role !== 'primary') inert ??= 'not-pool-primary';
      else if (owner !== pool.owner) inert ??= 'owner-not-pool-scope';
      else router = poolBridgeRouter((verb, args) => callPool(pool!, verb, args), join(ashlrHome(), 'node-pool'));
    } else if (existsSync(join(ashlrHome(), 'nodes'))) {
      const directory = join(ashlrHome(), 'nodes');
      const store = new LocalNodesStore(directory);
      router = localBridgeRouter(new DriveNodes(store), directory);
    }
  });
  return runNodeBridge({
    host: { runsRoot: traceBridgeSync(opts.trace, 'resolve-runs-dir', runsRoot), wtRoot: join(homedir(), 'Projects', 'ashlrai', 'wt') },
    router, owner, apply: opts.apply, now: opts.now ?? Date.now(), inert,
    ...(config !== 'invalid' && config.maxPerPass ? { maxPerPass: config.maxPerPass } : {}),
    ...(config !== 'invalid' && config.pendingTtlMs ? { pendingTtlMs: config.pendingTtlMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.trace ? { trace: opts.trace } : {}),
  });
}

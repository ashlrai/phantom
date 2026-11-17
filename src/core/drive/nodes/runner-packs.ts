import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const PACK_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_PACKS = 16;

/**
 * Ask the host-owned runner which packs it executes: `<runner> packs` must exit 0 and print
 * `{"protocol":"phm-node-worker/v1","packs":[...]}`. Returns `pack:<name>` caps. Any other
 * outcome (old runner, timeout, bad JSON) advertises none. Never read from config.
 */
export function probeRunnerPacks(runner: string, run: typeof spawnSync = spawnSync): string[] {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = run(runner, ['packs'], { shell: false, timeout: 5000, encoding: 'utf8', maxBuffer: 4096,
      stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env['PATH'], HOME: homedir() } });
  } catch { return []; }
  if (!result || result.error || result.status !== 0 || typeof result.stdout !== 'string') return [];
  try {
    const value = JSON.parse(result.stdout) as { protocol?: unknown; packs?: unknown };
    if (value?.protocol !== 'phm-node-worker/v1' || !Array.isArray(value.packs)) return [];
    const names = value.packs.filter((p): p is string => typeof p === 'string' && PACK_NAME.test(p));
    return [...new Set(names)].sort().slice(0, MAX_PACKS).map(name => `pack:${name}`);
  } catch { return []; }
}

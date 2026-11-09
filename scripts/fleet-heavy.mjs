import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Re-enter once under the shared host lock. Nested test helpers inherit it.
export function enterHeavy() {
  if (process.env.PHANTOM_HEAVY_HELD === '1' || (process.env.CI && process.env.CI !== 'false')) return;
  const wrapper = fileURLToPath(new URL('../contrib/mac/fleet-heavy', import.meta.url));
  const result = spawnSync('python3', [wrapper, '--', process.execPath, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, PHANTOM_HEAVY_HELD: '1' },
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

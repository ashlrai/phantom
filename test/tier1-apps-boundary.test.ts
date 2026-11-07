import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeClosure, runtimeSpecifiers, shortestTier1Chain } from '../scripts/tier1-why.js';

const { closure } = computeClosure();
const closureSet = new Set(closure);
// One breadth-first walk at collection time; unreachable targets cost a full
// traversal, so only genuinely reachable files get a chain lookup. Closure
// membership already proves unreachability for the rest.
const invocationsChain = shortestTier1Chain('src/core/fleet/apps-recovery-invocations.ts');
const rootChain = shortestTier1Chain('src/core/authority/protected-paths.ts');

describe('Tier-1 apps boundary', () => {
  it('keeps app-control CLI implementations outside the authority closure', () => {
    // src/cli/fleet-apps-* spawn, observe and control desktop apps. Only the
    // fleet convention entry (fleet-entry.ts) and the MCP CLI extension
    // (mcp-native-fleet.ts) may reach them.
    expect(closure.filter(file => /^src\/cli\/fleet-apps-/.test(file))).toEqual([]);
  });

  it('keeps the MCP fleet-apps extension and the fleet entry outside the closure', () => {
    expect(closureSet.has('src/core/mcp-native-fleet.ts')).toBe(false);
    expect(closureSet.has('src/cli/fleet-entry.ts')).toBe(false);
  });

  it('reaches retained apps-recovery readers only through the mounted verse API', () => {
    // src/core/fleet/apps-recovery-* are pure runs-store readers serving the
    // verse apps API; they must not gain an authority- or MCP-side path.
    // invocations is the hub: history is imported through it and verdict only
    // through fleet-apps-api, so its shortest chain pins the shared route.
    for (const file of [
      'src/core/fleet/apps-recovery-invocations.ts',
      'src/core/fleet/apps-recovery-history.ts',
      'src/core/fleet/apps-recovery-verdict.ts',
    ]) {
      expect(closureSet.has(file), file).toBe(true);
    }
    expect(invocationsChain).not.toBeNull();
    expect(invocationsChain).toContain('src/core/verse/fleet-apps-api.ts');
  });

  it('uses the closure test runtime walk verbatim', () => {
    const source = readFileSync(new URL('./authority-tier1-closure-310b.test.ts', import.meta.url), 'utf8');
    const original = source.slice(source.indexOf('function runtimeSpecifiers'), source.indexOf('\nfunction resolveLocal')).trim();
    const diagnostic = readFileSync(new URL('../scripts/tier1-why.ts', import.meta.url), 'utf8');
    expect(diagnostic).toContain(`export ${original}`);
    expect(runtimeSpecifiers(new URL('../src/core/mcp-native-fleet.ts', import.meta.url).pathname)).toContain('../cli/fleet-apps-ensure.js');
  });

  it('finds a shortest direct path for an authority root', () => {
    expect(rootChain).toEqual(['src/core/authority/protected-paths.ts']);
  });
});

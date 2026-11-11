import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeClosure, runtimeSpecifiers, shortestTier1Chain } from '../scripts/tier1-why.js';

const { closure } = computeClosure();
const recoveryChain = shortestTier1Chain('src/core/fleet/apps-recovery-invocations.ts');
const rootChain = shortestTier1Chain('src/core/authority/protected-paths.ts');

describe('Tier-1 apps boundary', () => {
  it('keeps every apps implementation outside the authority closure', () => {
    expect(closure.filter(file => /^src\/(core\/fleet\/apps-|cli\/fleet-apps-)/.test(file))).toEqual([]);
  });

  it('uses the closure test runtime walk verbatim', () => {
    const source = readFileSync(new URL('./authority-tier1-closure-310b.test.ts', import.meta.url), 'utf8');
    const original = source.slice(source.indexOf('function runtimeSpecifiers'), source.indexOf('\nfunction resolveLocal')).trim();
    const diagnostic = readFileSync(new URL('../scripts/tier1-why.ts', import.meta.url), 'utf8');
    expect(diagnostic).toContain(`export ${original}`);
    expect(runtimeSpecifiers(new URL('../src/core/mcp-native-fleet.ts', import.meta.url).pathname)).toContain('../cli/fleet-apps-ensure.js');
  });

  it('finds a shortest direct path and reports unreachable apps', () => {
    expect(rootChain).toEqual(['src/core/authority/protected-paths.ts']);
    expect(recoveryChain).toBeNull();
  });
});

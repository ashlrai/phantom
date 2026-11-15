import { describe, expect, it, vi } from 'vitest';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

// Regression for RQ-PHX-REDTESTFIXN1S123: a convention-only fleet verb must
// dispatch through the real entry wrapper (fleet-entry injects
// FLEET_SUBCOMMAND_LOADERS). Calling raw cmdFleet from fleet.js leaves
// loaders={} so `release-gate-start` fell through to "unknown subcommand" 2.
const impl = vi.hoisted(() => vi.fn(async (args: string[]) => (args[0] === 'probe' ? 7 : 3)));

vi.mock('../src/cli/fleet-release-gate-start.js', () => ({
  cmdFleetReleaseGateStart: impl,
}));

const { cmdFleet } = await import('../src/cli/fleet-entry.js');

describe('release-gate-start convention dispatch (RQ-PHX-REDTESTFIXN1S123)', () => {
  it('resolves the verb name to the convention module and export', () => {
    expect(resolveFleetSubcommand('release-gate-start')).toEqual({
      module: './fleet-release-gate-start.js',
      exportName: 'cmdFleetReleaseGateStart',
    });
  });

  it('is registered in the real loader map the entry wrapper injects', () => {
    expect(Object.hasOwn(FLEET_SUBCOMMAND_LOADERS, 'release-gate-start')).toBe(true);
  });

  it('dispatches release-gate-start with the remaining args, not exit 2', async () => {
    impl.mockClear();
    await expect(cmdFleet(['release-gate-start', 'probe'])).resolves.toBe(7);
    await expect(cmdFleet(['release-gate-start', 'other'])).resolves.toBe(3);
    expect(impl.mock.calls.map((c) => c[0])).toEqual([['probe'], ['other']]);
  });
});

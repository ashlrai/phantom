/** RQ-PHX-REDTESTFIXC173: `fleet merge-identity` must be reachable through the
 * production FLEET_SUBCOMMAND_LOADERS registry, not only through the injected
 * loaders test/merge-actor-recovery-171.test.ts uses. No network: --help never
 * calls gh. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdFleet } from '../src/cli/fleet.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdFleetMergeIdentity } from '../src/cli/fleet-merge-identity.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('fleet merge-identity production wiring', () => {
  it('registers a literal merge-identity loader', async () => {
    const loader = FLEET_SUBCOMMAND_LOADERS['merge-identity'];
    expect(typeof loader).toBe('function');
    const loaded = await loader!();
    expect(loaded['cmdFleetMergeIdentity']).toBe(cmdFleetMergeIdentity);
  });

  it('cmdFleet dispatches merge-identity --help through the real registry', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => { out.push(String(m)); });
    const code = await cmdFleet(['merge-identity', '--help'], FLEET_SUBCOMMAND_LOADERS);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Usage: ashlr fleet merge-identity --since <ISO>');
  });

  it('usage errors still return 2 without reaching the network', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleet(['merge-identity', '--since', 'not-a-date'], FLEET_SUBCOMMAND_LOADERS)).toBe(2);
  });
});

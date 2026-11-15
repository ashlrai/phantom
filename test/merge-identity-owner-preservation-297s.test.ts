/** Preservation of ashlrai/phantom PR #5273 (RQ-PHX-MERGEIDENTITYREGISTRY208S,
 * observed owner head c1c1ac3955f5), serving Mason's Nov 5 accumulated
 * unique-PR preservation order. The original PR added
 * test/merge-identity-registry.test.ts proving `fleet merge-identity` is
 * reachable through the production FLEET_SUBCOMMAND_LOADERS registry rather
 * than only through injected loaders. This file re-expresses those three
 * behavioral cases against current master exports: the real registry resolves
 * cmdFleetMergeIdentity, cmdFleet dispatches `merge-identity --help` to exit 0
 * with the current usage text, and an invalid --since exits 2. No runtime
 * module mocks bypass production dispatch; child_process.execFile and fetch
 * are booby-trapped so any gh/network attempt is a failing assertion. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdFleet } from '../src/cli/fleet.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdFleetMergeIdentity } from '../src/cli/fleet-merge-identity.js';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(() => {
    throw new Error('child_process.execFile must not run: merge-identity help/validation never shells out to gh');
  }),
}));
vi.mock('node:child_process', async importOriginal => {
  const mod = await importOriginal<typeof import('node:child_process')>();
  return { ...mod, execFile: execFileMock };
});

const fetchMock = vi.fn(() => {
  throw new Error('fetch must not run: merge-identity help/validation never touches the network');
});

beforeEach(() => {
  execFileMock.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('fleet merge-identity production wiring (preserved from #5273)', () => {
  it('registers a literal merge-identity loader resolving the production export', async () => {
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
    // Current master usage line (src/cli/fleet-merge-identity.ts USAGE); the
    // original PR asserted the shorter prefix 'Usage: ashlr fleet
    // merge-identity --since <ISO>', which this line still contains.
    expect(out.join('\n')).toContain('Usage: ashlr fleet merge-identity --since <ISO> [--until <ISO>] [--repo <owner/name>] [--automation-login <login>]... [--json]');
    expect(execFileMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('usage errors still return 2 without reaching gh or the network', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleet(['merge-identity', '--since', 'not-a-date'], FLEET_SUBCOMMAND_LOADERS)).toBe(2);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * RQ-PHX-SAFARIORIGINALPROOF286S — preservation proof for the CLI helper slice of
 * original open PR #2774 (RQ-PHX-SAFARIIMPORTVERB01, head
 * 45c1e4dc22568577e34fee6b576769e95c76e8bf).
 *
 * Every helper scenario from the original test/fleet-safari-import-verb-01.test.ts
 * is already covered by test/fleet-safari-import-helper-recutolda60.test.ts through
 * cmdFleetSafariImport's exec/locateScript seams; this file adds only the original
 * registry/dispatch semantics that file cannot reach: it imports cmdFleet from
 * src/cli/fleet.js (the loader-less core dispatcher), while the executable entry
 * src/cli/fleet-entry.ts is what supplies FLEET_SUBCOMMAND_LOADERS. The original
 * asserted resolveFleetSubcommand('safari-import') and dispatch through the real
 * fleet registry; those assertions live here, against the real entry.
 *
 * No test opens Safari, runs AppleScript/System Events, reads a real home dir or
 * spawns python3: --help returns before locateScript or exec are consulted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet-entry.js';
import { cmdFleetSafariImport } from '../src/cli/fleet-safari-import.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fleet safari-import original #2774 preservation (CLI helper slice)', () => {
  it('keeps the original registry contract: safari-import resolves to ./fleet-safari-import.js cmdFleetSafariImport', async () => {
    expect(resolveFleetSubcommand('safari-import')).toEqual({
      module: './fleet-safari-import.js',
      exportName: 'cmdFleetSafariImport',
    });
    const loaded = await FLEET_SUBCOMMAND_LOADERS['safari-import']!();
    expect(loaded['cmdFleetSafariImport']).toBe(cmdFleetSafariImport);
  });

  it('dispatches ashlr fleet safari-import --help through the real fleet entry and prints both usage forms', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleet(['safari-import', '--help'])).toBe(0);
    expect(await cmdFleet(['safari-import', 'status', '--help'])).toBe(0);
    const help = log.mock.calls.flat().join('\n');
    expect(help).toContain('Usage: ashlr fleet safari-import');
    expect(help).toContain('ashlr fleet safari-import <status|begin-import>');
  });
});

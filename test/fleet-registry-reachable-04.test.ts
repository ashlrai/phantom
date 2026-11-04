import { describe, expect, it } from 'vitest';
import { generateFleetRegistry } from '../scripts/gen-fleet-registry.mjs';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const MISSING_VERBS = [
  'guardian-compact',
  'guardian-continue',
  'guardian-loop',
  'guardian-stream-continue',
  'path-history',
  'reset-await',
  'reset-follow',
  'reset-group-await',
  'reset-release-await',
];

describe('9 missing fleet verbs now reachable', () => {
  it('register file contains all 9 verbs', () => {
    for (const verb of MISSING_VERBS) {
      expect(FLEET_SUBCOMMAND_LOADERS).toHaveProperty(verb);
    }
  });

  it.each(MISSING_VERBS)('%s resolves and exports a function', { timeout: 60_000 }, async (verb) => {
    const resolved = resolveFleetSubcommand(verb);
    expect(resolved).not.toBeNull();
    const mod = await FLEET_SUBCOMMAND_LOADERS[verb]();
    expect(typeof (mod as Record<string, unknown>)[resolved!.exportName]).toBe('function');
  });

  it('gen-fleet-registry --check is in sync', () => {
    expect(generateFleetRegistry(['--check'])).toBe(0);
  });
});

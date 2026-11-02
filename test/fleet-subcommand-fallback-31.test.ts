import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveFleetSubcommand, isModuleNotFound } from '../src/cli/fleet-subcommand-resolve.js';
import { cmdFleet } from '../src/cli/fleet.js';

// This module has no explicit dispatch line: exercise the real fallback import.
vi.mock('../src/cli/fleet-job-read.js', () => ({
  cmdFleetJobRead: vi.fn(async (args: string[]) => args[0] === 'probe' ? 7 : 9),
}));

afterEach(() => vi.restoreAllMocks());

describe('fleet convention resolver', () => {
  it.each([
    ['lane-truth', 'LaneTruth'], ['dead-heads', 'DeadHeads'], ['ship-gap', 'ShipGap'],
    ['ab', 'Ab'], ['a1-b2', 'A1B2'], ['a'.repeat(40), 'A' + 'a'.repeat(39)],
  ])('resolves %s', (name, suffix) => {
    expect(resolveFleetSubcommand(name)).toEqual({ module: `./fleet-${name}.js`, exportName: `cmdFleet${suffix}` });
  });
  it.each([undefined, 'Lane', '../x', 'a.b', '-x', 'x--y', '', 'x', '..', 'a/b', 'a'.repeat(41)])('rejects %s', name => {
    expect(resolveFleetSubcommand(name)).toBeNull();
  });
  it('identifies only the missing target module', () => {
    const missing = (message: string, code = 'ERR_MODULE_NOT_FOUND') => Object.assign(new Error(message), { code });
    expect(isModuleNotFound(missing("Cannot find module './fleet-nope.js'"), './fleet-nope.js')).toBe(true);
    expect(isModuleNotFound(missing("Cannot find module '/repo/src/cli/fleet-nope.js'", 'MODULE_NOT_FOUND'), './fleet-nope.js')).toBe(true);
    expect(isModuleNotFound(new Error("Cannot find module './fleet-nope.js'"), './fleet-nope.js')).toBe(false);
    expect(isModuleNotFound(missing("Cannot find package 'dependency' imported from /repo/fleet-nope.js"), './fleet-nope.js')).toBe(false);
    expect(isModuleNotFound(missing("Cannot find module './fleet-other.js'"), './fleet-nope.js')).toBe(false);
  });
});

it('preserves explicit dispatch and unknown-command diagnostics', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(await cmdFleet(['lane-truth', '--help'])).toBe(0);
  expect(await cmdFleet(['definitely-not-a-command'])).toBe(2);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('unknown fleet subcommand: definitely-not-a-command\n'));
});

it('dispatches a convention-only module with the remaining arguments', async () => {
  expect(await cmdFleet(['job-read', 'probe'])).toBe(7);
});

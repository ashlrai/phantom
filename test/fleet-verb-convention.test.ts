import { existsSync, readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

afterEach(() => vi.restoreAllMocks());

it.each([
  'bet-trace', 'dead-heads', 'lane-truth', 'meter-drop', 'wait-jobs',
  'canary-ladder', 'stray-slots', 'edit-collisions', 'ship-gap', 'workers',
  'dispatch-summary', 'runs-read', 'job-read',
])('%s resolves to an existing module with the convention export', async verb => {
  const exportName = 'cmdFleet' + verb.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('');
  const resolved = resolveFleetSubcommand(verb);
  expect(resolved).toEqual({ module: `./fleet-${verb}.js`, exportName });
  expect(existsSync(new URL(`../src/cli/fleet-${verb}.ts`, import.meta.url))).toBe(true);
  const module = `../src/cli/${resolved!.module.slice(2)}`;
  const loaded = await import(module);
  expect(typeof loaded[exportName]).toBe('function');
});

it('lets a convention verb handle its own help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleet(['stray-slots', '--help'])).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet stray-slots'));
  expect(log).not.toHaveBeenCalledWith(expect.stringContaining('fleet control plane'));
});

it('keeps new convention verbs out of the central dispatcher', () => {
  const source = readFileSync(new URL('../src/cli/fleet.ts', import.meta.url), 'utf8');
  expect(source.match(/if \(args\[0\] === '/g)?.length ?? 0,
    'Add a new src/cli/fleet-<verb>.ts with its convention export and no dispatch line.',
  ).toBeLessThanOrEqual(4);
});

import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { generateFleetRegistry } from '../scripts/gen-fleet-registry.mjs';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

async function dispatch(args: string[]): Promise<{ code: number; errText: string }> {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    return { code: await cmdFleet(args), errText: stderr.mock.calls.map(call => String(call[0])).join('') };
  } finally {
    stderr.mockRestore();
    stdout.mockRestore();
  }
}

describe('RQ-PHX-GUARDIANCOMMANDREACH02: merged guardian commands reachable through the fleet registry', { timeout: 120_000 }, () => {
  it.each([
    ['guardian-compact', 'cmdFleetGuardianCompact'],
    ['guardian-retry', 'cmdFleetGuardianRetry'],
  ] as const)('registry loader for %s resolves the conventional %s export', async (verb, exportName) => {
    const resolved = resolveFleetSubcommand(verb);
    expect(resolved).toMatchObject({ module: `./fleet-${verb}.js`, exportName });
    const loader = FLEET_SUBCOMMAND_LOADERS[verb];
    expect(typeof loader, `${verb} must be in FLEET_SUBCOMMAND_LOADERS`).toBe('function');
    const loaded = await loader!();
    expect(typeof loaded[exportName]).toBe('function');
    expect((loaded[exportName] as { name?: string }).name).toBe(exportName);
  });

  it('fleet guardian-compact with no flags reaches its own argument parser, not unknown-subcommand', async () => {
    const { code, errText } = await dispatch(['guardian-compact']);
    expect(code).toBe(2);
    expect(errText).toContain('invalid guardian-compact arguments');
    expect(errText).not.toContain('unknown fleet subcommand');
  });

  it('fleet guardian-compact with a bad flag still reaches its parser, not unknown-subcommand', async () => {
    const { code, errText } = await dispatch(['guardian-compact', '--bogus']);
    expect(code).toBe(2);
    expect(errText).toContain('invalid guardian-compact arguments');
    expect(errText).not.toContain('unknown fleet subcommand');
  });

  it('fleet guardian-retry with no flags reaches its own validation, not unknown-subcommand', async () => {
    const { code, errText } = await dispatch(['guardian-retry']);
    expect(code).toBe(3);
    expect(errText).toContain('guardian-retry could not validate or prepare retry state');
    expect(errText).not.toContain('unknown fleet subcommand');
  });

  it('fleet guardian-retry with a bad flag reaches its own argument parser, not unknown-subcommand', async () => {
    const { code, errText } = await dispatch(['guardian-retry', '--bogus']);
    expect(code).toBe(2);
    expect(errText).toContain('invalid guardian-retry arguments');
    expect(errText).not.toContain('unknown fleet subcommand');
  });

  it('the generator keeps guardian-compact when run on an isolated CLI fixture with the real compact source', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'guardian-reach-fixture-'));
    const realSource = fileURLToPath(new URL('../src/cli/fleet-guardian-compact.ts', import.meta.url));
    await copyFile(realSource, join(fixture, 'fleet-guardian-compact.ts'));
    expect(generateFleetRegistry([fixture])).toBe(0);
    const generated = await readFile(join(fixture, 'fleet-subcommand-registry.ts'), 'utf8');
    expect(generated).toContain("'guardian-compact': () => import('./fleet-guardian-compact.js'),");
  });

  it('committed registry stays in sync with the generator on the real tree', () => {
    expect(generateFleetRegistry(['--check'])).toBe(0);
  });

  it('compact validation runs through the real registered export on temp files with zero mutation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guardian-reach-compact-'));
    const manifest = join(dir, 'm.json');
    const source = join(dir, 's.json');
    const output = join(dir, 'o.json');
    await writeFile(manifest, '{not json');
    await writeFile(source, JSON.stringify({ version: 1, entries: [] }));
    const sourceBytes = await readFile(source, 'utf8');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const loaded = await FLEET_SUBCOMMAND_LOADERS['guardian-compact']!();
      const compact = loaded['cmdFleetGuardianCompact'] as (args: string[]) => Promise<number>;
      expect(typeof compact).toBe('function');
      expect(await compact(['--manifest', manifest, '--source-state', source, '--output-state', output])).toBe(1);
      expect(await compact(['--bogus'])).toBe(2);
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
    expect(existsSync(output)).toBe(false); // malformed manifest: never materializes output
    expect(await readFile(source, 'utf8')).toBe(sourceBytes);
  });
});

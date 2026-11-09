import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetTscWarm, fleetTscWarm } from '../src/cli/fleet-tsc-warm.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

let root: string;
let target: string;
let donor: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tsc-warm-'));
  target = join(root, 'target'); donor = join(root, 'donor');
  await mkdir(target); await mkdir(join(donor, 'cache'), { recursive: true });
  await writeFile(join(target, 'tsconfig.json'), JSON.stringify({ compilerOptions: { tsBuildInfoFile: 'cache/build.info' } }));
  await writeFile(join(donor, 'cache/build.info'), 'cache data');
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('fleet tsc-warm', () => {
  it('reports a donor without changing the target, then copies on apply', async () => {
    const planned = await fleetTscWarm(target, donor, false);
    expect(planned).toMatchObject({ action: 'would-copy', target: { bytes: null }, donor: { bytes: 10 } });
    await expect(readFile(planned.target.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const copied = await fleetTscWarm(target, donor, true);
    expect(copied).toMatchObject({ action: 'copied', target: { bytes: 10 } });
    expect(await readFile(copied.target.path, 'utf8')).toBe('cache data');
    await writeFile(copied.target.path, 'existing');
    expect((await fleetTscWarm(target, donor, true)).action).toBe('target-exists');
    expect(await readFile(copied.target.path, 'utf8')).toBe('existing');
  });
  it('reports missing donors and missing donor argument', async () => {
    expect((await fleetTscWarm(target, undefined, true)).action).toBe('no-donor');
    expect((await fleetTscWarm(target, join(root, 'missing'), true)).action).toBe('donor-missing');
  });
  it('provides JSON, usage errors, and a registered command', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetTscWarm(['--dir', target, '--from', donor, '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string).action).toBe('would-copy');
    expect(await cmdFleetTscWarm(['--dir'])).toBe(2);
    expect(await cmdFleetTscWarm(['--dir', join(root, 'missing')])).toBe(1);
    expect(await resolveFleetSubcommand('tsc-warm')).toBeDefined();
  });
});

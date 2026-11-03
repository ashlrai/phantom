import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetLoad, readFleetLoad } from '../src/cli/fleet-load.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const base = { load1: 10, ncpu: 8, load_max: 24, procs: 300, worktrees: 40,
  running: 3, cap: 8, daemon_tick_age_s: 1800, warnings: [] };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(patch: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-load-'));
  dirs.push(dir);
  const file = join(dir, 'status.json');
  await writeFile(file, JSON.stringify({ admission: { ...base, ...patch }, ignored: 'not projected' }));
  return { file, read: async (path: string) => {
    expect(path).toMatch(/\.ashlr-runs\/queue\/status\.json$/);
    return readFile(file, 'utf8');
  } };
}
describe('fleet load', () => {
  it('registers the verb and prints the typed JSON projection without changing the fixture', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS.load!()).cmdFleetLoad).toBe(cmdFleetLoad);
    const { file, read } = await fixture();
    const before = await readFile(file, 'utf8');
    let output = '';
    expect(await cmdFleetLoad(['--json'], { read, write: text => { output += text; } })).toBe(0);
    expect(JSON.parse(output)).toEqual({ ...base, status: 'ok' });
    expect(await readFile(file, 'utf8')).toBe(before);
  });
  it.each([
    [{ load1: 24 }, 'ok', 0], [{ load1: 24.1 }, 'warn', 0],
    [{ load1: 48 }, 'warn', 0], [{ load1: 48.1 }, 'red', 1],
    [{ daemon_tick_age_s: 1801 }, 'red', 1], [{ worktrees: 41 }, 'warn', 0],
    [{ warnings: ['Admission paused'] }, 'warn', 0],
  ])('applies strict thresholds for %j', async (patch, status, exit) => {
    const { read } = await fixture(patch);
    expect((await readFleetLoad(read)).status).toBe(status);
    expect(await cmdFleetLoad(['--json'], { read, write: () => {} })).toBe(exit);
  });
  it('uses plain words and keeps admission warnings', async () => {
    const { read } = await fixture({ warnings: ['Admission paused'] });
    let output = '';
    await cmdFleetLoad([], { read, write: text => { output += text; } });
    for (const text of ['Load: 10', 'CPUs: 8', 'load limit: 24', 'Processes: 300',
      'worktrees: 40', 'Running: 3 of 8', '1800 seconds ago', 'Warning: Admission paused']) expect(output).toContain(text);
  });
  it.each(['missing', 'broken', 'empty', 'invalid'])('reports %s evidence without inventing measurements', async kind => {
    const { file, read } = await fixture({ load1: '10', daemon_tick_age_s: null });
    if (kind === 'missing') await rm(file);
    if (kind === 'broken') await writeFile(file, '{');
    if (kind === 'empty') await writeFile(file, '{}');
    const result = await readFleetLoad(read);
    expect(result.load1).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.status).toBe(kind === 'invalid' ? 'warn' : 'red');
  });
  it('handles help and rejects options before reading', async () => {
    const read = async () => { throw new Error('must not read'); };
    expect(await cmdFleetLoad(['--help'], { read, write: () => {} })).toBe(0);
    expect(await cmdFleetLoad(['--other'], { read })).toBe(2);
  });
});

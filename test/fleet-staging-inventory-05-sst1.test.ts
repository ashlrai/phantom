import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetStagingInventory } from '../src/cli/fleet-staging-inventory.js';
import { MAX_CHILDREN, type InventoryDeps } from '../src/core/fleet/staging-inventory.js';

const child = (name: string) => ({ name, modifiedAt: '2026-11-05T00:00:00.000Z' });
async function run(args: string[], deps: InventoryDeps = {}) {
  const lines: string[] = [];
  const code = await cmdFleetStagingInventory(args, { ...deps, output: { log: s => lines.push(s), error: s => lines.push(s) } });
  return { code, lines, json: () => JSON.parse(lines.join('\n')) };
}
const list = async () => ({ state: 'ok' as const, children: [child('small'), child('big'), child('unknown')], skippedSymlinks: 0, truncated: false });

describe('staging inventory command', () => {
  it('sorts measured entries and preserves unknown evidence in JSON and human output', async () => {
    const deps = { list, measure: (path: string) => { if (path.endsWith('unknown')) throw Error('unreadable'); return path.endsWith('big') ? 35_000_000_000 : 10; } };
    const json = (await run(['--root', '/fake', '--json'], deps)).json();
    expect(json.entries.map((e: { name: string }) => e.name)).toEqual(['big', 'small', 'unknown']);
    expect(json.entries[2].bytes).toBeNull();
    expect(json.totalMeasuredBytes).toBe(35_000_000_010);
    expect(json.complete).toBe(false);
    const human = (await run(['--root', '/fake'], deps)).lines.join('\n');
    expect(human).toContain('incomplete');
    expect(human).toContain(json.cleanupEligibility);
    expect(human).toContain('not reclaimable');
  });
  it('degrades on timeout and output cap failures and passes names literally', async () => {
    const paths: string[] = [];
    const deps = { list: async () => ({ state: 'ok' as const, children: [child('space ; $(touch nope)'), child('timeout'), child('cap')], skippedSymlinks: 0, truncated: false }), measure: (path: string) => { paths.push(path); if (!path.includes('space')) throw Error('timeout or maxBuffer'); return 1024; } };
    const report = (await run(['--root', '/fake', '--json'], deps)).json();
    expect(paths[0]).toBe('/fake/space ; $(touch nope)');
    expect(report.entries.filter((e: { bytes: number | null }) => e.bytes === null)).toHaveLength(2);
    expect(report.source).toBe('degraded');
  });
  it('bounds children and reports truncation', async () => {
    let calls = 0;
    const report = (await run(['--root', '/fake', '--json'], { list: async () => ({ state: 'ok', children: Array.from({ length: MAX_CHILDREN + 1 }, (_, i) => child(String(i))), skippedSymlinks: 0, truncated: false }), measure: () => { calls++; return 1; } })).json();
    expect(calls).toBe(MAX_CHILDREN);
    expect(report.truncated).toBe(true);
    expect(report.complete).toBe(false);
  });
  it('uses the real listing and du without following symlinks, and reports missing roots', async () => {
    const base = await mkdtemp(join(tmpdir(), 'staging-test-'));
    try {
      const root = join(base, 'root'); await mkdir(root);
      await mkdir(join(root, 'space ; $name')); await writeFile(join(root, 'space ; $name', 'payload'), 'x');
      await symlink(join(root, 'space ; $name'), join(root, 'link'));
      await symlink(root, join(base, 'root-link'));
      const report = (await run(['--root', root, '--json'])).json();
      expect(report.complete).toBe(true); expect(report.skippedSymlinks).toBe(1);
      expect(report.entries).toHaveLength(1); expect(report.entries[0].bytes).toBeGreaterThanOrEqual(0);
      expect((await run(['--root', join(base, 'root-link'), '--json'])).json().source).toBe('degraded');
      const missing = (await run(['--root', join(base, 'absent'), '--json'])).json();
      expect(missing.source).toBe('missing'); expect(missing.entries).toEqual([]);
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetWtCache, type FleetWtCacheDeps } from '../src/cli/fleet-wt-cache.js';

const NOW = Date.parse('2026-11-02T00:00:00Z');
const H = 3_600_000;
const GB = 1024 ** 3;
const ROOT = '/wt';

// job -> dir name -> age in hours
const tree: Record<string, Record<string, number>> = {
  'RQ-A': { node_modules: 5, target: 10, '.next': 3, src: 100 },
  'RQ-YOUNG': { node_modules: 1, target: 1.5 },
  'guardian-x': { node_modules: 500 },
};

function setup(remove = vi.fn(async (_p: string) => {})) {
  const du = vi.fn(async (p: string) => (p.endsWith('node_modules') ? 2 * GB : p.endsWith('target') ? GB : GB / 2));
  const deps: FleetWtCacheDeps = {
    now: () => NOW,
    fs: {
      listDirs: async d => (d === ROOT ? Object.keys(tree) : Object.keys(tree[d.slice(ROOT.length + 1)] ?? {})),
      mtimeMs: async p => {
        const [job, name] = p.slice(ROOT.length + 1).split('/');
        const age = tree[job!]?.[name!];
        return age === undefined ? null : NOW - age * H;
      },
    },
    du,
    remove,
  };
  return { deps, du, remove };
}

async function run(args: string[], deps: FleetWtCacheDeps) {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => ((out += s), true)) as never);
  const code = await cmdFleetWtCache(['--root', ROOT, '--json', ...args], deps);
  return { code, view: JSON.parse(out) };
}

afterEach(() => vi.restoreAllMocks());

describe('fleet wt-cache', () => {
  it('finds each idle kind, skipping young dirs, guardian-* and source', async () => {
    const { deps, du } = setup();
    const { code, view } = await run([], deps);
    expect(code).toBe(0);
    expect(view.caches.map((c: { path: string }) => c.path)).toEqual(['/wt/RQ-A/node_modules', '/wt/RQ-A/target', '/wt/RQ-A/.next']);
    expect(view.kinds).toEqual([
      { kind: 'node_modules', count: 1, gb: 2 },
      { kind: 'target', count: 1, gb: 1 },
      { kind: '.next', count: 1, gb: 0.5 },
    ]);
    expect(view.freeGb).toBe(3.5);
    expect(du.mock.calls.flat().join(' ')).not.toMatch(/guardian|YOUNG|src/);
  });

  it('dry run deletes nothing', async () => {
    const { deps, remove } = setup();
    const { view } = await run([], deps);
    expect(view.apply).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it('--apply removes only the idle cache dirs', async () => {
    const { deps, remove } = setup();
    const { code } = await run(['--apply'], deps);
    expect(code).toBe(0);
    expect(remove.mock.calls.map(c => c[0])).toEqual(['/wt/RQ-A/node_modules', '/wt/RQ-A/target', '/wt/RQ-A/.next']);
  });

  it('reports a failed removal, exits 1 and does not count it as freed', async () => {
    const { deps } = setup(vi.fn(async (p: string) => { if (p.endsWith('target')) throw new Error('busy'); }));
    const { code, view } = await run(['--apply'], deps);
    expect(code).toBe(1);
    expect(view.freeGb).toBe(2.5);
    expect(view.caches.find((c: { kind: string }) => c.kind === 'target').error).toBe('busy');
  });

  it('prints one plain line per kind then free', async () => {
    const { deps } = setup();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => void lines.push(s));
    await cmdFleetWtCache(['--root', ROOT], deps);
    expect(lines).toEqual([
      'node_modules: 1 dirs, 2 GB',
      'target: 1 dirs, 1 GB',
      '.next: 1 dirs, 0.5 GB',
      'free: 3.5 GB (dry run; add --apply to delete)',
    ]);
  });

  it('rejects unknown and duplicate options without reading anything', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, remove, du } = setup();
    expect(await cmdFleetWtCache(['--force'], deps)).toBe(2);
    expect(await cmdFleetWtCache(['--apply', '--apply'], deps)).toBe(2);
    expect(remove).not.toHaveBeenCalled();
    expect(du).not.toHaveBeenCalled();
  });
});

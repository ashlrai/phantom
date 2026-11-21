import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetLanded } from '../src/cli/fleet-landed.js';
import { cmdFleetLandedSweep, type FleetLandedSweepDeps } from '../src/cli/fleet-landed-sweep.js';
import { landedHeadline, readLandedFromGit } from '../src/core/fleet/landed-from-git.js';

const F = '\x1f', R = '\x1e';
const sha = (c: string) => c.repeat(40);
const commit = (c: string, at: string, body: string) => `${sha(c)}${F}${at}${F}${body}${R}\n`;
// Newest first: 3 bridge commits and 1 unrelated one.
const LOG = commit('d', '2026-11-21T09:00:00Z', 'bridge(RQ-ALPHA): alpha (#3)\n\nbody')
  + commit('c', '2026-11-21T08:00:00Z', 'fix typo in readme')
  + commit('b', '2026-11-21T07:00:00Z', 'bridge(RQ-BETA): beta (#2)')
  + commit('a', '2026-11-21T06:00:00Z', 'merge work\n\nRQ-GAMMA: gamma');
const gitOk = (calls: string[][] = []) => (args: string[]) => {
  calls.push(args);
  if (args[0] === 'symbolic-ref') return 'origin/master\n';
  return args[0] === 'log' ? LOG : '';
};

afterEach(() => vi.restoreAllMocks());

describe('readLandedFromGit', () => {
  it('finds 3 landed jobs and ignores the unrelated commit', () => {
    const calls: string[][] = [];
    const r = readLandedFromGit({ git: gitOk(calls), now: Date.parse('2026-11-21T10:00:00Z') });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('git');
    expect(r.schema).toBe('fleet.landed.v1');
    expect(r.jobs.map(j => j.id)).toEqual(['RQ-GAMMA', 'RQ-BETA', 'RQ-ALPHA']);
    expect(r.jobs[2]).toMatchObject({ repo: 'phantom', sha: sha('d') });
    expect(calls.some(a => a[0] === 'fetch' && a.includes('master'))).toBe(true);
    expect(calls.find(a => a[0] === 'log')).toContain('--since=2026-11-20T10:00:00.000Z');
    expect(landedHeadline(r)).toBe('3 jobs landed on phantom in the last 24 h (from git).');
  });

  it('a fetch failure is a plain reason, not an empty guess', () => {
    const git = (args: string[]) => { if (args[0] === 'fetch') throw Object.assign(new Error('x'), { stderr: 'fatal: no route to host\n' }); return ''; };
    const r = readLandedFromGit({ git });
    expect(r).toMatchObject({ ok: false, jobs: [], reason: 'git could not read origin/master (fatal: no route to host)' });
    expect(landedHeadline(r)).toContain("Can't tell");
  });
});

describe('fleet landed', () => {
  it('prints a plain first line then one line per job', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((t: string) => { out.push(t); });
    const code = await cmdFleetLanded([], { read: () => readLandedFromGit({ git: gitOk() }) });
    expect(code).toBe(0);
    expect(out[0]).toBe('3 jobs landed on phantom in the last 24 h (from git).');
    expect(out[1]).toBe(`RQ-GAMMA phantom ${'a'.repeat(7)} 2026-11-21T06:00:00Z`);
    expect(out).toHaveLength(4);
  });

  it('--json carries the schema id and exit 1 when git is unreadable', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((t: string) => { out.push(t); });
    const bad = () => { throw new Error('offline'); };
    expect(await cmdFleetLanded(['--json', '--since', '2d'], { read: h => readLandedFromGit({ git: bad, sinceHours: h }) })).toBe(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ schema: 'fleet.landed.v1', ok: false, sinceHours: 48, source: 'git' });
  });

  it('rejects a bad --since', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetLanded(['--since', 'soon'])).toBe(2);
  });
});

describe('landed-sweep fallback', () => {
  const ghDown = async () => ({ ok: false, stdout: '', stderr: 'nope' });
  const run = async (landedFromGit: NonNullable<FleetLandedSweepDeps['landedFromGit']>) => {
    const out: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await cmdFleetLandedSweep(['--json'], { gh: ghDown, landedFromGit, output: t => out.push(t) });
    return { code, result: JSON.parse(out[0]!) as Record<string, unknown> };
  };

  it('falls back to git when gh fails', async () => {
    const { code, result } = await run(() => readLandedFromGit({ git: gitOk() }));
    expect(code).toBe(0);
    expect(result).toMatchObject({ inspected: 3, landed: 3, closed: 0, source: 'git' });
    expect(result['skippedReason']).toContain('from git, 3 jobs landed');
  });

  it('reports inspected 0 with the reason when the fetch fails too', async () => {
    const { code, result } = await run(() => readLandedFromGit({ git: () => { throw new Error('offline'); } }));
    expect(code).toBe(0);
    expect(result).toMatchObject({ inspected: 0, landed: 0, source: 'git' });
    expect(result['skippedReason']).toContain('gh pr list failed');
    expect(result['skippedReason']).toContain('git could not read origin/master (offline)');
  });
});

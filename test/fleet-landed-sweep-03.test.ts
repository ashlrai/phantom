import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirtyRow } from '../src/core/fleet/dirty-landed-inspect.js';
import { cmdFleetLandedSweep } from '../src/cli/fleet-landed-sweep.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

// The git-backed inspection is faked: PR 11 is fully on master (landed),
// PR 12 still differs (needs-recut). No git process or remote is touched.
vi.mock('../src/core/fleet/dirty-landed-inspect.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/core/fleet/dirty-landed-inspect.js')>();
  return {
    ...real,
    withScratchRepo: async <T>(fn: (dir: string) => Promise<T>) => fn('/unused'),
    inspectDirtyLanded: async (_dir: string, row: DirtyRow) => {
      const landed = row.number === 11;
      return {
        number: row.number, title: row.title, head: row.headSha, base: 'master',
        class: landed ? 'landed' : 'needs-recut', changedPaths: ['a.txt'],
        landedPaths: landed ? ['a.txt'] : [], remainingPaths: landed ? [] : ['a.txt'],
      };
    },
  };
});

const H11 = 'a'.repeat(40);
const H12 = 'b'.repeat(40);
const dirs: string[] = [];
let out: string[];
let errs: string[];
beforeEach(() => { out = []; errs = []; });
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const row = (number: number, title: string, head: string) => ({
  number, title, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefOid: head, baseRefName: 'master',
});

function setup(liveHead11?: string) {
  const h11 = H11, h12 = H12;
  const runsDir = mkdtempSync(join(tmpdir(), 'landed-sweep-runs-')); dirs.push(runsDir);
  const calls: string[][] = [];
  const gh = vi.fn(async () => ({
    ok: true, stderr: '',
    stdout: JSON.stringify([row(11, 'bridge: RQ-PHX-LANDED', h11), row(12, 'bridge: RQ-PHX-RECUT', h12)]),
  }));
  const runner = vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    if (args[1] === 'view') return { code: 0, stdout: JSON.stringify({ headRefOid: liveHead11 ?? h11, state: 'OPEN' }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const run = (args: string[]) => cmdFleetLandedSweep([...args, '--runs-dir', runsDir], {
    gh, runner, now: () => 0,
    output: t => out.push(t), error: t => errs.push(t),
  });
  const ledger = () => join(runsDir, 'queue', 'landed-closes.jsonl');
  return { run, calls, ledger, gh, runner, h11, h12 };
}

describe('fleet landed-sweep', () => {
  it('is dispatched as a fleet verb', () => {
    expect(resolveFleetSubcommand('landed-sweep'))
      .toEqual({ module: './fleet-landed-sweep.js', exportName: 'cmdFleetLandedSweep' });
  });

  it('dry run plans the landed PR and closes nothing', async () => {
    const { run, calls, ledger } = setup();
    expect(await run(['--json'])).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({ v: 1, inspected: 2, landed: 1, planned: 1, closed: 0, skipped: 0, failed: 0 });
    expect(calls).toEqual([]);
    expect(existsSync(ledger())).toBe(false);
  });

  it('--apply closes only the landed PR and writes one ledger row', async () => {
    const { run, calls, ledger, h11 } = setup();
    expect(await run(['--json', '--apply'])).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ v: 1, inspected: 2, landed: 1, planned: 1, closed: 1, skipped: 0, failed: 0 });
    const closes = calls.filter(a => a[1] === 'close');
    expect(closes).toEqual([[
      'pr', 'close', '11', '--repo', 'ashlrai/phantom', '--comment',
      'Closed by ashlr fleet landed-close: every changed path already matches master at the time of the check.',
    ]]);
    expect(calls.some(a => a.includes('12'))).toBe(false);
    const rows = readFileSync(ledger(), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(rows).toEqual([{ at: new Date(0).toISOString(), pr: 11, head: h11, outcome: 'closed' }]);
  });

  it('reports a head that moved between inspect and close as skipped', async () => {
    const { run, calls } = setup('f'.repeat(40));
    expect(await run(['--json', '--apply'])).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ planned: 1, closed: 0, skipped: 1, failed: 0 });
    expect(calls.filter(a => a[1] === 'close')).toEqual([]);
  });

  it('--limit 0 closes nothing', async () => {
    const { run, calls } = setup();
    expect(await run(['--json', '--apply', '--limit', '0'])).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ planned: 1, closed: 0 });
    expect(calls).toEqual([]);
  });

  it('exits 1 with an error when the gh list read fails', async () => {
    const code = await cmdFleetLandedSweep(['--json'], {
      gh: async () => ({ ok: false, stdout: '', stderr: 'nope' }), output: t => out.push(t), error: t => errs.push(t),
    });
    expect(code).toBe(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ v: 1, closed: 0, error: 'dirty-landed report unreadable' });
  });

  it('exits 2 on usage errors', async () => {
    const code = await cmdFleetLandedSweep(['--runs-dir', 'relative'], { output: t => out.push(t), error: t => errs.push(t) });
    expect(code).toBe(2);
    expect(errs[0]).toContain('Usage: ashlr fleet landed-sweep');
  });
});

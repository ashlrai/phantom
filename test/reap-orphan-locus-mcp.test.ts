/**
 * Orphaned locus-mcp reaper (scripts/mac-bridge/reap-orphan-locus-mcp.mjs).
 * Fixture ps output exercises every gate: fleet worktree and ~/.ashlr-runs
 * paths match; Mason's own app-launched servers, live agents, young and
 * unverifiable chains never do. Dry-run is the default; --apply re-verifies
 * against a fresh process table before signaling.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPLY_NAME,
  DRY_RUN_NAME,
  elapsedSeconds,
  parsePs,
  referencesRoot,
  run,
  selectOrphans,
} from '../scripts/mac-bridge/reap-orphan-locus-mcp.mjs';

const fixture = readFileSync(fileURLToPath(new URL('fixtures/reap-orphan-locus-mcp-ps.txt', import.meta.url)), 'utf8');
const HOME = '/Users/masonwyatt';
const WT = `${HOME}/Projects/ashlrai/wt`;
const RUNS = `${HOME}/.ashlr-runs`;
const ROOTS = [resolve(WT), resolve(RUNS)];
const MATCHED_PIDS = [41001, 42001, 52001, 52002, 55001];
const KILL_ORDER = [41000, 41001, 42000, 42001, 52000, 52001, 52002, 55000, 55001];

const dirs: string[] = [];
const stateDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'reap-locus-mcp-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const base = (overrides: Record<string, unknown> = {}) => ({
  home: HOME,
  stateDir: stateDir(),
  listProcesses: async () => fixture,
  cwdOf: async (pid: number) => `/cwd/${pid}`,
  log: () => {},
  ...overrides,
});

describe('elapsedSeconds', () => {
  it.each([
    ['43200', 43200], ['05:07', 307], ['13:54:40', 50080], ['1-22:40:00', 168000], ['10-00:00:05', 864005],
  ])('parses %s as %d seconds', (field, seconds) => {
    expect(elapsedSeconds(field)).toBe(seconds);
  });
  it.each(['soon', '1:2:3:4', '', '::'])('rejects %s', (field) => {
    expect(elapsedSeconds(field)).toBeNull();
  });
});

describe('parsePs', () => {
  it('reads pid, ppid, age, ucomm and command while skipping headers', () => {
    const rows = parsePs(fixture);
    expect(rows.get(1)).toMatchObject({ pid: 1, ppid: 0, etimes: 9000000, ucomm: 'launchd' });
    expect(rows.get(52001)!.etimes).toBe(168000);
    expect(rows.get(42001)!.command).toBe('locus-mcp serve --state /Users/masonwyatt/.ashlr-runs/runs/RQ-STATE');
  });
});

describe('referencesRoot', () => {
  it('matches paths at or under a root, in bare or --flag= argv form', () => {
    expect(referencesRoot(`node ${WT}/RQ/dist/cli.js`, ROOTS)).toBe(true);
    expect(referencesRoot(`locus-mcp --home=${RUNS}/q`, ROOTS)).toBe(true);
    expect(referencesRoot(`locus-mcp --home ${RUNS}`, ROOTS)).toBe(true);
  });
  it('rejects siblings sharing a prefix and non-path text', () => {
    expect(referencesRoot(`locus-mcp --home ${RUNS}-evil/x`, ROOTS)).toBe(false);
    expect(referencesRoot('locus-mcp', ROOTS)).toBe(false);
    expect(referencesRoot(`node ${HOME}/.locus/bin/locus-mcp`, ROOTS)).toBe(false);
  });
});

describe('selectOrphans against fixture ps', () => {
  it('matches only orphaned locus-mcp chains under fleet roots', () => {
    const matches = selectOrphans(parsePs(fixture), { roots: ROOTS });
    expect(matches.map(({ process: leaf }) => leaf.pid)).toEqual(MATCHED_PIDS);
    expect(matches.map(({ parent }) => parent.pid)).toEqual([41000, 42000, 52000, 52000, 55000]);
  });
  it.each([
    [43001, 'node parent is not orphaned (ppid 99000)'],
    [44001, 'parent is a Mac app, not node'],
    [45001, 'Mason Cursor orphan has no fleet path'],
    [45501, 'Mason claude orphan has no fleet path'],
    [46001, 'chain is younger than 12h'],
    [47001, '.ashlr-runs-evil is a prefix sibling, not the root'],
    [48000, 'node parent is absent from the process table'],
    [49001, 'parent is a shell, not node'],
    [51000, 'node parent is absent from the process table'],
    [56000, 'the reaper script itself is node, not a locus-mcp leaf'],
    [57001, 'lexicon-mcp is not locus-mcp'],
  ])('never matches pid %d (%s)', (pid) => {
    const matches = selectOrphans(parsePs(fixture), { roots: ROOTS });
    expect(matches.map(({ process: leaf }) => leaf.pid)).not.toContain(pid);
  });
  it('honours a tighter --min-age', () => {
    const matches = selectOrphans(parsePs(fixture), { roots: ROOTS, minAge: 160000 });
    expect(matches.map(({ process: leaf }) => leaf.pid)).toEqual([41001, 52001]);
  });
});

describe('run dry-run (default)', () => {
  it('lists matches to reap-locus-mcp-dryrun.txt without signaling anything', async () => {
    const signal = vi.fn();
    const dir = stateDir();
    const result = await run([], base({ stateDir: dir, signal }));
    expect(result.matches.map(({ process: leaf }) => leaf.pid)).toEqual(MATCHED_PIDS);
    expect(signal).not.toHaveBeenCalled();
    const file = join(dir, DRY_RUN_NAME);
    expect(result.file).toBe(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const listing = readFileSync(file, 'utf8');
    expect(listing).toContain('# reap-orphan-locus-mcp DRY-RUN');
    expect(listing).toContain('pid=41001 ppid=41000 age=170000s cwd=/cwd/41001 cmd=/Users/masonwyatt/.locus/bin/locus-mcp');
    expect(listing).toContain('parent pid=41000 ppid=1');
    expect(listing).toContain(`#   ${resolve(WT)}`);
    expect(listing).not.toContain('pid=45001');
    expect(listing).toContain('# 5 match(es)');
  });
  it('defaults to the fleet worktree and ~/.ashlr-runs under the injected home', async () => {
    const result = await run([], base());
    expect(result.matches).toHaveLength(5);
  });
  it('refuses overly broad eligible roots', async () => {
    await expect(run(['--root', HOME], base())).rejects.toThrow('too broad');
    await expect(run(['--root', '/'], base())).rejects.toThrow('too broad');
  });
  it('rejects unknown arguments and bad values', async () => {
    await expect(run(['--bogus'], base())).rejects.toThrow('unknown argument');
    await expect(run(['--min-age', 'nan'], base())).rejects.toThrow('invalid');
    await expect(run(['--state-dir', '--apply'], base())).rejects.toThrow('missing value');
  });
  it.each([['--help'], ['-h']])('prints usage with %s without scanning or writing', async (flag) => {
    const listProcesses = vi.fn();
    const log = vi.fn();
    const result = await run([flag], base({ listProcesses, log }));
    expect(result.file).toBeNull();
    expect(listProcesses).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('usage:'));
  });
});

describe('run --apply', () => {
  const terminating = () => {
    const calls: Array<readonly [number, number | string]> = [];
    const signal = (pid: number, sig: number | string) => {
      calls.push([pid, sig] as const);
      if (sig === 0) { const error = new Error('gone') as NodeJS.ErrnoException; error.code = 'ESRCH'; throw error; }
    };
    return { calls, signal };
  };

  it('re-scans, then SIGTERMs parent before leaf, deduped', async () => {
    const { calls, signal } = terminating();
    const listProcesses = vi.fn().mockResolvedValue(fixture);
    const dir = stateDir();
    const result = await run(['--apply'], base({ stateDir: dir, signal, listProcesses, sleep: async () => {} }));
    expect(listProcesses).toHaveBeenCalledTimes(2);
    expect(calls.filter(([, sig]) => sig === 'SIGTERM').map(([pid]) => pid)).toEqual(KILL_ORDER);
    expect(result.results!.every(({ result }) => result === 'terminated')).toBe(true);
    const apply = readFileSync(join(dir, APPLY_NAME), 'utf8');
    expect(apply).toContain('signal pid=41000 result=terminated');
    expect(apply).toContain('# reap-orphan-locus-mcp APPLY');
  });

  it('signals only chains still matching in the confirmation scan', async () => {
    const { calls, signal } = terminating();
    const shrunk = fixture.split('\n').filter((line) => !/^\s*(41000|41001)\s/.test(line)).join('\n');
    const listProcesses = vi.fn().mockResolvedValueOnce(fixture).mockResolvedValueOnce(shrunk);
    const result = await run(['--apply'], base({ listProcesses, signal, sleep: async () => {} }));
    const signaled = calls.filter(([, sig]) => sig === 'SIGTERM').map(([pid]) => pid);
    expect(signaled).toEqual(KILL_ORDER.filter((pid) => pid !== 41000 && pid !== 41001));
    expect(result.matches.map(({ process: leaf }) => leaf.pid)).toEqual([42001, 52001, 52002, 55001]);
  });

  it('escalates to SIGKILL only for survivors past the grace window', async () => {
    const alive = new Set<number>();
    const calls: Array<readonly [number, number | string]> = [];
    const signal = vi.fn((pid: number, sig: number | string) => {
      calls.push([pid, sig] as const);
      if (sig === 'SIGTERM') return;
      if (sig === 'SIGKILL') { alive.delete(pid); return; }
      if (!alive.has(pid)) { const error = new Error('gone') as NodeJS.ErrnoException; error.code = 'ESRCH'; throw error; }
    });
    alive.add(41001); // leaf ignores SIGTERM; everything else dies quietly
    const result = await run(['--apply'], base({ signal, sleep: async () => {}, graceMs: 0 }));
    const stubborn = result.results!.find(({ pid }) => pid === 41001)!;
    expect(stubborn.result).toBe('terminated');
    expect(calls).toContainEqual([41001, 'SIGKILL']);
    expect(calls.filter(([, sig]) => sig === 'SIGKILL')).toHaveLength(1);
  });

  it('records a signal refusal instead of killing the wrong thing', async () => {
    const signal = vi.fn((pid: number, sig: number | string) => {
      if (pid === 42000 && sig === 'SIGTERM') { const error = new Error('denied') as NodeJS.ErrnoException; error.code = 'EPERM'; throw error; }
      if (sig === 0) { const error = new Error('gone') as NodeJS.ErrnoException; error.code = 'ESRCH'; throw error; }
    });
    const result = await run(['--apply'], base({ signal, sleep: async () => {} }));
    expect(result.results!.find(({ pid }) => pid === 42000)!.result).toBe('denied:EPERM');
  });
});

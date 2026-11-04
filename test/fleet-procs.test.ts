import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cmdFleetProcs,
  jobInCommand,
  parsePsRows,
  PROCS_PS_ARGS,
  type FleetProcsDeps,
} from '../src/cli/fleet-procs.js';

const ROOT = '/wt';
const NOW = Date.parse('2026-11-04T00:00:00Z');

const PS_FIXTURE = `    PID   PPID %CPU     RSS COMMAND
      1      0  0.0  12344 /sbin/launchd
    501      1  0.0   2048 /usr/libexec/loginwindow
    800      1 65.0 400000 /usr/bin/node ${ROOT}/RQ-AAA/dist/cli.js serve
    801    800 10.5 200000 ${ROOT}/RQ-AAA/node_modules/.bin/esbuild --service=42137
    806      1  0.1   1024 /usr/bin/tail -f ${ROOT}/RQ-AAA/run.log
    802      1  3.2  50000 /usr/bin/vim ${ROOT}/RQ-BBB/notes.md
    803      1  0.4  10240 -zsh
    804      1  0.0   4096 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder
    805      1  2.0  30720 /bin/zsh -c cd ${ROOT}/RQ-CCC && npm run build
malformed line without numbers
`;

function setup(psOutput: string | Error = PS_FIXTURE) {
  const ps = vi.fn(async () => {
    if (psOutput instanceof Error) throw psOutput;
    return psOutput;
  });
  const deps: FleetProcsDeps = { ps, now: () => NOW };
  return { deps, ps };
}

async function runJson(args: string[], deps: FleetProcsDeps) {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => ((out += s), true)) as never);
  const code = await cmdFleetProcs(['--root', ROOT, '--json', ...args], deps);
  return { code, view: out ? JSON.parse(out) : null };
}

afterEach(() => vi.restoreAllMocks());

describe('fleet procs', () => {
  it('groups processes by the job dir named in the command line', async () => {
    const { deps, ps } = setup();
    const { code, view } = await runJson([], deps);
    expect(code).toBe(0);
    expect(ps).toHaveBeenCalledTimes(1);
    expect(view).toMatchObject({ v: 1, generatedAt: new Date(NOW).toISOString(), root: ROOT, total: 9 });
    expect(view.jobs).toEqual([
      { job: 'RQ-AAA', count: 3, cpu: 75.6, rssMb: 586.9 },
      { job: 'RQ-BBB', count: 1, cpu: 3.2, rssMb: 48.8 },
      { job: 'RQ-CCC', count: 1, cpu: 2, rssMb: 30 },
    ]);
    expect(view.other).toEqual({ count: 4, cpu: 0.4, rssMb: 28.1, jobs: [] });
  });

  it('prints one plain line per job then one other line', async () => {
    const { deps } = setup();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => void lines.push(s));
    const code = await cmdFleetProcs(['--root', ROOT], deps);
    expect(code).toBe(0);
    expect(lines).toEqual([
      'RQ-AAA: 3 procs, 75.6% cpu, 586.9 MB',
      'RQ-BBB: 1 procs, 3.2% cpu, 48.8 MB',
      'RQ-CCC: 1 procs, 2% cpu, 30 MB',
      'other: 4 procs, 0.4% cpu, 28.1 MB',
    ]);
  });

  it('caps job lines at the top 10 by CPU and folds the rest into other', async () => {
    const rows = [
      '  PID PPID %CPU RSS COMMAND',
      ' 9000    1  0.5  2048 /usr/bin/unrelated',
      ...Array.from({ length: 12 }, (_, i) =>
        ` ${9001 + i}    1  ${i + 1}.0  1024 /bin/sh ${ROOT}/RQ-J${String(i + 1).padStart(2, '0')} run`),
    ].join('\n');
    const { deps } = setup(rows);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => void lines.push(s));
    expect(await cmdFleetProcs(['--root', ROOT], deps)).toBe(0);
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe('RQ-J12: 1 procs, 12% cpu, 1 MB');
    expect(lines[9]).toBe('RQ-J03: 1 procs, 3% cpu, 1 MB');
    expect(lines[10]).toBe('other: 3 procs, 3.5% cpu, 4 MB');
    const { view } = await runJson([], deps);
    expect(view.jobs.map((j: { job: string }) => j.job)).toHaveLength(10);
    expect(view.other.jobs).toEqual(['RQ-J02', 'RQ-J01']);
  });

  it('prints only the other line when no job dirs appear', async () => {
    const { deps } = setup('  PID PPID %CPU RSS COMMAND\n    1    0 0.0 100 /sbin/launchd\n');
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => void lines.push(s));
    expect(await cmdFleetProcs(['--root', ROOT], deps)).toBe(0);
    expect(lines).toEqual(['other: 1 procs, 0% cpu, 0.1 MB']);
  });

  it('exits 1 when ps fails and prints nothing to stdout', async () => {
    const { deps } = setup(new Error('ps: permission denied\nsecond line'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await cmdFleetProcs(['--root', ROOT], deps)).toBe(1);
    expect(err).toHaveBeenCalledWith('error: cannot read the process list: ps: permission denied');
    expect(out).not.toHaveBeenCalled();
  });

  it('rejects unknown options, duplicates and a missing --root value without running ps', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, ps } = setup();
    expect(await cmdFleetProcs(['--force'], deps)).toBe(2);
    expect(await cmdFleetProcs(['--json', '--json'], deps)).toBe(2);
    expect(await cmdFleetProcs(['stray'], deps)).toBe(2);
    expect(await cmdFleetProcs(['--root', '--json'], deps)).toBe(2);
    expect(await cmdFleetProcs(['--root'], deps)).toBe(2);
    expect(ps).not.toHaveBeenCalled();
  });

  it('answers --help without running ps', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, ps } = setup();
    expect(await cmdFleetProcs(['--help'], deps)).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet procs'));
    expect(ps).not.toHaveBeenCalled();
  });
});

describe('parsePsRows', () => {
  it('parses pid, ppid, cpu, rss and the full command, skipping header and junk', () => {
    const rows = parsePsRows(PS_FIXTURE);
    expect(rows).toHaveLength(9);
    expect(rows[2]).toEqual({
      pid: 800, ppid: 1, cpu: 65, rssKb: 400000,
      command: '/usr/bin/node /wt/RQ-AAA/dist/cli.js serve',
    });
    expect(rows.every(r => r.command.length > 0)).toBe(true);
  });
});

describe('jobInCommand', () => {
  it('names the first job dir token under root', () => {
    expect(jobInCommand(ROOT, `cd ${ROOT}/RQ-X && npm test`)).toBe('RQ-X');
    expect(jobInCommand(ROOT, `node --cwd ${ROOT}/RQ-Y/dist/index.js`)).toBe('RQ-Y');
    expect(jobInCommand(ROOT, `env HOME=${ROOT}/RQ-Z node x.js`)).toBe('RQ-Z');
  });
  it('stops the job name at path and shell boundaries', () => {
    expect(jobInCommand(ROOT, `tail -f ${ROOT}/RQ-A/run.log`)).toBe('RQ-A');
    expect(jobInCommand(ROOT, `docker -v ${ROOT}/RQ-B:/work img`)).toBe('RQ-B');
  });
  it('returns null when root is absent or embedded in a longer path', () => {
    expect(jobInCommand(ROOT, 'vim notes.md')).toBeNull();
    expect(jobInCommand(ROOT, `cat /private${ROOT}/RQ-A/x`)).toBeNull();
    expect(jobInCommand(ROOT, `cat ${ROOT}2/RQ-A/x`)).toBeNull();
  });
});

describe('ps invocation contract', () => {
  it('uses the exact spec column set', () => {
    expect(PROCS_PS_ARGS).toEqual(['-axo', 'pid,ppid,pcpu,rss,command']);
  });
});

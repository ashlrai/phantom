import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostFamily, parseEtime, parseHostPs, readHostTop, type HostTopReader } from '../src/core/fleet/host-top.js';
import { cmdHost } from '../src/cli/host.js';
import { createFleetMemoryApi, VERSE_FLEET_HOST_PATH } from '../src/core/verse/fleet-memory-api.js';

const HOME = '/Users/fixture';
const WT = `${HOME}/Projects/ashlrai/wt`;
const NOW = Date.parse('2026-11-17T20:00:00Z');

/** One ps line: pid ppid %cpu rssKb etime comm args. */
const line = (pid: number, ppid: number, cpu: number, rssKb: number, etime: string, comm: string, args = comm) =>
  `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${cpu.toFixed(1).padStart(5)} ${String(rssKb).padStart(8)} ${etime.padStart(11)} ${comm} ${args}`;

function reader(lines: string[] | Error, opts: { load1?: number; cwd?: Record<number, string>; existing?: string[] } = {}): HostTopReader {
  return {
    home: HOME, now: () => NOW,
    ps: async () => { if (lines instanceof Error) throw lines; return lines.join('\n') + '\n'; },
    cwd: pid => opts.cwd?.[pid] ?? null,
    exists: path => (opts.existing ?? [`${WT}/RQ-LIVE`]).includes(path),
    load: () => ({ load1: opts.load1 ?? 0.8, load5: 1.1, load15: 1.3, cores: 18 }),
    memory: () => ({ freePercent: 41.5, swapGb: 0 }),
  };
}

const DISPATCHD = line(500, 1, 0.5, 20_000, '2-03:00:00', '/bin/bash', `/bin/bash ${HOME}/.ashlr-runs/bin/dispatchd.sh`);
const LAUNCHD = line(1, 0, 0.1, 10_000, '4-00:00:00', '/sbin/launchd');

afterEach(() => vi.restoreAllMocks());

describe('parsing', () => {
  it('reads etime and splits a comm path that holds spaces from its args', () => {
    expect(parseEtime('05:03')).toBe(303);
    expect(parseEtime('1-02:03:04')).toBe(93_784);
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper (Renderer)';
    const [row] = parseHostPs(line(9, 1, 12, 1000, '10:00', chrome, `${chrome} --type=renderer`))!;
    expect(row).toMatchObject({ pid: 9, cpu: 12, rss: 1_024_000, age: 600, exe: 'Google Chrome Helper (Renderer)' });
    expect(parseHostPs('garbage\n')).toBeNull();
  });
  it.each([
    ['node', 'node /x/node_modules/vitest/vitest.mjs', 'node'], ['bun', 'bun run dev', 'node'], ['tsx', 'tsx a.ts', 'node'],
    ['git', 'git status', 'git'], ['git-remote-https', 'git-remote-https origin', 'git'],
    ['codex', 'codex exec', 'codex'], ['node', 'node /opt/lib/node_modules/@openai/codex/bin/codex.js exec', 'codex'],
    ['claude', 'claude -p', 'claude'], ['node', 'node /opt/@anthropic-ai/claude-code/cli.js', 'claude'],
    ['python3.12', 'python3.12 -m mlx_lm.server', 'python'], ['oMLX', 'oMLX', 'python'],
    ['com.docker.backend', 'com.docker.backend', 'docker'], ['mds_stores', 'mds_stores', 'spotlight'], ['mdworker_shared', 'mdworker_shared -s', 'spotlight'],
    ['Safari', 'Safari', 'browser'], ['com.apple.WebKit.WebContent', 'x', 'browser'], ['zsh', 'zsh -l', 'other'],
  ])('%s (%s) is %s', (exe, args, family) => expect(hostFamily(exe, args)).toBe(family));
});

describe('readHostTop', () => {
  it('idle host: known, nothing busy, no orphans', async () => {
    const r = await readHostTop({ reader: reader([LAUNCHD, line(300, 1, 0, 4000, '01:00:00', '/bin/zsh', '/bin/zsh -l')]) });
    expect(r).toMatchObject({ schema: 'phantom.host.v1', version: 1, generatedAt: '2026-11-17T20:00:00.000Z',
      load: { load1: 0.8, load5: 1.1, load15: 1.3, cpuCount: 18 }, memory: { freePercent: 41.5, swapGb: 0 },
      processes: { state: 'known', reason: null, count: 2, cwd: 'unavailable', cpuPercent: 0.1, fleetCpuPercent: 0, otherCpuPercent: 0.1, fleetShare: 0 },
      orphans: [], orphanCount: 0 });
    expect(r.topCpu!.every(g => !g.fleet)).toBe(true);
  });

  it('fleet-owned load: dispatchd descendants and worktree cwds count as fleet', async () => {
    const r = await readHostTop({ reader: reader([LAUNCHD, DISPATCHD,
      line(510, 500, 95, 300_000, '20:00', 'codex', 'codex exec --sandbox workspace-write'),
      line(511, 510, 380, 900_000, '05:00', 'node', 'node node_modules/vitest/vitest.mjs run'),
      line(520, 1, 150, 200_000, '03:00', 'node', 'node /tmp/build.js'),
      line(600, 1, 5, 50_000, '1-00:00:00', 'Safari', 'Safari'),
    ], { load1: 9, cwd: { 520: `${WT}/RQ-LIVE` } }) });
    expect(r.processes).toMatchObject({ cwd: 'read', cpuPercent: 630.6, fleetCpuPercent: 625.5, otherCpuPercent: 5.1, fleetShare: 0.992 });
    expect(r.topCpu![0]).toEqual({ family: 'node', label: 'Node/Bun/tsx', fleet: true, processes: 2, cpuPercent: 530, rssBytes: 1_100_000 * 1024 });
    // pid 520 sits in a live job worktree under launchd: a launchd orphan, not a dead one.
    expect(r.orphans).toEqual([{ pid: 520, family: 'node', name: 'node', job: 'RQ-LIVE', reason: 'parent-launchd', ageSeconds: 180 }]);
  });

  it('non-fleet load: Spotlight and Chrome dominate, fleet share stays small', async () => {
    const r = await readHostTop({ top: 2, reader: reader([LAUNCHD, DISPATCHD,
      line(510, 500, 20, 100_000, '10:00', 'claude', 'claude -p'),
      ...[700, 701, 702].map(pid => line(pid, 1, 300, 80_000, '02:00:00', '/usr/sbin/mds_stores')),
      line(800, 1, 250, 2_000_000, '03:00:00', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ], { load1: 165 }) });
    expect(r.topCpu!.map(g => [g.label, g.fleet, g.cpuPercent])).toEqual([['Spotlight', false, 900], ['Chrome/Safari', false, 250]]);
    expect(r.topRss![0]).toMatchObject({ label: 'Chrome/Safari', rssBytes: 2_000_000 * 1024 });
    expect(r.processes.fleetShare).toBeCloseTo(20.5 / 1170.6, 3);
  });

  it('orphaned job child: reports the top of a deleted worktree tree with its age', async () => {
    const r = await readHostTop({ reader: reader([LAUNCHD,
      line(900, 1, 60, 400_000, '03:12:00', 'node', `node ${WT}/RQ-GONE/node_modules/vitest/vitest.mjs`),
      line(901, 900, 90, 300_000, '03:11:00', 'node', `node ${WT}/RQ-GONE/node_modules/tinypool/worker.js`),
    ]) });
    expect(r.orphans).toEqual([{ pid: 900, family: 'node', name: 'node', job: 'RQ-GONE', reason: 'worktree-gone', ageSeconds: 11_520 }]);
    expect(r.orphanCount).toBe(1);
    expect(r.topCpu![0]).toMatchObject({ fleet: true, processes: 2, cpuPercent: 150 });
  });

  it('ps denied: process fields are unknown, not zero; load and memory still report', async () => {
    const denied = Object.assign(new Error('spawn /bin/ps EPERM'), { code: 'EPERM' });
    const r = await readHostTop({ reader: reader(denied, { load1: 160 }) });
    expect(r.processes).toEqual({ state: 'unknown', reason: 'ps-denied', count: null, cwd: 'unavailable',
      cpuPercent: null, fleetCpuPercent: null, otherCpuPercent: null, fleetShare: null });
    expect([r.topCpu, r.topRss, r.orphans, r.orphanCount]).toEqual([null, null, null, null]);
    expect(r.load.load1).toBe(160);
    const failed = await readHostTop({ reader: reader(new Error('boom')) });
    expect(failed.processes.reason).toBe('ps-failed');
  });
});

describe('phm host', () => {
  const secretArgs = [LAUNCHD, line(42, 1, 10, 1000, '01:00', 'node', 'node app.js --token=sk-live-SECRET123 OPENAI_API_KEY=abc')];
  const run = async (args: string[], lines: string[] | Error = secretArgs) => {
    const out: string[] = [], err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
    vi.spyOn(console, 'error').mockImplementation((s: string) => { err.push(s); });
    const code = await cmdHost(args, { reader: reader(lines, { load1: 160 }) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('--json prints the versioned schema and never prints process args', async () => {
    const { code, out } = await run(['--json', '--top', '3']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ schema: 'phantom.host.v1', version: 1 });
    expect(out).not.toMatch(/SECRET|API_KEY|app\.js/);
  });
  it('human output explains load above CPU and lists groups', async () => {
    const { out } = await run([]);
    expect(out).toContain('Load 160 / 1.1 / 1.3 on 18 CPUs (8.9 per CPU)');
    expect(out).toContain('Memory 41.5% free · swap 0 GB');
    expect(out).toContain('Load is 159.9 above the CPU in use');
    expect(out).toContain('Orphans: none');
    expect(out).not.toMatch(/SECRET/);
  });
  it('prints unknown when ps is denied', async () => {
    const { code, out } = await run([], Object.assign(new Error('x'), { code: 'EPERM' }));
    expect(code).toBe(0);
    expect(out).toContain('Processes: unknown (ps is not permitted here)');
  });
  it('rejects bad flags with exit 2', async () => {
    expect((await run(['--top', '0'])).code).toBe(2);
    expect((await run(['--bogus'])).code).toBe(2);
    expect((await run(['--help'])).out).toContain('Usage: phm host');
  });
});

describe('GET /api/verse/fleet/host', () => {
  it('serves the report and hides thrown errors', async () => {
    const send = async (readHost: () => Promise<never> | ReturnType<typeof readHostTop>) => {
      const res = { statusCode: 0, body: '', writeHead(code: number) { this.statusCode = code; return this; }, setHeader() {}, end(body: string) { this.body = body; } };
      const handled = await createFleetMemoryApi({ readHost })({} as never, {} as never, res as never, VERSE_FLEET_HOST_PATH, 'GET');
      return { handled, status: res.statusCode, body: JSON.parse(res.body) };
    };
    const ok = await send(() => readHostTop({ reader: reader([LAUNCHD]) }));
    expect(ok).toMatchObject({ handled: true, status: 200, body: { schema: 'phantom.host.v1', version: 1 } });
    const bad = await send(() => Promise.reject(new Error('/secret/path')));
    expect(bad).toEqual({ handled: true, status: 503, body: { v: 1, error: 'host report unavailable' } });
  });
});

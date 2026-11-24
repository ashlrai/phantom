import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirtyRow } from '../src/core/fleet/dirty-landed-inspect.js';
import { readRecutGateFacts, recutTarget, refContained, runGit, shouldEmitRecut, type GitRun, type RecutGateInput } from '../src/core/fleet/recut-gate.js';
import { cmdRecut } from '../src/cli/recut-check.js';
import { cmdFleetRecutSweep } from '../src/cli/fleet-recut-sweep.js';

vi.mock('../src/core/fleet/dirty-landed-inspect.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/fleet/dirty-landed-inspect.js')>(),
  withScratchRepo: async <T>(fn: (dir: string) => Promise<T>) => fn('/unused'),
  inspectDirtyLanded: async (_dir: string, row: DirtyRow) => ({ number: row.number, title: row.title, head: row.headSha, base: 'master',
    class: 'needs-recut', changedPaths: ['src/fake.ts'], landedPaths: [], remainingPaths: ['src/fake.ts'] }),
}));

const now = Date.parse('2026-11-18T00:00:00Z');
const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const row = (fields: Record<string, unknown>) => JSON.stringify(fields);
const ran = (job: string, hoursAgo: number, empty: boolean) => [row({ event: 'launch', job, repo: 'phantom', ts: at(hoursAgo + 1) }),
  row({ event: 'finish', job, empty, ts: at(hoursAgo) })];
const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'recut-gate-')); dirs.push(dir); return dir; };
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.unstubAllEnvs(); });
const metricsFile = (lines: string[]) => { const file = join(scratch(), 'jobs.jsonl'); writeFileSync(file, `${lines.join('\n')}\n`); return file; };
/** A fake git: `log` answers with the given output, anything else fails. */
const fakeGit = (log: string | null): GitRun => async args => args[0] === 'log' && log !== null ? { code: 0, stdout: log } : { code: 128, stdout: '' };

const base: RecutGateInput = { family: 'RQ-PHX-RECUTCORE', stopList: [], lastJobs: [], masterTouched: null, diffContained: null };
const empties = (n: number) => Array.from({ length: n }, (_, i) => ({ job: `RQ-PHX-RECUTCOREC${570 - i}`, empty: true, ended_at: at(i + 1) }));

describe('shouldEmitRecut', () => {
  it('skips a kind on the yield stop list', () => {
    expect(shouldEmitRecut({ ...base, stopList: ['RQ-PHX-RECUTCORE'] }))
      .toEqual({ emit: false, code: 'stop-list', reason: 'RQ-PHX-RECUTCORE is on the yield stop list' });
  });
  it('skips after 3 empty jobs with no new master commits in the area', () => {
    expect(shouldEmitRecut({ ...base, lastJobs: empties(3), masterTouched: false })).toMatchObject({ emit: false, code: 'empty-streak' });
  });
  it('skips when the source ref is already on master', () => {
    expect(shouldEmitRecut({ ...base, diffContained: true })).toMatchObject({ emit: false, code: 'already-on-master' });
  });
  it('emits when master changed since the empty run, or the run is too short', () => {
    expect(shouldEmitRecut({ ...base, lastJobs: empties(3), masterTouched: true })).toMatchObject({ emit: true, code: 'emit' });
    expect(shouldEmitRecut({ ...base, lastJobs: empties(2), masterTouched: false })).toEqual({ emit: true, code: 'emit', reason: 'no skip rule matched' });
    expect(shouldEmitRecut({ ...base, lastJobs: [{ ...empties(1)[0]!, empty: false }, ...empties(2)], masterTouched: false }).emit).toBe(true);
  });
  it('emits with reason "yield unknown" when yield data is missing', () => {
    expect(shouldEmitRecut({ ...base, stopList: null, lastJobs: empties(3), masterTouched: false }))
      .toEqual({ emit: true, code: 'yield-unknown', reason: 'yield unknown' });
  });
  it('keeps an unknown master history unknown: it never skips on it', () => {
    expect(shouldEmitRecut({ ...base, lastJobs: empties(3), masterTouched: null })).toMatchObject({ emit: true, code: 'emit' });
  });
});

describe('recutTarget', () => {
  it.each([
    ['core', 'RQ-PHX-RECUTCORE', 'CORE', ['src/core']], ['RQ-PHX-RECUTCOREC566', 'RQ-PHX-RECUTCORE', 'CORE', ['src/core']],
    ['RQ-PHX-RECUTWEBUIC502', 'RQ-PHX-RECUTWEBUI', 'WEBUI', ['src/web-ui']], ['RQ-PHX-REDTYPEFIXC459', 'RQ-PHX-REDTYPEFIX', '', []],
    ['RQ-PHX-RECUTODDC1', 'RQ-PHX-RECUTODD', 'ODD', []],
  ])('%s is %s', (arg, family, area, paths) => expect(recutTarget(arg)).toEqual({ family, area, paths }));
  it('refuses odd input', () => { expect(recutTarget('-x')).toBeNull(); expect(recutTarget('a b')).toBeNull(); });
});

describe('readRecutGateFacts', () => {
  it('reads the stop list from the same tally as phm jobs yield', async () => {
    const file = metricsFile(Array.from({ length: 6 }, (_, i) => ran(`RQ-PHX-RECUTCOREC${561 + i}`, 7 - i, true)).flat());
    const facts = await readRecutGateFacts('core', { metrics: file, git: fakeGit(''), now });
    expect(facts?.stopList).toContain('RQ-PHX-RECUTCORE');
    expect(shouldEmitRecut(facts!).code).toBe('stop-list');
  });
  it('asks git about the area since the newest empty job started', async () => {
    const file = metricsFile([...ran('RQ-PHX-RECUTCOREC561', 4, true), ...ran('RQ-PHX-RECUTCOREC562', 3, true),
      ...ran('RQ-PHX-RECUTCOREC563', 2, true), ...ran('RQ-PHX-RECUTWEBC9', 1, false)]);
    const calls: (readonly string[])[] = [];
    const git: GitRun = async args => { calls.push(args); return { code: 0, stdout: '' }; };
    const facts = await readRecutGateFacts('RQ-PHX-RECUTCOREC564', { metrics: file, git, now });
    expect(facts?.lastJobs.map(job => job.job)).toEqual(['RQ-PHX-RECUTCOREC563', 'RQ-PHX-RECUTCOREC562', 'RQ-PHX-RECUTCOREC561']);
    expect(calls).toEqual([['log', '-1', '--format=%H', `--since=${at(3)}`, 'master', '--', 'src/core']]);
    expect(shouldEmitRecut(facts!)).toMatchObject({ emit: false, code: 'empty-streak' });
    expect(shouldEmitRecut((await readRecutGateFacts('core', { metrics: file, git: fakeGit('abc\n'), now }))!).emit).toBe(true);
    expect((await readRecutGateFacts('core', { metrics: file, git: fakeGit(null), now }))?.masterTouched).toBeNull();
  });
  it('reads launch and finish facts through the jobs-ledger field dialect', async () => {
    const file = metricsFile([
      row({ job_id: 'RQ-PHX-RECUTCOREC561', type: 'launch', repo: 'phantom', at: at(5) }),
      row({ id: 'RQ-PHX-RECUTCOREC561', kind: 'finish', empty: true, recordedAt: at(4) }),
      row({ jobId: 'RQ-PHX-RECUTCOREC562', event: 'launch', timestamp: at(3) }),
      row({ job: 'RQ-PHX-RECUTCOREC562', type: 'finish', time: at(2), empty: true }),
      row({ job_id: 'RQ-PHX-RECUTCOREC563', kind: 'finish', updatedAt: at(1), empty: true }),
    ]);
    const facts = await readRecutGateFacts('RQ-PHX-RECUTCOREC564', { metrics: file, git: fakeGit(''), now });
    expect(facts?.lastJobs.map(job => job.job)).toEqual(['RQ-PHX-RECUTCOREC563', 'RQ-PHX-RECUTCOREC562', 'RQ-PHX-RECUTCOREC561']);
    expect(shouldEmitRecut(facts!)).toMatchObject({ emit: false, code: 'empty-streak' });
  });
  it('treats a missing ledger as yield unknown', async () => {
    const facts = await readRecutGateFacts('core', { metrics: join(scratch(), 'none.jsonl'), git: fakeGit(''), now });
    expect(facts?.stopList).toBeNull();
    expect(shouldEmitRecut(facts!)).toEqual({ emit: true, code: 'yield-unknown', reason: 'yield unknown' });
  });
});

describe('refContained', () => {
  it('sees an empty diff, applied hunks and real work in a real repo', async () => {
    const repo = scratch();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();
    git('init', '-q', '-b', 'master'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.txt'), 'one\n'); git('add', '.'); git('commit', '-qm', 'one');
    git('branch', 'same');
    git('checkout', '-qb', 'work'); writeFileSync(join(repo, 'a.txt'), 'two\n'); git('commit', '-qam', 'two');
    git('checkout', '-qb', 'more'); writeFileSync(join(repo, 'b.txt'), 'new\n'); git('add', '.'); git('commit', '-qm', 'new');
    // master takes the "two" change as its own commit, like a squash merge.
    git('checkout', '-q', 'master'); writeFileSync(join(repo, 'a.txt'), 'two\n'); git('commit', '-qam', 'squash');
    const run = runGit(repo);
    expect(await refContained(run, 'master', 'same')).toBe(true);
    expect(await refContained(run, 'master', 'work')).toBe(true);
    expect(await refContained(run, 'master', 'more')).toBe(false);
    expect(await refContained(run, 'master', 'gone')).toBeNull();
    expect(await refContained(run, 'master', '--output=x')).toBeNull();
  });
});

describe('phm recut check', () => {
  const check = async (args: string[], git = fakeGit('')) => {
    const out: string[] = [];
    const code = await cmdRecut(['check', ...args], { git, now, output: t => out.push(t), error: t => out.push(t) });
    return { code, out };
  };
  it('prints JSON with schema and version and exits 1 on skip', async () => {
    const file = metricsFile([...ran('RQ-PHX-RECUTCOREC1', 4, true), ...ran('RQ-PHX-RECUTCOREC2', 3, true), ...ran('RQ-PHX-RECUTCOREC3', 2, true)]);
    const { code, out } = await check(['--json', '--metrics', file, 'core']);
    expect(code).toBe(1);
    const report = JSON.parse(out[0]!);
    expect(report).toMatchObject({ schema: 'recut.check.v1', version: 1, family: 'RQ-PHX-RECUTCORE', area: 'CORE', emit: false, code: 'empty-streak' });
    expect(report.facts).toMatchObject({ yield: 'known', on_stop_list: false, master_touched: false, area_paths: ['src/core'] });
  });
  it('prints one plain line and exits 0 when the yield is unknown', async () => {
    expect(await check(['--metrics', join(scratch(), 'none.jsonl'), 'RQ-PHX-RECUTCOREC9'])).toEqual({ code: 0, out: ['recut launch: yield unknown'] });
  });
  it('rejects bad usage', async () => {
    expect((await check([])).code).toBe(2);
    expect((await check(['core', 'web'])).code).toBe(2);
    expect((await check(['--ref'])).code).toBe(2);
    expect((await cmdRecut(['other'], { output: () => {}, error: () => {} }))).toBe(2);
    expect((await cmdRecut(['--help'], { output: () => {} }))).toBe(0);
  });
});

describe('fleet recut-sweep runs the gate before writing', () => {
  it('logs one "recut skipped" line and queues nothing when the kind is on the stop list', async () => {
    const root = scratch(), home = join(root, 'home'), runs = join(root, 'runs'), drop = join(root, 'drop');
    mkdirSync(home); vi.stubEnv('HOME', home);
    mkdirSync(join(runs, 'metrics'), { recursive: true });
    const stamp = new Date(Date.now() - 3_600_000).toISOString();
    writeFileSync(join(runs, 'metrics', 'jobs.jsonl'), Array.from({ length: 6 }, (_, i) => [
      row({ event: 'launch', job: `RQ-PHX-RECUT${100 + i}1117`, repo: 'phantom', ts: stamp }),
      row({ event: 'finish', job: `RQ-PHX-RECUT${100 + i}1117`, empty: true, ts: stamp })]).flat().join('\n'));
    const gh = async () => ({ ok: true, stderr: '', stdout: JSON.stringify([12, 13].map(number => ({ number, title: 'bridge: RQ-PHX-FAKE',
      headRefOid: 'a'.repeat(40), baseRefName: 'master', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }))) });
    let report: { written: number; planned: unknown[]; skipped: { pr: number; reason: string }[] } | undefined;
    const errors: string[] = [];
    const code = await cmdFleetRecutSweep(['--json', '--apply', '--runs-dir', runs], { gh, remote: '/unused', dropRoot: drop,
      output: t => { report = JSON.parse(t); }, error: t => errors.push(t) });
    expect(code).toBe(0);
    expect(errors).toEqual(['recut skipped: RQ-PHX-RECUT is on the yield stop list']);
    expect(report).toMatchObject({ written: 0, planned: [], skipped: [{ pr: 12, reason: 'gate: stop-list' }, { pr: 13, reason: 'gate: stop-list' }] });
    expect(existsSync(join(drop, 'leader/drop/claude')) ? readdirSync(join(drop, 'leader/drop/claude')) : []).toEqual([]);
  });
});

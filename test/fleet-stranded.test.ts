import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetStranded, readFleetStranded } from '../src/cli/fleet-stranded.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import {
  findStrandedWork, pushedBranch, readStrandedWork, recoveredBy, STRANDED_CAUSES, strandedWorkText, verifyAgainstMain,
  type StrandedCandidate, type StrandedItem, type StrandedWorkReport,
} from '../src/core/fleet/stranded-work.js';
import { makeCfg } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const now = 1_800_000_000_000;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('finds unfinished filename IDs on explicitly idle lanes, strictly over the threshold and oldest first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stranded-'));
  try {
    vi.stubEnv('ASHLR_RUNS_DIR', root);
    const dir = join(root, 'queue', 'run');
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, 'queue', 'status.json'), JSON.stringify({ lanes: { idle: { running: 0 }, other: { running: 0 }, busy: { running: 1 }, invalid: { running: '0' } } }));
    for (const [id, lane, age] of [['older', 'other', 120], ['old', 'idle', 100], ['done', 'idle', 150], ['boundary', 'idle', 90], ['busy', 'busy', 200], ['unknown', 'missing', 200], ['invalid', 'invalid', 200]] as const) {
      const path = join(dir, `${id}.line`);
      await writeFile(path, `different-id\tphantom\t${lane}\twork\n`);
      await utimes(path, new Date(now - age * 60_000), new Date(now - age * 60_000));
    }
    await writeFile(join(dir, 'done.fin'), '');
    await writeFile(join(dir, 'different-id.fin'), '');
    expect((await readFleetStranded({ now })).runs).toEqual([
      { id: 'older', lane: 'other', ageMinutes: 120 }, { id: 'old', lane: 'idle', ageMinutes: 100 },
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetStranded(['--minutes', '110', '--json'], { now })).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0]).runs.map((r: { id: string }) => r.id)).toEqual(['older']);
    expect(await cmdFleetStranded([], { now })).toBe(0);
    expect(log).toHaveBeenCalledWith('older\tother\t120.0 min old');
    expect(await cmdFleetStranded(['--minutes', '200'], { now })).toBe(0);
    expect(log).toHaveBeenCalledWith('No stranded runs.');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([['--minutes'], ['--minutes', '-1'], ['--minutes', 'NaN'], ['--minutes', '1e3'], ['--json', '--json'], ['--bad']])('rejects invalid arguments %j (#%#)', async (...args) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetStranded(args)).toBe(2);
});

it('loads through the registry and displays help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect((await FLEET_SUBCOMMAND_LOADERS.stranded!()).cmdFleetStranded).toBe(cmdFleetStranded);
  expect(await cmdFleetStranded(['--help'])).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('default 90'));
});

it.each(['null', '{}', '{"lanes":[]}', 'bad'])('reports invalid status as an error: %s', async status => {
  const root = await mkdtemp(join(tmpdir(), 'stranded-invalid-'));
  try {
    await mkdir(join(root, 'queue', 'run'), { recursive: true });
    await writeFile(join(root, 'queue', 'status.json'), status);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetStranded([], { runsDir: root })).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Finished work that never became a pull request (RQ-STRANDEDN19NQ8).
describe('finished work without a pull request', () => {
  const at = now - 3_600_000;
  const finish = { at, lane: 'claude', diff_files: 4, diff_lines: 120 };
  const hint = (job: string) => `remote: Create a pull request for 'codex-bridge/${job}' on GitHub by visiting:\nremote:      https://github.com/someone/phantom/pull/new/codex-bridge/${job}\n`;
  const candidate = (job: string, publish: string | null, extra: Partial<StrandedCandidate> = {}): StrandedCandidate =>
    ({ job, repo: 'phantom', publish, finish, recoveredBy: null, ...extra });
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

  it('names one cause and one next step per item', () => {
    const items = findStrandedWork([
      candidate('JOB-PUSH', `${hint('JOB-PUSH')}RESULT ABORT default-fetch\n`),
      candidate('JOB-GATE', 'RESULT ABORT PUBLISH-ABORT secret-shape in diff (JOB-GATE)\n'),
      candidate('JOB-GATE-PUSHED', `${hint('JOB-GATE-PUSHED')}RESULT ABORT git-unsafe hooks\n`),
      candidate('JOB-OTHER', 'NOTE scoped\nRESULT ABORT commit\n'),
      candidate('JOB-QUIET', 'NOTE nothing else was written\n'),
      candidate('JOB-NOFILE', null, { repo: null, finish: { at: null, lane: null, diff_files: null, diff_lines: null } }),
    ]);
    expect(STRANDED_CAUSES).toEqual(['abort_after_push', 'gate_stop', 'abort_other', 'unknown']);
    expect(Object.fromEntries(items.map(item => [item.job, item.cause]))).toEqual({
      'JOB-PUSH': 'abort_after_push', 'JOB-GATE': 'gate_stop', 'JOB-GATE-PUSHED': 'gate_stop', 'JOB-OTHER': 'abort_other', 'JOB-QUIET': 'unknown', 'JOB-NOFILE': 'unknown',
    });
    const byJob = Object.fromEntries(items.map(item => [item.job, item]));
    expect(Object.keys(byJob['JOB-PUSH']!)).toEqual(['job', 'repo', 'lane', 'finished_at', 'diff_files', 'diff_lines', 'cause', 'pushed_branch', 'recovered_by', 'verify', 'next_step']);
    expect(byJob['JOB-PUSH']).toEqual({
      job: 'JOB-PUSH', repo: 'phantom', lane: 'claude', finished_at: new Date(at).toISOString(), diff_files: 4, diff_lines: 120,
      cause: 'abort_after_push', pushed_branch: 'codex-bridge/JOB-PUSH', recovered_by: null, verify: null,
      next_step: 'Recover the pushed branch codex-bridge/JOB-PUSH: run phm fleet republish for the ready-made recovery job.',
    });
    expect(byJob['JOB-GATE']).toMatchObject({ pushed_branch: null, next_step: 'Re-run the job with plain-word fixtures: a safety gate stopped the publish.' });
    // A gate outranks a pushed branch: recovering the branch would walk around the gate.
    expect(byJob['JOB-GATE-PUSHED']).toMatchObject({ pushed_branch: 'codex-bridge/JOB-GATE-PUSHED', next_step: 'Re-run the job once the git-unsafe safety gate is cleared.' });
    expect(byJob['JOB-OTHER']!.next_step).toBe('Re-run the job: the publish stopped before any branch was pushed.');
    expect(byJob['JOB-QUIET']!.next_step).toBe('Open the publish result by hand: the cause is unknown.');
    // Unknown stays unknown: no invented repo, lane, time or size.
    expect(byJob['JOB-NOFILE']).toMatchObject({ repo: 'unknown', lane: 'unknown', finished_at: null, diff_files: null, diff_lines: null, cause: 'unknown' });
    expect(items.at(-1)!.job).toBe('JOB-NOFILE');
    for (const item of items) expect(item.next_step).toMatch(/^[A-Z][^.]*\.$/);
  });

  it('says nothing is left to do when a later job recovered the work', () => {
    const others = [
      { id: 'JOB-EARLY-RECOVER', text: 'recover JOB-PUSH', firstSeen: at - 1 },
      { id: 'JOB-NOTE', text: 'JOB-PUSH is mentioned in passing', firstSeen: at + 1 },
      { id: 'JOB-PUSH2', text: 'recover JOB-PUSH2', firstSeen: at + 1 },
      { id: 'JOB-RECUT', text: 'JOB-RECUT\tphantom\tclaude\tRecover the branch for JOB-PUSH.', firstSeen: at + 2 },
      { id: 'RQ-REPUBLISH-JOB-PUSH', text: '', firstSeen: at + 3 },
    ];
    expect(recoveredBy('JOB-PUSH', at, others)).toBe('JOB-RECUT');
    expect(recoveredBy('JOB-PUSH', at, others.slice(4))).toBe('RQ-REPUBLISH-JOB-PUSH');
    expect(recoveredBy('JOB-PUSH', at, others.slice(0, 3))).toBeNull();
    const [item] = findStrandedWork([candidate('JOB-PUSH', `${hint('JOB-PUSH')}RESULT ABORT default-fetch\n`, { recoveredBy: 'JOB-RECUT' })]);
    expect(item).toMatchObject({ cause: 'abort_after_push', recovered_by: 'JOB-RECUT', next_step: 'Nothing to do: JOB-RECUT recovered this work.' });
  });

  it('leaves out work that is not stranded, and an empty list stays empty', () => {
    expect(findStrandedWork([])).toEqual([]);
    expect(findStrandedWork([
      candidate('JOB-ZERO', 'RESULT ABORT commit\n', { finish: { ...finish, diff_files: 0, diff_lines: 0 } }),
      candidate('JOB-PR', `${hint('JOB-PR')}RESULT PR https://github.com/ashlrai/phantom/pull/1 SENS=[]\n`),
      candidate('JOB-EMPTY', 'RESULT EMPTY\n'),
      candidate('JOB-RUNNING', null, { finish: null }),
    ])).toEqual([]);
    expect(findStrandedWork([candidate('JOB-OLD', 'RESULT ABORT commit\n')], at + 1)).toEqual([]);
    expect(pushedBranch('JOB-A', hint('JOB-AB'))).toBeNull();
    expect(strandedWorkText({ schema: 'fleet.stranded.work.v1', readOnly: true, days: 3, known: true, verified: false, kept: 0, items: [], gaps: [] }))
      .toEqual(['No finished work without a pull request in the last 3 days.']);
  });

  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=tester', '-c', 'user.email=tester@example.com', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
  /** A local repo whose main branch already holds JOB-LANDED's change but not JOB-NEEDED's. */
  async function makeRepo(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'master');
    const commit = async (file: string, text: string, note = 'edit') => { await writeFile(join(dir, file), text); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', `${note} ${file}`); };
    await commit('base.txt', 'base\n');
    git(dir, 'checkout', '-q', '-b', 'codex-bridge/JOB-LANDED');
    await commit('landed.txt', 'same words\n');
    git(dir, 'checkout', '-q', '-b', 'codex-bridge/JOB-NEEDED', 'master');
    await commit('needed.txt', 'new words\n');
    git(dir, 'branch', 'codex-bridge/JOB-NOCHANGE', 'master');
    git(dir, 'checkout', '-q', 'master');
    // Landed the way a squash merge lands: the same content in a different commit.
    await commit('landed.txt', 'same words\n', 'squash');
    await commit('other.txt', 'later work on main\n');
  }

  /** A runs folder with one job per outcome; every lane is busy, so there are no stranded run markers. */
  async function makeRuns(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'stranded-work-')); roots.push(root);
    await mkdir(join(root, 'queue', 'run'), { recursive: true }); await mkdir(join(root, 'metrics'));
    const kept = ['JOB-LANDED', 'JOB-NEEDED', 'JOB-GATE', 'JOB-ZERO', 'JOB-PR', 'JOB-STALE'];
    await writeFile(join(root, 'queue', 'status.json'), JSON.stringify({ lanes: { claude: { running: 1 } }, kept_worktrees: kept }));
    const row = (job: string, fields: object, age: number) => JSON.stringify({ job, lane: 'claude', ts: new Date(now - age * 3_600_000).toISOString(), ...fields });
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), [
      row('JOB-LANDED', { event: 'finish', diff_files: 1, diff_lines: 1, empty: false }, 30),
      row('JOB-NEEDED', { event: 'finish', diff_files: 1, diff_lines: 1, empty: false }, 20),
      row('JOB-GATE', { event: 'finish', diff_files: 2, diff_lines: 9, empty: false }, 10),
      row('JOB-ZERO', { event: 'finish', diff_files: 0, diff_lines: 0, empty: true }, 10),
      row('JOB-PR', { event: 'finish', diff_files: 3, diff_lines: 5, empty: false }, 10),
      row('JOB-STALE', { event: 'finish', diff_files: 3, diff_lines: 5, empty: false }, 24 * 5),
      row('JOB-FIX', { event: 'launch' }, 5),
      'not json',
    ].join('\n'));
    for (const job of [...kept, 'JOB-FIX']) await writeFile(join(root, 'queue', 'run', `${job}.line`), `${job}\tphantom\tclaude\t${job === 'JOB-FIX' ? 'Recover the gate stop of JOB-GATE.' : 'work'}\n`);
    await writeFile(join(root, 'JOB-LANDED.publish'), `${hint('JOB-LANDED')}RESULT ABORT default-fetch\n`);
    await writeFile(join(root, 'JOB-NEEDED.publish'), `${hint('JOB-NEEDED')}RESULT ABORT pr\n`);
    await writeFile(join(root, 'JOB-GATE.publish'), 'RESULT ABORT secret-shape\n');
    await writeFile(join(root, 'JOB-ZERO.publish'), 'RESULT ABORT commit\n');
    await writeFile(join(root, 'JOB-PR.publish'), 'RESULT PR https://github.com/ashlrai/phantom/pull/2 SENS=[]\n');
    await writeFile(join(root, 'JOB-STALE.publish'), 'RESULT ABORT commit\n');
    return root;
  }

  it('checks a pushed branch against the local main branch with read-only git', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stranded-git-')); roots.push(dir);
    await makeRepo(dir);
    const before = git(dir, 'for-each-ref').toString() + git(dir, 'status', '--porcelain').toString();
    expect(await verifyAgainstMain(dir, 'codex-bridge/JOB-LANDED')).toBe('already_on_main');
    expect(await verifyAgainstMain(dir, 'codex-bridge/JOB-NEEDED')).toBe('still_needed');
    // A missing branch or a branch with no changed paths proves nothing.
    expect(await verifyAgainstMain(dir, 'codex-bridge/JOB-ABSENT')).toBe('unknown');
    expect(await verifyAgainstMain(dir, 'codex-bridge/JOB-NOCHANGE')).toBe('unknown');
    expect(await verifyAgainstMain(join(dir, 'absent'), 'codex-bridge/JOB-LANDED')).toBe('unknown');
    expect(git(dir, 'for-each-ref').toString() + git(dir, 'status', '--porcelain').toString()).toBe(before);
  }, 30_000);

  it('prints one JSON object with a stable shape, and --verify marks work already on main', async () => {
    const root = await makeRuns();
    const checkoutRoot = await mkdtemp(join(tmpdir(), 'stranded-checkouts-')); roots.push(checkoutRoot);
    await makeRepo(join(checkoutRoot, 'phantom'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetStranded(['--json'], { runsDir: root, now, checkoutRoot })).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    const plain = JSON.parse(log.mock.calls[0]![0] as string);
    expect(Object.keys(plain)).toEqual(['v', 'minutes', 'runs', 'schema', 'readOnly', 'days', 'known', 'verified', 'kept', 'items', 'gaps']);
    expect(plain).toMatchObject({ v: 1, runs: [], schema: 'fleet.stranded.work.v1', readOnly: true, days: 3, known: true, verified: false, kept: 6, gaps: [] });
    expect(Object.keys(plain.items[0])).toEqual(['job', 'repo', 'lane', 'finished_at', 'diff_files', 'diff_lines', 'cause', 'pushed_branch', 'recovered_by', 'verify', 'next_step']);
    // Oldest first; the zero-file finish, the PR and the finish outside the window are left out.
    expect(plain.items.map((item: StrandedItem) => [item.job, item.cause, item.recovered_by, item.verify])).toEqual([
      ['JOB-LANDED', 'abort_after_push', null, null], ['JOB-NEEDED', 'abort_after_push', null, null], ['JOB-GATE', 'gate_stop', 'JOB-FIX', null],
    ]);
    expect(plain.items[2]).toMatchObject({ repo: 'phantom', lane: 'claude', diff_files: 2, diff_lines: 9, next_step: 'Nothing to do: JOB-FIX recovered this work.' });

    expect(await cmdFleetStranded(['--days', '7', '--verify', '--json'], { runsDir: root, now, checkoutRoot })).toBe(0);
    const checked = JSON.parse(log.mock.calls[1]![0] as string);
    expect(checked).toMatchObject({ days: 7, verified: true, gaps: [] });
    expect(checked.items.map((item: StrandedItem) => [item.job, item.verify])).toEqual([
      ['JOB-STALE', null], ['JOB-LANDED', 'already_on_main'], ['JOB-NEEDED', 'still_needed'], ['JOB-GATE', null],
    ]);
    expect(checked.items[1].next_step).toBe('Nothing to do: this work is already on the main branch.');
    expect(checked.items[2].next_step).toContain('Recover the pushed branch codex-bridge/JOB-NEEDED');

    // With no local checkout the answer is unknown, never "still needed".
    const none = await readStrandedWork({ runsDir: root, now, verify: true, checkoutRoot: join(checkoutRoot, 'absent') });
    expect(none.items.map(item => item.verify)).toEqual(['unknown', 'unknown', null]);
    expect(none.gaps).toEqual(['Some pushed branches could not be compared with the local main branch.']);

    log.mockClear();
    expect(await cmdFleetStranded([], { runsDir: root, now, checkoutRoot })).toBe(0);
    const text = log.mock.calls.map(call => call[0] as string);
    expect(text[0]).toBe('Finished work without a pull request (last 3 days): 3');
    expect(text[1]).toBe(`JOB-LANDED: phantom, claude, ${new Date(now - 30 * 3_600_000).toISOString()}, 1 files, 1 lines, abort after push`);
    expect(text.at(-1)).toBe('No stranded runs.');
  }, 30_000);

  it.each([['--days'], ['--days', '0'], ['--days', '91'], ['--days', '1.5'], ['--verify', '--verify']])('rejects %j', async (...args) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetStranded(args)).toBe(2);
  });

  it('shows unknown, not none, when the kept list or the metrics file is missing', async () => {
    const root = await makeRuns();
    await rm(join(root, 'metrics'), { recursive: true });
    // With no finish event the publish result's own file time stands in, so use the real clock here.
    const blind = await readStrandedWork({ runsDir: root });
    expect(blind.gaps).toEqual(['The job metrics file could not be read, so finish times and sizes are unknown.']);
    expect(blind.items.find(item => item.job === 'JOB-GATE')).toMatchObject({ lane: 'unknown', diff_files: null, diff_lines: null, cause: 'gate_stop' });
    await writeFile(join(root, 'queue', 'status.json'), JSON.stringify({ lanes: {} }));
    const report = await readStrandedWork({ runsDir: root, now });
    expect(report).toMatchObject({ known: false, kept: 0, items: [], gaps: ['The kept worktree list (queue/status.json) could not be read.'] });
    expect(strandedWorkText(report)).toEqual(['Finished work without a pull request: unknown, the kept worktree list could not be read.']);
  });

  it('serves the same report at GET /api/fleet/stranded', async () => {
    const root = await makeRuns();
    vi.stubEnv('ASHLR_RUNS_DIR', root);
    const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
    try {
      const get = (query: string) => fetch(`${h.url}/api/fleet/stranded${query}`, { headers: readAuthHeaders(h.port) });
      const ok = await get('?days=90');
      expect(ok.status).toBe(200);
      const body = await ok.json() as StrandedWorkReport;
      expect(body).toMatchObject({ schema: 'fleet.stranded.work.v1', readOnly: true, days: 90, known: true, verified: false });
      expect(body.items.length).toBeGreaterThan(0);
      for (const query of ['?days=0', '?days=abc', '?days=91', '?verify=yes']) expect((await get(query)).status).toBe(400);
      vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'absent'));
      expect((await get('')).status).toBe(503);
    } finally { vi.unstubAllEnvs(); await h.close(); }
  });
});

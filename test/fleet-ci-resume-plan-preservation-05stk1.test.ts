import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { cmdFleetCiResumePlan, type FleetCiResumePlanDeps } from '../src/cli/fleet-ci-resume-plan.js';
import { planCiResumeInputs } from '../src/core/fleet/ci-resume-inputs.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const REPO = 'example/project';
const RUN = 10; const ATTEMPT = 2; const ART = 30; const NAME = 'ci-resume-receipts';
const POLL = 500;
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const ok = (stdout: string): GitRunResult => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false });
const bad = (over: Partial<GitRunResult> = {}): GitRunResult =>
  ({ code: 1, stdout: '', stderr: 'HTTP 404: Not Found', timedOut: false, truncated: false, missing: false, ...over });
const manifest = { version: 1, repo: REPO, jobs: ['a', 'b'].map((id) => ({ id, command: `test ${id}`, os: 'linux', arch: 'x64', toolchain: 'node', paths: [id] })) };

// Synthetic single-member zip (stored, one entry) so the archive path exercises the real ZIP reader.
function zipOf(member: string, data: Buffer): Buffer {
  const name = Buffer.from(member);
  const crc = crc32(data) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}

let root: string; let scratch: string; let baseRev: string; let headRev: string;
let manifestPath: string; let zipPath: string; let prior: unknown;
let out: string[]; let err: string[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'resume-plan-await-root-'));
  scratch = mkdtempSync(join(tmpdir(), 'resume-plan-await-scratch-'));
  git(root, 'init', '-q');
  for (const p of ['a', 'b']) { mkdirSync(join(root, p)); writeFileSync(join(root, p, 'x'), p); }
  git(root, 'add', '.'); git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'); baseRev = git(root, 'rev-parse', 'HEAD');
  const initial = await planCiResumeInputs({ manifest, prior: { version: 1, repo: REPO, receipts: [] }, base: baseRev, head: baseRev, cwd: root });
  prior = { version: 1, repo: REPO, receipts: initial.jobs.map((j, i) => ({ job: j.job, run: RUN, attempt: ATTEMPT, jobId: 20 + i, headSha: baseRev, conclusion: 'success', inputsDigest: j.baseDigest })) };
  writeFileSync(join(root, 'b', 'x'), 'changed'); git(root, 'add', '.'); git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fix'); headRev = git(root, 'rev-parse', 'HEAD');
  manifestPath = join(scratch, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest));
  zipPath = join(scratch, 'receipts.zip'); writeFileSync(zipPath, zipOf('receipts.json', Buffer.from(JSON.stringify(prior))));
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((v) => { out.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((v) => { err.push(String(v)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); });

type Call = { bin: string; args: string[] };
interface FakeGh {
  /** Per-poll responses for the attempt endpoint; the last entry repeats. */
  attempts?: GitRunResult[];
  /** Per-poll responses for the run artifact listing; the last entry repeats. */
  listings?: GitRunResult[];
}
const pop = (q: GitRunResult[] | undefined): GitRunResult | undefined =>
  q === undefined ? undefined : q.length > 1 ? q.shift()! : q[0]!;
const RUN_URL = `repos/${REPO}/actions/runs/${RUN}`;
const ATTEMPT_URL = `${RUN_URL}/attempts/${ATTEMPT}`;
const ARTIFACTS_URL = `${RUN_URL}/artifacts?per_page=100`;
const ART_URL = `repos/${REPO}/actions/artifacts/${ART}`;
const JOBS_URL = `${ATTEMPT_URL}/jobs?per_page=100`;
const attemptMeta = (status: string) => ({ id: RUN, run_attempt: ATTEMPT, head_sha: baseRev, status, conclusion: null, repository: { full_name: REPO } });
const presentPage = [{ total_count: 1, artifacts: [{ id: ART, name: NAME, expired: false, size_in_bytes: 100, workflow_run: { id: RUN } }] }];
const emptyPage = [{ total_count: 0, artifacts: [] }];

/** Fake gh: serves exact-endpoint GETs and writes receipts.json into --dir for `run download`. */
const fakeGh = (f: FakeGh, calls: Call[]): GitRunner => async (bin, a) => {
  calls.push({ bin, args: [...a] });
  if (bin !== 'gh') return bad();
  if (a[0] === 'run' && a[1] === 'download') {
    writeFileSync(join(a[a.indexOf('--dir') + 1]!, 'receipts.json'), JSON.stringify(prior));
    return ok('');
  }
  const endpoint = a.find((s) => s.startsWith('repos/')) ?? '';
  if (a[0] !== 'api') return bad();
  if (endpoint === ATTEMPT_URL) return pop(f.attempts) ?? ok(JSON.stringify(attemptMeta('completed')));
  if (endpoint === ARTIFACTS_URL) return pop(f.listings) ?? ok(JSON.stringify(presentPage));
  if (endpoint === RUN_URL) return ok(JSON.stringify({ id: RUN, run_attempt: ATTEMPT, head_sha: baseRev, status: 'completed', repository: { full_name: REPO } }));
  if (endpoint === ART_URL) return ok(JSON.stringify({ id: ART, name: NAME, size_in_bytes: 100, expired: false, workflow_run: { id: RUN } }));
  if (endpoint === JOBS_URL) return ok(JSON.stringify([{ total_count: 2, jobs: ['a', 'b'].map((name, i) => ({ id: 20 + i, run_id: RUN, run_attempt: ATTEMPT, name, status: 'completed', conclusion: 'success', head_sha: baseRev })) }]));
  return bad();
};

/** Virtual time: sleeps advance the clock and are recorded; no real timer runs. */
const virtualClock = () => {
  let t = 0; const sleeps: number[] = [];
  return { now: () => t, sleeps, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } };
};

const run = async (args: string[], deps: FleetCiResumePlanDeps) => {
  out = []; err = [];
  const code = await cmdFleetCiResumePlan(args, { cwd: root, ...deps });
  return { code, out: out.join('\n'), err: err.join('') };
};
const base = () => ['--repo', REPO, '--run', String(RUN), '--attempt', String(ATTEMPT)];
const tail = () => ['--manifest', manifestPath, '--base', baseRev, '--head', headRev];
const idArgs = () => [...base(), '--artifact-id', String(ART), '--archive', zipPath, ...tail(), '--json'];
const nameArgs = () => [...base(), '--artifact-name', NAME, '--await-ms', '60000', '--poll-ms', String(POLL), ...tail(), '--json'];
const without = (args: string[], flag: string) => { const i = args.indexOf(flag); return [...args.slice(0, i), ...args.slice(i + 2)]; };

/** Every recorded gh call must be a GET-style api read or a run download; nothing mutates. */
const WRITE_FLAGS = ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'];
const readOnly = (c: Call) => c.bin === 'gh' && (c.args[0] === 'run' && c.args[1] === 'download'
  || (c.args[0] === 'api' && !c.args.some((a) => WRITE_FLAGS.includes(a))));
const downloads = (calls: Call[]) => calls.filter((c) => c.args[0] === 'run' && c.args[1] === 'download');

describe('fleet ci-resume-plan --artifact-name (await mode)', () => {
  it('waits through pending polls then plans exactly as artifact-id mode does', async () => {
    const idCalls: Call[] = [];
    const idResult = await run(idArgs(), { gh: fakeGh({}, idCalls) });
    expect(idResult.code).toBe(0);

    const calls: Call[] = [];
    const clock = virtualClock();
    const awaited = await run(nameArgs(), {
      gh: fakeGh({
        attempts: [ok(JSON.stringify(attemptMeta('in_progress'))), ok(JSON.stringify(attemptMeta('queued'))),
          ok(JSON.stringify(attemptMeta('completed')))],
        listings: [ok(JSON.stringify(emptyPage)), ok(JSON.stringify(emptyPage)), ok(JSON.stringify(presentPage))],
      }, calls),
      now: clock.now, sleep: clock.sleep,
    });
    expect(awaited.code).toBe(0);
    expect(clock.sleeps).toEqual([POLL, POLL]); // two pending observations, then the artifact appears
    expect(awaited.err).toContain('in_progress');
    expect(awaited.err).toContain('queued');
    expect(awaited.err).toContain('receipts bound');

    // stdout is exactly one parseable plan document, identical to the artifact-id plan.
    expect(awaited.out.split('\n')).toHaveLength(1);
    const plan = JSON.parse(awaited.out);
    expect(JSON.parse(idResult.out)).toEqual(plan);
    expect(plan.summary).toEqual({ reuse: 1, rerun: 1 });
    expect(plan.jobs[0]).toMatchObject({ job: 'a', decision: 'reuse', reasons: ['inputs_unchanged'] });
    expect(plan.jobs[1]).toMatchObject({ job: 'b', decision: 'rerun', reasons: ['inputs_changed'], changedCoveredPaths: ['b/x'] });

    expect(calls.every(readOnly)).toBe(true);
    expect(downloads(calls)).toHaveLength(1);
    expect(downloads(idCalls)).toHaveLength(0); // artifact-id mode read the local archive instead
  });

  it('preserves immediate name discovery without wait flags', async () => {
    const calls: Call[] = [];
    const args = without(without(nameArgs(), '--await-ms'), '--poll-ms');
    const result = await run(args, { gh: fakeGh({}, calls), sleep: async () => { throw new Error('unexpected sleep'); } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).summary).toEqual({ reuse: 1, rerun: 1 });
    expect(downloads(calls)).toHaveLength(1);
    expect(calls.every(readOnly)).toBe(true);
  });

  it('binds an already-present artifact on the first observation with no sleep', async () => {
    const calls: Call[] = [];
    const { code, out: o } = await run(nameArgs(), {
      gh: fakeGh({ attempts: [ok(JSON.stringify(attemptMeta('completed')))] }, calls),
      sleep: async () => { throw new Error('sleep must not run'); },
      now: virtualClock().now,
    });
    expect(code).toBe(0);
    expect(JSON.parse(o).summary).toEqual({ reuse: 1, rerun: 1 });
    expect(calls.every(readOnly)).toBe(true);
  });

  it('ends unavailable on a completed attempt with no artifact, without a plan or retry', async () => {
    const calls: Call[] = [];
    const { code, out: o, err: e } = await run(nameArgs(), {
      gh: fakeGh({ attempts: [ok(JSON.stringify(attemptMeta('completed')))], listings: [ok(JSON.stringify(emptyPage))] }, calls),
      now: virtualClock().now, sleep: async () => { throw new Error('sleep must not run'); },
    });
    expect(code).toBe(1);
    expect(o).toBe('');
    expect(e).toContain('completed with no artifact');
    expect(downloads(calls)).toHaveLength(0);
    expect(calls.filter((c) => c.args.includes(`repos/${REPO}/actions/runs/${RUN}/attempts/${ATTEMPT}`))).toHaveLength(1);
    expect(calls.every(readOnly)).toBe(true);
  });

  it('times out with no plan while the attempt stays pending', async () => {
    const calls: Call[] = [];
    const clock = virtualClock();
    const { code, out: o, err: e } = await run(
      [...base(), '--artifact-name', NAME, '--await-ms', '1000', '--poll-ms', '250', ...tail(), '--json'],
      { gh: fakeGh({ attempts: [ok(JSON.stringify(attemptMeta('in_progress')))], listings: [ok(JSON.stringify(emptyPage))] }, calls),
        now: clock.now, sleep: clock.sleep });
    expect(code).toBe(1);
    expect(o).toBe('');
    expect(e).toContain('timed out');
    expect(clock.sleeps).toEqual([250, 250, 250, 250]);
    expect(downloads(calls)).toHaveLength(0);
  });

  it('aborts before any remote read and prints no plan', async () => {
    const controller = new AbortController(); controller.abort();
    const calls: Call[] = [];
    const { code, out: o } = await run(nameArgs(), { gh: fakeGh({}, calls), now: virtualClock().now, signal: controller.signal });
    expect(code).toBe(1);
    expect(o).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('rejects mixed, missing, duplicate and out-of-bound flags with exit 2 and zero remote calls', async () => {
    const invalid: string[][] = [
      [...nameArgs(), '--artifact-id', String(ART)], // both acquisition modes
      [...idArgs(), '--artifact-name', NAME], // both modes, id listed first
      without(nameArgs(), '--await-ms'), // poll requires a wait bound
      [...idArgs(), '--await-ms', '1000'], // wait bound on the artifact-id mode
      [...idArgs(), '--poll-ms', '1000'],
      [...nameArgs(), '--archive', zipPath], // local archive has no meaning while waiting
      without(idArgs(), '--artifact-id'), // neither acquisition mode
      [...nameArgs(), '--await-ms', '5'], // duplicate wait bound
      [...nameArgs(), '--artifact-name', NAME], // duplicate name
      [...nameArgs(), '--json'], // duplicate --json
      [...base(), '--artifact-name', NAME, '--await-ms', '0', ...tail(), '--json'],
      [...base(), '--artifact-name', NAME, '--await-ms', 'soon', ...tail(), '--json'],
      [...base(), '--artifact-name', NAME, '--await-ms', '3600001', ...tail(), '--json'], // one-hour bound
      [...base(), '--artifact-name', NAME, '--await-ms', '1000', '--poll-ms', '0', ...tail(), '--json'],
      [...base(), '--artifact-name', NAME, '--await-ms', '1000', '--poll-ms', '100', ...tail(), '--json'], // below the floor
      [...base(), '--artifact-name', NAME, '--await-ms', '1000', '--poll-ms', '3600001', ...tail(), '--json'],
      [...base(), '--artifact-name', '-flag', '--await-ms', '1000', ...tail(), '--json'],
      [...base(), '--artifact-name', 'bad\nname', '--await-ms', '1000', ...tail(), '--json'],
    ];
    for (const args of invalid) {
      const calls: Call[] = [];
      const noManifest = args.map((arg) => arg === manifestPath ? join(scratch, 'missing.json') : arg);
      const { code, out: o, err: e } = await run(noManifest, { gh: fakeGh({}, calls), now: virtualClock().now, sleep: async () => {} });
      expect(code).toBe(2);
      expect(o).toBe('');
      expect(e).toContain('usage: ashlr fleet ci-resume-plan');
      expect(e).not.toContain('manifest file cannot be read');
      expect(calls).toHaveLength(0);
    }
  });

  it('validates the manifest before any wait or remote call', async () => {
    writeFileSync(manifestPath, '{');
    const calls: Call[] = [];
    const sleeps: number[] = [];
    const { code, out: o } = await run(nameArgs(), { gh: fakeGh({}, calls), now: virtualClock().now, sleep: async (ms) => { sleeps.push(ms); } });
    expect(code).toBe(1);
    expect(o).toBe('');
    expect(calls).toHaveLength(0);
    expect(sleeps).toHaveLength(0);
  });
});

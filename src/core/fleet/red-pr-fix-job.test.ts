/**
 * red-pr-fix-job.test.ts — the red-PR fix join: selection guards, id shape,
 * body contract (validateDropJob, Supersedes marker, secret redaction, the
 * 8 KB cap) and the write-once behaviour of runRedPrFix. Hermetic: a fake
 * argv-only gh plus a fresh mkdtemp runs dir; nothing touches HOME or GitHub.
 */
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Gh } from '../autopilot/github.js';
import type { CiRunFactsV1 } from './ci-run-facts.js';
import {
  composeDropJobFile,
  DROP_JOB_ID,
  DROP_JOB_MAX_FILE_BYTES,
  DROP_JOB_QUEUE_LIMIT,
  validateDropJob,
} from './drop-job-writer.js';
import {
  fixJobId,
  renderRedPrFixJob,
  runRedPrFix,
  selectRedFleetPrs,
  type RedPrCandidate,
} from './red-pr-fix-job.js';

const REPO = 'ashlrai/phantom';
const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-11-01T12:00:00Z');
const RUN = 91011;
const JOB = 424242;
const PR = 2563;
const JOB_ID = 'RQ-PHX-REDPRFIXJOB01';
const FIX_ID = 'REDPRFIXJOB01FIX1';

type PrRow = { number: number; title: string; headRefOid: string; mergeable: string; isDraft: boolean };
type RecentRow = CiRunFactsV1['recent'][number];

const prRow = (over: Record<string, unknown> = {}): PrRow => ({
  number: PR, title: `bridge: ${JOB_ID}`, headRefOid: SHA, mergeable: 'MERGEABLE', isDraft: false, ...over,
} as PrRow);

const recentRow = (over: Record<string, unknown> = {}): RecentRow => ({
  runId: RUN, workflow: 'CI', event: 'pull_request', headBranch: 'codex-bridge/x', prNumber: PR,
  conclusion: 'failure', status: 'completed', failureClass: 'code',
  createdAt: '2026-11-01T10:00:00Z', url: '', ...over,
} as RecentRow);

const facts = (recent: CiRunFactsV1['recent']): CiRunFactsV1 => ({
  v: 1, generatedAt: new Date(NOW).toISOString(), repo: REPO, windowHours: 24, available: true, reason: null,
  total: recent.length,
  byEvent: { pull_request: recent.length, push: 0, schedule: 0, merge_group: 0, workflow_dispatch: 0, other: 0 },
  byWorkflow: [], failures: { total: 0, bindArtifact: 0, code: 0, unclassified: 0 }, daily: null, recent,
});

// ---------------------------------------------------------------------------
// selectRedFleetPrs
// ---------------------------------------------------------------------------

describe('selectRedFleetPrs', () => {
  it('selects a MERGEABLE bridge PR whose newest run is a completed code failure', () => {
    expect(selectRedFleetPrs([prRow()], facts([recentRow()]))).toEqual([
      { number: PR, title: `bridge: ${JOB_ID}`, jobId: JOB_ID, headSha: SHA, runId: RUN },
    ]);
  });

  it.each([
    ['bind-artifact failure', prRow(), recentRow({ failureClass: 'bind-artifact' })],
    ['unclassified failure', prRow(), recentRow({ failureClass: null })],
    ['DIRTY PR', prRow({ mergeable: 'CONFLICTING' }), recentRow()],
    ['unknown mergeability', prRow({ mergeable: 'UNKNOWN' }), recentRow()],
    ['draft PR', prRow({ isDraft: true }), recentRow()],
    ['non-bridge title', prRow({ title: 'fix the thing' }), recentRow()],
    ['bridge title with suffix', prRow({ title: `bridge: ${JOB_ID} v2` }), recentRow()],
    ['in-progress newest run', prRow(), recentRow({ status: 'in_progress', conclusion: null, failureClass: null })],
    ['queued newest run', prRow(), recentRow({ status: 'queued', conclusion: null, failureClass: null })],
    ['green newest run', prRow(), recentRow({ conclusion: 'success', failureClass: null })],
    ['run of another PR', prRow(), recentRow({ prNumber: 99 })],
    ['no run at all', prRow(), null],
  ])('excludes %s', (_name, pr, recent) => {
    const rows = recent === null ? [] : [recent];
    expect(selectRedFleetPrs([pr], facts(rows))).toEqual([]);
  });

  it('judges the newest row only: in-progress newest beats an older failure', () => {
    const rows = [
      recentRow({ runId: RUN + 1, status: 'in_progress', conclusion: null, failureClass: null }),
      recentRow(),
    ];
    expect(selectRedFleetPrs([prRow()], facts(rows))).toEqual([]);
    expect(selectRedFleetPrs([prRow()], facts([recentRow(), rows[0]!]))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// fixJobId
// ---------------------------------------------------------------------------

describe('fixJobId', () => {
  it('strips the prefix and appends the attempt', () => {
    expect(fixJobId('RQ-PHX-UNIONPREVIEWFIX02', 1)).toBe('UNIONPREVIEWFIX02FIX1');
    expect(fixJobId('RQ-PHX-UNIONPREVIEWFIX02', 5)).toBe('UNIONPREVIEWFIX02FIX5');
  });

  it('caps the stem at 34 chars and always satisfies DROP_JOB_ID', () => {
    const id = fixJobId(`RQ-PHX-${'A'.repeat(50)}`, 3);
    expect(id).toBe(`${'A'.repeat(34)}FIX3`);
    for (const attempt of [1, 2, 3, 4, 5]) expect(fixJobId('RQ-PHX-REDPRFIXJOB01', attempt)).toMatch(DROP_JOB_ID);
  });
});

// ---------------------------------------------------------------------------
// renderRedPrFixJob
// ---------------------------------------------------------------------------

const candidate = (over: Partial<RedPrCandidate> = {}): RedPrCandidate => ({
  number: PR, title: `bridge: ${JOB_ID}`, jobId: JOB_ID, headSha: SHA, runId: RUN,
  failedSteps: ['Quick typecheck'], excerpts: ["src/core/fleet/x.ts(1,1): error TS2304: Cannot find name 'x'."],
  ...over,
});

describe('renderRedPrFixJob', () => {
  const valid = (body: string) => validateDropJob({ id: FIX_ID, lane: 'codex-personal', tier: 'work', body });

  it('passes validateDropJob and carries the fix contract', () => {
    const body = renderRedPrFixJob(candidate(), FIX_ID);
    expect(valid(body)).toEqual({ ok: true });
    expect(body).toContain(`Fix the real CI failure in ashlrai/phantom PR #${PR} (job ${JOB_ID}), head ${SHA}`);
    expect(body).toContain(`git fetch origin pull/${PR}/head`);
    expect(body).toContain(`Observed run: ${RUN}`);
    expect(body).toContain('- Quick typecheck');
    expect(body).toContain('error TS2304');
    expect(body).toContain(`Supersedes #${PR}`);
    expect(body).toContain('npx tsc --noEmit -p tsconfig.json');
    expect(body).toContain('uncommitted');
    for (const denied of ['.github/', 'auth.json', 'CODEOWNERS', '/.codex']) {
      expect(body).not.toContain(denied);
    }
  });

  it('redacts a planted secret-shaped token from excerpts', () => {
    const fake = 'FAKE4fakeTOKEN1234567890ab'; // 26-char token run, obviously fake
    const body = renderRedPrFixJob(candidate({ excerpts: [`error: leaked ${fake} here`] }), FIX_ID);
    expect(body).not.toContain(fake);
    expect(body).toContain('[REDACTED]');
    expect(valid(body)).toEqual({ ok: true });
  });

  it('replaces a denied-token title with (unavailable)', () => {
    const body = renderRedPrFixJob(candidate({ title: `bridge: ${JOB_ID} auth.json` }), FIX_ID);
    expect(body).toContain('(unavailable)');
    expect(body).not.toContain('auth.json');
    expect(valid(body)).toEqual({ ok: true });
  });

  it('bounds excerpts to 12 lines of 200 chars and stays under the file cap', () => {
    const excerpts = Array.from({ length: 50 }, (_, i) => `error ${i}: ${'x'.repeat(380)}`);
    const body = renderRedPrFixJob(candidate({ excerpts }), FIX_ID);
    const excerptLines = body.split('\n').filter((line) => line.startsWith('- error '));
    expect(excerptLines).toHaveLength(12);
    for (const line of excerptLines) expect(line.length).toBeLessThanOrEqual(202);
    expect(valid(body)).toEqual({ ok: true });
    expect(Buffer.byteLength(composeDropJobFile({ lane: 'codex-personal', tier: 'work', body }), 'utf8'))
      .toBeLessThanOrEqual(DROP_JOB_MAX_FILE_BYTES);
  });

  it('drops excerpts and step names until a pathological report still fits', () => {
    const body = renderRedPrFixJob(candidate({
      failedSteps: Array.from({ length: 20 }, (_, i) => `step${i}-${'y'.repeat(190)}`),
      excerpts: Array.from({ length: 20 }, (_, i) => `e${i}${'z'.repeat(199)}`),
    }), FIX_ID);
    expect(valid(body)).toEqual({ ok: true });
    expect(Buffer.byteLength(composeDropJobFile({ lane: 'codex-personal', tier: 'work', body }), 'utf8'))
      .toBeLessThanOrEqual(DROP_JOB_MAX_FILE_BYTES);
  });
});

// ---------------------------------------------------------------------------
// runRedPrFix
// ---------------------------------------------------------------------------

const apiRun = () => ({
  id: RUN, name: 'CI', event: 'pull_request', head_branch: 'codex-bridge/x',
  pull_requests: [{ number: PR }], status: 'completed', conclusion: 'failure',
  created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:30:00Z',
  html_url: `https://github.com/${REPO}/actions/runs/${RUN}`,
});

const apiJob = () => ({
  id: JOB, name: 'Quick typecheck', status: 'completed', conclusion: 'failure',
  html_url: `https://github.com/${REPO}/actions/runs/${RUN}/job/${JOB}`,
  steps: [{ name: 'Install', conclusion: 'success' }, { name: 'Quick typecheck', conclusion: 'failure' }],
});

const evidenceJob = () => ({
  id: JOB, run_id: RUN, name: 'Quick typecheck', head_sha: SHA, conclusion: 'failure',
  steps: [{ name: 'Install', conclusion: 'success' }, { name: 'Quick typecheck', conclusion: 'failure' }],
});

function fakeGh(prs: unknown[] = [prRow()]): Gh {
  return vi.fn(async (args: string[]) => {
    const last = args[args.length - 1]!;
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
    if (last.startsWith(`repos/${REPO}/actions/runs?`)) return JSON.stringify({ workflow_runs: [apiRun()] });
    if (last === `repos/${REPO}/actions/runs/${RUN}/jobs?per_page=100&page=1`) return JSON.stringify({ jobs: [apiJob()] });
    if (last === `repos/${REPO}/actions/runs/${RUN}/jobs?per_page=100`) return JSON.stringify({ jobs: [apiJob()] });
    if (last === `repos/${REPO}/actions/runs/${RUN}/jobs?filter=all&per_page=100`) {
      return JSON.stringify([{ total_count: 1, jobs: [evidenceJob()] }]);
    }
    if (last === `repos/${REPO}/actions/jobs/${JOB}/logs`) {
      return "src/core/fleet/x.ts(1,1): error TS2304: Cannot find name 'x'.\n";
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  });
}

let runsDir: string;
beforeEach(async () => { runsDir = await realpath(await mkdtemp(join(tmpdir(), 'redfix-'))); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

const dropDir = () => join(runsDir, 'leader', 'drop', 'claude');
const runOpts = (write: boolean, gh: Gh = fakeGh()) => ({ repo: REPO, hours: 24, write, runsDir, gh, now: () => NOW });

describe('runRedPrFix', () => {
  it('writes RQ-PHX-<fixId>.md once, then reports already-dropped', async () => {
    const first = await runRedPrFix(runOpts(true));
    expect(first.reason).toBeNull();
    expect(first.candidates).toEqual([
      { number: PR, jobId: JOB_ID, headSha: SHA, fixId: FIX_ID, written: true, skipped: null },
    ]);
    const file = join(dropDir(), `RQ-PHX-${FIX_ID}.md`);
    const content = await readFile(file, 'utf8');
    expect(content).toContain('#job repo=phantom lane=codex-personal tier=work');
    expect(content).toContain(`Observed run: ${RUN}`);
    expect(content).toContain(`Supersedes #${PR}`);
    expect(content).toContain(`PR #${PR} (job ${JOB_ID})`);

    const second = await runRedPrFix(runOpts(true));
    expect(second.candidates).toEqual([
      { number: PR, jobId: JOB_ID, headSha: SHA, fixId: FIX_ID, written: false, skipped: 'already-dropped' },
    ]);
    expect(await readdir(dropDir())).toEqual([`RQ-PHX-${FIX_ID}.md`]);
  });

  it('dry run reads everything and writes nothing', async () => {
    const report = await runRedPrFix(runOpts(false));
    expect(report.candidates).toEqual([
      { number: PR, jobId: JOB_ID, headSha: SHA, fixId: FIX_ID, written: false, skipped: null },
    ]);
    expect(await readdir(runsDir)).toEqual([]);
  });

  it('skips a non-code newest run without touching gh evidence', async () => {
    const greenRun = { ...apiRun(), conclusion: 'success' };
    const gh = vi.fn(async (args: string[]) => {
      const last = args[args.length - 1]!;
      if (args[0] === 'pr') return JSON.stringify([prRow()]);
      if (last.startsWith(`repos/${REPO}/actions/runs?`)) return JSON.stringify({ workflow_runs: [greenRun] });
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });
    const report = await runRedPrFix(runOpts(true, gh));
    expect(report.candidates).toEqual([]);
    expect(report.reason).toBeNull();
    expect(gh).toHaveBeenCalledTimes(1 + 1); // pr list + one runs page; no jobs, no evidence
  });

  it('skips attempts-exhausted when all five fix ids exist', async () => {
    await mkdir(dropDir(), { recursive: true });
    for (let i = 1; i <= 5; i++) {
      await writeFile(join(dropDir(), `RQ-PHX-REDPRFIXJOB01FIX${i}.md`), '#job repo=phantom lane=codex-personal tier=work\n\nolder run\n');
    }
    const report = await runRedPrFix(runOpts(true));
    expect(report.candidates[0]).toMatchObject({ fixId: 'REDPRFIXJOB01FIX5', written: false, skipped: 'attempts-exhausted' });
  });

  it('moves to the next free attempt when an older run was fixed', async () => {
    await mkdir(dropDir(), { recursive: true });
    await writeFile(join(dropDir(), `RQ-PHX-${FIX_ID}.md`), '#job repo=phantom lane=codex-personal tier=work\n\nObserved run: 1\n');
    const report = await runRedPrFix(runOpts(true));
    expect(report.candidates[0]).toMatchObject({ fixId: 'REDPRFIXJOB01FIX2', written: true });
    await expect(readFile(join(dropDir(), 'RQ-PHX-REDPRFIXJOB01FIX2.md'), 'utf8')).resolves.toContain(`Observed run: ${RUN}`);
  });

  it('marks candidates queue-full instead of writing past the queue limit', async () => {
    const prompts = join(runsDir, 'queue', 'prompts');
    await mkdir(prompts, { recursive: true });
    for (let i = 0; i < DROP_JOB_QUEUE_LIMIT; i++) {
      await writeFile(join(prompts, `RQ-PHX-QUEUE${String(i).padStart(2, '0')}.md`), 'x');
    }
    const report = await runRedPrFix(runOpts(true));
    expect(report.queueFull).toBe(true);
    expect(report.candidates[0]).toMatchObject({ fixId: FIX_ID, written: false, skipped: 'queue-full' });
  });

  it('never throws: a failing gh yields empty candidates with a reason', async () => {
    const gh: Gh = async () => { throw new Error('gh offline'); };
    const report = await runRedPrFix(runOpts(true, gh));
    expect(report.candidates).toEqual([]);
    expect(report.reason).toBe('open PR list unavailable');
  });

  it('never throws: malformed gh output yields empty candidates with a reason', async () => {
    const gh: Gh = async () => 'not json';
    const report = await runRedPrFix(runOpts(true, gh));
    expect(report.candidates).toEqual([]);
    expect(report.reason).toBe('open PR list unavailable');
  });
});

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdJobsStranded } from '../src/cli/jobs-stranded.js';
import { planStrandedRequeue, requeueText } from '../src/core/fleet/stranded-requeue.js';
import { readLandedFromGit } from '../src/core/fleet/landed-from-git.js';
import { hooksFromPlannerReport } from '../src/core/fleet/self-tick-hooks.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const fast = { verifyMs: 0, sleep: async () => {} };

async function setup(files: Record<string, string>, ready = '') {
  const dir = await mkdtemp(join(tmpdir(), 'requeue-')); dirs.push(dir);
  await mkdir(join(dir, 'queue', 'prompts'), { recursive: true });
  for (const [job, fixture] of Object.entries(files)) {
    const log = await readFile(`test/fixtures/stranded/${fixture}.publish`, 'utf8');
    await writeFile(join(dir, `${job}.publish`), log.replace(/RQ-RESULT/g, job));
  }
  await writeFile(join(dir, 'queue', 'ready.tsv'), ready);
  await writeFile(join(dir, 'queue', 'prompts', 'RQ-RESULT.md'), 'Fix the parser.\n');
  return dir;
}
const readyOf = (dir: string) => readFile(join(dir, 'queue', 'ready.tsv'), 'utf8');

it('dry run plans one R2 row and writes nothing', async () => {
  const dir = await setup({ 'RQ-RESULT': 'result-abort' });
  const plan = await planStrandedRequeue(dir, { ready: fast });
  expect(plan).toMatchObject({ schema: 'jobs.stranded.requeue.v1', apply: false, status: 'ok', summary: 'would_requeue=1 gave_up=0 already=0' });
  expect(plan.requeued.map(r => r.id)).toEqual(['RQ-RESULTR2']);
  expect(await readyOf(dir)).toBe('');
  expect(await readdir(join(dir, 'queue', 'prompts'))).toEqual(['RQ-RESULT.md']);
});

it('apply writes the prompt and a tab-separated row; a second run is a no-op', async () => {
  const dir = await setup({ 'RQ-RESULT': 'result-abort' }, 'RQ-OLD\tphantom\tcodex\twork\t/x/old.md\n');
  const first = await planStrandedRequeue(dir, { apply: true, ready: fast });
  expect(first.summary).toBe('requeued=1 gave_up=0 already=0');
  const prompt = join(dir, 'queue', 'prompts', 'RQ-RESULTR2.md');
  expect(await readyOf(dir)).toBe(`RQ-OLD\tphantom\tcodex\twork\t/x/old.md\nRQ-RESULTR2\tphantom\tclaude\twork\t${prompt}\n`);
  const text = await readFile(prompt, 'utf8');
  expect(text).toContain('Step R');
  expect(text).toContain('codex-bridge/RQ-RESULT');
  expect(text).toContain('Fix the parser.');
  const second = await planStrandedRequeue(dir, { apply: true, ready: fast });
  expect(second).toMatchObject({ requeued: [], summary: 'requeued=0 gave_up=0 already=1' });
  expect((await readyOf(dir)).split('\n').filter(Boolean)).toHaveLength(2);
});

it('skips a job whose PR was created later, and a recovery that is queued', async () => {
  const dir = await setup({ 'RQ-FIXED': 'recovered', 'RQ-RESULT': 'result-abort' }, `RQ-RESULTR2\tphantom\tclaude\twork\t/x/p.md\n`);
  const plan = await planStrandedRequeue(dir, { ready: fast });
  expect(plan.requeued).toEqual([]);
  expect(plan.already.map(a => a.job)).toEqual(['RQ-RESULT']);
});

it('reports gave up when the R3 try is spent', async () => {
  const dir = await setup({ 'RQ-RESULT': 'result-abort', 'RQ-RESULTR2': 'result-abort', 'RQ-RESULTR3': 'result-abort' });
  const plan = await planStrandedRequeue(dir, { apply: true, ready: fast });
  expect(plan.gaveUp).toEqual([{ job: 'RQ-RESULT', tries: 3 }]);
  expect(plan.requeued).toEqual([]);
  expect(requeueText(plan)[0]).toBe('requeued=0 gave_up=1 already=0');
});

it('a stranded R2 gets R3, not a second R2', async () => {
  const dir = await setup({ 'RQ-RESULT': 'result-abort', 'RQ-RESULTR2': 'result-abort' });
  const plan = await planStrandedRequeue(dir, { ready: fast });
  expect(plan.requeued.map(r => r.id)).toEqual(['RQ-RESULTR3']);
});

it('lists a non-fetch abort with its reason and never requeues it', async () => {
  const dir = await setup({ 'RQ-SECRET': 'result-abort' });
  const log = (await readFile(join(dir, 'RQ-SECRET.publish'), 'utf8')).replace(/RQ-RESULT/g, 'RQ-SECRET').replace('default-fetch', 'abort_secret_shape');
  await writeFile(join(dir, 'RQ-SECRET.publish'), log);
  const plan = await planStrandedRequeue(dir, { apply: true, ready: fast });
  expect(plan.notRequeued).toEqual([{ job: 'RQ-SECRET', reason: 'abort_secret_shape' }]);
  expect(plan.requeued).toEqual([]);
  expect(await readyOf(dir)).toBe('');
  expect(requeueText(plan).join('\n')).toContain('abort reason abort_secret_shape');
});

it('caps rows per run and defers the rest', async () => {
  const dir = await setup({ 'RQ-A': 'result-abort', 'RQ-B': 'result-abort', 'RQ-C': 'result-abort' });
  const plan = await planStrandedRequeue(dir, { apply: true, limit: 2, ready: fast });
  expect(plan.requeued).toHaveLength(2);
  expect(plan.deferred.map(d => d.job)).toEqual(['RQ-C']);
});

it('reports a branch already recovered under another id, with the recovering job', async () => {
  const dir = await setup({ 'RQ-BURNPACEN22QQ8': 'result-abort' }, 'RQ-BURNPACER2N22SQ8\tphantom\tclaude\twork\t/x/none.md\n');
  const plan = await planStrandedRequeue(dir, { apply: true, ready: fast });
  expect(plan.requeued).toEqual([]);
  expect(plan.already).toEqual([{ job: 'RQ-BURNPACEN22QQ8', why: 'RQ-BURNPACER2N22SQ8 already recovers this branch', by: 'RQ-BURNPACER2N22SQ8' }]);
  expect(await readyOf(dir)).toBe('RQ-BURNPACER2N22SQ8\tphantom\tclaude\twork\t/x/none.md\n');
});

it('reports a recovery found by its prompt text or the branch name', async () => {
  const dir = await setup({ 'RQ-ONE': 'result-abort', 'RQ-TWO': 'result-abort' });
  await writeFile(join(dir, 'queue', 'prompts', 'p.md'), '# RQ-NEWX: recover finished job RQ-ONE\n');
  await writeFile(join(dir, 'queue', 'ready.tsv'), `RQ-NEWX\tphantom\tclaude\twork\t${join(dir, 'queue', 'prompts', 'p.md')}\n`);
  await writeFile(join(dir, 'queue', 'router-queue.md'), '- RQ-NEWY: finish codex-bridge/RQ-TWO please\n');
  const plan = await planStrandedRequeue(dir, { ready: fast });
  expect(plan.requeued).toEqual([]);
  expect(plan.already.map(a => [a.job, a.by])).toEqual([['RQ-ONE', 'RQ-NEWX'], ['RQ-TWO', 'RQ-NEWY']]);
});

it('never puts gh work on a lane without gh', async () => {
  const dir = await setup({ 'FIXUP-CI-ONE': 'result-abort', 'RQ-PLAIN': 'result-abort' });
  const none = await planStrandedRequeue(dir, { apply: true, ready: fast, ghSlots: async () => 0 });
  expect(none.requeued.map(r => [r.id, r.lane])).toEqual([['RQ-PLAINR2', 'claude']]);
  expect(none.deferred).toEqual([{ job: 'FIXUP-CI-ONE', why: 'needs gh; no gh lane free' }]);
  expect((await readyOf(dir)).split('\n').filter(l => l.startsWith('FIXUP'))).toEqual([]);
  const unknown = await planStrandedRequeue(dir, { ready: fast });
  expect(unknown.deferred.map(d => d.job)).toEqual(['FIXUP-CI-ONE']);
  const room = await planStrandedRequeue(dir, { apply: true, ready: fast, ghSlots: async () => 1 });
  expect(room.requeued.find(r => r.job === 'FIXUP-CI-ONE')).toMatchObject({ lane: 'codex-personal' });
  expect(await readyOf(dir)).toContain('FIXUP-CI-ONER2\tphantom\tcodex-personal\twork\t');
});

it('sends a job whose prompt calls gh to the gh lane only, and caps at three', async () => {
  const dir = await setup({ 'RQ-A': 'result-abort', 'RQ-B': 'result-abort', 'RQ-C': 'result-abort', 'RQ-D': 'result-abort' });
  await writeFile(join(dir, 'queue', 'prompts', 'RQ-A.md'), 'Run gh pr list and fix it.\n');
  const plan = await planStrandedRequeue(dir, { limit: 9, ready: fast, ghSlots: async () => 0 });
  expect(plan.requeued.map(r => r.job)).toEqual(['RQ-B', 'RQ-C', 'RQ-D']);
  expect(plan.deferred).toEqual([{ job: 'RQ-A', why: 'needs gh; no gh lane free' }]);
});

it('the CLI prints json with a schema id, plain text, and rejects --apply alone', async () => {
  const dir = await setup({ 'RQ-RESULT': 'result-abort' });
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdJobsStranded(['--requeue', '--json', '--runs-dir', dir], undefined, noGit)).toBe(0);
  expect(JSON.parse(out[0]!).schema).toBe('jobs.stranded.requeue.v1');
  expect(await cmdJobsStranded(['--requeue', '--runs-dir', dir], undefined, noGit)).toBe(0);
  expect(out[1]).toContain('would requeue RQ-RESULT as RQ-RESULTR2');
  expect(await cmdJobsStranded(['--apply', '--runs-dir', dir])).toBe(2);
});

it('the self-tick hook reads the requeue summary', () => {
  const hook = (p: unknown) => hooksFromPlannerReport(p).find(h => h.hook === 'stranded-requeue');
  expect(hook({ strandedRequeue: { requeued: [{}, {}], summary: 'requeued=2 gave_up=0 already=5' } })).toMatchObject({ state: 'ran', items: 2, note: 'requeued=2 gave_up=0 already=5' });
  expect(hook({ strandedRequeue: { error: 'boom' } })).toMatchObject({ state: 'failed' });
  expect(hook({})).toMatchObject({ state: 'not-recorded' });
});

const landedLog = (...subjects: string[]) => (args: string[]) => args[0] === 'log'
  ? subjects.map((m, i) => `${String(i).repeat(40)}\x1f2026-11-21T0${i}:00:00Z\x1f${m}\x1e\n`).join('') : '';
const gitSays = (...subjects: string[]) => () => readLandedFromGit({ git: landedLog(...subjects) });
const noGit = () => readLandedFromGit({ git: () => { throw new Error('offline'); } });

it('skips a job whose base id already landed, even when only its R2 id is on master', async () => {
  const dir = await setup({ 'RQ-RESULT': 'result-abort' });
  const plan = await planStrandedRequeue(dir, { ready: fast, landed: gitSays('bridge: RQ-RESULTR2 (#7)') });
  expect(plan.requeued).toEqual([]);
  expect(plan.alreadyLanded).toEqual([{ job: 'RQ-RESULT', landedAs: 'RQ-RESULTR2' }]);
  expect(plan.summary).toContain('already_landed=1');
  expect(requeueText(plan).join('\n')).toContain('already landed RQ-RESULT');
});

it('requeues when the landed commit is for another job', async () => {
  const dir = await setup({ 'RQ-RESULT': 'result-abort' });
  const plan = await planStrandedRequeue(dir, { ready: fast, landed: gitSays('bridge(RQ-OTHER): x (#8)') });
  expect(plan.requeued.map(r => r.id)).toEqual(['RQ-RESULTR2']);
  expect(plan.alreadyLanded).toEqual([]);
});

it('requeues a job mentioned only as superseded in a landed commit body', async () => {
  const dir = await setup({ 'RQ-RESULT': 'result-abort' });
  const git = (args: string[]) => landedLog(args.some(a => a.includes('%B'))
    ? 'bridge(RQ-OTHER): x (#8)\n\nSupersedes RQ-RESULT'
    : 'bridge(RQ-OTHER): x (#8)')(args);
  const plan = await planStrandedRequeue(dir, { ready: fast, landed: () => readLandedFromGit({ git }) });
  expect(plan.requeued.map(r => r.id)).toEqual(['RQ-RESULTR2']);
  expect(plan.alreadyLanded).toEqual([]);
});

it('skips a job that finished over 48 h ago and counts it as tooOld', async () => {
  const dir = await setup({ 'RQ-RESULT': 'result-abort' });
  const plan = await planStrandedRequeue(dir, { ready: fast, now: Date.now() + 72 * 3_600_000 });
  expect(plan.requeued).toEqual([]);
  expect(plan.tooOld).toHaveLength(1);
  expect(plan.tooOld[0]).toMatchObject({ job: 'RQ-RESULT' });
  expect(plan.summary).toContain('too_old=1');
});

it('a git failure is said plainly and the requeue goes on', async () => {
  const dir = await setup({ 'RQ-RESULT': 'result-abort' });
  const plan = await planStrandedRequeue(dir, { ready: fast, landed: noGit });
  expect(plan.requeued).toHaveLength(1);
  expect(plan.landedCheck).toContain('git could not read origin/master');
});

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdJobsStranded } from '../src/cli/jobs-stranded.js';
import { planStrandedRequeue, requeueText } from '../src/core/fleet/stranded-requeue.js';
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
  expect(plan.deferred).toEqual(['RQ-C']);
});

it('the CLI prints json with a schema id, plain text, and rejects --apply alone', async () => {
  const dir = await setup({ 'RQ-RESULT': 'result-abort' });
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdJobsStranded(['--requeue', '--json', '--runs-dir', dir])).toBe(0);
  expect(JSON.parse(out[0]!).schema).toBe('jobs.stranded.requeue.v1');
  expect(await cmdJobsStranded(['--requeue', '--runs-dir', dir])).toBe(0);
  expect(out[1]).toContain('would requeue RQ-RESULT as RQ-RESULTR2');
  expect(await cmdJobsStranded(['--apply', '--runs-dir', dir])).toBe(2);
});

it('the self-tick hook reads the requeue summary', () => {
  const hook = (p: unknown) => hooksFromPlannerReport(p).find(h => h.hook === 'stranded-requeue');
  expect(hook({ strandedRequeue: { requeued: [{}, {}], summary: 'requeued=2 gave_up=0 already=5' } })).toMatchObject({ state: 'ran', items: 2, note: 'requeued=2 gave_up=0 already=5' });
  expect(hook({ strandedRequeue: { error: 'boom' } })).toMatchObject({ state: 'failed' });
  expect(hook({})).toMatchObject({ state: 'not-recorded' });
});

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { formatWorkState, readJobWorkState, workStateOf } from '../src/core/fleet/job-work-state.js';

const job = 'RQ-FAKE-914';
const at = new Date('2026-11-20T10:00:00Z');
const tsv = `id\tstatus\tpool\trepo\n${job}\tREADY\tfake-lane\tphantom\n`;
const claimed = `- CLAIMED ${job} work\n`;
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

async function host(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'queue-honesty-'));
  dirs.push(root);
  await mkdir(join(root, 'queue', 'run'), { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    await writeFile(join(root, path), contents);
    await utimes(join(root, path), at, at);
  }
  return root;
}

it('reports a lane as queue context, including in the formatted reply', async () => {
  const result = await readJobWorkState(job, { runsDir: await host({ 'queue/ready.tsv': tsv }) });
  expect(result).toMatchObject({ state: 'RECEIVED', owner: null, source: 'queue/ready.tsv', as_of: at.toISOString() });
  expect(result.evidence.join(' ')).toContain('queue destination');
  expect(formatWorkState(result)).toContain('queued for lane fake-lane; lane is a queue destination');
});

it('reports a CLAIMED marker without owner and receipt evidence', async () => {
  const result = await readJobWorkState(job, { runsDir: await host({ 'queue/router-queue.md': claimed }) });
  expect(result).toMatchObject({ state: 'RECEIVED', owner: null, source: 'queue/router-queue.md', as_of: at.toISOString() });
  expect(formatWorkState(result)).toContain('named owner and durable claim/task receipt are not evidenced');
  expect(result.evidence.join(' ')).toContain('receipt');
});

it('keeps unrelated rows, READY-only, and absent jobs distinct', async () => {
  const runsDir = await host({ 'queue/ready.tsv': tsv, 'queue/router-queue.md': '- READY RQ-FAKE-915 work\n' });
  expect(await readJobWorkState('RQ-FAKE-915', { runsDir })).toMatchObject({ state: 'RECEIVED', owner: null, source: 'queue/router-queue.md' });
  const absent = await readJobWorkState('RQ-FAKE-916', { runsDir });
  expect(absent).toMatchObject({ state: 'UNKNOWN', owner: null, source: null, as_of: null });
  expect(formatWorkState(absent)).toContain('UNKNOWN');
});

it('retains launch, exit, and publish precedence over queue evidence', async () => {
  const queue = { 'queue/ready.tsv': tsv, 'queue/router-queue.md': claimed };
  const launch = { ...queue, [`queue/run/${job}.launches`]: 'launch\n' };
  expect(await readJobWorkState(job, { runsDir: await host(launch) })).toMatchObject({ state: 'RUNNING', source: `queue/run/${job}.launches` });
  const exit = { ...launch, [`queue/run/${job}.rc`]: '2\n' };
  expect(await readJobWorkState(job, { runsDir: await host(exit) })).toMatchObject({ state: 'BLOCKED', source: `queue/run/${job}.rc` });
  const url = 'https://github.com/example/fake/pull/1';
  const result = await readJobWorkState(job, { runsDir: await host({ ...exit, [`${job}.publish`]: `RESULT PR ${url}\n` }) });
  expect(result).toMatchObject({ state: 'VERIFIED', detail: url, source: `${job}.publish` });
  expect(formatWorkState(result)).toContain(url);
});

it('classifies both queue-only branches in the pure function', () => {
  const base = { job, publish: null, rc: null, launches: null, readyTsv: null, routerQueue: null };
  const seen = (text: string) => ({ text, mtimeMs: at.getTime() });
  expect(workStateOf({ ...base, readyTsv: seen(tsv) })).toMatchObject({ state: 'RECEIVED', owner: null, source: 'queue/ready.tsv' });
  expect(workStateOf({ ...base, routerQueue: seen(claimed) })).toMatchObject({ state: 'RECEIVED', owner: null, source: 'queue/router-queue.md' });
});

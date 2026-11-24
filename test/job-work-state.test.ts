import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatWorkState, readJobWorkState } from '../src/core/fleet/job-work-state.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

const AT = new Date('2026-11-20T10:00:00Z');
const JOB = 'RQ-DEMO-1';

async function host(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'work-state-'));
  dirs.push(root);
  await mkdir(join(root, 'queue', 'run'), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(root, name), text);
    await utimes(join(root, name), AT, AT);
  }
  return root;
}

describe('readJobWorkState', () => {
  it('READY alone is RECEIVED', async () => {
    const r = await readJobWorkState(JOB, { runsDir: await host({ 'queue/router-queue.md': `- READY ${JOB} fix the docs\n` }) });
    expect(r).toMatchObject({ state: 'RECEIVED', as_of: AT.toISOString(), source: 'queue/router-queue.md', owner: null });
  });
  it('a lane in ready.tsv is queue context, not an assignment', async () => {
    const tsv = `id\tstatus\tpool\trepo\n${JOB}\tREADY\tclaude\tphantom\n`;
    const r = await readJobWorkState(JOB, { runsDir: await host({ 'queue/router-queue.md': `- READY ${JOB} x\n`, 'queue/ready.tsv': tsv }) });
    expect(r).toMatchObject({ state: 'RECEIVED', owner: null, source: 'queue/ready.tsv' });
    expect(formatWorkState(r)).toBe(`${JOB}: RECEIVED - queued for lane claude; lane is a queue destination, not an assigned owner (as of ${AT.toISOString()}, source queue/ready.tsv)`);
  });
  it('launched with no exit code is RUNNING', async () => {
    const r = await readJobWorkState(JOB, { runsDir: await host({ [`queue/run/${JOB}.launches`]: 'launch 1\n' }) });
    expect(r).toMatchObject({ state: 'RUNNING', source: `queue/run/${JOB}.launches` });
  });
  it('a non-zero exit code is BLOCKED with the code in words', async () => {
    const r = await readJobWorkState(JOB, { runsDir: await host({ [`queue/run/${JOB}.launches`]: 'x', [`queue/run/${JOB}.rc`]: '2\n' }) });
    expect(r).toMatchObject({ state: 'BLOCKED', detail: 'worker exited with code 2' });
  });
  it('an empty result with a reason is BLOCKED with that reason', async () => {
    const r = await readJobWorkState(JOB, { runsDir: await host({ [`${JOB}.publish`]: 'RESULT EMPTY: the change already landed\n' }) });
    expect(r).toMatchObject({ state: 'BLOCKED', detail: 'the change already landed' });
  });
  it('an empty result with no reason says so', async () => {
    const r = await readJobWorkState(JOB, { runsDir: await host({ [`${JOB}.publish`]: 'RESULT EMPTY\n' }) });
    expect(r).toMatchObject({ state: 'BLOCKED', detail: 'finished with no change and no reason recorded' });
  });
  it('a PR url is VERIFIED even when the exit code is zero', async () => {
    const url = 'https://github.com/ashlrai/phantom/pull/1';
    const r = await readJobWorkState(JOB, { runsDir: await host({ [`${JOB}.publish`]: `RESULT PR ${url}\n`, [`queue/run/${JOB}.rc`]: '0' }) });
    expect(r).toMatchObject({ state: 'VERIFIED', detail: url, source: `${JOB}.publish` });
  });
  it('an id no file names is UNKNOWN, never guessed', async () => {
    const r = await readJobWorkState('RQ-NOPE-9', { runsDir: await host({ 'queue/router-queue.md': `- READY ${JOB} x\n` }) });
    expect(r).toMatchObject({ state: 'UNKNOWN', as_of: null, source: null });
    expect(formatWorkState(r)).toContain('UNKNOWN');
  });
  it('rejects bad ids and relative folders', async () => {
    await expect(readJobWorkState('../x')).rejects.toThrow('invalid fleet job id');
    await expect(readJobWorkState(JOB, { runsDir: 'rel' })).rejects.toThrow('absolute');
  });
});

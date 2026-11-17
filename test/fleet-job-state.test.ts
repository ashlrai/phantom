import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { jobStateOf, parsePublishResult, readJobState } from '../src/core/fleet/job-state.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

const NOW = Date.parse('2026-11-17T12:00:00Z');
async function fixture(opts: { publish?: string; log?: boolean; logAgeS?: number; worktree?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'job-state-'));
  dirs.push(root);
  const wt = join(root, 'wt-JOB1');
  if (opts.worktree !== false) await mkdir(wt);
  await writeFile(join(root, 'JOB1.base'), `abc1234 branch ${wt} devin\n`);
  const old = new Date(NOW - 3600_000);
  await utimes(join(root, 'JOB1.base'), old, old);
  if (opts.publish !== undefined) await writeFile(join(root, 'JOB1.publish'), opts.publish);
  if (opts.log) {
    await writeFile(join(root, 'JOB1.log'), 'work\n');
    const at = new Date(NOW - (opts.logAgeS ?? 10) * 1000);
    await utimes(join(root, 'JOB1.log'), at, at);
  }
  return root;
}

describe('jobState', () => {
  it('local job with a fresh log is running', async () => {
    const s = await readJobState('JOB1', { runsDir: await fixture({ log: true }), now: () => NOW });
    expect(s.state).toBe('running');
    expect(s.version).toBe(1);
  });
  it('published cloud job (PR) is done with no log', async () => {
    const s = await readJobState('JOB1', { runsDir: await fixture({ publish: 'RESULT PR https://github.com/o/r/pull/9\n' }), now: () => NOW });
    expect(s).toMatchObject({ state: 'done', result: { kind: 'pr', url: 'https://github.com/o/r/pull/9' } });
  });
  it('empty cloud job is done', async () => {
    const s = await readJobState('JOB1', { runsDir: await fixture({ publish: 'TEST ok\nRESULT EMPTY\n' }), now: () => NOW });
    expect(s).toMatchObject({ state: 'done', result: { kind: 'empty' } });
  });
  it('cloud job still in flight is running', async () => {
    const s = await readJobState('JOB1', { runsDir: await fixture({}), now: () => NOW });
    expect(s.state).toBe('running');
    expect(s.evidence.join(' ')).toContain('no local log');
  });
  it('malformed publish record is unknown, not running', async () => {
    const s = await readJobState('JOB1', { runsDir: await fixture({ publish: 'RESULT PR\n' }), now: () => NOW });
    expect(s).toMatchObject({ state: 'unknown', result: null });
  });
  it('stale log is idle; a publish with no RESULT line yet keeps the old rules', async () => {
    expect((await readJobState('JOB1', { runsDir: await fixture({ log: true, logAgeS: 900 }), now: () => NOW })).state).toBe('idle');
    expect((await readJobState('JOB1', { runsDir: await fixture({ publish: 'TEST ok\n' }), now: () => NOW })).state).toBe('running');
  });
  it('gone worktree is idle; pure helper uses the last RESULT line', () => {
    expect(jobStateOf({ publish: null, hasBase: true, hasWorktree: false, logMtimeMs: null, baseMtimeMs: null, nowMs: NOW }).state).toBe('idle');
    expect(parsePublishResult('RESULT EMPTY\nRESULT PR https://github.com/o/r/pull/1').result).toEqual({ kind: 'pr', url: 'https://github.com/o/r/pull/1' });
  });
  it('rejects bad ids and relative runs dirs', async () => {
    await expect(readJobState('../x')).rejects.toThrow();
    await expect(readJobState('JOB1', { runsDir: 'rel' })).rejects.toThrow();
  });
});

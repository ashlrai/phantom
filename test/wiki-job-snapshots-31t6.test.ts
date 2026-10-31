import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildWikiOptions, BuildWikiResult } from '../src/core/knowledge/wiki/generate.js';
import type { WikiRunSummary } from '../src/core/knowledge/wiki/types.js';
import { __resetWikiJobsForTests, runningWikiJobs, startWikiJob, wikiJob, type WikiJob } from '../src/core/knowledge/wiki/jobs.js';

vi.mock('../src/core/knowledge/wiki/generate.js', () => ({ buildWiki: vi.fn() }));
import { buildWiki } from '../src/core/knowledge/wiki/generate.js';

const mockedBuild = vi.mocked(buildWiki);
const repo = '/fake/wiki-snapshot-repo';

function deferredBuild() {
  let resolve!: (result: BuildWikiResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<BuildWikiResult>((res, rej) => { resolve = res; reject = rej; });
  mockedBuild.mockReturnValueOnce(promise);
  return { resolve, reject };
}

function progress() {
  const options: BuildWikiOptions = mockedBuild.mock.calls[0]![0];
  options.onProgress!({ repo, index: 2, total: 5, page: 'overview', action: 'generated' });
}

const summary: WikiRunSummary = {
  startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z',
  generated: 3, skippedFresh: 1, deferred: 1, failed: 0, estimatedTokens: 42,
  engine: 'fake', budgetStop: 'pages', modelNote: 'fixture',
};

beforeEach(() => { __resetWikiJobsForTests(); mockedBuild.mockReset(); });
afterEach(() => { __resetWikiJobsForTests(); });

describe('wiki job snapshots', () => {
  it('detaches start, join and progress reads while retaining single-flight and limits', async () => {
    const build = deferredBuild();
    let settled!: () => void;
    const finished = new Promise<void>((resolve) => { settled = resolve; });
    const started = startWikiJob(repo, { onSettled: settled });
    if (!started.ok) throw new Error(started.reason);
    const key = started.job.key;
    started.job.progress.index = 99;
    started.job.state = 'failed';
    expect(wikiJob(key)).toMatchObject({ state: 'running', progress: { index: 0, total: 0, page: null } });

    progress();
    const joined = startWikiJob(repo);
    if (!joined.ok) throw new Error(joined.reason);
    expect(mockedBuild).toHaveBeenCalledTimes(1);
    expect(joined.job.progress).toEqual({ index: 2, total: 5, page: 'overview' });
    joined.job.progress.page = 'tampered';
    const read = wikiJob(key)!;
    read.progress.total = 100;
    expect(wikiJob(key)?.progress).toEqual({ index: 2, total: 5, page: 'overview' });
    expect(started.job.progress).toEqual({ index: 99, total: 0, page: null });

    const second = deferredBuild();
    let secondSettled!: () => void;
    const secondFinished = new Promise<void>((resolve) => { secondSettled = resolve; });
    expect(startWikiJob('/fake/second', { onSettled: secondSettled }).ok).toBe(true);
    expect(runningWikiJobs()).toBe(2);
    expect(startWikiJob('/fake/third')).toEqual({ ok: false, reason: 'Already building 2 wikis; try again when one finishes.' });
    expect(startWikiJob(repo).ok).toBe(true);
    expect(mockedBuild).toHaveBeenCalledTimes(2);
    build.resolve({ ok: false, reason: 'fixture failure' });
    second.resolve({ ok: false, reason: 'fixture failure' });
    await Promise.all([finished, secondFinished]);
    expect(runningWikiJobs()).toBe(0);
  });

  it('detaches successful summaries and progress from a mutating, throwing observer and later reads', async () => {
    const build = deferredBuild();
    let settled!: () => void;
    const finished = new Promise<void>((resolve) => { settled = resolve; });
    const observer = vi.fn((job: WikiJob) => {
      expect(job).toMatchObject({ state: 'done', progress: { index: 2, total: 5, page: 'overview' }, summary });
      job.progress.page = 'observer';
      job.summary!.generated = 999;
      job.state = 'failed';
      settled();
      throw new Error('observer failure');
    });
    const started = startWikiJob(repo, { onSettled: observer });
    if (!started.ok) throw new Error(started.reason);
    progress();
    build.resolve({ ok: true, summary: { ...summary }, manifest: {} as Extract<BuildWikiResult, { ok: true }>['manifest'] });
    await finished;
    expect(observer).toHaveBeenCalledOnce();
    const read = wikiJob(started.job.key)!;
    expect(read).toMatchObject({ state: 'done', progress: { index: 2, total: 5, page: 'overview' }, summary, error: null });
    expect(read.finishedAt).not.toBeNull();
    read.summary!.generated = 77;
    read.summary!.modelNote = 'changed';
    read.progress.index = 100;
    expect(wikiJob(started.job.key)).toMatchObject({ state: 'done', progress: { index: 2, total: 5, page: 'overview' }, summary });
  });

  it.each(['result', 'rejection'] as const)('preserves %s failure and detaches the observer', async (failure) => {
    const build = deferredBuild();
    let settled!: () => void;
    const finished = new Promise<void>((resolve) => { settled = resolve; });
    const observer = vi.fn((job: WikiJob) => {
      job.progress.page = 'observer';
      job.error = 'changed';
      settled();
    });
    const started = startWikiJob(repo, { trigger: 'auto', onSettled: observer });
    if (!started.ok) throw new Error(started.reason);
    progress();
    if (failure === 'result') build.resolve({ ok: false, reason: 'fixture failure' });
    else build.reject(new Error('private fixture error'));
    await finished;
    expect(observer).toHaveBeenCalledOnce();
    expect(wikiJob(started.job.key)).toMatchObject({
      state: 'failed', trigger: 'auto', summary: null,
      error: failure === 'result' ? 'fixture failure' : 'The wiki build failed.',
      progress: { index: 2, total: 5, page: 'overview' },
    });
    expect(runningWikiJobs()).toBe(0);
  });
});

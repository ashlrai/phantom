/**
 * jobs-outcome-events: the metrics/jobs.jsonl -> learner event bridge.
 * Real ledger rows fold into ASSIGN/OUTCOME lines; unknown usage stays
 * absent, pending work stays pending, and nothing is fabricated.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { foldJobsOutcomeEvents, readJobsOutcomeEvents } from '../src/core/fleet/jobs-outcome-events.js';
import { learnOutcomes, outcomeLearningView } from '../src/core/routing/outcome-learning.js';

const T0 = '2026-11-10T10:00:00Z';
const T1 = '2026-11-10T10:30:00Z';
const T2 = '2026-11-10T11:00:00Z';

function launch(job: string, lane: string, model: string, repo = 'phantom', ts = T0): string {
  return JSON.stringify({ event: 'launch', job, repo, lane, model, tier: 'work', ts });
}

function finish(job: string, tokens: number | null, ts = T1): string {
  return JSON.stringify({ event: 'finish', job, lane: 'claude', exit_code: 0, empty: false, tokens_total: tokens, ts });
}

function publish(job: string, url: string, ts = T1): string {
  return JSON.stringify({ event: 'publish', job, url, ts });
}

function outcome(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

function lines(text: string): Record<string, unknown>[] {
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
}

let home: string | undefined;
afterEach(() => { if (home !== undefined) rmSync(home, { recursive: true, force: true }); home = undefined; });

describe('foldJobsOutcomeEvents', () => {
  it('folds a merged job into assign + outcome with usage and minutes', () => {
    const jobs = [
      launch('RQ-PHX-1', 'claude', 'sonnet'),
      finish('RQ-PHX-1', 1200),
      publish('RQ-PHX-1', 'https://github.com/ashlrai/phantom/pull/9'),
      outcome({ event: 'outcome', job: 'RQ-PHX-1', state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/9', ts: T2, mergedAt: T2 }),
    ].join('\n');
    const folded = foldJobsOutcomeEvents(jobs);
    expect(folded.stats).toMatchObject({ jobs: 1, outcomes: 1, pending: 0, skipped: 0, malformed: 0 });
    const events = lines(folded.text);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: 'assign', job: 'RQ-PHX-1', repo: 'phantom', resource: 'claude', model: 'sonnet', jobType: 'PHX' });
    expect(events[1]).toMatchObject({ event: 'outcome', job: 'RQ-PHX-1', state: 'merged', usage: 1200, minutes: 60 });
    const view = outcomeLearningView(learnOutcomes(folded.text));
    expect(view.finished).toBe(1);
    const cell = view.cells[0]!;
    expect(cell).toMatchObject({ resource: 'claude', model: 'sonnet', jobType: 'PHX', repo: 'phantom', attempts: 1, merges: 1, goodMerges: 1, meanUsage: 1200 });
  });

  it('keeps a launched job with no terminal row pending', () => {
    const folded = foldJobsOutcomeEvents([launch('RQ-DVL-2', 'devin', 'swe-2-max'), finish('RQ-DVL-2', 300, T1)].join('\n'));
    expect(folded.stats).toMatchObject({ jobs: 1, outcomes: 0, pending: 1 });
    const events = lines(folded.text);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'assign', job: 'RQ-DVL-2', jobType: 'DVL' });
  });

  it('omits usage when no finish row reports tokens', () => {
    const jobs = [
      launch('RQ-BUS-3', 'codex', 'gpt-5.4'),
      JSON.stringify({ event: 'finish', job: 'RQ-BUS-3', exit_code: 0, empty: false, tokens_total: null, ts: T1 }),
      outcome({ event: 'outcome', job: 'RQ-BUS-3', state: 'CLOSED', ts: T2 }),
    ].join('\n');
    const folded = foldJobsOutcomeEvents(jobs);
    const events = lines(folded.text);
    expect(events[1]).toMatchObject({ event: 'outcome', state: 'closed' });
    expect(events[1]).not.toHaveProperty('usage');
    const view = outcomeLearningView(learnOutcomes(folded.text));
    expect(view.cells[0]).toMatchObject({ attempts: 1, merges: 0, usageSamples: 0, meanUsage: null });
  });

  it('attaches an outcome row to its job through an unambiguous PR url', () => {
    const jobs = [
      launch('RQ-REL-4', 'claude', 'haiku'),
      publish('RQ-REL-4', 'https://github.com/ashlrai/phantom/pull/11', T1),
      outcome({ state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/11', ts: T2, mergedAt: T2 }),
    ].join('\n');
    const folded = foldJobsOutcomeEvents(jobs);
    expect(folded.stats).toMatchObject({ jobs: 1, outcomes: 1 });
    expect(lines(folded.text)[1]).toMatchObject({ event: 'outcome', job: 'RQ-REL-4', state: 'merged' });
  });

  it('does not attach an outcome whose url is claimed by two jobs', () => {
    const jobs = [
      launch('RQ-PHX-5', 'claude', 'sonnet'),
      launch('RQ-PHX-6', 'devin', 'swe-2-max'),
      publish('RQ-PHX-5', 'https://github.com/ashlrai/phantom/pull/12', T1),
      publish('RQ-PHX-6', 'https://github.com/ashlrai/phantom/pull/12', T1),
      outcome({ state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/12', ts: T2 }),
    ].join('\n');
    const folded = foldJobsOutcomeEvents(jobs);
    expect(folded.stats).toMatchObject({ jobs: 2, outcomes: 0, pending: 2 });
  });

  it('lets a merged record win over a closed one for the same job', () => {
    const jobs = [
      launch('RQ-PHX-7', 'claude', 'sonnet'),
      outcome({ event: 'outcome', job: 'RQ-PHX-7', state: 'CLOSED', ts: T1 }),
      outcome({ event: 'outcome', job: 'RQ-PHX-7', state: 'MERGED', ts: T2, mergedAt: T2 }),
    ].join('\n');
    const folded = foldJobsOutcomeEvents(jobs);
    expect(lines(folded.text)[1]).toMatchObject({ state: 'merged' });
  });

  it('uses the newest launch when a job id ran more than once', () => {
    const jobs = [
      launch('RQ-PHX-8', 'claude', 'haiku', 'phantom', '2026-11-10T09:00:00Z'),
      launch('RQ-PHX-8', 'devin', 'swe-2-max', 'phantom', T0),
      finish('RQ-PHX-8', 50, '2026-11-10T09:30:00Z'),
      finish('RQ-PHX-8', 500, T1),
      outcome({ event: 'outcome', job: 'RQ-PHX-8', state: 'MERGED', ts: T2, mergedAt: T2 }),
    ].join('\n');
    const folded = foldJobsOutcomeEvents(jobs);
    const events = lines(folded.text);
    expect(events[0]).toMatchObject({ resource: 'devin', model: 'swe-2-max' });
    // Only the finish at/after the newest launch counts toward usage.
    expect(events[1]).toMatchObject({ usage: 500 });
  });

  it('skips batch bundle ids but keeps member jobs', () => {
    const jobs = [
      launch('RQ-BATCH-abc', 'claude', 'sonnet'),
      JSON.stringify({ event: 'batch_claim', job: 'RQ-PHX-9', batch: 'RQ-BATCH-abc', repo: 'phantom', lane: 'claude', tier: 'work', area: 'src', model: 'sonnet', ts: T0 }),
      outcome({ event: 'task_outcome', job: 'RQ-PHX-9', batch: 'RQ-BATCH-abc', outcome: 'done', model: 'sonnet', ts: T1 }),
      outcome({ event: 'outcome', job: 'RQ-PHX-9', state: 'MERGED', ts: T2, mergedAt: T2 }),
    ].join('\n');
    const folded = foldJobsOutcomeEvents(jobs);
    expect(folded.stats).toMatchObject({ jobs: 1, outcomes: 1, skipped: 1 });
    expect(lines(folded.text)[0]).toMatchObject({ job: 'RQ-PHX-9', resource: 'claude', jobType: 'PHX' });
  });

  it('falls back to work_class for jobType and sanitizes owner/repo slashes', () => {
    const jobs = [
      launch('JOB-1', 'claude', 'sonnet', 'ashlrai/phantom'),
      outcome({ event: 'outcome', job: 'JOB-1', state: 'MERGED', ts: T2 }),
    ].join('\n');
    const market = JSON.stringify({ schema: 'work-market.v1', event: 'route_decision', job: 'JOB-1', work_class: 'standard', ts: T0 });
    const folded = foldJobsOutcomeEvents(jobs, market);
    const events = lines(folded.text);
    expect(events[0]).toMatchObject({ repo: 'ashlrai.phantom', jobType: 'standard' });
  });

  it('counts malformed lines and ignores rows with no usable evidence', () => {
    const jobs = [
      '{bad json',
      JSON.stringify([1, 2, 3]),
      JSON.stringify({ event: 'enqueue', job: 'RQ-PHX-10', repo: 'phantom', lane: 'claude', tier: 'work', ts: T0 }),
      JSON.stringify({ event: 'claim', job: 'RQ-PHX-11', repo: 'phantom', lane: 'claude', tier: 'work', ts: T0 }),
      outcome({ event: 'outcome', state: 'MERGED', ts: T2 }),
    ].join('\n');
    const folded = foldJobsOutcomeEvents(jobs);
    // enqueue/claim carry no model, so both jobs drop for lack of assign
    // evidence; the url-less outcome attaches to nobody.
    expect(folded.stats).toMatchObject({ jobs: 0, outcomes: 0, pending: 0, skipped: 2, malformed: 2 });
    expect(folded.text).toBe('');
  });
});

describe('readJobsOutcomeEvents', () => {
  it('reports missing ledgers without throwing', async () => {
    home = mkdtempSync(join(tmpdir(), 'jobs-events-'));
    const read = await readJobsOutcomeEvents(home);
    expect(read).toMatchObject({ text: '', jobsState: 'missing', marketState: 'missing', truncated: false });
    expect(read.stats.jobs).toBe(0);
  });

  it('reads bounded tails from a runs dir', async () => {
    home = mkdtempSync(join(tmpdir(), 'jobs-events-'));
    mkdirSync(join(home, 'metrics'), { recursive: true });
    writeFileSync(join(home, 'metrics', 'jobs.jsonl'), [
      launch('RQ-PHX-20', 'claude', 'sonnet'),
      finish('RQ-PHX-20', 800),
      outcome({ event: 'outcome', job: 'RQ-PHX-20', state: 'MERGED', ts: T2, mergedAt: T2 }),
    ].join('\n'));
    const read = await readJobsOutcomeEvents(home);
    expect(read.jobsState).toBe('read');
    expect(read.stats).toMatchObject({ jobs: 1, outcomes: 1 });
    const view = outcomeLearningView(learnOutcomes(read.text));
    expect(view.finished).toBe(1);
    expect(view.cells[0]).toMatchObject({ resource: 'claude', jobType: 'PHX', meanUsage: 800 });
  });
});

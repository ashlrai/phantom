import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_TAGS, EMPTY_TAGS_SCHEMA, emptyDigestLine, formatEmptyTags, recordEmptyTags, summarizeEmptyTags, tagEmpty } from '../src/core/fleet/empty-tags.js';
import { readEmptyJobs } from '../src/core/fleet/empty-jobs.js';

const FIXTURES = {
  already_done: 'Checked master. The feature is already on master, so there is nothing to add.',
  pool_cap: "You've reached your Fable limit. Try again later.",
  blocked: 'Stopped: the tool is missing and permission denied for the shared folder.',
  no_change_needed: 'Reviewed the code. No change is needed here.',
  unknown: 'Done for now.',
} as const;

describe('tagEmpty', () => {
  for (const tag of EMPTY_TAGS) {
    it(`tags ${tag}`, () => expect(tagEmpty(FIXTURES[tag]).tag).toBe(tag));
  }
  it('a duplicate counts as already_done', () => expect(tagEmpty('This is a duplicate of an earlier job.').tag).toBe('already_done'));
  it('a missing log is unknown', () => expect(tagEmpty(null)).toEqual({ tag: 'unknown', sentence: null }));
  it('a limit outranks a no-change line', () => expect(tagEmpty('No change is needed.\nYou have reached your usage limit.').tag).toBe('pool_cap'));
});

describe('summary and digest line', () => {
  const jobs = [
    { id: 'a', lane: 'claude', tag: 'pool_cap' as const }, { id: 'b', lane: 'claude', tag: 'pool_cap' as const },
    { id: 'c', lane: 'zai', tag: 'already_done' as const },
  ];
  it('counts, lanes, one example per tag and the rate', () => {
    const report = summarizeEmptyTags(jobs, 10);
    expect(report).toMatchObject({ schema: EMPTY_TAGS_SCHEMA, finished: 10, empty: 3, rate: 0.3, top: 'pool_cap' });
    expect(report.counts.pool_cap).toBe(2);
    expect(report.examples.pool_cap?.id).toBe('b');
    expect(report.lanes[0]).toMatchObject({ lane: 'claude', empty: 2 });
  });
  it('names the top reason only above 15%', () => {
    expect(emptyDigestLine(summarizeEmptyTags(jobs, 10))).toContain('30% of jobs ended empty; top reason: model limit or quota');
    expect(emptyDigestLine(summarizeEmptyTags(jobs, 20))).toBeNull();
    expect(emptyDigestLine(summarizeEmptyTags([], 0))).toBeNull();
  });
  it('formats by reason and by lane', () => {
    const report = summarizeEmptyTags(jobs, 10);
    expect(formatEmptyTags(report, 'reason', 24)[1]).toContain('pool_cap: 2');
    expect(formatEmptyTags(report, 'lane', 24)[1]).toBe('claude: 2 empty; pool_cap 2');
    expect(formatEmptyTags(summarizeEmptyTags([], 0), 'lane', 24)).toEqual(['No empty jobs.']);
  });
});

describe('readEmptyJobs and recordEmptyTags', () => {
  it('tags each empty job from its log and stores the tag once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'empty-tags-'));
    await mkdir(join(root, 'metrics'));
    const now = Date.now();
    const row = (id: string, empty: boolean) => JSON.stringify({ event: 'finish', id, lane: 'claude', empty, ts: new Date(now - 60_000).toISOString() });
    await writeFile(join(root, 'metrics/jobs.jsonl'), [row('RQ-ONE', true), row('RQ-TWO', true), row('RQ-THREE', false)].join('\n') + '\n');
    await writeFile(join(root, 'RQ-ONE.log'), FIXTURES.pool_cap);
    await writeFile(join(root, 'RQ-TWO.log'), FIXTURES.unknown);
    const report = await readEmptyJobs(24, root, join(root, 'wt'), now);
    expect(report?.tags).toMatchObject({ schema: EMPTY_TAGS_SCHEMA, empty: 2, finished: 3, top: 'pool_cap' });
    expect(report?.tags?.counts).toMatchObject({ pool_cap: 1, unknown: 1 });
    expect(await recordEmptyTags(root, report!.tagged!)).toBe(2);
    expect(await recordEmptyTags(root, report!.tagged!)).toBe(0);
    const lines = (await readFile(join(root, 'metrics/empty-tags.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => l.tag).sort()).toEqual(['pool_cap', 'unknown']);
  });
});

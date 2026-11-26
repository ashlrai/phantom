/** Inert fixtures only. No provider calls, native profiles or credentials. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncEmptyTagsFromJobsLedger } from '../src/core/fleet/empty-tag-sync.js';

const NOW_MS = Date.parse('2026-10-28T20:00:00.000Z');
const NOW = () => new Date(NOW_MS);
const TS = '2026-10-28T19:00:00.000Z';
const OLD_TS = '2026-10-20T00:00:00.000Z'; // outside the 72 h window

const line = (row: Record<string, unknown>): string => JSON.stringify(row);
const finish = (job: string, empty: boolean, ts = TS, lane = 'codex-cmp') =>
  line({ event: 'finish', job, lane, empty, ts });

const TAGS_FILE = 'metrics/empty-tags.jsonl';
const DUPCHECK_FILE = 'metrics/dupcheck.jsonl';

const readTags = (runsDir: string): Record<string, unknown>[] =>
  readFileSync(join(runsDir, TAGS_FILE), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
const readDupcheck = (runsDir: string): Record<string, unknown>[] =>
  readFileSync(join(runsDir, DUPCHECK_FILE), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);

describe('syncEmptyTagsFromJobsLedger', () => {
  let directory: string;
  let runsDir: string;

  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'empty-tag-sync-')));
    runsDir = join(directory, 'runs');
    mkdirSync(join(runsDir, 'metrics'), { recursive: true });
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const writeJobs = (text: string) => writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'), text, { mode: 0o600 });
  const writeLog = (job: string, text: string) => writeFileSync(join(runsDir, `${job}.log`), text, { mode: 0o600 });

  it('records a tag per windowed empty finish from the log tail, idempotently', async () => {
    writeJobs([
      finish('RQ-A', true), finish('RQ-B', true), finish('RQ-C', false), finish('RQ-OLD', true, OLD_TS),
      'not json at all',
    ].join('\n') + '\n');
    writeLog('RQ-A', 'Checked master. The feature is already on master, so there is nothing to add.');
    writeLog('RQ-B', "You've reached your Fable limit. Try again later.");
    // RQ-C finished non-empty; RQ-OLD is outside the window; neither is a candidate.

    const first = await syncEmptyTagsFromJobsLedger({ runsDir, now: NOW });
    expect(first).toMatchObject({
      state: 'read', tagsState: 'missing', truncated: false,
      candidates: 2, alreadyTagged: 0, classified: 2, deferred: 0, recorded: 2,
    });
    const rows = readTags(runsDir);
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r['job'] === 'RQ-A')).toMatchObject({ schema: 'job.empty-tag.v1', lane: 'codex-cmp', tag: 'already_done' });
    expect(rows.find(r => r['job'] === 'RQ-B')).toMatchObject({ tag: 'pool_cap' });

    const second = await syncEmptyTagsFromJobsLedger({ runsDir, now: NOW });
    expect(second).toMatchObject({ state: 'read', tagsState: 'read', candidates: 2, alreadyTagged: 2, classified: 0, recorded: 0 });
    expect(readTags(runsDir)).toHaveLength(2);
  });

  it('tags a missing or unreadable log unknown rather than guessing', async () => {
    writeJobs(finish('RQ-GONE', true) + '\n');
    const out = await syncEmptyTagsFromJobsLedger({ runsDir, now: NOW });
    expect(out).toMatchObject({ state: 'read', candidates: 1, classified: 1, recorded: 1 });
    expect(readTags(runsDir)[0]).toMatchObject({ job: 'RQ-GONE', tag: 'unknown' });
  });

  it('records a dupcheck outcome once for a launched job that ended already_done', async () => {
    writeJobs([finish('RQ-A', true), finish('RQ-B', true)].join('\n') + '\n');
    writeLog('RQ-A', 'This is a duplicate of an earlier job.');
    writeLog('RQ-B', "You've reached your Fable limit. Try again later.");
    writeFileSync(join(runsDir, DUPCHECK_FILE), line({
      schema: 'queue.dupcheck-event.v1', at: '2026-10-28T18:00:00.000Z', job: 'RQ-A', action: 'launch',
    }) + '\n', { mode: 0o600 });

    const first = await syncEmptyTagsFromJobsLedger({ runsDir, now: NOW });
    expect(first.dupcheckOutcomes).toBe(1);
    const outcomes = readDupcheck(runsDir).filter(r => r['action'] === 'outcome');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ schema: 'queue.dupcheck-event.v1', job: 'RQ-A', tag: 'already_done' });

    const second = await syncEmptyTagsFromJobsLedger({ runsDir, now: NOW });
    expect(second.dupcheckOutcomes).toBe(0);
    expect(readDupcheck(runsDir).filter(r => r['action'] === 'outcome')).toHaveLength(1);
  });

  it('keeps the recorded tag authoritative over a fresh classification', async () => {
    writeJobs(finish('RQ-A', true) + '\n');
    writeLog('RQ-A', 'This is a duplicate of an earlier job.'); // would classify already_done
    writeFileSync(join(runsDir, TAGS_FILE), line({
      schema: 'job.empty-tag.v1', job: 'RQ-A', lane: 'codex-cmp', tag: 'unknown',
    }) + '\n', { mode: 0o600 });
    writeFileSync(join(runsDir, DUPCHECK_FILE), line({
      schema: 'queue.dupcheck-event.v1', at: '2026-10-28T18:00:00.000Z', job: 'RQ-A', action: 'launch',
    }) + '\n', { mode: 0o600 });

    const out = await syncEmptyTagsFromJobsLedger({ runsDir, now: NOW });
    expect(out).toMatchObject({ candidates: 1, alreadyTagged: 1, classified: 0, recorded: 0, dupcheckOutcomes: 0 });
    expect(readTags(runsDir)).toHaveLength(1);
    expect(readDupcheck(runsDir).filter(r => r['action'] === 'outcome')).toHaveLength(0);
  });

  it.each(['launch', 'batch_claim'])('waits for the current attempt after a %s', async (event) => {
    const job = 'RQ-RETRY';
    const dispatch = line({ event, job, ts: TS });
    const previousFinish = finish(job, true, '2026-10-28T18:30:00.000Z');
    // The previous finish arrived late in the ledger. The log already belongs to the retry.
    writeJobs([dispatch, previousFinish].join('\n') + '\n');
    writeLog(job, 'This is a duplicate of an earlier job.');
    writeFileSync(join(runsDir, DUPCHECK_FILE), line({
      schema: 'queue.dupcheck-event.v1', at: TS, job, action: 'launch',
    }) + '\n');

    const pending = await syncEmptyTagsFromJobsLedger({ runsDir, now: NOW });
    expect(pending).toMatchObject({ state: 'read', candidates: 0, classified: 0, recorded: 0, dupcheckOutcomes: 0 });
    expect(existsSync(join(runsDir, TAGS_FILE))).toBe(false);

    // A finish at the dispatch timestamp belongs to the retry when appended after it.
    // Replaying that dispatch after the finish does not start another attempt.
    writeJobs([dispatch, previousFinish, finish(job, true), dispatch].join('\n') + '\n');
    const completed = await syncEmptyTagsFromJobsLedger({ runsDir, now: NOW });
    expect(completed).toMatchObject({ state: 'read', candidates: 1, classified: 1, recorded: 1, dupcheckOutcomes: 1 });
    expect(readTags(runsDir)).toEqual([expect.objectContaining({ job, tag: 'already_done' })]);
  });

  it('defers fresh classifications past the per-pass cap to a later sync', async () => {
    writeJobs(['RQ-A', 'RQ-B', 'RQ-C'].map(id => finish(id, true)).join('\n') + '\n');
    const first = await syncEmptyTagsFromJobsLedger({ runsDir, now: NOW, maxClassify: 1 });
    expect(first).toMatchObject({ candidates: 3, classified: 1, deferred: 2, recorded: 1 });
    expect(readTags(runsDir)).toHaveLength(1);
    const second = await syncEmptyTagsFromJobsLedger({ runsDir, now: NOW, maxClassify: 1 });
    expect(second).toMatchObject({ candidates: 3, alreadyTagged: 1, classified: 1, deferred: 1, recorded: 1 });
    const third = await syncEmptyTagsFromJobsLedger({ runsDir, now: NOW, maxClassify: 1 });
    expect(third).toMatchObject({ candidates: 3, alreadyTagged: 2, classified: 1, deferred: 0, recorded: 1 });
    expect(readTags(runsDir)).toHaveLength(3);
  });

  it('reports a missing jobs ledger without writing', async () => {
    const out = await syncEmptyTagsFromJobsLedger({ runsDir, now: NOW });
    expect(out).toMatchObject({ state: 'missing', candidates: 0, recorded: 0 });
  });

  it('skips recording when the tags ledger is not a readable file', async () => {
    writeJobs(finish('RQ-A', true) + '\n');
    writeLog('RQ-A', 'Done for now.');
    mkdirSync(join(runsDir, TAGS_FILE)); // a directory where the ledger should be
    const out = await syncEmptyTagsFromJobsLedger({ runsDir, now: NOW });
    expect(out).toMatchObject({ state: 'read', tagsState: 'not-file', candidates: 0, recorded: 0 });
  });

  it('accepts injected ledger text and a pre-aborted signal writes nothing', async () => {
    const injected = await syncEmptyTagsFromJobsLedger({
      runsDir, now: NOW, jobsText: finish('RQ-A', true) + '\n',
    });
    expect(injected.state).toBe('read');
    expect(injected.candidates).toBe(1);
    const aborted = new AbortController();
    aborted.abort();
    const skipped = await syncEmptyTagsFromJobsLedger({
      runsDir, now: NOW, jobsText: finish('RQ-B', true) + '\n', signal: aborted.signal,
    });
    expect(skipped).toMatchObject({ state: 'read', candidates: 0, recorded: 0 });
  });
});

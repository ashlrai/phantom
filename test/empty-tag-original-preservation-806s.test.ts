import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ledgerFinishes } from '../src/core/fleet/empties.js';
import { syncEmptyTagsFromJobsLedger } from '../src/core/fleet/empty-tag-sync.js';

const now = () => new Date('2026-10-28T20:00:00Z');
const ts = '2026-10-28T19:00:00Z';
const jsonl = (...rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

describe('original empty-finish tag synchronization preservation', () => {
  let root: string;
  let metrics: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'empty-original-806s-'));
    metrics = join(root, 'metrics');
    mkdirSync(metrics);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('folds real empty finishes, excludes node completion, and preserves imported tags across syncs', async () => {
    const jobs = jsonl(
      { event: 'finish', job: 'RQ-EMPTY', lane: 'codex', empty: true, ts },
      { event: 'outcome', job: 'RQ-MARKED', lane: 'codex', state: 'EMPTY_DONE', ts },
      { schema: 'fleet.session-pool.v1', event: 'finish', job: 'session-1', jobId: 'ready:RQ-NODE-1:1', outcome: 'completed', ts },
      { schema: 'phm-node-runner.v1', event: 'finish', job: 'runner-1', jobId: 'ready:RQ-NODE-2:1', outcome: 'succeeded', ts },
    );
    writeFileSync(join(metrics, 'jobs.jsonl'), jobs);
    writeFileSync(join(root, 'RQ-EMPTY.log'), 'This is a duplicate of an earlier job.');
    writeFileSync(join(root, 'RQ-MARKED.log'), 'This is a duplicate of an earlier job.');
    const tagsPath = join(metrics, 'empty-tags.jsonl');
    writeFileSync(tagsPath, jsonl({ schema: 'job.empty-tag.v1', job: 'RQ-MARKED', lane: 'codex', tag: 'unknown' }));
    const dupPath = join(metrics, 'dupcheck.jsonl');
    writeFileSync(dupPath, jsonl({ schema: 'queue.dupcheck-event.v1', at: ts, job: 'RQ-EMPTY', action: 'launch' }));

    const finishes = ledgerFinishes(jobs, now().getTime(), 72).finishes;
    expect(finishes.filter(f => f.empty).map(f => f.id)).toEqual(['RQ-EMPTY', 'RQ-MARKED']);
    expect(finishes.filter(f => f.id === 'session-1' || f.id === 'runner-1').map(f => f.empty)).toEqual([false, false]);
    expect(await syncEmptyTagsFromJobsLedger({ runsDir: root, now })).toMatchObject({
      state: 'read', tagsState: 'read', candidates: 2, alreadyTagged: 1, classified: 1, recorded: 1, dupcheckOutcomes: 1,
    });
    const tags = readFileSync(tagsPath, 'utf8');
    const dup = readFileSync(dupPath, 'utf8');
    expect(tags.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ job: 'RQ-MARKED', tag: 'unknown' }),
      expect.objectContaining({ job: 'RQ-EMPTY', tag: 'already_done' }),
    ]);
    expect(dup.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ job: 'RQ-EMPTY', action: 'outcome', tag: 'already_done' }));
    expect(await syncEmptyTagsFromJobsLedger({ runsDir: root, now })).toMatchObject({ candidates: 2, alreadyTagged: 2, classified: 0, recorded: 0, dupcheckOutcomes: 0 });
    expect(readFileSync(tagsPath, 'utf8')).toBe(tags);
    expect(readFileSync(dupPath, 'utf8')).toBe(dup);
  });

  it('keeps unavailable evidence unknown and refuses to write without readable ledgers', async () => {
    const tagsPath = join(metrics, 'empty-tags.jsonl');
    expect(await syncEmptyTagsFromJobsLedger({ runsDir: root, now })).toMatchObject({ state: 'missing', tagsState: 'not-read', candidates: 0, recorded: 0 });
    expect(existsSync(tagsPath)).toBe(false);
    writeFileSync(join(metrics, 'jobs.jsonl'), jsonl({ event: 'finish', job: 'RQ-NO-LOG', empty: true, ts }));
    expect(await syncEmptyTagsFromJobsLedger({ runsDir: root, now })).toMatchObject({ state: 'read', candidates: 1, recorded: 1 });
    expect(JSON.parse(readFileSync(tagsPath, 'utf8').trim())).toMatchObject({ job: 'RQ-NO-LOG', tag: 'unknown' });
    rmSync(tagsPath);
    mkdirSync(tagsPath);
    expect(await syncEmptyTagsFromJobsLedger({ runsDir: root, now })).toMatchObject({ state: 'read', tagsState: 'not-file', candidates: 0, classified: 0, recorded: 0 });
    expect(existsSync(join(metrics, 'dupcheck.jsonl'))).toBe(false);
  });
});

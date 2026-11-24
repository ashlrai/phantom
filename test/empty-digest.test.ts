import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyDigestReason, formatEmptyDigest, summarizeEmptyDigest } from '../src/core/fleet/empty-digest.js';
import { readEmptyJobs } from '../src/core/fleet/empty-jobs.js';

// Plain-words fixtures: one per reason, plus an unknown.
const CASES: ReadonlyArray<readonly [string, string | null, string | null]> = [
  ['already on master', 'The change is already on master.', null],
  ['no change needed', 'No change is needed here.', null],
  ['sign-in failed', 'Authentication failed. Please log in again.', null],
  ['usage limit', "You've reached your usage limit.", null],
  ['timed out', 'The run timed out.', null],
  ['lane held', 'The lane is held until the weekly window resets.', null],
  ['tool or file missing', 'bash: gh: command not found', null],
  ['blocked by a repo rule', 'This path is reserved for the owner.', null],
  ['waiting on another job', 'Blocked on another job.', null],
  ['secret-shape gate', 'Done.', 'publish stopped by the secret-shape gate'],
  ['no gh on this lane', 'Done.', 'no gh on this lane, not published'],
  ['already on master', 'Done.', 'already on master, nothing to publish'],
];

describe('classifyDigestReason', () => {
  for (const [reason, log, publish] of CASES) it(`says ${reason}`, () => expect(classifyDigestReason(log, publish).reason).toBe(reason));
  it('unknown and missing files are other', () => {
    expect(classifyDigestReason('Finished the pass.', null).reason).toBe('other');
    expect(classifyDigestReason(null, null).reason).toBe('other');
  });
});

describe('summarizeEmptyDigest', () => {
  const jobs = [
    { id: 'A1', lane: 'claude', log: 'already on master', publish: null },
    { id: 'A2', lane: 'claude', log: 'already on master', publish: null },
    { id: 'A3', lane: 'zai', log: 'already on master', publish: null },
    { id: 'S1', lane: 'gemini', log: 'Authentication failed', publish: null },
    { id: 'O1', lane: 'zai', log: '\nWandering around the repo.\nmore text', publish: null },
  ];
  const digest = summarizeEmptyDigest(jobs);
  it('counts per reason with lanes and two newest examples', () => {
    expect(digest.total).toBe(5);
    expect(digest.reasons[0]).toMatchObject({ reason: 'already on master', count: 3, examples: ['A3', 'A2'], lanes: [{ lane: 'claude', count: 2 }, { lane: 'zai', count: 1 }] });
  });
  it('keeps unknown in other with its first log line', () => {
    expect(digest.reasons.find(r => r.reason === 'other')).toMatchObject({ count: 1, firstLine: 'Wandering around the repo.' });
  });
  it('groups by lane', () => {
    expect(digest.lanes[0]).toMatchObject({ lane: 'claude', count: 2 });
    expect(formatEmptyDigest(digest, 'lane', 24)).toContain('zai: 2 (already on master 1, other 1)');
  });
  it('prints plain lines', () => {
    expect(formatEmptyDigest(digest, 'reason', 24)[1]).toBe('already on master: 3 (claude 2, zai 1); e.g. A3, A2');
    expect(formatEmptyDigest(summarizeEmptyDigest([]), 'reason', 24)).toEqual(['No empty jobs.']);
  });
  it('redacts the quoted line', () => {
    const secret = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwx'].join('-');
    const row = summarizeEmptyDigest([{ id: 'X', lane: 'l', log: `token ${secret}`, publish: null }]).reasons[0]!;
    expect(row.firstLine).not.toContain(secret);
  });
});

describe('readEmptyJobs digest window', () => {
  it('keeps only jobs inside --since and reads the publish note', async () => {
    const root = await mkdtemp(join(tmpdir(), 'empty-digest-'));
    await mkdir(join(root, 'metrics'));
    const now = Date.now();
    const row = (id: string, lane: string, hoursAgo: number) => JSON.stringify({ event: 'finish', id, lane, empty: true, ts: new Date(now - hoursAgo * 3600_000).toISOString() });
    await writeFile(join(root, 'metrics/jobs.jsonl'), [row('RQ-NEW', 'claude', 1), row('RQ-OLD', 'zai', 30)].join('\n') + '\n');
    await writeFile(join(root, 'RQ-NEW.log'), 'Done.');
    await writeFile(join(root, 'RQ-NEW.publish'), 'secret-shape gate refused the push');
    await writeFile(join(root, 'RQ-OLD.log'), 'already on master');
    const day = await readEmptyJobs(24, root, join(root, 'wt'), now, { quote: true });
    expect(day?.digest?.reasons.map(r => r.reason)).toEqual(['secret-shape gate']);
    const week = await readEmptyJobs(48, root, join(root, 'wt'), now);
    expect(week?.digest?.total).toBe(2);
    expect(week?.digest?.lanes.map(l => l.lane)).toEqual(['claude', 'zai']);
  });
});

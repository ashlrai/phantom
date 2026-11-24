/**
 * What became of a session's pull request (src/core/fleet/session-pr.ts):
 * read from the job ledger's outcome rows, carried on the activity entry,
 * picked for the job's current attempt, and said in the session's summary.
 * Fixture rows only; the shapes are the ones the outcome reconciler writes.
 */
import { describe, expect, it } from 'vitest';
import { parseJobLedgerEvents, rowPrFate, type FleetJobActivityEntry, type FleetJobActivityV1 } from '../src/core/fleet/runs-job-activity.js';
import { PR_SENTENCE_START, prSentence, prWords, sessionPr } from '../src/core/fleet/session-pr.js';
import { sessionWork } from '../src/core/fleet/session-thread.js';

const URL = 'https://github.com/ashlrai/phantom/pull/7836';
const row = (fields: Record<string, unknown>) => JSON.stringify({ job: 'RQ-A', ...fields });
const LEDGER = [
  row({ event: 'launch', lane: 'claude', ts: '2026-11-21T01:15:51-0500' }),
  row({ event: 'finish', exit_code: 0, ts: '2026-11-21T01:21:46-0500' }),
  row({ event: 'publish', url: URL, ts: '2026-11-21T01:22:12-0500' }),
  row({ checks: 'red', event: 'outcome', state: 'MERGED', ts: '2026-11-21T01:26:32-0500', ttm_s: 92, url: URL }),
  JSON.stringify({ event: 'outcome', job: 'RQ-OTHER', state: 'CLOSED', ts: '2026-11-21T01:27:00-0500', url: URL }),
].join('\n');

function activity(entries: FleetJobActivityEntry[]): FleetJobActivityV1 {
  return { schema: 'fleet.job.activity.v1', generatedAt: '2026-11-21T06:30:00.000Z', job: 'RQ-A', state: 'finished', lane: 'claude', tier: null, model: null,
    sources: { events: 'healthy', commands: 'healthy', files: 'missing', reports: 'missing' }, counts: { events: entries.length, commands: 0, files: 0, reports: 0 }, truncated: false, entries };
}
const event = (name: string, at: string | null, pr?: { state: 'merged' | 'closed' | 'open'; mergeSeconds: number | null }): FleetJobActivityEntry =>
  ({ kind: 'event', at, event: name, summary: '', ...(pr ? { pr } : {}) });

describe('rowPrFate', () => {
  it('reads an outcome row in the reconciler\'s spelling, and a merged or closed event', () => {
    expect(rowPrFate({ state: 'MERGED', ttm_s: 92 }, 'outcome')).toEqual({ state: 'merged', mergeSeconds: 92 });
    expect(rowPrFate({ state: 'OPEN', ttm_s: null }, 'outcome')).toEqual({ state: 'open', mergeSeconds: null });
    expect(rowPrFate({ status: 'closed' }, 'outcome')).toEqual({ state: 'closed', mergeSeconds: null });
    expect(rowPrFate({}, 'merged')).toEqual({ state: 'merged', mergeSeconds: null });
    expect(rowPrFate({ ttm_s: 40 }, 'closed')).toEqual({ state: 'closed', mergeSeconds: null });
  });

  it('gives nothing for a row that does not say, and never a time that is not a count of seconds', () => {
    // A finish, a publish and an outcome naming another kind of end are not a pull request outcome.
    for (const [fields, name] of [[{ exit_code: 0 }, 'finish'], [{ url: URL }, 'publish'], [{ state: 'EMPTY' }, 'outcome'], [{}, 'outcome'], [{ state: 'MERGED' }, 'launch']] as const) {
      expect(rowPrFate(fields, name)).toBeUndefined();
    }
    for (const took of ['92', -1, Number.NaN, null, undefined]) expect(rowPrFate({ state: 'MERGED', ttm_s: took }, 'outcome')).toEqual({ state: 'merged', mergeSeconds: null });
  });
});

describe('parseJobLedgerEvents', () => {
  it('carries the outcome on its own row only, and names the state in the row\'s summary', () => {
    const { events } = parseJobLedgerEvents(LEDGER, 'RQ-A', 50);
    expect(events.map(entry => [entry.event, entry.pr ?? null])).toEqual([['launch', null], ['finish', null], ['publish', null], ['outcome', { state: 'merged', mergeSeconds: 92 }]]);
    expect(events.at(-1)!.summary).toBe(`state=MERGED ttm_s=92 url=${URL}`);
    expect(Object.keys(events[0]!)).toEqual(['kind', 'at', 'event', 'summary']);
    // What became of this job's pull request is this job's rows only.
    expect(sessionPr(activity(events))).toEqual({ state: 'merged', mergeSeconds: 92, at: '2026-11-21T01:26:32-0500' });
  });
});

describe('sessionPr', () => {
  it('is null until a row records an outcome: a published job is not known to be open', () => {
    expect(sessionPr(null)).toBeNull();
    expect(sessionPr(undefined)).toBeNull();
    expect(sessionPr(activity([]))).toBeNull();
    expect(sessionPr(activity([event('launch', null), event('finish', null), event('publish', '2026-11-21T06:22:12.000Z')]))).toBeNull();
  });

  it('lets a merge stand, and otherwise believes the newest row', () => {
    const merged = { state: 'merged', mergeSeconds: 92 } as const, open = { state: 'open', mergeSeconds: null } as const, closed = { state: 'closed', mergeSeconds: null } as const;
    expect(sessionPr(activity([event('outcome', '2026-11-21T06:00:00.000Z', open), event('outcome', '2026-11-21T06:10:00.000Z', open)])))
      .toEqual({ state: 'open', mergeSeconds: null, at: '2026-11-21T06:10:00.000Z' });
    expect(sessionPr(activity([event('outcome', '2026-11-21T06:00:00.000Z', open), event('outcome', '2026-11-21T06:10:00.000Z', closed)]))?.state).toBe('closed');
    // A later row that still says open (a slow reconciler) does not undo a recorded merge.
    expect(sessionPr(activity([event('outcome', '2026-11-21T06:00:00.000Z', merged), event('outcome', '2026-11-21T06:10:00.000Z', open)])))
      .toEqual({ state: 'merged', mergeSeconds: 92, at: '2026-11-21T06:00:00.000Z' });
  });

  it('sets aside what was recorded before the job\'s newest launch', () => {
    const closed = { state: 'closed', mergeSeconds: null } as const;
    const earlier = [event('launch', null), event('publish', null), event('outcome', '2026-11-21T05:00:00.000Z', closed), event('launch', null)];
    expect(sessionPr(activity(earlier))).toBeNull();
    expect(sessionPr(activity([...earlier, event('outcome', '2026-11-21T06:00:00.000Z', { state: 'merged', mergeSeconds: 61 })]))?.state).toBe('merged');
  });

  it('keeps only a time that parses, and whole seconds', () => {
    expect(sessionPr(activity([event('outcome', 'soon', { state: 'merged', mergeSeconds: 92.7 })]))).toEqual({ state: 'merged', mergeSeconds: 92, at: null });
    expect(sessionPr(activity([event('outcome', null, { state: 'open', mergeSeconds: 30 })]))).toEqual({ state: 'open', mergeSeconds: null, at: null });
  });
});

describe('the words for an outcome', () => {
  it('says each state once, in a sentence and in a chip', () => {
    const at = '2026-11-21T06:10:00.000Z';
    expect(prSentence({ state: 'merged', mergeSeconds: 92, at })).toBe('Its pull request merged 1m after it opened.');
    expect(prSentence({ state: 'merged', mergeSeconds: null, at })).toBe('Its pull request merged.');
    expect(prSentence({ state: 'closed', mergeSeconds: null, at })).toBe('Its pull request was closed without merging.');
    expect(prSentence({ state: 'open', mergeSeconds: null, at })).toBe(`Its pull request was still open when last checked at ${at}.`);
    expect(prSentence({ state: 'open', mergeSeconds: null, at: null })).toBe('Its pull request was still open when last checked.');
    for (const state of ['merged', 'closed', 'open'] as const) expect(prSentence({ state, mergeSeconds: null, at: null }).startsWith(PR_SENTENCE_START)).toBe(true);
    expect([prWords({ state: 'merged', mergeSeconds: 7_500 }), prWords({ state: 'merged', mergeSeconds: null }), prWords({ state: 'closed', mergeSeconds: null }), prWords({ state: 'open', mergeSeconds: null })])
      .toEqual(['merged in 2h 5m', 'merged', 'closed, not merged', 'still open']);
  });
});

describe('sessionWork', () => {
  it('puts the outcome first in a job\'s work, null when none is recorded', () => {
    const work = sessionWork(activity(parseJobLedgerEvents(LEDGER, 'RQ-A', 50).events));
    expect(Object.keys(work!)).toEqual(['pr', 'commands', 'files', 'step']);
    expect(work!.pr).toEqual({ state: 'merged', mergeSeconds: 92, at: '2026-11-21T01:26:32-0500' });
    expect(sessionWork(activity([event('publish', null)]))!.pr).toBeNull();
  });
});

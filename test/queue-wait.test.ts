import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdQueue } from '../src/cli/queue.js';
import { fleetMergeLatency } from '../src/cli/fleet-merge-latency.js';
import { queueWait } from '../src/core/queue/wait.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const fixture = new URL('./fixtures/queue/merge-wait.jsonl', import.meta.url);
const text = await readFile(fixture, 'utf8');
const event = (type: string, extra = {}) => JSON.stringify({ repo: 'ashlrai/phantom', pr: 20, type, at: '2026-11-18T11:30:00Z', ...extra });
const report = async (input: string | null) => queueWait(await fleetMergeLatency(async () => input, now), now);
afterEach(() => vi.restoreAllMocks());

it('selects the oldest active enqueue, excludes merged PRs, and retains required checks after one success', async () => {
  const result = await report(text);
  expect(result).toEqual({ schema: 'queue.wait.v1', source: 'recorded_events', observedAt: new Date(now).toISOString(),
    readOnly: true, requiredChecksPreserved: true, state: 'queued', oldestQueued: {
      repo: 'ashlrai/phantom', pr: 20, enqueuedAt: '2026-11-18T10:00:00Z', waitingSeconds: 7200,
      reason: 'required_checks', reasonSince: '2026-11-18T10:10:00.000Z' } });
  expect(await report(text.trim().split('\n').reverse().join('\n'))).toEqual(result);
  expect((await report(text + event('checks_passed'))).oldestQueued?.reason).toBe('queue');
  expect((await report(text + event('conflict'))).oldestQueued?.reason).toBe('conflict');
});

it.each(['merged', 'closed'])('has no current wait after every queued PR is %s', async type => {
  expect(await report(event('queued') + '\n' + event(type))).toMatchObject({ state: 'empty', oldestQueued: null });
});

it.each([null, '{', text + event('queued'), text + event('queued', { at: '2099-01-01T00:00:00Z' }),
  text + event('queued', { at: 'bad' })])('keeps unavailable, malformed and ambiguous oldest evidence unknown (%#)', async input => {
  expect(await report(input)).toMatchObject({ state: 'unknown', oldestQueued: null });
});

it('separates unknown reasons from unknown ages and does not treat readiness as queue membership', async () => {
  const unclear = text + event('blocked', { reason: 'review' }) + '\n' + event('conflict');
  expect((await report(unclear)).oldestQueued).toMatchObject({ pr: 20, reason: 'unknown', waitingSeconds: 7200 });
  expect(await report(event('eligible'))).toMatchObject({ state: 'empty', oldestQueued: null });
  expect(await report('')).toMatchObject({ state: 'empty', oldestQueued: null });
});

it('includes short and old waits, and breaks equal enqueue times by repo then PR number', async () => {
  const tied = [event('queued', { repo: 'z/repo' }), event('queued'), event('queued', { pr: 10 })].join('\n');
  expect((await report(tied)).oldestQueued).toMatchObject({ repo: 'ashlrai/phantom', pr: 10, waitingSeconds: 1800, reason: 'queue' });
  expect((await report(tied + '\n' + event('queued', { pr: 40, at: '2026-11-01T00:00:00Z' }))).oldestQueued?.pr).toBe(40);
});

it('routes JSON, plain words and help through queue without changing its evidence file', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdQueue(['--events', fixture.pathname, 'wait', '--json'])).toBe(0);
  expect(JSON.parse(out.mock.calls.at(-1)![0] as string)).toEqual(await report(text));
  expect(await cmdQueue(['wait', '--events', fixture.pathname])).toBe(0);
  expect(out.mock.calls.at(-1)![0]).toContain('ashlrai/phantom#20: 7200s queued; waiting on required checks');
  expect(await readFile(fixture, 'utf8')).toBe(text);
  expect(await cmdQueue(['wait', '--help'])).toBe(0);
  expect(out.mock.calls.at(-1)![0]).toContain('Start here: phm queue wait --json');
  expect(await cmdQueue(['wait', '--events', `${fixture.pathname}.missing`, '--json'])).toBe(1);
  expect(JSON.parse(out.mock.calls.at(-1)![0] as string)).toMatchObject({ schema: 'queue.wait.v1', state: 'unknown' });
});

it.each([['--apply'], ['--admin'], ['--record', '{}'], ['--events'], ['--json', '--json'], ['--events', 'a', '--events', 'b']])('rejects unsupported or duplicate options %j', async (...args) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdQueue(['wait', ...args])).toBe(2);
});

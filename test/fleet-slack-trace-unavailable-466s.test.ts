import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSlackTrace } from '../src/cli/fleet-slack-trace.js';

const CHANNEL = 'C0FAKE0001';
const THREAD = '1731000000.000100';
const MSG = '1731000010.000100';
const SENTINEL = 'fake-private-sentinel-466s /tmp/fake-private-path body-text-466s';

afterEach(() => vi.restoreAllMocks());

function run(args: string[], deps: Parameters<typeof cmdFleetSlackTrace>[1]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  return cmdFleetSlackTrace(args, deps).then((code) => ({ code, out, err }));
}

describe('fleet slack-trace collector failure (466s)', () => {
  it.each([
    ['Error', () => { throw new Error(SENTINEL); }],
    ['string', () => { throw SENTINEL; }],
    ['object', () => { throw { message: SENTINEL, stack: SENTINEL }; }],
  ])('emits one bounded unavailable JSON report for %s throws', async (_n, readTrace) => {
    const { code, out } = await run(['--json', '--thread', THREAD, '--channel', CHANNEL, '--message', MSG],
      { readTrace, now: () => new Date(1731000100000) });
    expect(code).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toMatch(/sentinel|private|body-text|stack/);
    expect(JSON.parse(out[0]!)).toEqual({
      asOf: new Date(1731000100000).toISOString(), rows: [],
      counts: { total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 },
      sources: { journal: 'degraded', sends: 'degraded' }, sourceState: 'unavailable',
      scope: 'Bounded local persisted journal and send evidence only; does not prove current runtime reachability.',
      collectionScope: { thread: THREAD, channelId: CHANNEL, messageTs: MSG },
    });
  });

  it('keeps absent selectors absent and survives a failing clock', async () => {
    const { code, out } = await run(['--json'], {
      readTrace: () => { throw new Error(SENTINEL); }, now: () => { throw new Error(SENTINEL); } });
    expect(code).toBe(1);
    const report = JSON.parse(out[0]!);
    expect(report.collectionScope).toEqual({});
    expect(report.asOf).toBe(new Date(0).toISOString());
    expect(report.sourceState).toBe('unavailable');
  });

  it('human output is bounded, says unavailable, and leaks nothing', async () => {
    const { code, out } = await run(['--channel', CHANNEL], { readTrace: () => { throw new Error(SENTINEL); } });
    expect(code).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('evidence unavailable');
    expect(out[0]).toContain('not a runtime probe');
    expect(out[0]).not.toMatch(/sentinel|private|body-text/);
  });

  it.each([
    [['--thread', 'bad']], [['--channel', 'bad']], [['--thread', THREAD, '--thread', THREAD]],
    [['--message', MSG]], [['--bogus']],
  ])('argument errors exit 2 without invoking the reader: %j', async (args) => {
    const readTrace = vi.fn();
    const { code } = await run(args, { readTrace });
    expect(code).toBe(2);
    expect(readTrace).not.toHaveBeenCalled();
  });

  it('passes successful reads through with existing exit semantics', async () => {
    const row = { at: '2024-11-07T17:20:10.000Z', channelId: CHANNEL, threadTs: THREAD, messageTs: MSG, ingress: 'posted', outcome: 'answered', replyTs: '1731000050.000100' };
    const base = { asOf: '2024-11-07T17:21:40.000Z', counts: { total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 } };
    const ok = vi.fn(() => ({ ...base, rows: [row], sources: { journal: 'ok', sends: 'ok' } }) as never);
    const good = await run(['--json'], { readTrace: ok });
    expect(good.code).toBe(0);
    expect(JSON.parse(good.out[0]!).sourceState).toBeUndefined();
    const degraded = vi.fn(() => ({ ...base, rows: [row], sources: { journal: 'ok', sends: 'degraded' } }) as never);
    expect((await run(['--json'], { readTrace: degraded })).code).toBe(1);
    const empty = vi.fn(() => ({ ...base, rows: [], sources: { journal: 'ok', sends: 'ok' } }) as never);
    expect((await run(['--json'], { readTrace: empty })).code).toBe(1);
  });
});

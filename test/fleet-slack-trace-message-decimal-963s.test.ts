import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetSlackTrace } from '../src/cli/fleet-slack-trace.js';
import type { SlackRequestTraceRead, SlackTraceRow } from '../src/core/agents/slack-request-trace.js';

const thread = '1731000000.000100';
const channel = 'C0FAKE0001';
const row: SlackTraceRow = { at: '2024-11-07T00:00:00.000Z', channelId: channel, threadTs: thread,
  messageTs: '1795600000.100000', ingress: 'posted', outcome: 'answered' };
const counts = { total: 99, answered: 99, uncertain: 0, busFailed: 0, unanswered: 0 };
afterEach(() => vi.restoreAllMocks());

async function run(rows: SlackTraceRow[], message: string, sources: SlackRequestTraceRead['sources'] = { journal: 'ok', sends: 'ok' }) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const readTrace = vi.fn(() => ({ asOf: '2024-11-07T00:00:00.000Z', rows, counts, sources }));
  const code = await cmdFleetSlackTrace(['--thread', thread, '--channel', channel, '--message', message, '--work-state', '--json'],
    { readTrace, readClaims: () => [] });
  const result = JSON.parse(String(log.mock.calls.at(-1)![0]));
  expect(readTrace).toHaveBeenCalledWith({ thread });
  return { code, result };
}

it('selects decimal identity only in the exact channel and preserves evidence and scope', async () => {
  const message = '001795600000.1000000';
  const { code, result } = await run([row, { ...row, channelId: 'G0FAKE0002' },
    { ...row, messageTs: '1795600000.1000001' }, { ...row, messageTs: '1795600000.100000x' }], message);
  expect(code).toBe(0);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ ...row, state: 'RECEIVED' });
  expect(result.counts).toEqual({ total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 });
  expect(result.collectionScope).toEqual({ thread, channelId: channel, messageTs: message });
  expect(result.sources).toEqual({ journal: 'ok', sends: 'ok' });
});

it('keeps distinct values even when floating point would collapse them and rejects invalid evidence', async () => {
  const { code, result } = await run([{ ...row, messageTs: '99999999999999999999.1000001' },
    { ...row, messageTs: '99999999999999999999.100000x' }], '99999999999999999999.1000000');
  expect(code).toBe(1);
  expect(result.rows).toEqual([]);
  expect(result.counts.total).toBe(0);
});

it.each([
  [{ ingress: 'unknown' }, { journal: 'ok', sends: 'ok' }],
  [{ outcome: 'uncertain' }, { journal: 'ok', sends: 'ok' }],
  [{}, { journal: 'degraded', sends: 'ok' }],
] as const)('preserves incomplete evidence and source health', async (change, sources) => {
  const { code, result } = await run([{ ...row, ...change }], '1795600000.1000000', sources);
  expect(code).toBe(1);
  expect(result.rows[0]).toMatchObject({ ...row, ...change, state: 'RECEIVED' });
  expect(result.sources).toEqual(sources);
});

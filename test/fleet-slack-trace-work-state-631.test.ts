import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSlackTrace } from '../src/cli/fleet-slack-trace.js';
import type { SlackRequestTraceRead, SlackTraceRow } from '../src/core/agents/slack-request-trace.js';
import type { SlackTraceClaim } from '../src/core/comms/slack-trace-work-items.js';

const CH = 'C0FAKE0001';
const THREAD = '1700000000.000100';
const MSG = '1700000010.000100';
const AT = '2025-11-07T17:00:00.000Z';
const NOW = new Date('2025-11-07T18:00:00.000Z');

const row = (over: Partial<SlackTraceRow> = {}): SlackTraceRow =>
  ({ at: AT, channelId: CH, threadTs: THREAD, messageTs: MSG, ingress: 'posted', outcome: 'unanswered', ...over });
const trace = (rows: SlackTraceRow[]): SlackRequestTraceRead => ({
  asOf: NOW.toISOString(), rows, sources: { journal: 'ok', sends: 'ok' },
  counts: { total: rows.length, answered: 0, uncertain: 0, busFailed: 0, unanswered: rows.length },
});
const claim: SlackTraceClaim = { claimId: 'claim-fake-1', repo: 'fake/repo', agent: 'fake-agent', threadKey: `slack:T0FAKE0001:${CH}:${THREAD}` };

async function run(rows: SlackTraceRow[], args: string[], claims: SlackTraceClaim[] = []) {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(m); });
  const code = await cmdFleetSlackTrace(args, { readTrace: () => trace(rows), readClaims: () => claims, now: () => NOW });
  return { code, out: logs.join('\n') };
}
const json = async (rows: SlackTraceRow[], args: string[], claims?: SlackTraceClaim[]) => {
  const r = await run(rows, [...args, '--json'], claims);
  return { code: r.code, rows: JSON.parse(r.out).rows as Array<Record<string, unknown>> };
};

afterEach(() => vi.restoreAllMocks());

describe('fleet slack-trace --work-state', () => {
  it('ingress evidence with no claim is RECEIVED and missing owner and receipt', async () => {
    const { rows } = await json([row()], ['--work-state']);
    expect(rows[0]).toMatchObject({ state: 'RECEIVED', stateAsOf: AT, stateMissing: ['named owner', 'durable claim receipt'] });
  });

  it('a claim bound to the thread with owner and receipt is ASSIGNED', async () => {
    const { rows } = await json([row()], ['--work-state'], [claim]);
    expect(rows[0]).toMatchObject({ state: 'ASSIGNED', stateAsOf: AT, stateMissing: [] });
  });

  it('a claim bound to a different thread does not assign the request', async () => {
    const other = { ...claim, threadKey: `slack:T0FAKE0001:${CH}:1700000999.000100` };
    const { rows } = await json([row()], ['--work-state'], [other]);
    expect(rows[0]!.state).toBe('RECEIVED');
  });

  it('an answered reply with no claim stays RECEIVED, never VERIFIED', async () => {
    const { rows } = await json([row({ outcome: 'answered', replyTs: '1700000050.000100' })], ['--work-state']);
    expect(rows[0]!.state).toBe('RECEIVED');
  });

  it('unknown ingress has no receivedAt: RECEIVED with as-of unknown', async () => {
    const { rows } = await json([row({ ingress: 'unknown' })], ['--work-state']);
    expect(rows[0]).toMatchObject({ state: 'RECEIVED', stateAsOf: 'unknown' });
  });

  it('prints state and missing in the text line', async () => {
    const { out } = await run([row()], ['--work-state']);
    expect(out).toContain(' state=RECEIVED missing=named owner,durable claim receipt');
  });

  it('without --work-state no state keys appear and the exit code is unchanged', async () => {
    const withFlag = await run([row({ outcome: 'answered' })], ['--work-state']);
    const without = await json([row({ outcome: 'answered' })], [], [claim]);
    expect(without.rows[0]).not.toHaveProperty('state');
    expect(without.rows[0]).not.toHaveProperty('stateMissing');
    expect(without.code).toBe(withFlag.code);
  });

  it('an unreadable claim store degrades to RECEIVED', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(m); });
    await cmdFleetSlackTrace(['--work-state', '--json'], { readTrace: () => trace([row()]),
      readClaims: () => { throw new Error('boom'); } });
    expect(JSON.parse(logs.join('')).rows[0].state).toBe('RECEIVED');
  });
});

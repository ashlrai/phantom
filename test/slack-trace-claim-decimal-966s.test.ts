import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSlackTrace } from '../src/cli/fleet-slack-trace.js';
import type { SlackRequestTraceRead, SlackTraceRow } from '../src/core/agents/slack-request-trace.js';
import { slackTraceRowsToWorkItems, type SlackTraceClaim } from '../src/core/comms/slack-trace-work-items.js';

const channel = 'C0FAKE0001';
const at = '2025-11-07T17:00:00.000Z';
const row: SlackTraceRow = { at, channelId: channel, threadTs: '01700000000.0001', messageTs: '1700000010.000100', ingress: 'posted', outcome: 'answered', replyTs: '1700000020.000100' };
const claim: SlackTraceClaim = { claimId: 'claim-1', repo: 'fake/repo', agent: 'agent-1', threadKey: `slack:T0FAKE0001:${channel}:1700000000.000100` };
const receipt = { owner: 'agent-1', claimReceipt: 'fake/repo#claim-1' };
const join = (claims: SlackTraceClaim[], input = row) => slackTraceRowsToWorkItems([input], claims)[0]!;

async function cli(claims: SlackTraceClaim[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const trace: SlackRequestTraceRead = { asOf: at, rows: [row], sources: { journal: 'ok', sends: 'ok' }, counts: { total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 } };
  const code = await cmdFleetSlackTrace(['--work-state', '--json'], { readTrace: () => trace, readClaims: () => claims });
  const result = JSON.parse(String(log.mock.calls[0]![0]));
  log.mockRestore();
  expect(code).toBe(0);
  return result.rows[0];
}

afterEach(() => vi.restoreAllMocks());

describe('decimal Slack claim identity', () => {
  it('joins both reference forms in either direction without altering row identity', () => {
    expect(join([claim])).toEqual({ id: `slack:${channel}:${row.messageTs}`, receivedAt: at, ...receipt });
    const reverse = { ...claim, threadKey: `T0FAKE0001/${channel}/01700000000.0001` };
    expect(join([reverse], { ...row, threadTs: '1700000000.000100' })).toMatchObject(receipt);
    expect(join([claim, reverse])).toMatchObject(receipt);
  });

  it.each([
    ['owner', { agent: 'agent-2' }],
    ['team', { threadKey: `T0FAKE0002/${channel}/01700000000.0001` }],
    ['repo', { repo: 'fake/other' }],
    ['claim', { claimId: 'claim-2' }],
  ])('refuses a competing %s in either order', (_label, difference) => {
    const other = { ...claim, threadKey: `T0FAKE0001/${channel}/01700000000.0001`, ...difference };
    for (const claims of [[claim, other], [other, claim]]) {
      expect(join(claims)).toEqual({ id: `slack:${channel}:${row.messageTs}`, receivedAt: at });
    }
  });

  it('isolates precise large timestamps, malformed rows, and other channels', () => {
    const large = { ...claim, threadKey: `slack:T0FAKE0001:${channel}:99999999999999999999.1234567891` };
    expect(join([large], { ...row, threadTs: '99999999999999999999.1234567890' })).not.toHaveProperty('owner');
    expect(join([large], { ...row, threadTs: '99999999999999999999.1234567891' })).toMatchObject(receipt);
    for (const threadTs of ['1700000000.0001x', '1700000000', ' 01700000000.0001', '1700000000.']) {
      expect(join([claim], { ...row, threadTs })).not.toHaveProperty('owner');
    }
    expect(join([claim], { ...row, channelId: 'C0FAKE0002' })).not.toHaveProperty('owner');
  });

  it('reports assignment only for an unambiguous durable claim through the CLI', async () => {
    expect(await cli([claim])).toMatchObject({ state: 'ASSIGNED', stateAsOf: at, stateMissing: [] });
    const other = { ...claim, agent: 'agent-2', threadKey: `T0FAKE0001/${channel}/01700000000.0001` };
    for (const claims of [[claim, other], [other, claim]]) {
      expect(await cli(claims)).toMatchObject({ state: 'RECEIVED', stateAsOf: at, stateMissing: ['named owner', 'durable claim receipt'] });
    }
    expect(await cli([])).toMatchObject({ state: 'RECEIVED' });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSlackTrace } from '../src/cli/fleet-slack-trace.js';
import type { SlackRequestTraceRead, SlackTraceRow } from '../src/core/agents/slack-request-trace.js';
import { slackTraceRowsToWorkItems, type SlackTraceClaim } from '../src/core/comms/slack-trace-work-items.js';

const channel = 'C0FAKE0001';
const thread = '1700000000.000100';
const at = '2025-11-07T17:00:00.000Z';
const row: SlackTraceRow = { at, channelId: channel, threadTs: thread, messageTs: '1700000010.000100', ingress: 'posted', outcome: 'answered', replyTs: '1700000020.000100' };
const claim: SlackTraceClaim = { claimId: 'claim-1', repo: 'fake/repo', agent: 'agent-1', threadKey: `slack:T0FAKE0001:${channel}:${thread}` };
const assigned = { owner: claim.agent, claimReceipt: 'fake/repo#claim-1', receivedAt: at };
const join = (claims: SlackTraceClaim[], rows = [row]) => slackTraceRowsToWorkItems(rows, claims);

async function cli(claims: SlackTraceClaim[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const trace: SlackRequestTraceRead = { asOf: at, rows: [row], sources: { journal: 'ok', sends: 'ok' },
    counts: { total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 } };
  const code = await cmdFleetSlackTrace(['--work-state', '--json'], { readTrace: () => trace, readClaims: () => claims });
  const result = JSON.parse(String(log.mock.calls[0]![0]));
  log.mockRestore();
  return { code, row: result.rows[0] };
}

afterEach(() => vi.restoreAllMocks());

describe('Slack claim attribution ambiguity', () => {
  it('refuses conflicts in either order, including an answered transport receipt', async () => {
    const other = { ...claim, agent: 'agent-2' };
    for (const claims of [[claim, other], [other, claim]]) {
      expect(join(claims)[0]).toEqual({ id: `slack:${channel}:${row.messageTs}`, receivedAt: at });
      const result = await cli(claims);
      expect(result.code).toBe(0);
      expect(result.row).toMatchObject({ state: 'RECEIVED', stateAsOf: at, stateMissing: ['named owner', 'durable claim receipt'] });
    }
  });

  it('assigns a single claim and deduplicates identical and equivalent references', async () => {
    const slash = { ...claim, threadKey: `T0FAKE0001/${channel}/${thread}` };
    expect(join([claim])[0]).toMatchObject(assigned);
    expect(join([claim, claim, slash])[0]).toMatchObject(assigned);
    expect((await cli([claim])).row).toMatchObject({ state: 'ASSIGNED', stateAsOf: at, stateMissing: [] });
  });

  it.each([
    ['workspace', { threadKey: `slack:T0FAKE0002:${channel}:${thread}` }],
    ['repository', { repo: 'fake/other' }],
    ['owner', { agent: 'agent-2' }],
    ['claim ID', { claimId: 'claim-2' }],
  ])('refuses distinct %s identities', (_label, difference) => {
    expect(join([claim, { ...claim, ...difference }])[0]).toEqual({ id: `slack:${channel}:${row.messageTs}`, receivedAt: at });
  });

  it('ignores malformed references and blank identity fields', () => {
    const invalid = [
      { ...claim, threadKey: 'bad' }, { ...claim, repo: ' ' },
      { ...claim, agent: '\t' }, { ...claim, claimId: '' },
    ];
    expect(join([claim, ...invalid])[0]).toMatchObject(assigned);
    expect(join(invalid)[0]).toEqual({ id: `slack:${channel}:${row.messageTs}`, receivedAt: at });
  });

  it('isolates unrelated threads', () => {
    const otherThread = '1700000099.000100';
    const otherRow = { ...row, threadTs: otherThread, messageTs: otherThread };
    const other = { ...claim, agent: 'agent-2', threadKey: `slack:T0FAKE0001:${channel}:${otherThread}` };
    expect(join([claim, other], [row, otherRow])).toMatchObject([assigned, { owner: 'agent-2', claimReceipt: 'fake/repo#claim-1' }]);
  });
});

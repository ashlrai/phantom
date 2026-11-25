import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSlackTrace, readSlackTraceClaims } from '../src/cli/fleet-slack-trace.js';
import type { SlackRequestTraceRead } from '../src/core/agents/slack-request-trace.js';
import type { SlackTraceClaim } from '../src/core/comms/slack-trace-work-items.js';

const at = '2025-11-07T17:00:00.000Z';
const channel = 'C0FAKE0001';
const thread = '1700000000.000100';
const claim: SlackTraceClaim = { claimId: 'claim-1', repo: 'fake/repo', agent: 'agent-1', threadKey: `slack:T0FAKE0001:${channel}:${thread}` };
const trace: SlackRequestTraceRead = { asOf: '2025-11-07T18:00:00.000Z', sources: { journal: 'ok', sends: 'ok' },
  rows: [{ at, channelId: channel, threadTs: thread, messageTs: '1700000010.000100', ingress: 'posted', outcome: 'answered' }],
  counts: { total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 } };

async function run(args: string[], readClaims: () => readonly SlackTraceClaim[]) {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
  const code = await cmdFleetSlackTrace(args, { readTrace: () => trace, readClaims });
  log.mockRestore();
  return { code, output: lines.join('\n') };
}
afterEach(() => vi.restoreAllMocks());

describe('slack trace work provenance', () => {
  it('retains unique claim evidence in JSON and text without treating a reply as execution', async () => {
    const json = await run(['--work-state', '--json'], () => [claim]);
    expect(json.code).toBe(0); // Exit status reports reply transport, not execution verification.
    expect(JSON.parse(json.output)).toMatchObject({ claimSourceHealth: 'ok', rows: [{ state: 'ASSIGNED', owner: 'agent-1',
      claimReceipt: 'fake/repo#claim-1', stateSource: 'claim:fake/repo#claim-1', stateAsOf: at, outcome: 'answered' }] });
    const text = await run(['--work-state'], () => [claim]);
    expect(text.output).toContain(`asOf=${at} source=claim:fake/repo#claim-1 owner=agent-1 claimReceipt=fake/repo#claim-1`);
    expect(text.output).toContain('claimSourceHealth=ok');
  });

  it('does not select a conflicting owner or receipt', async () => {
    const result = JSON.parse((await run(['--work-state', '--json'], () => [claim, { ...claim, agent: 'agent-2' }])).output);
    expect(result.rows[0]).toMatchObject({ state: 'RECEIVED', stateSource: 'receivedAt' });
    expect(result.rows[0]).not.toHaveProperty('owner');
    expect(result.rows[0]).not.toHaveProperty('claimReceipt');
  });

  it('distinguishes empty from unavailable claims without echoing errors or changing exit status', async () => {
    const empty = await run(['--work-state', '--json'], () => []);
    const failed = await run(['--work-state', '--json'], () => { throw new Error('/secret/path sensitive'); });
    expect(JSON.parse(empty.output).claimSourceHealth).toBe('ok');
    expect(JSON.parse(failed.output)).toMatchObject({ claimSourceHealth: 'unavailable', rows: [{ state: 'RECEIVED' }] });
    expect(failed.output).not.toContain('/secret/path');
    expect(failed.code).toBe(empty.code);
    expect((await run(['--work-state'], () => { throw new Error('sensitive'); })).output).toContain('claimSourceHealth=unavailable');
  });

  it('does not read claims or add fields to a plain trace', async () => {
    const readClaims = vi.fn(() => [claim]);
    const result = await run(['--json'], readClaims);
    expect(readClaims).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).not.toHaveProperty('claimSourceHealth');
    expect(JSON.parse(result.output).rows[0]).not.toHaveProperty('state');
  });

  it('treats an unknown board as unavailable', () => {
    expect(() => readSlackTraceClaims({ readBoard: () => ({ schema: 'fleet.coordination.v1', state: 'unknown', claims: [], leases: [], asOf: at }) as never })).toThrow();
  });
});

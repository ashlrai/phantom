import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetSlackTrace, readSlackTraceClaims } from '../src/cli/fleet-slack-trace.js';
import type { SlackRequestTraceRead } from '../src/core/agents/slack-request-trace.js';
import type { SlackTraceClaim } from '../src/core/comms/slack-trace-work-items.js';

const at = '2025-11-07T17:00:00.000Z';
const trace: SlackRequestTraceRead = { asOf: '2025-11-08T17:00:00.000Z', sources: { journal: 'ok', sends: 'ok' },
  counts: { total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 },
  rows: [{ at, channelId: 'C0FAKE0001', threadTs: '1700000000.000100', messageTs: '1700000010.000100', ingress: 'posted', outcome: 'answered' }] };
const claim: SlackTraceClaim = { claimId: 'claim-1', repo: 'fake/repo', agent: 'agent-1', threadKey: 'slack:T0FAKE0001:C0FAKE0001:1700000000.000100' };

async function run(args: string[], readClaims: () => readonly SlackTraceClaim[] = () => [claim]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetSlackTrace(args, { readTrace: () => trace, readClaims });
  const output = log.mock.calls.map(call => String(call[0])).join('\n');
  log.mockRestore();
  return { code, output };
}
afterEach(() => vi.restoreAllMocks());

it('reports the joined owner and classifier source in JSON and text', async () => {
  const json = await run(['--work-state', '--json']);
  expect(json.code).toBe(0);
  expect(JSON.parse(json.output).rows[0]).toMatchObject({ state: 'ASSIGNED', stateOwner: 'agent-1', stateSource: 'claim:fake/repo#claim-1', stateAsOf: at });
  expect((await run(['--work-state'])).output).toContain('state=ASSIGNED owner=agent-1 source=claim:fake/repo#claim-1');
});

it('does not attribute ambiguous, unknown or unreadable claims, even with an answered reply', async () => {
  const unknown = () => readSlackTraceClaims({ readBoard: () => ({ schema: 'fleet.coordination.v1', state: 'unknown', claims: [], messages: [], proposals: [], expiredClaims: 0 }) });
  for (const reader of [() => [claim, { ...claim, agent: 'agent-2' }], unknown, () => { throw new Error('unreadable'); }, () => []]) {
    const result = await run(['--work-state', '--json'], reader);
    const row = JSON.parse(result.output).rows[0];
    expect(result.code).toBe(0);
    expect(row).toMatchObject({ state: 'RECEIVED', stateSource: 'receivedAt', stateAsOf: at });
    expect(row).not.toHaveProperty('stateOwner');
    expect((await run(['--work-state'], reader)).output).toContain('state=RECEIVED owner=unknown source=receivedAt');
  }
});

it('leaves the original output unchanged without the flag', async () => {
  const result = await run(['--json'], () => { throw new Error('must not read claims'); });
  expect(JSON.parse(result.output).rows[0]).not.toHaveProperty('stateOwner');
  expect(JSON.parse(result.output).rows[0]).not.toHaveProperty('stateSource');
  expect((await run([])).output).not.toMatch(/state=|owner=|source=/);
});

it('scrubs secrets and line controls from owner and source in both formats', async () => {
  const unsafe = { ...claim, agent: 'agent\nINJECT\u001b[31m', repo: 'fake\u2028repo', claimId: 'claim\rINJECT' };
  const json = JSON.parse((await run(['--work-state', '--json'], () => [unsafe])).output).rows[0];
  expect(json.stateOwner).toBe('agent INJECT [31m');
  expect(json.stateSource).toBe('claim:fake repo#claim INJECT');
  const text = (await run(['--work-state'], () => [unsafe])).output;
  expect(text.split('\n')).toHaveLength(2);
  for (const control of ['\r', '\u001b', '\u2028']) expect(text).not.toContain(control);
});

import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetSlackTrace, readSlackTraceClaims } from '../src/cli/fleet-slack-trace.js';
import type { SlackRequestTraceRead, SlackTraceRow } from '../src/core/agents/slack-request-trace.js';
import { slackTraceRowsToWorkItems } from '../src/core/comms/slack-trace-work-items.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const at = '2025-11-07T17:00:00.000Z';
const channel = 'C0FAKE0001';
const threads = ['1700000000.000100', '1700000000.000200'];
const claim = { id: 'claim-1', repo: 'fake/repo', agent: 'agent-1', task: 'fake', claimedAt: 1, expiresAt: 2 };
const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', claims: [claim], messages: [], proposals: [], expiredClaims: 0 };
const bindings = threads.map(thread => ({ claimId: claim.id, repo: claim.repo, threadKey: `slack:T0FAKE0001:${channel}:${thread}` }));
const rows: SlackTraceRow[] = threads.map(thread => ({ at, channelId: channel, threadTs: thread, messageTs: thread, ingress: 'posted', outcome: 'answered' }));
const trace: SlackRequestTraceRead = { asOf: at, rows, sources: { journal: 'ok', sends: 'ok' }, counts: { total: 2, answered: 2, uncertain: 0, busFailed: 0, unanswered: 0 } };

async function classify(currentBoard: FleetBoard, currentBindings: typeof bindings) {
  const readBoard = vi.fn(() => currentBoard);
  const readBindings = vi.fn(() => currentBindings);
  const claims = readSlackTraceClaims({ readBoard, readBindings });
  expect(readBoard).toHaveBeenCalledWith({ reap: false });
  const items = slackTraceRowsToWorkItems(rows, claims);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetSlackTrace(['--work-state', '--json'], { readTrace: () => trace, readClaims: () => claims });
  const result = JSON.parse(String(log.mock.calls[0]![0])) as { rows: { state: string }[] };
  log.mockRestore();
  expect(code).toBe(0);
  return { items, states: result.rows.map(row => row.state), readBindings };
}

afterEach(() => vi.restoreAllMocks());

it('assigns every bound thread independently of order and duplicate rows', async () => {
  for (const input of [bindings, [...bindings].reverse(), [bindings[0]!, ...bindings]]) {
    const result = await classify(board, input);
    expect(result.states).toEqual(['ASSIGNED', 'ASSIGNED']);
    expect(result.items.map(item => [item.owner, item.claimReceipt])).toEqual([
      ['agent-1', 'fake/repo#claim-1'], ['agent-1', 'fake/repo#claim-1'],
    ]);
  }
});

it('rejects bindings for another repository or claim', async () => {
  const result = await classify(board, [
    { ...bindings[0]!, repo: 'fake/other' }, { ...bindings[1]!, claimId: 'claim-2' },
  ]);
  expect(result.states).toEqual(['RECEIVED', 'RECEIVED']);
});

it('keeps competing live owners ambiguous for the shared thread', async () => {
  const other = { ...claim, id: 'claim-2', agent: 'agent-2' };
  const result = await classify({ ...board, claims: [claim, other] }, [
    ...bindings, { ...bindings[0]!, claimId: other.id },
  ]);
  expect(result.states).toEqual(['RECEIVED', 'ASSIGNED']);
});

it('does not read bindings or assign when the board is unknown', async () => {
  const result = await classify({ ...board, state: 'unknown' }, bindings);
  expect(result.readBindings).not.toHaveBeenCalled();
  expect(result.states).toEqual(['RECEIVED', 'RECEIVED']);
});

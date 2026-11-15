import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimFleetWork, postFleetMessage, proposeFleetAssignment, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim, type FleetClaimReturnInput } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'returns-view-377-'));
  dirs.push(dir);
  const options = { path: join(dir, 'board.jsonl'), now: 1000 };
  function receipt(form: Partial<FleetClaimReturnInput>, task = 'Return "quoted" work') {
    const claimed = claimFleetWork({ repo: 'example/demo', task, agent: 'test-agent' }, options);
    if (!claimed.ok) throw new Error('fixture claim failed');
    const result = returnFleetClaim({ id: claimed.value.claim.id, agent: 'test-agent', lease: claimed.value.lease, ...form }, options);
    expect(result.outcome).toBe('returned');
    options.now++;
    return claimed.value.claim.id;
  }
  const project = () => projectCoordinationReturns(readFleetBoard(options), options.now);
  return { options, receipt, project };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('coordination RESULT projection', () => {
  it('reads real PR, tests, artifact and blocked receipts newest first without private fields', () => {
    const { options, receipt, project } = fixture();
    const id = receipt({ pr: 377, head: 'abc1234' });
    receipt({ tests: '12 tests passed' });
    receipt({ artifact: 'report.txt' });
    receipt({ blocked: 'upstream change needed' });
    expect(claimFleetWork({ repo: 'example/demo', task: 'Still active', agent: 'other-agent' }, options).ok).toBe(true);
    expect(proposeFleetAssignment({ repo: 'example/demo', task: 'Proposed', to: 'test-agent' }, options).ok).toBe(true);
    const output = project();
    expect(output).toMatchObject({ v: 1, source: 'coordination-ledger', state: 'known', unparsed: 0,
      asOf: new Date(options.now).toISOString() });
    expect(output.returns).toEqual([
      expect.objectContaining({ result: 'BLOCKED', evidenceKind: 'dependency', evidence: 'dependency upstream change needed', pr: null, head: null }),
      expect.objectContaining({ result: 'VERIFIED', evidenceKind: 'artifact', pr: null, head: null }),
      expect.objectContaining({ result: 'VERIFIED', evidenceKind: 'tests', pr: null, head: null }),
      { claimId: id, repo: 'example/demo', result: 'VERIFIED', evidenceKind: 'pr', pr: 377, head: 'abc1234',
        evidence: 'pr #377 head abc1234', from: 'test-agent', at: new Date(1000).toISOString(), expiresAt: new Date(86401000).toISOString() },
    ]);
    expect(JSON.stringify(output)).not.toContain('lease');
  });
  it('counts malformed and mismatched return ids while ignoring other messages', () => {
    const { options, project } = fixture();
    const bodies = [
      ['return-x', 'malformed'],
      ['return-y', 'RESULT VERIFIED example/demo claim x task "Work": tests passed'],
      ['return-z', 'RESULT BLOCKED example/demo claim z task "Work": tests passed'],
      ['return-a', 'RESULT VERIFIED example/demo claim a task "Work": pr #9007199254740992 head abc1234'],
      ['ordinary', 'RESULT VERIFIED example/demo claim ordinary task "Work": tests passed'],
    ];
    for (const [id, body] of bodies) {
      expect(postFleetMessage({ id, body: body!, from: 'test-agent', to: 'all' }, options).ok).toBe(true);
    }
    expect(project()).toMatchObject({ state: 'known', returns: [], unparsed: 4 });
  });
  it('reports reader failures as unknown, including an unavailable ledger', () => {
    const { options } = fixture();
    for (const board of [null, readFleetBoard(options)]) {
      const output = projectCoordinationReturns(board, 1000);
      expect(output).toMatchObject({ state: 'unknown', returns: [], unparsed: 0, reason: expect.stringContaining('reader failed') });
      expect(JSON.stringify(output)).not.toContain('lease');
    }
  });
  it('caps evidence at 300 characters and selects only the newest 50 without mutating the board', () => {
    const { options, receipt } = fixture();
    receipt({ tests: 'x'.repeat(400) });
    const board = readFleetBoard(options);
    const message = board.messages[0]!;
    board.messages = Array.from({ length: 55 }, (_, i) => ({ ...message, at: 1000 + i }));
    const before = JSON.stringify(board);
    const output = projectCoordinationReturns(board, options.now);
    expect(output.returns).toHaveLength(50);
    expect(output.returns[0]?.at).toBe(new Date(1054).toISOString());
    expect(output.returns[49]?.at).toBe(new Date(1005).toISOString());
    expect(output.returns[0]?.evidence).toHaveLength(300);
    expect(JSON.stringify(board)).toBe(before);
  });
});

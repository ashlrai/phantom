import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimFleetWork, concludeFleetClaim, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'recut-c400-'));
  dirs.push(dir);
  const options = { path: join(dir, 'board.jsonl'), now: 5000 };
  const claim = claimFleetWork({ repo: 'ashlrai/phantom', task: 'Recut durable return', agent: 'agent-a' }, options);
  if (!claim.ok) throw new Error('fixture claim failed');
  return { options, id: claim.value.claim.id, lease: claim.value.lease };
}
const kinds = (path: string, kind: string): unknown[] =>
  readFileSync(path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as { kind: string }).filter(e => e.kind === kind);

describe('concludeFleetClaim durable return intent (recut of #5746)', () => {
  it('records intent without posting, then resolves the pending intent on a lease-verified retry', () => {
    const { options, id, lease } = fixture();
    const message = { id: `return-${id}`, from: 'agent-a', to: 'all', body: 'RESULT VERIFIED ashlrai/phantom: tests passed' };
    const intended = concludeFleetClaim({ id, agent: 'agent-a', lease, message }, options);
    expect(intended).toMatchObject({ ok: true, value: { outcome: 'intended', message: { id: message.id } } });
    // The claim is durably released but no receipt reached the board yet.
    expect(readFleetBoard(options)).toMatchObject({ claims: [], messages: [] });
    expect(kinds(options.path, 'return')).toHaveLength(1);
    expect(kinds(options.path, 'post')).toHaveLength(0);
    // Retry without the live claim: the stored intent reposts the same receipt.
    const resolved = concludeFleetClaim({ id, agent: 'agent-a', lease }, options);
    expect(resolved).toMatchObject({ ok: true, value: { outcome: 'resolved', message: { id: message.id, body: message.body } } });
    // A third call sees the posted receipt and stays idempotent.
    expect(concludeFleetClaim({ id, agent: 'agent-a', lease }, options))
      .toMatchObject({ ok: true, value: { outcome: 'existing' } });
    expect(kinds(options.path, 'return')).toHaveLength(1);
    expect(kinds(options.path, 'post')).toHaveLength(1);
    expect(readFleetBoard(options).messages).toHaveLength(1);
  });
  it('rejects non-owners and bad input without touching the ledger', () => {
    const { options, id, lease } = fixture();
    const before = readFileSync(options.path, 'utf8');
    expect(concludeFleetClaim({ id, agent: 'agent-b', lease }, options)).toEqual({ ok: false, error: 'not-owner' });
    expect(concludeFleetClaim({ id, agent: 'agent-a', lease: 'wrong' }, options)).toEqual({ ok: false, error: 'not-owner' });
    expect(concludeFleetClaim({ id: 'no-such-claim', agent: 'agent-a', lease }, options)).toEqual({ ok: false, error: 'not-found' });
    expect(concludeFleetClaim({ id, agent: 'agent-a', lease }, options)).toEqual({ ok: false, error: 'invalid-input' });
    expect(readFileSync(options.path, 'utf8')).toBe(before);
  });
  it('completes a stranded returnFleetClaim intent through the exported surface', () => {
    const { options, id, lease } = fixture();
    const message = { id: `return-${id}`, from: 'agent-a', to: 'all', body: 'RESULT VERIFIED ashlrai/phantom claim x: tests passed' };
    expect(concludeFleetClaim({ id, agent: 'agent-a', lease, message }, options)).toMatchObject({ ok: true, value: { outcome: 'intended' } });
    const retry = returnFleetClaim({ id, agent: 'agent-a', lease, tests: 'passed' }, options);
    expect(retry).toMatchObject({ ok: true, outcome: 'returned', claimId: id, message: { id: message.id, body: message.body } });
    expect(kinds(options.path, 'post')).toHaveLength(1);
  });
});

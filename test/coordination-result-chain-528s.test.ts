import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it('keeps the latest of three persisted heads across reloads and isolates another claim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'result-chain-528s-'));
  const options = { path: join(dir, 'coordination.jsonl'), now: 10_000, reap: false };
  const heads = ['abcdef1234567890', '1234567890abcdef', 'fedcba9876543210'];
  const otherHead = '9876543210abcdef';
  const bytes = () => readFileSync(options.path, 'utf8');
  try {
    let coordination = await import('../src/core/fleet/coordination.js');
    let returns = await import('../src/core/fleet/coordination-return.js');
    let view = await import('../src/core/fleet/coordination-returns-view.js');
    const owned = coordination.claimFleetWork({ repo: 'fake-chain/project', task: 'fake chain', agent: 'fake-agent-one' }, options);
    const other = coordination.claimFleetWork({ repo: 'fake-other/project', task: 'fake independent task', agent: 'fake-agent-two' }, options);
    if (!owned.ok || !other.ok) throw new Error('fake claims failed');
    const input = { id: owned.value.claim.id, agent: 'fake-agent-one', lease: owned.value.lease, pr: 7 };
    const otherInput = { id: other.value.claim.id, agent: 'fake-agent-two', lease: other.value.lease, pr: 8, head: otherHead };
    const projected = () => view.projectCoordinationReturns(coordination.readFleetBoard(options), options.now);
    expect(returns.returnFleetClaim({ ...input, head: heads[0] }, options)).toMatchObject({ ok: true, outcome: 'returned' });
    expect(returns.returnFleetClaim(otherInput, options)).toMatchObject({ ok: true, outcome: 'returned' });
    const afterA = bytes();
    options.now++;
    expect(returns.returnFleetClaim({ ...input, agent: 'fake-intruder', head: heads[1] }, options).outcome).toBe('not-owner');
    expect(returns.returnFleetClaim({ ...input, lease: 'fake-wrong-lease', head: heads[1] }, options).outcome).toBe('not-owner');
    expect(bytes()).toBe(afterA);
    expect(returns.returnFleetClaim({ ...input, head: heads[1] }, options)).toMatchObject({ ok: true, outcome: 'returned' });
    const afterB = bytes();
    expect(afterB.startsWith(afterA)).toBe(true);

    vi.resetModules();
    coordination = await import('../src/core/fleet/coordination.js');
    returns = await import('../src/core/fleet/coordination-return.js');
    view = await import('../src/core/fleet/coordination-returns-view.js');
    options.now++;
    expect(returns.returnFleetClaim({ ...input, agent: 'fake-intruder', head: heads[2] }, options).outcome).toBe('not-owner');
    expect(returns.returnFleetClaim({ ...input, lease: 'fake-wrong-lease', head: heads[2] }, options).outcome).toBe('not-owner');
    expect(bytes()).toBe(afterB);
    expect(returns.returnFleetClaim({ ...input, head: heads[2] }, options)).toMatchObject({ ok: true, outcome: 'returned' });
    const afterC = bytes();
    expect(afterC.startsWith(afterB)).toBe(true);

    vi.resetModules();
    coordination = await import('../src/core/fleet/coordination.js');
    returns = await import('../src/core/fleet/coordination-return.js');
    view = await import('../src/core/fleet/coordination-returns-view.js');
    options.now++;
    for (const head of heads) {
      expect(returns.returnFleetClaim({ ...input, head }, options)).toMatchObject({ ok: true, outcome: 'already-returned' });
      expect(bytes()).toBe(afterC);
      const projection = projected();
      expect(projection).toMatchObject({ state: 'known', unparsed: 0 });
      expect(projection.returns).toHaveLength(2);
      expect(projection.returns.find(row => row.claimId === input.id)).toMatchObject({ repo: 'fake-chain/project', head: heads[2], result: 'VERIFIED', temporal: 'current' });
      expect(projection.returns.find(row => row.claimId === otherInput.id)).toMatchObject({ repo: 'fake-other/project', head: otherHead, result: 'VERIFIED', temporal: 'current' });
    }
    expect(afterA).toContain(heads[0]);
    expect(afterB).toContain(heads[1]);
  } finally {
    vi.resetModules();
    rmSync(dir, { recursive: true, force: true });
  }
});

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { claimFleetWork, postFleetMessage, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';

it('opts into published return history without reviving live messages or ownership (C574)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redtestfix-c574-'));
  try {
    const options = { path: join(dir, 'board.jsonl'), now: 1000 };
    const claim = claimFleetWork({ repo: 'example/history', task: 'fake work', agent: 'fake-agent' }, options);
    if (!claim.ok) throw new Error('fake claim failed');
    expect(returnFleetClaim({ id: claim.value.claim.id, agent: 'fake-agent', lease: claim.value.lease,
      tests: 'synthetic test evidence', ttlMs: 1000 }, options).outcome).toBe('returned');
    expect(postFleetMessage({ id: 'ordinary', from: 'fake-agent', to: 'all', body: 'fake notice', ttlMs: 1000 }, options).ok).toBe(true);
    expect(postFleetMessage({ id: 'return-fake', from: 'fake-agent', to: 'all',
      body: 'RESULT VERIFIED example/history claim fake task "fake": tests fake', ttlMs: 1000 }, options).ok).toBe(true);
    const bytes = readFileSync(options.path);
    const later = { ...options, now: 2000 };
    expect(readFleetBoard({ ...later, reap: false }).messages).toEqual([]);
    expect(readFleetBoard({ ...later, includeExpiredReturns: true }).messages).toEqual([]);
    for (const now of [1999, 2000, 3000]) {
      const board = readFleetBoard({ ...options, now, reap: false, includeExpiredReturns: true });
      expect(board.claims).toEqual([]);
      const view = projectCoordinationReturns(board, now);
      expect(view.returns).toEqual([expect.objectContaining({ claimId: claim.value.claim.id,
        temporal: now < 2000 ? 'current' : 'expired', evidence: 'tests synthetic test evidence' }),
      ...(now < 2000 ? [expect.objectContaining({ claimId: 'fake', temporal: 'current' })] : [])]);
      if (now >= 2000) expect(board.messages).toHaveLength(1);
      expect(readFileSync(options.path)).toEqual(bytes);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

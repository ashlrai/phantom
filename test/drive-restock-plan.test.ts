import { describe, expect, it } from 'vitest';
import { planDriveRestock } from '../src/core/drive/restock-plan.js';
import type { QueueDocument, QueueJob } from '../src/core/queue/schema.js';

const job = (id: string, scope = 'Improve docs'): QueueJob => ({ id, scope, status: 'PROPOSED', priority: 'P2', pool: 'codex-personal', tier: 'work', repo: 'phantom', deps: [], acceptance: 'Tests pass', claims: [] });
const queue = (...jobs: QueueJob[]): QueueDocument => ({ schema: 'queue.v1', jobs });

describe('drive restock planning', () => {
  it('ranks scored proposals and accounts for READY jobs against free capacity', () => {
    const ready = { ...job('ready'), status: 'READY' as const };
    const result = planDriveRestock(queue(ready, job('low'), job('high'), job('unscored')), [{ pool: 'codex-personal', freeSlots: 1 }], [{ id: 'low', impact: 1 }, { id: 'high', impact: 5 }]);
    expect(result.promotions).toEqual(['high', 'low']);
    expect(result.deficits['codex-personal']).toBe(0);
  });
  it('holds protected paths, holds and unfinished dependencies', () => {
    const jobs = [job('a', '.github/workflows/a'), job('b', 'ashlr-plugin/server/index.ts'), job('c', 'phantom #878'), { ...job('d'), deps: ['missing'] }];
    const result = planDriveRestock(queue(...jobs), [{ pool: 'codex-personal', freeSlots: 1 }], jobs.map(({ id }) => ({ id, impact: 1 })));
    expect(result.promotions).toEqual([]);
    expect(result.deficits['codex-personal']).toBe(3);
  });
  it('rejects ambiguous metrics and capacity', () => {
    expect(() => planDriveRestock(queue(job('a')), [], [{ id: 'a', impact: 1 }, { id: 'a', impact: 2 }])).toThrow();
    expect(() => planDriveRestock(queue(), [{ pool: 'x', freeSlots: -1 }], [])).toThrow();
  });
});

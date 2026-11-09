import { describe, expect, it } from 'vitest';
import { summarizeRebases, readRebaseStatus } from '../src/core/fleet/rebase-status.js';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = Date.parse('2026-11-07T12:00:00Z');
const pr = (number: number, extra = {}) => ({ number, title: 'bridge: work', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', createdAt: '2026-11-07T11:00:00Z', headRefOid: 'abcdef0123456789', ...extra });
describe('rebase status', () => {
  it('counts only conflicting bridge PRs and joins active jobs to the current head', () => {
    const report = summarizeRebases('ashlrai/phantom', [pr(1), pr(2), pr(3), pr(4, { headRefOid: '' }), pr(5, { title: 'other' }), pr(6, { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })], [
      { id: 'RQ-REBASE-phantom-1-abcdef0', status: 'READY' },
      { id: 'RQ-REBASE-phantom-1-abcdef0', status: 'RUNNING' },
      { id: 'RQ-REBASE-phantom-2-1234567', status: 'PARKED-HOLD.dev' },
      { id: 'RQ-REBASE-phantom-3-abcdef0', status: 'DONE' },
    ], now);
    expect(report).toEqual({ conflicting: 4, ageSeconds: { oldest: 3600, median: 3600, unknown: 0 }, coverage: { currentHead: 1, staleHeadOnly: 1, uncovered: 1, unknownHead: 1 } });
  });
  it('does not invent ages for invalid or future timestamps', () => {
    const report = summarizeRebases('a/b', [pr(1, { createdAt: 'bad' }), pr(2, { createdAt: '2027-01-01' })], [], now);
    expect(report.ageSeconds).toEqual({ oldest: null, median: null, unknown: 2 });
  });
  it('reports missing queue instead of empty success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rebase-status-'));
    try {
      await mkdir(join(root, 'queue'));
      await writeFile(join(root, 'queue', 'ready.tsv'), 'status\tid\tlane\nREADY\tjob\tdevin\n');
      expect((await readRebaseStatus([], root, new Date(now))).queueSource).toBe('healthy');
      await rm(join(root, 'queue', 'ready.tsv'));
      expect((await readRebaseStatus([], root, new Date(now))).queueSource).toBe('missing');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

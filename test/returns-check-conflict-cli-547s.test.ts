import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetReturnsCheck } from '../src/cli/fleet-returns-check.js';
import { claimFleetWork } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';

const at = Date.parse('2026-11-17T12:00:00Z');
const heads = ['abc1234', '9998887'];
const observed = ['abc1234def567890abcdef1234567890abcdef12', '9998887def567890abcdef1234567890abcdef12'];

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('disk-backed returns-check head conflicts', () => {
  it.each([
    { reverse: false, distinct: false },
    { reverse: true, distinct: false },
    { reverse: false, distinct: true },
  ])('checks each receipt in both output modes: $reverse $distinct', async ({ reverse, distinct }) => {
    const root = mkdtempSync(join(tmpdir(), 'returns-conflict-547s-'));
    try {
      for (const key of ['HOME', 'ASHLR_HOME', 'ASHLR_RUNS_ROOT']) vi.stubEnv(key, root);
      const path = join(root, 'coordination.jsonl');
      vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', path);
      const rows = heads.map((head, index) => ({ head, pr: distinct ? 547 + index : 547, task: `fake task ${index}` }));
      if (reverse) rows.reverse();
      const receipts = rows.map(row => {
        const options = { path, now: at };
        const claim = claimFleetWork({ repo: 'fake/repo', task: row.task, agent: 'fake-agent' }, options);
        if (!claim.ok) throw new Error(`fixture claim failed: ${claim.error}`);
        expect(returnFleetClaim({ id: claim.value.claim.id, agent: 'fake-agent', lease: claim.value.lease,
          pr: row.pr, head: row.head, ttlMs: 60_000 }, options).ok).toBe(true);
        return { ...row, claimId: claim.value.claim.id };
      });
      expect(new Set(receipts.map(row => row.claimId)).size).toBe(2);
      const gh = vi.fn(async (args: string[]) => {
        const endpoint = args.at(-1);
        if (endpoint !== 'repos/fake/repo/pulls/547' && !(distinct && endpoint === 'repos/fake/repo/pulls/548')) {
          throw new Error('unexpected fake endpoint');
        }
        return JSON.stringify({ merged: true, merged_at: '2026-11-17T11:00:00Z',
          head: { sha: endpoint.endsWith('/548') ? observed[1] : observed[0] } });
      });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const bytes = readFileSync(path);
      const entries = readdirSync(root).sort();
      for (const args of [['--json'], []]) {
        log.mockClear();
        gh.mockClear();
        expect(await cmdFleetReturnsCheck(args, { gh, now: () => at + 1_000 })).toBe(distinct ? 0 : 1);
        expect(readFileSync(path)).toEqual(bytes);
        expect(readdirSync(root).sort()).toEqual(entries);
        expect(gh).toHaveBeenCalledTimes(2);
        const output = log.mock.calls.map(call => String(call[0])).join('\n');
        if (args.length) {
          const report = JSON.parse(output);
          expect(report).toMatchObject({ authority: 'none', asOf: new Date(at + 1_000).toISOString(),
            returnsState: 'known', skipped: 0, truncated: false });
          expect(report.receipts).toHaveLength(2);
          expect(report.checked).toHaveLength(2);
          for (const row of receipts) {
            const verdict = distinct || row.head === heads[0] ? 'merged-at-head' : 'merged-other-head';
            expect(report.receipts).toEqual(expect.arrayContaining([expect.objectContaining({
              claimId: row.claimId, repo: 'fake/repo', pr: row.pr, head: row.head, temporal: 'current',
            })]));
            expect(report.checked).toEqual(expect.arrayContaining([expect.objectContaining({
              claimId: row.claimId, repo: 'fake/repo', pr: row.pr, head: row.head, verdict,
              observedHead: distinct && row.pr === 548 ? observed[1] : observed[0],
            })]));
          }
        } else {
          for (const row of receipts) {
            const verdict = distinct || row.head === heads[0] ? 'merged-at-head' : 'merged-other-head';
            const actualHead = distinct && row.pr === 548 ? heads[1] : heads[0];
            expect(output).toContain(`${verdict}  fake/repo#${row.pr}  claimed ${row.head} observed ${actualHead} (${row.claimId})`);
            expect(output).toContain(`receipt temporal=current  fake/repo#${row.pr} (${row.claimId})`);
          }
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});

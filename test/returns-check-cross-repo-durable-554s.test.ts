import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetReturnsCheck } from '../src/cli/fleet-returns-check.js';
import { claimFleetWork } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';

const at = Date.parse('2026-11-17T22:00:00Z');
const observedAt = at + 1_000;
const pr = 554;
const items = [
  { repo: 'synthetic-orchard/alpha', agent: 'reviewer-alpha', task: 'Review alpha return', head: 'a'.repeat(40) },
  { repo: 'synthetic-harbor/beta', agent: 'reviewer-beta', task: 'Review beta return', head: 'b'.repeat(40) },
];

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('independent second reading of durable cross-repository returns', () => {
  it.each([
    { reverse: false, betaState: 'open' },
    { reverse: true, betaState: 'open' },
    { reverse: false, betaState: 'closed' },
    { reverse: true, betaState: 'closed' },
  ])('isolates colliding PRs: reverse=$reverse beta=$betaState', async ({ reverse, betaState }) => {
    const root = mkdtempSync(join(tmpdir(), 'returns-cross-repo-554s-'));
    try {
      for (const key of ['HOME', 'USERPROFILE', 'ASHLR_HOME', 'ASHLR_RUNS_ROOT']) vi.stubEnv(key, root);
      const path = join(root, 'coordination.jsonl');
      vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', path);
      vi.spyOn(Date, 'now').mockReturnValue(observedAt);
      const ordered = reverse ? [...items].reverse() : items;
      const privateValues: string[] = [];
      const receipts = ordered.map(item => {
        const options = { path, now: at };
        const claim = claimFleetWork(item, options);
        if (!claim.ok) throw new Error(`synthetic claim failed: ${claim.error}`);
        const { lease } = claim.value;
        privateValues.push(lease, createHash('sha256').update(lease).digest('hex'));
        const returned = returnFleetClaim({ id: claim.value.claim.id, agent: item.agent, lease,
          pr, head: item.head, ttlMs: 60_000 }, options);
        expect(returned).toMatchObject({ ok: true, outcome: 'returned', claimId: claim.value.claim.id });
        expect(returned.message?.body).toBe(`RESULT VERIFIED ${item.repo} claim ${claim.value.claim.id} task "${item.task}": pr #${pr} head ${item.head}`);
        return { ...item, claimId: claim.value.claim.id };
      });
      expect(new Set(receipts.map(row => row.claimId)).size).toBe(2);
      const bytes = readFileSync(path);
      const entries = readdirSync(root, { recursive: true }).sort();
      let betaMerged = false;
      const gh = vi.fn(async (args: string[]) => {
        const item = items.find(row => args.at(-1) === `repos/${row.repo}/pulls/${pr}`);
        if (!item) throw new Error('unexpected synthetic endpoint');
        const merged = item.repo === items[0]!.repo || betaMerged;
        return JSON.stringify({ number: pr, base: { repo: { full_name: item.repo } },
          state: merged ? 'closed' : betaState, merged,
          merged_at: merged ? new Date(at).toISOString() : null, head: { sha: item.head } });
      });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      let originalReceipts: unknown;
      for (const merged of [false, true]) {
        betaMerged = merged;
        for (const args of [['--json'], []]) {
          log.mockClear();
          gh.mockClear();
          // Only Gh is injected: the CLI reads and projects the real durable ledger.
          expect(await cmdFleetReturnsCheck(args, { gh })).toBe(merged ? 0 : 1);
          expect(readFileSync(path)).toEqual(bytes);
          expect(readdirSync(root, { recursive: true }).sort()).toEqual(entries);
          expect(error).not.toHaveBeenCalled();
          expect(gh.mock.calls.map(([call]) => call).sort()).toEqual(items.map(item =>
            ['api', '-H', 'Accept: application/vnd.github+json', `repos/${item.repo}/pulls/${pr}`]).sort());
          const output = log.mock.calls.map(call => String(call[0])).join('\n');
          expect(output).not.toMatch(/lease/i);
          for (const value of privateValues) expect(output.includes(value)).toBe(false);
          const verdictFor = (repo: string) => repo === items[0]!.repo || merged
            ? 'merged-at-head' : betaState === 'open' ? 'open' : 'closed-unmerged';
          if (args.length) {
            const report = JSON.parse(output);
            expect(report).toMatchObject({ authority: 'none', asOf: new Date(observedAt).toISOString(),
              returnsState: 'known', skipped: 0, truncated: false, unparsed: 0,
              projectionCoverage: { parsedTotal: 2, omitted: 0, unparsed: 0 } });
            expect(report.receipts).toHaveLength(2);
            expect(report.checked).toHaveLength(2);
            for (const row of receipts) {
              expect(report.receipts).toEqual(expect.arrayContaining([expect.objectContaining({
                claimId: row.claimId, repo: row.repo, from: row.agent,
                result: 'VERIFIED', evidenceKind: 'pr', pr, head: row.head, temporal: 'current',
              })]));
              expect(report.checked).toEqual(expect.arrayContaining([expect.objectContaining({
                claimId: row.claimId, repo: row.repo, pr, head: row.head,
                verdict: verdictFor(row.repo), observedHead: row.head,
              })]));
            }
            if (originalReceipts === undefined) originalReceipts = report.receipts;
            expect(report.receipts).toEqual(expect.arrayContaining(originalReceipts as unknown[]));
          } else {
            for (const row of receipts) {
              expect(output).toContain(`${verdictFor(row.repo)}  ${row.repo}#${pr}  claimed ${row.head.slice(0, 7)} observed ${row.head.slice(0, 7)} (${row.claimId})`);
              expect(output).toContain(`receipt temporal=current  ${row.repo}#${pr} (${row.claimId})`);
            }
            expect(output).toContain(`checked=2 skipped=0 truncated=no as-of=${new Date(observedAt).toISOString()}`);
          }
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});

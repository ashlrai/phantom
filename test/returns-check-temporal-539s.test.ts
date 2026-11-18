import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetReturnsCheck } from '../src/cli/fleet-returns-check.js';
import { claimFleetWork } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('requires current ledger receipts despite merged-at-head GitHub evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'returns-temporal-539s-'));
  try {
    for (const key of ['HOME', 'ASHLR_HOME', 'ASHLR_RUNS_ROOT']) vi.stubEnv(key, root);
    const path = join(root, 'coordination.jsonl');
    vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', path);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const gh = vi.fn(async () => JSON.stringify({ merged: true, head: { sha: 'abc1234abcdef' } }));
    const seed = (at: number, pr: number) => {
      const options = { path, now: at };
      const claim = claimFleetWork({ repo: 'fake/repo', task: `task ${pr}`, agent: 'fake-agent' }, options);
      if (!claim.ok) throw new Error('fixture claim failed');
      const input = { id: claim.value.claim.id, agent: 'fake-agent', lease: claim.value.lease, pr, head: 'abc1234', ttlMs: 2_000 };
      expect(returnFleetClaim(input, options).ok).toBe(true);
      return input;
    };
    const run = async (at: number, labels: string[], code: number, args = ['--json']) => {
      log.mockClear();
      const bytes = readFileSync(path);
      const clock = vi.fn(() => at + 10_000).mockReturnValueOnce(at);
      expect(await cmdFleetReturnsCheck(args, { gh, now: clock })).toBe(code);
      expect(readFileSync(path)).toEqual(bytes);
      const output = log.mock.calls.map(call => String(call[0])).join('\n');
      if (args.includes('--json')) {
        const report = JSON.parse(output);
        expect(report).toMatchObject({ authority: 'none', asOf: Number.isFinite(at) ? new Date(at).toISOString() : 'unknown' });
        expect(report.receipts.map((row: { temporal: string }) => row.temporal)).toEqual(labels);
        expect(report.checked.every((row: { verdict: string }) => row.verdict === 'merged-at-head')).toBe(true);
      } else for (const label of labels) expect(output).toContain(`temporal=${label}`);
    };
    const original = seed(1_000, 1);
    await run(1_000, ['current'], 0);
    await run(3_000, ['expired'], 1);
    await run(3_000, ['expired'], 1, []);
    await run(999, ['future'], 1);
    await run(999, ['future'], 1, []);
    await run(NaN, ['invalid'], 1);
    expect(returnFleetClaim({ ...original, head: 'abc1234a' }, { path, now: 2_999 }).ok).toBe(true);
    await run(3_000, ['current'], 0);
    seed(1_000, 2);
    await run(3_000, ['current', 'expired'], 1);
    await run(3_000, ['current', 'expired'], 1, ['--json', '--limit', '1']);
    expect(gh).toHaveBeenCalled();
    rmSync(path);
    gh.mockClear();
    expect(await cmdFleetReturnsCheck(['--json'], { gh, now: () => 3_000 })).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ returnsState: 'unknown', checked: [] });
    expect(gh).not.toHaveBeenCalled();
    writeFileSync(path, '', { mode: 0o600 });
    await run(3_000, [], 0);
    seed(3_000, 1);
    await run(3_000, ['current'], 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

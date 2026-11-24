import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetReturnsCheck } from '../src/cli/fleet-returns-check.js';
import { claimFleetWork } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'returns-coverage-542s-'));
  dirs.push(root);
  for (const key of ['HOME', 'ASHLR_HOME', 'ASHLR_RUNS_ROOT']) vi.stubEnv(key, root);
  const path = join(root, 'ledger.jsonl');
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', path);
  const seed = (task: string, evidence: { pr: number; head: string } | { tests: string }) => {
    const options = { path, now: 1_000 };
    const claim = claimFleetWork({ repo: 'example/demo', task, agent: 'test-agent' }, options);
    if (!claim.ok) throw new Error('fixture claim failed');
    const result = returnFleetClaim({ id: claim.value.claim.id, agent: 'test-agent', lease: claim.value.lease,
      ...evidence, ttlMs: 10_000 }, options);
    if (!result.ok) throw new Error('fixture return failed');
  };
  return { seed };
}

it('reports incomplete coverage and fails only when eligible PRs exceed the limit', async () => {
  const { seed } = fixture();
  seed('first task', { pr: 1, head: 'abc1234' });
  seed('second task', { pr: 2, head: 'abc1234' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const gh = vi.fn(async () => JSON.stringify({ merged: true, head: { sha: 'abc1234abcdef' } }));
  const deps = { gh, now: () => 2_000 };

  expect(await cmdFleetReturnsCheck(['--json', '--limit', '1'], deps)).toBe(1);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
    truncated: true, skipped: 1, checked: [{ pr: 1, verdict: 'merged-at-head' }],
  });
  expect(gh).toHaveBeenCalledTimes(1);
  log.mockClear();
  gh.mockClear();
  expect(await cmdFleetReturnsCheck(['--json', '--limit', '2'], deps)).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
    truncated: false, skipped: 0, checked: [{ pr: 1, verdict: 'merged-at-head' }, { pr: 2, verdict: 'merged-at-head' }],
  });
  expect(gh).toHaveBeenCalledTimes(2);
  log.mockClear();
  expect(await cmdFleetReturnsCheck(['--limit', '1'], deps)).toBe(1);
  expect(log.mock.calls.map(call => String(call[0])).join('\n')).toContain('incomplete coverage: the limit prevented checking all eligible PR returns');
});

it('does not treat skipped non-PR evidence as incomplete coverage', async () => {
  const { seed } = fixture();
  seed('test task', { tests: 'synthetic tests passed' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const gh = vi.fn(async () => { throw new Error('unexpected GitHub call'); });
  expect(await cmdFleetReturnsCheck(['--json', '--limit', '1'], { gh, now: () => 2_000 })).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ truncated: false, skipped: 1, checked: [] });
  expect(gh).not.toHaveBeenCalled();
});

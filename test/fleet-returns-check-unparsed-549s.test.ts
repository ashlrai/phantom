import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetReturnsCheck } from '../src/cli/fleet-returns-check.js';
import { claimFleetWork, postFleetMessage } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each([
  { malformed: true, evidence: 'none', code: 1 },
  { malformed: true, evidence: 'pr', code: 1 },
  { malformed: true, evidence: 'tests', code: 1 },
  { malformed: false, evidence: 'none', code: 0 },
  { malformed: false, evidence: 'pr', code: 0 },
  { malformed: false, evidence: 'tests', code: 0 },
] as const)('checks disk-backed returns: $malformed / $evidence', async ({ malformed, evidence, code }) => {
  const root = mkdtempSync(join(tmpdir(), 'returns-unparsed-549s-'));
  dirs.push(root);
  for (const key of ['HOME', 'ASHLR_HOME', 'ASHLR_RUNS_ROOT']) vi.stubEnv(key, root);
  const path = join(root, 'ledger.jsonl');
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', path);
  writeFileSync(path, '', { mode: 0o600 });
  const options = { path, now: 1_000 };
  const invalidBody = 'malformed private return text';
  if (malformed) expect(postFleetMessage({ id: 'return-bad', from: 'fake-agent', to: 'all', body: invalidBody }, options).ok).toBe(true);
  if (evidence !== 'none') {
    const claim = claimFleetWork({ repo: 'fake/repo', task: 'test task', agent: 'fake-agent' }, options);
    if (!claim.ok) throw new Error('fixture claim failed');
    const detail = evidence === 'pr' ? { pr: 42, head: 'abc1234' } : { tests: 'synthetic checks passed' };
    expect(returnFleetClaim({ id: claim.value.claim.id, agent: 'fake-agent', lease: claim.value.lease,
      ...detail, ttlMs: 10_000 }, options).ok).toBe(true);
  }
  const before = readFileSync(path);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const gh = vi.fn(async (_args: string[]) => JSON.stringify({ merged: true, head: { sha: 'abc1234567890000000000000000000000000000' } }));
  for (const args of [['--json'], []]) {
    log.mockClear();
    gh.mockClear();
    expect(await cmdFleetReturnsCheck(args, { gh, now: () => 2_000 })).toBe(code);
    const output = log.mock.calls.map(call => String(call[0])).join('\n');
    expect(output).not.toContain(invalidBody);
    if (args.length) {
      expect(JSON.parse(output)).toMatchObject({ returnsState: 'known', unparsed: Number(malformed) });
    } else if (malformed) {
      expect(output).toContain('incomplete coverage: 1 unparsed return message(s)');
    } else expect(output).not.toContain('unparsed return');
    expect(gh).toHaveBeenCalledTimes(evidence === 'pr' ? 1 : 0);
    if (evidence === 'pr') expect(gh.mock.calls[0]?.[0]).toContain('repos/fake/repo/pulls/42');
    expect(readFileSync(path)).toEqual(before);
  }
});

it('keeps invalid arguments at exit 2 without reading the ledger', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const gh = vi.fn(async () => '');
  expect(await cmdFleetReturnsCheck(['--limit', '0'], { gh })).toBe(2);
  expect(gh).not.toHaveBeenCalled();
});

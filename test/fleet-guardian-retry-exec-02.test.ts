import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianRetry } from '../src/cli/fleet-guardian-retry.js';
import { cmdFleetGuardianVerify } from '../src/cli/fleet-guardian-verify.js';
import { prepareGuardianRetryState } from '../src/core/fleet/guardian-retry-state.js';
import { GUARDIAN_VERIFY_MAX_TIMEOUT_MS, runGuardianVerifyLoop } from '../src/core/fleet/guardian-verify-loop.js';
import type { DetachedPostMergeRunnerInput, DetachedPostMergeRunnerResult } from '../src/core/fleet/detached-post-merge-runner.js';

const result = (terminal: 'pass' | 'fail'): DetachedPostMergeRunnerResult => ({ schemaVersion: 1, authority: 'observation-only', policyEligible: false, mergePermitted: false, rollbackPermitted: false, deployPermitted: false, terminal, reason: terminal === 'pass' ? 'verified' : 'code-failure', verifierManifestDigest: null, requiredCommandCount: 1, commandsRun: 1, failureCategory: terminal === 'fail' ? 'code' : null, cleanup: 'removed', recordDisposition: 'recorded' });
const input = (repo: string, digit: string): DetachedPostMergeRunnerInput => ({ repo, cohortId: 'cohort', proposalId: 'proposal', baseBranch: 'master', baseHead: 'b'.repeat(40), candidateHead: 'c'.repeat(40), mergeCommit: digit.repeat(40) });

// Manifest: /fake/a fails (selected for retry), /fake/b passes, /fake/d fails
// (unrelated, must survive). All local fake repos; the verifier run is faked.
async function seed(name = 'retry.json') {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-retry-exec-'));
  const manifest = join(dir, 'manifest.json'); const source = join(dir, 'state.json'); const output = join(dir, name);
  await writeFile(manifest, JSON.stringify([input('/fake/a', 'a'), input('/fake/b', 'b'), input('/fake/d', 'd')]));
  const run = vi.fn(async (item: DetachedPostMergeRunnerInput) => result(item.repo.endsWith('b') ? 'pass' : 'fail'));
  await runGuardianVerifyLoop({ manifest, state: source, maxPasses: 1, intervalMs: 1, run });
  return { dir, manifest, source, output };
}
const argv = (o: Awaited<ReturnType<typeof seed>>, extra: string[] = []) =>
  ['--manifest', o.manifest, '--source-state', o.source, '--output-state', o.output, '--repo', '/fake/a', '--sha', 'a'.repeat(40), ...extra];
const capture = () => { const lines: string[] = []; const spy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => { lines.push(String(value)); }); return { lines, restore: () => spy.mockRestore() }; };
const mute = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

describe('guardian-retry execution mode (--verify)', () => {
  it('prepares before it verifies and meets the existing wrapper argv contract', async () => {
    const o = await seed();
    const order: string[] = [];
    const prepare = async (options: Parameters<typeof prepareGuardianRetryState>[0]) => { order.push('prepare'); return prepareGuardianRetryState(options); };
    let seen: string[] = [];
    const verify = vi.fn(async (args: string[]) => { order.push('verify'); seen = args; return 0; });
    const out = capture();
    let code: number;
    try { code = await cmdFleetGuardianRetry(argv(o, ['--verify']), prepare, verify); } finally { out.restore(); }
    expect(code).toBe(0);
    expect(order).toEqual(['prepare', 'verify']); // prepare strictly first
    expect(seen).toEqual(['--manifest', o.manifest, '--state', o.output, '--max-passes', '1', '--timeout-ms', '60000']);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(out.lines).toEqual([`guardian-retry: removed=1 retained=2 verifying=${o.output}`]);

    const p = await seed(); // explicit timeout and the guardian maximum are forwarded verbatim
    const verify2 = vi.fn(async (_args: string[]) => 0);
    expect(await cmdFleetGuardianRetry(argv(p, ['--verify', '--timeout-ms', '2500', '--json']), prepareGuardianRetryState, verify2)).toBe(0);
    expect(verify2.mock.calls[0]![0]).toEqual(['--manifest', p.manifest, '--state', p.output, '--max-passes', '1', '--timeout-ms', '2500', '--json']);
    const q = await seed();
    const verify3 = vi.fn(async (_args: string[]) => 0);
    expect(await cmdFleetGuardianRetry(argv(q, ['--verify', '--timeout-ms', String(GUARDIAN_VERIFY_MAX_TIMEOUT_MS)]), prepareGuardianRetryState, verify3)).toBe(0);
    expect(verify3.mock.calls[0]![0]).toContain(String(GUARDIAN_VERIFY_MAX_TIMEOUT_MS));
  });
  it('preparation-only calls never verify and keep the original output shape', async () => {
    const o = await seed();
    const verify = vi.fn(async (_args: string[]) => 0);
    const out = capture();
    let code: number;
    try { code = await cmdFleetGuardianRetry(argv(o, ['--json']), prepareGuardianRetryState, verify); } finally { out.restore(); }
    expect(code).toBe(0);
    expect(verify).not.toHaveBeenCalled();
    const summary = JSON.parse(out.lines.join(''));
    expect(summary).toMatchObject({ removed: 1, retained: 2 });
    expect(summary.nextAction).toContain('guardian-verify');

    const p = await seed();
    const out2 = capture();
    try { code = await cmdFleetGuardianRetry(argv(p), prepareGuardianRetryState, verify); } finally { out2.restore(); }
    expect(code).toBe(0);
    expect(verify).not.toHaveBeenCalled();
    expect(out2.lines[0]).toMatch(/^guardian-retry: removed=1 retained=2 next=guardian-verify --state /);
  });
  it('propagates verification failure, deadline, unknown and refusal exit codes', async () => {
    for (const expected of [1, 3, 4, 5]) {
      const o = await seed(`${expected}.json`);
      const verify = vi.fn(async (_args: string[]) => expected);
      expect(await cmdFleetGuardianRetry(argv(o, ['--verify']), prepareGuardianRetryState, verify)).toBe(expected);
      expect(verify).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects duplicate or invalid timeout and flags before any write or verifier call', async () => {
    const o = await seed();
    const bytes = await readFile(o.source, 'utf8');
    const verify = vi.fn(async (_args: string[]) => 0);
    const err = mute();
    try {
      const base = ['--manifest', o.manifest, '--source-state', o.source, '--output-state', o.output, '--repo', '/fake/a', '--sha', 'a'.repeat(40)];
      expect(await cmdFleetGuardianRetry([...base, '--timeout-ms', '5000'], prepareGuardianRetryState, verify)).toBe(2); // --timeout-ms requires --verify
      expect(await cmdFleetGuardianRetry([...base, '--verify', '--timeout-ms', '0'], prepareGuardianRetryState, verify)).toBe(2);
      expect(await cmdFleetGuardianRetry([...base, '--verify', '--timeout-ms', 'abc'], prepareGuardianRetryState, verify)).toBe(2);
      expect(await cmdFleetGuardianRetry([...base, '--verify', '--timeout-ms', '-5'], prepareGuardianRetryState, verify)).toBe(2);
      expect(await cmdFleetGuardianRetry([...base, '--verify', '--timeout-ms', '1.5'], prepareGuardianRetryState, verify)).toBe(2);
      expect(await cmdFleetGuardianRetry([...base, '--verify', '--timeout-ms', String(GUARDIAN_VERIFY_MAX_TIMEOUT_MS + 1)], prepareGuardianRetryState, verify)).toBe(2);
      expect(await cmdFleetGuardianRetry([...base, '--verify', '--timeout-ms', '100', '--timeout-ms', '200'], prepareGuardianRetryState, verify)).toBe(2); // duplicate
      expect(await cmdFleetGuardianRetry([...base, '--verify', '--verify'], prepareGuardianRetryState, verify)).toBe(2); // duplicate
      expect(await cmdFleetGuardianRetry([...base, '--verify', '--timeout-ms'], prepareGuardianRetryState, verify)).toBe(2); // missing value
      expect(await cmdFleetGuardianRetry([...base, '--verify', '--bogus'], prepareGuardianRetryState, verify)).toBe(2);
    } finally { err.mockRestore(); }
    expect(verify).not.toHaveBeenCalled();
    expect(existsSync(o.output)).toBe(false); // zero writes
    expect(await readFile(o.source, 'utf8')).toBe(bytes);
  });
  it('temp-file integration: real prepare removes only the selected failure and the fake verifier runs on it', async () => {
    const o = await seed();
    const bytes = await readFile(o.source, 'utf8');
    const verify = vi.fn(async (_args: string[]) => 1); // verifier fails: states must survive untouched
    expect(await cmdFleetGuardianRetry(argv(o, ['--verify']), prepareGuardianRetryState, verify)).toBe(1);
    expect(verify).toHaveBeenCalledTimes(1);
    const entries = JSON.parse(await readFile(o.output, 'utf8')).entries as { repo: string; terminal: string }[];
    expect(Object.fromEntries(entries.map(e => [e.repo, e.terminal]))).toEqual({ '/fake/b': 'pass', '/fake/d': 'fail' }); // only /fake/a removed
    expect(await readFile(o.source, 'utf8')).toBe(bytes); // source bytes unchanged
  });
  it('existing output fails prepare without invoking the verifier', async () => {
    const o = await seed();
    const bytes = await readFile(o.source, 'utf8');
    await writeFile(o.output, 'keep');
    const verify = vi.fn(async (_args: string[]) => 0);
    const err = mute();
    let code: number;
    try { code = await cmdFleetGuardianRetry(argv(o, ['--verify']), prepareGuardianRetryState, verify); } finally { err.mockRestore(); }
    expect(code).toBe(3);
    expect(verify).not.toHaveBeenCalled();
    expect(await readFile(o.output, 'utf8')).toBe('keep'); // never overwritten or deleted
    expect(await readFile(o.source, 'utf8')).toBe(bytes);
  });
  it('the real guardian-verify wrapper accepts retry argv and prints one parseable JSON object', async () => {
    const o = await seed();
    const run = vi.fn(async (item: DetachedPostMergeRunnerInput) => { expect(item.repo).toBe('/fake/a'); return result('pass'); });
    const verify = (execArgs: string[]): Promise<number> => cmdFleetGuardianVerify(execArgs, options => runGuardianVerifyLoop({ ...options, run }));
    const out = capture();
    // /fake/a is rerun to pass; pre-existing pass /fake/b and unrelated fail /fake/d are kept, so the outcome is fail (1).
    let code: number;
    try { code = await cmdFleetGuardianRetry(argv(o, ['--verify', '--timeout-ms', '30000', '--json']), prepareGuardianRetryState, verify); } finally { out.restore(); }
    expect(code).toBe(1);
    expect(run).toHaveBeenCalledTimes(1); // only the retried identity is re-verified
    expect(out.lines).toHaveLength(1); // exactly one JSON value on stdout
    const summary = JSON.parse(out.lines[0]!);
    expect(summary).toMatchObject({ passes: 1, pass: 2, fail: 1, unknown: 0, cancelled: false, deadlineExceeded: false });
    const entries = JSON.parse(await readFile(o.output, 'utf8')).entries as { repo: string; terminal: string }[];
    expect(Object.fromEntries(entries.map(e => [e.repo, e.terminal]))).toEqual({ '/fake/a': 'pass', '/fake/b': 'pass', '/fake/d': 'fail' });
  });
});

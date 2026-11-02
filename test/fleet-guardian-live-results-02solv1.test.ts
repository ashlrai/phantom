import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runGuardianVerifyLoop } from '../src/core/fleet/guardian-verify-loop.js';
import { cmdFleetGuardianVerify } from '../src/cli/fleet-guardian-verify.js';
import type { DetachedPostMergeRunnerInput, DetachedPostMergeRunnerResult } from '../src/core/fleet/detached-post-merge-runner.js';

const result = (terminal: 'pass' | 'fail' | 'unknown'): DetachedPostMergeRunnerResult => ({ schemaVersion: 1, authority: 'observation-only', policyEligible: false, mergePermitted: false, rollbackPermitted: false, deployPermitted: false, terminal, reason: terminal === 'pass' ? 'verified' : terminal === 'fail' ? 'code-failure' : 'verification-infrastructure', verifierManifestDigest: null, requiredCommandCount: 1, commandsRun: 1, failureCategory: terminal === 'fail' ? 'code' : terminal === 'unknown' ? 'infra' : null, cleanup: 'removed', recordDisposition: 'recorded' });
const input = (repo: string, digit = 'a'): DetachedPostMergeRunnerInput => ({ repo, cohortId: 'cohort', proposalId: 'proposal', baseBranch: 'master', baseHead: 'b'.repeat(40), candidateHead: 'c'.repeat(40), mergeCommit: digit.repeat(40) });
const keyOf = (item: DetachedPostMergeRunnerInput): string => createHash('sha256').update(JSON.stringify([item.repo, item.cohortId, item.proposalId, item.baseBranch, item.baseHead, item.candidateHead, item.mergeCommit, item.runId ?? null, item.trajectoryId ?? null, item.workItemId ?? null])).digest('hex');
async function setup(entries: DetachedPostMergeRunnerInput[]): Promise<{ manifest: string; state: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-live-'));
  const manifest = join(dir, 'manifest.json'); const state = join(dir, 'state.json');
  await writeFile(manifest, JSON.stringify(entries));
  return { manifest, state };
}
const argv = (opts: { manifest: string; state: string }, ...flags: string[]): string[] => ['--manifest', opts.manifest, '--state', opts.state, ...flags];

function captureStdout(): { lines: string[]; results: () => Record<string, unknown>[]; summaries: () => Record<string, unknown>[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array, callback?: unknown) => {
    lines.push(String(chunk));
    if (typeof callback === 'function') (callback as () => void)();
    return true;
  });
  const ofType = (type: string): Record<string, unknown>[] => lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line['type'] === type);
  return { lines, results: () => ofType('result'), summaries: () => ofType('summary'), restore: () => spy.mockRestore() };
}

describe('guardian-verify --events-jsonl live results', () => {
  it('streams each completed verification before the next one finishes and ends with exactly one summary', async () => {
    const opts = await setup([input('/fake/a'), input('/fake/b')]);
    const cap = captureStdout();
    try {
      let releaseB!: (value: DetachedPostMergeRunnerResult) => void;
      const gateB = new Promise<DetachedPostMergeRunnerResult>(resolvePromise => { releaseB = resolvePromise; });
      const verify = vi.fn(async (item: DetachedPostMergeRunnerInput) => {
        if (item.repo.endsWith('/b')) {
          expect(cap.results().map(event => event['repo'])).toEqual([resolve('/fake/a')]);
          return gateB;
        }
        return result('pass');
      });
      const outcome = cmdFleetGuardianVerify(argv(opts, '--events-jsonl'), runGuardianVerifyLoop, verify);
      await vi.waitFor(() => { expect(verify.mock.calls.length).toBe(2); });
      expect(cap.results()).toHaveLength(1);
      expect(cap.summaries()).toHaveLength(0);
      releaseB(result('pass'));
      expect(await outcome).toBe(0);
      expect(verify).toHaveBeenCalledTimes(2);
      const events = cap.results();
      expect(events.map(event => event['repo'])).toEqual([resolve('/fake/a'), resolve('/fake/b')]);
      expect(events.map(event => event['terminal'])).toEqual(['pass', 'pass']);
      for (const event of events) expect(Object.keys(event).sort()).toEqual(['cleanup', 'failureCategory', 'reason', 'repo', 'sha', 'terminal', 'type']);
      expect(events[0]).toMatchObject({ type: 'result', sha: 'a'.repeat(40), reason: 'verified', failureCategory: null, cleanup: 'removed' });
      const summaries = cap.summaries();
      expect(summaries).toEqual([{ type: 'summary', passes: 1, pass: 2, fail: 0, unknown: 0, cancelled: false }]);
      expect(cap.lines.at(-1)).toBe(`${JSON.stringify(summaries[0])}\n`);
    } finally { cap.restore(); }
  });

  it('does not emit cached terminal entries as newly executed checks', async () => {
    const a = input('/fake/a'); const b = input('/fake/b');
    const opts = await setup([a, b]);
    await writeFile(opts.state, JSON.stringify({ version: 1, entries: [{ key: keyOf(a), repo: resolve(a.repo), sha: a.mergeCommit, terminal: 'pass', checkedAt: new Date().toISOString(), reason: 'verified', failureCategory: null, cleanup: 'removed' }] }));
    const cap = captureStdout();
    try {
      const verify = vi.fn(async () => result('pass'));
      expect(await cmdFleetGuardianVerify(argv(opts, '--events-jsonl'), runGuardianVerifyLoop, verify)).toBe(0);
      expect(verify).toHaveBeenCalledTimes(1);
      expect((verify.mock.calls[0]![0] as DetachedPostMergeRunnerInput).repo).toBe('/fake/b');
      expect(cap.results().map(event => event['repo'])).toEqual([resolve('/fake/b')]);
      expect(cap.summaries()).toEqual([{ type: 'summary', passes: 1, pass: 2, fail: 0, unknown: 0, cancelled: false }]);
      cap.lines.length = 0;
      expect(await cmdFleetGuardianVerify(argv(opts, '--events-jsonl'), runGuardianVerifyLoop, verify)).toBe(0);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(cap.results()).toHaveLength(0);
      expect(cap.summaries()).toEqual([{ type: 'summary', passes: 1, pass: 2, fail: 0, unknown: 0, cancelled: false }]);
    } finally { cap.restore(); }
  });

  it('emits only allowlisted fields, sanitized exactly like the state record, never raw result details', async () => {
    const opts = await setup([input('/fake/a'), input('/fake/b')]);
    const cap = captureStdout();
    try {
      const bogus = { ...result('pass'), terminal: 'pwned', reason: '; cat /etc/passwd', failureCategory: 'raw-output', cleanup: 'dump', extra: 'secret-subprocess-output' } as unknown as DetachedPostMergeRunnerResult;
      const verify = vi.fn(async (item: DetachedPostMergeRunnerInput): Promise<DetachedPostMergeRunnerResult> => {
        if (item.repo.endsWith('/b')) throw new Error('secret-failure-detail');
        return bogus;
      });
      expect(await cmdFleetGuardianVerify(argv(opts, '--events-jsonl'), runGuardianVerifyLoop, verify)).toBe(3);
      const events = cap.results();
      const expected = { type: 'result', sha: 'a'.repeat(40), terminal: 'unknown', reason: 'verification-infrastructure', failureCategory: null, cleanup: 'failed' };
      expect(events).toEqual([{ ...expected, repo: resolve('/fake/a') }, { ...expected, repo: resolve('/fake/b') }]);
      const serialized = cap.lines.join('');
      expect(serialized).not.toContain('secret-subprocess-output');
      expect(serialized).not.toContain('secret-failure-detail');
      expect(serialized).not.toContain('cat /etc/passwd');
      const saved = (JSON.parse(await readFile(opts.state, 'utf8')) as { entries: Array<Record<string, unknown>> }).entries;
      for (const [index, entry] of saved.entries()) {
        for (const field of ['repo', 'sha', 'terminal', 'reason', 'failureCategory', 'cleanup'] as const) expect(events[index]![field]).toEqual(entry[field]);
      }
      expect(cap.summaries()).toEqual([{ type: 'summary', passes: 1, pass: 0, fail: 0, unknown: 2, cancelled: false }]);
    } finally { cap.restore(); }
  });

  it('rejects --json combined with --events-jsonl and other invalid flags before any loop or verifier call', async () => {
    const opts = await setup([input('/fake/a')]);
    const cap = captureStdout();
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const verify = vi.fn(async () => result('pass'));
      const loop = vi.fn(runGuardianVerifyLoop);
      expect(await cmdFleetGuardianVerify(argv(opts, '--json', '--events-jsonl'), loop, verify)).toBe(2);
      expect(await cmdFleetGuardianVerify(argv(opts, '--events-jsonl', '--events-jsonl'), loop, verify)).toBe(2);
      expect(await cmdFleetGuardianVerify(argv(opts, '--events-jsonl', '--bogus'), loop, verify)).toBe(2);
      expect(loop).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(errors.mock.calls.map(call => String(call[0])).join('')).toBe('error: invalid guardian-verify arguments\n'.repeat(3));
      expect(cap.lines).toHaveLength(0);
    } finally { cap.restore(); errors.mockRestore(); }
  });

  it('emits the failed outcome and preserves the failure exit code', async () => {
    const opts = await setup([input('/fake/a')]);
    const cap = captureStdout();
    try {
      expect(await cmdFleetGuardianVerify(argv(opts, '--events-jsonl'), runGuardianVerifyLoop, async () => result('fail'))).toBe(1);
      expect(cap.results()).toEqual([{ type: 'result', repo: resolve('/fake/a'), sha: 'a'.repeat(40), terminal: 'fail', reason: 'code-failure', failureCategory: 'code', cleanup: 'removed' }]);
      expect(cap.summaries()).toEqual([{ type: 'summary', passes: 1, pass: 0, fail: 1, unknown: 0, cancelled: false }]);
    } finally { cap.restore(); }
  });

  it('keeps the cancellation exit code and removes its signal listeners', async () => {
    const opts = await setup([input('/fake/a'), input('/fake/b')]);
    const cap = captureStdout();
    const beforeInt = process.listeners('SIGINT'); const beforeTerm = process.listeners('SIGTERM');
    try {
      const verify = vi.fn(async () => {
        for (const listener of process.listeners('SIGTERM').filter(listener => !beforeTerm.includes(listener))) listener();
        return result('pass');
      });
      expect(await cmdFleetGuardianVerify(argv(opts, '--events-jsonl'), runGuardianVerifyLoop, verify)).toBe(3);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(cap.results()).toEqual([{ type: 'result', repo: resolve('/fake/a'), sha: 'a'.repeat(40), terminal: 'unknown', reason: 'verification-infrastructure', failureCategory: 'cancelled', cleanup: 'removed' }]);
      expect(cap.summaries()).toEqual([{ type: 'summary', passes: 1, pass: 0, fail: 0, unknown: 1, cancelled: true }]);
      expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
      expect(process.listeners('SIGINT')).toEqual(beforeInt);
    } finally { cap.restore(); }
  });

  it('keeps default and --json output unchanged and emits no event lines without the flag', async () => {
    const opts = await setup([input('/fake/a')]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await cmdFleetGuardianVerify(argv(opts), runGuardianVerifyLoop, async () => result('pass'))).toBe(0);
      expect(log).toHaveBeenNthCalledWith(1, 'guardian-verify: pass=1 fail=0 unknown=0 cancelled=false');
      expect(write).not.toHaveBeenCalled();
      const opts2 = await setup([input('/fake/a')]);
      expect(await cmdFleetGuardianVerify(argv(opts2, '--json'), runGuardianVerifyLoop, async () => result('pass'))).toBe(0);
      expect(log).toHaveBeenNthCalledWith(2, JSON.stringify({ passes: 1, pass: 1, fail: 0, unknown: 0, cancelled: false }));
      expect(write).not.toHaveBeenCalled();
    } finally { log.mockRestore(); write.mockRestore(); }
  });
});

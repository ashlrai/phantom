import { describe, expect, it, vi } from 'vitest';
import {
  cmdFleetPostMergeVerify,
  postMergeVerifyExitCode,
} from '../src/cli/fleet-post-merge-verify.js';
import type {
  DetachedPostMergeRunnerInput,
  DetachedPostMergeRunnerOptions,
  DetachedPostMergeRunnerResult,
} from '../src/core/fleet/detached-post-merge-runner.js';

const ARGS = [
  '--repo', '/abs/repo',
  '--cohort-id', 'cohort-1',
  '--proposal-id', 'proposal-1',
  '--base-branch', 'main',
  '--base-head', 'a'.repeat(40),
  '--candidate-head', 'b'.repeat(40),
  '--merge-commit', 'c'.repeat(40),
];

function outcome(overrides: Partial<DetachedPostMergeRunnerResult> = {}): DetachedPostMergeRunnerResult {
  return {
    schemaVersion: 1,
    authority: 'observation-only',
    policyEligible: false,
    mergePermitted: false,
    rollbackPermitted: false,
    deployPermitted: false,
    terminal: 'unknown',
    reason: 'verification-infrastructure',
    verifierManifestDigest: null,
    requiredCommandCount: 0,
    commandsRun: 0,
    failureCategory: null,
    cleanup: 'not-created',
    recordDisposition: 'not-recorded',
    ...overrides,
  };
}

interface Captured {
  input: DetachedPostMergeRunnerInput;
  options: DetachedPostMergeRunnerOptions;
}

function injected(result: DetachedPostMergeRunnerResult | Error): {
  run: (input: DetachedPostMergeRunnerInput, options?: DetachedPostMergeRunnerOptions) => Promise<DetachedPostMergeRunnerResult>;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  return {
    calls,
    run: async (input, options = {}) => {
      calls.push({ input, options });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

async function runCli(args: string[], run: ReturnType<typeof injected>['run']) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await cmdFleetPostMergeVerify(args, run);
    return { code, out: log.mock.calls.map((call) => String(call[0])).join('\n'), err: stderr.mock.calls.flat().join('') };
  } finally {
    log.mockRestore();
    stderr.mockRestore();
  }
}

describe('fleet post-merge-verify', () => {
  it('exits 0 and prints the bounded JSON result on pass', async () => {
    const { run, calls } = injected(outcome({
      terminal: 'pass', reason: 'verified', cleanup: 'removed',
      commandsRun: 1, requiredCommandCount: 1, recordDisposition: 'recorded',
    }));
    const { code, out } = await runCli([...ARGS, '--json'], run);
    expect(code).toBe(0);
    const printed = JSON.parse(out) as DetachedPostMergeRunnerResult;
    expect(printed.terminal).toBe('pass');
    expect(printed.reason).toBe('verified');
    expect(printed.cleanup).toBe('removed');
    expect(calls[0]!.input).toEqual<DetachedPostMergeRunnerInput>({
      repo: '/abs/repo',
      cohortId: 'cohort-1',
      proposalId: 'proposal-1',
      baseBranch: 'main',
      baseHead: 'a'.repeat(40),
      candidateHead: 'b'.repeat(40),
      mergeCommit: 'c'.repeat(40),
    });
  });

  it('exits 1 on fail', async () => {
    const { run } = injected(outcome({ terminal: 'fail', reason: 'code-failure', cleanup: 'removed', failureCategory: 'code' }));
    const { code, out } = await runCli([...ARGS, '--json'], run);
    expect(code).toBe(1);
    expect(JSON.parse(out).terminal).toBe('fail');
  });

  it('exits 3 on unknown and never reads as pass', async () => {
    const { run } = injected(outcome({ terminal: 'unknown', reason: 'isolation-lost', cleanup: 'removed' }));
    const { code, out } = await runCli([...ARGS, '--json'], run);
    expect(code).toBe(3);
    expect(code).not.toBe(0);
    const printed = JSON.parse(out);
    expect(printed.terminal).toBe('unknown');
    expect(printed.reason).toBe('isolation-lost');
  });

  it('keeps a cleanup failure visible in the output', async () => {
    const { run } = injected(outcome({ terminal: 'unknown', reason: 'cleanup-failed', cleanup: 'failed' }));
    const { code, out } = await runCli([...ARGS, '--json'], run);
    expect(code).toBe(3);
    const printed = JSON.parse(out);
    expect(printed.cleanup).toBe('failed');
    expect(printed.reason).toBe('cleanup-failed');
    const text = await runCli(ARGS, run);
    expect(text.code).toBe(3);
    expect(text.out).toContain('cleanup=failed');
  });

  it('maps optional ids and timeout flags onto the runner input and options', async () => {
    const { run, calls } = injected(outcome({ terminal: 'pass', cleanup: 'removed' }));
    const { code } = await runCli([...ARGS,
      '--run-id', 'run-9', '--trajectory-id', 'traj-3', '--work-item-id', 'work-2',
      '--max-command-timeout-ms', '5000', '--max-total-timeout-ms', '90000',
    ], run);
    expect(code).toBe(0);
    expect(calls[0]!.input.runId).toBe('run-9');
    expect(calls[0]!.input.trajectoryId).toBe('traj-3');
    expect(calls[0]!.input.workItemId).toBe('work-2');
    expect(calls[0]!.options).toEqual({ maxCommandTimeoutMs: 5000, maxTotalTimeoutMs: 90000 });
  });

  it('refuses missing required input, unknown options and bad timeouts before running', async () => {
    const { run, calls } = injected(outcome({ terminal: 'pass' }));
    expect((await runCli(ARGS.slice(2), run)).code).toBe(2);
    expect((await runCli([...ARGS, '--dry-run'], run)).code).toBe(2);
    expect((await runCli([...ARGS, '--merge-commit'], run)).code).toBe(2);
    expect((await runCli([...ARGS, '--max-total-timeout-ms', 'soon'], run)).code).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('prints help and exits 0 without running', async () => {
    const { run, calls } = injected(outcome());
    for (const flag of ['--help', '-h']) {
      const { code, out } = await runCli([flag], run);
      expect(code).toBe(0);
      expect(out).toContain('post-merge-verify');
    }
    expect(calls).toHaveLength(0);
  });

  it('reports unknown, not pass, when the runner throws', async () => {
    const { run } = injected(new Error('private detail'));
    const { code, out, err } = await runCli([...ARGS, '--json'], run);
    expect(code).toBe(3);
    const printed = JSON.parse(out);
    expect(printed.terminal).toBe('unknown');
    expect(printed.cleanup).toBe('failed');
    expect(out).not.toContain('private detail');
    expect(err).not.toContain('private detail');
  });

  it('maps only pass to 0, keeping unknown and future verdicts off the pass path', () => {
    expect(postMergeVerifyExitCode('pass')).toBe(0);
    expect(postMergeVerifyExitCode('fail')).toBe(1);
    expect(postMergeVerifyExitCode('unknown')).toBe(3);
  });
});

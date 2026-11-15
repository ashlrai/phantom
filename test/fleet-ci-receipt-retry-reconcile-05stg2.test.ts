import { expect, it, vi } from 'vitest';
import { cmdFleetCiReceiptRetryBatch } from '../src/cli/fleet-ci-receipt-retry-batch.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

it('dispatches the CLI and reads only unresolved identities after validation', async () => {
  expect(resolveFleetSubcommand('ci-receipt-retry-batch')).toEqual({
    module: './fleet-ci-receipt-retry-batch.js', exportName: 'cmdFleetCiReceiptRetryBatch',
  });
  const entry = (run: number, outcome: string) => ({ repo: 'example/repo', run, attempt: 1,
    artifactName: 'receipts', outcome, prior: null, reason: outcome === 'bound' ? null : 'failed' });
  const report = { version: 1, total: 3, bound: 1, failed: 1, notStarted: 1,
    timedOut: false, aborted: false, entries: [entry(1, 'bound'), entry(2, 'failed'), entry(3, 'not-started')] };
  const calls: string[] = [];
  const gh: GitRunner = async (_bin, args) => {
    calls.push(args.join(' '));
    return { code: 1, stdout: '', stderr: 'not found', timedOut: false, truncated: false, missing: false };
  };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const input = (async function* () { yield JSON.stringify(report); })();
    expect(await cmdFleetCiReceiptRetryBatch(['--stdin', '--timeout-ms', '1000', '--poll-ms', '250', '--json'], { input, gh })).toBe(1);
    expect(calls.some(c => c.includes('/runs/1/'))).toBe(false);
    expect(calls.some(c => c.includes('/runs/2/'))).toBe(true);
    expect(calls.some(c => c.includes('/runs/3/'))).toBe(true);
  } finally { log.mockRestore(); err.mockRestore(); }
});

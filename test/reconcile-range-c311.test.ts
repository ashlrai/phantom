/**
 * reconcile-range-c311: preserves the unique coverage of PR #4610 (recut of
 * #3373) for the self-update smoke gate. A `smokeOk:false` updater report must
 * fail the apply and the durable result file must record the failure, while
 * `smokeOk:null` (smoke not determinable) still counts as updated.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { applySelfUpdate, type SelfUpdateRunner } from '../src/core/verse/self-update-apply.js';

async function apply(report: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'reconcile-c311-'));
  const resultPath = join(dir, 'verse', 'self-update-last.json');
  const script: Array<[string, string]> = [
    ['status --porcelain', ''],
    ['fetch origin master', ''],
    ['rev-parse HEAD', 'a'.repeat(40)],
    ['rev-parse origin/master', 'b'.repeat(40)],
    ['merge-base --is-ancestor HEAD origin/master', ''],
    ['/repo/dist/cli/index.js update --json', JSON.stringify(report)],
  ];
  const runner: SelfUpdateRunner = {
    run: async (_cmd, args) => {
      const next = script.shift();
      return next && args.join(' ') === next[0]
        ? { code: 0, stdout: next[1], stderr: '', timedOut: false }
        : { code: 42, stdout: '', stderr: 'unscripted call', timedOut: false };
    },
  };
  try {
    const result = await applySelfUpdate({ runner, repoRoot: '/repo', cliEntry: '/repo/dist/cli/index.js', resultPath });
    const persisted = JSON.parse(await readFile(resultPath, 'utf8')) as { outcome?: string; reason?: string };
    return { result, persisted };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe('self-update smoke gate durability (PR #4610)', () => {
  it('fails a smoke-broken update and records it in the result file', async () => {
    const { result, persisted } = await apply({ updated: true, smokeOk: false, commitAfter: 'c'.repeat(40) });
    expect(result).toMatchObject({ outcome: 'failed', reason: 'smoke test failed', restart: { required: false } });
    expect(persisted).toMatchObject({ outcome: 'failed', reason: 'smoke test failed' });
  });

  it('treats an indeterminate smoke result as updated', async () => {
    const { result, persisted } = await apply({ updated: true, smokeOk: null, commitAfter: 'd'.repeat(40) });
    expect(result).toMatchObject({ outcome: 'updated', restart: { required: true } });
    expect(persisted.outcome).toBe('updated');
  });
});

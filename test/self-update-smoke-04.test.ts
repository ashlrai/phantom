import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { applySelfUpdate, type SelfUpdateRunner } from '../src/core/verse/self-update-apply.js';

const commitAfter = 'a'.repeat(40);

async function apply(report: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'smoke-gate-'));
  const script = [
    ['status --porcelain', ''],
    ['fetch origin master', ''],
    ['rev-parse HEAD', 'b'.repeat(40)],
    ['rev-parse origin/master', 'c'.repeat(40)],
    ['merge-base --is-ancestor HEAD origin/master', ''],
    ['/repo/dist/cli/index.js update --json', JSON.stringify(report)],
  ];
  const runner: SelfUpdateRunner = {
    run: async (_cmd, args) => {
      const next = script.shift();
      return next && args.join(' ') === next[0]
        ? { code: 0, stdout: next[1]!, stderr: '', timedOut: false }
        : { code: 42, stdout: '', stderr: 'unscripted call', timedOut: false };
    },
  };
  try {
    return await applySelfUpdate({ runner, repoRoot: '/repo', cliEntry: '/repo/dist/cli/index.js', resultPath: join(dir, 'result.json'), writeFile: vi.fn().mockResolvedValue(undefined) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('self-update smoke gate', () => {
  it('fails without requiring a restart and records the failed commit', async () => {
    const result = await apply({ updated: true, smokeOk: false, commitAfter });
    expect(result).toMatchObject({ outcome: 'failed', reason: 'smoke test failed', toCommit: commitAfter, restart: { required: false } });
    expect(result.steps.at(-1)).toMatchObject({ name: 'update', ok: false, note: 'smoke test failed' });
  });

  it('requires a restart when smoke succeeds', async () => {
    const result = await apply({ updated: true, smokeOk: true, commitAfter });
    expect(result).toMatchObject({ outcome: 'updated', restart: { required: true } });
  });

  it('accepts older updater reports without smokeOk', async () => {
    const result = await apply({ updated: true, commitAfter });
    expect(result.outcome).toBe('updated');
  });
});

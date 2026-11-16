/**
 * recut-release-61 : the smoke gate recut from #3373 — a `smokeOk:false`
 * updater report must fail the apply (no restart into a smoke-broken build)
 * and the durable result file must record the failure; `smokeOk:null`
 * (smoke not determinable) still counts as updated.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { applySelfUpdate, type SelfUpdateRunner } from '../src/core/verse/self-update-apply.js';

async function apply(report: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'recut-release-61-'));
  const resultPath = join(dir, 'verse', 'self-update-last.json');
  const script = [
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
        ? { code: 0, stdout: next[1]!, stderr: '', timedOut: false }
        : { code: 42, stdout: '', stderr: 'unscripted call', timedOut: false };
    },
  };
  try {
    const result = await applySelfUpdate({ runner, repoRoot: '/repo', cliEntry: '/repo/dist/cli/index.js', resultPath });
    return { result, resultPath };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe('self-update smoke gate (recut of #3373)', () => {
  it('fails a smoke-broken update and records it durably', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recut-release-61-'));
    const resultPath = join(dir, 'self-update-last.json');
    const script = [
      ['status --porcelain', ''],
      ['fetch origin master', ''],
      ['rev-parse HEAD', 'a'.repeat(40)],
      ['rev-parse origin/master', 'b'.repeat(40)],
      ['merge-base --is-ancestor HEAD origin/master', ''],
      ['/repo/dist/cli/index.js update --json', JSON.stringify({ updated: true, smokeOk: false, commitAfter: 'c'.repeat(40) })],
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
      const result = await applySelfUpdate({ runner, repoRoot: '/repo', cliEntry: '/repo/dist/cli/index.js', resultPath });
      expect(result).toMatchObject({ outcome: 'failed', reason: 'smoke test failed', restart: { required: false } });
      const persisted = JSON.parse(await readFile(resultPath, 'utf8')) as { outcome?: string; reason?: string };
      expect(persisted).toMatchObject({ outcome: 'failed', reason: 'smoke test failed' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats an indeterminate smoke result as updated', async () => {
    const { result } = await apply({ updated: true, smokeOk: null, commitAfter: 'd'.repeat(40) });
    expect(result).toMatchObject({ outcome: 'updated', restart: { required: true } });
  });
});

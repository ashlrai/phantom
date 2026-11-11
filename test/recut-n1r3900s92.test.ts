import { expect, it, vi } from 'vitest';
import { applySelfUpdate, type SelfUpdateRunner } from '../src/core/verse/self-update-apply.js';

it('does not restart after the updater reports a failed smoke test', async () => {
  const responses = ['', '', 'b'.repeat(40), 'c'.repeat(40), '', JSON.stringify({ updated: true, smokeOk: false, commitAfter: 'a'.repeat(40) })];
  const runner: SelfUpdateRunner = {
    run: async () => ({ code: 0, stdout: responses.shift() ?? '', stderr: '', timedOut: false }),
  };
  const result = await applySelfUpdate({ runner, repoRoot: '/repo', cliEntry: '/repo/dist/cli/index.js', resultPath: '/tmp/recut-result.json', writeFile: vi.fn().mockResolvedValue(undefined) });
  expect(result).toMatchObject({ outcome: 'failed', reason: 'smoke test failed', toCommit: 'a'.repeat(40), restart: { required: false } });
});

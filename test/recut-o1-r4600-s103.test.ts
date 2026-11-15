import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { applySelfUpdate, type SelfUpdateRunner } from '../src/core/verse/self-update-apply.js';

it('persists a failed smoke test without requesting a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recut-o1-'));
  const resultPath = join(dir, 'result.json');
  const responses = ['', '', 'a'.repeat(40), 'b'.repeat(40), '', JSON.stringify({ updated: true, smokeOk: false })];
  const runner: SelfUpdateRunner = {
    run: async () => ({ code: 0, stdout: responses.shift() ?? '', stderr: '', timedOut: false }),
  };
  try {
    const result = await applySelfUpdate({ runner, repoRoot: '/repo', cliEntry: '/repo/dist/cli/index.js', resultPath });
    expect(result).toMatchObject({ outcome: 'failed', reason: 'smoke test failed', restart: { required: false } });
    expect(JSON.parse(await readFile(resultPath, 'utf8'))).toMatchObject({ outcome: 'failed', reason: 'smoke test failed' });
    expect(responses).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

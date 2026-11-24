import { describe, expect, it } from 'vitest';
import { gitOnlyLanded } from '../src/core/fleet/landed-git-only.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

const sha = 'a'.repeat(40);
function runner(missing: 'none' | 'fetch' | 'base' = 'none'): GitRunner {
  return async (_bin, args) => {
    const cmd = args[0];
    const code = (cmd === 'fetch' && missing === 'fetch') || (cmd === 'rev-parse' && missing === 'base') ? 1 : 0;
    const stdout = cmd === 'rev-parse' ? (args[1] === '--is-shallow-repository' ? 'false' : sha) : cmd === 'for-each-ref' ? 'refs/heads/contained\nrefs/heads/diverged\n' : cmd === 'rev-list' ? (args[2]?.endsWith('diverged') ? '2\n' : '0\n') : '';
    return { code, stdout, stderr: 'secret stderr', missing: false, timedOut: false, truncated: false };
  };
}
describe('branch containment', () => {
  it('binds contained and diverged branches to the fetched SHA', async () => {
    expect(await gitOnlyLanded({ git: runner(), fetch: true })).toEqual({ state: 'ok', baseSha: sha, branches: [
      { name: 'refs/heads/contained', ahead: 0, contained: true }, { name: 'refs/heads/diverged', ahead: 2, contained: false },
    ] });
  });
  it('reports missing remote or base as unknown', async () => {
    for (const missing of ['fetch', 'base'] as const) expect((await gitOnlyLanded({ git: runner(missing), fetch: true })).state).toBe('unknown');
  });
  it('does not invoke git for a dry run', async () => {
    expect(await gitOnlyLanded({ git: () => { throw Error('called'); } })).toEqual({ state: 'unknown', reason: 'base not refreshed' });
  });
});

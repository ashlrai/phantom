import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { matchProtectedPath } from '../src/core/authority/protected-paths.js';
import { applySelfUpdate, type SelfUpdateRunner } from '../src/core/verse/self-update-apply.js';

// Re-land of #4841 (RQ-PHX-RECUTN1R3900S92). The head's Quick typecheck failed
// in test/authority-codeowners-310b.test.ts: it carried the Tier-1 suite
// test/self-update-smoke-gate-04.test.ts without its CODEOWNERS owner line.
// This file pins the two halves of that failure on current master: the tier1
// test file is G1-protected AND owned, and the source change it guards —
// a smoke failure failing the apply even when `updated` is absent/false —
// actually holds (before, `updated:false + upToDate:true + smokeOk:false`
// was reported as `already-current` success and `commitAfter` was dropped).
const commitAfter = 'a'.repeat(40);

async function apply(report: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'redtestfix-c398-'));
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

/** GitHub CODEOWNERS pattern → RegExp (same subset the authority suite uses). */
function codeownersRegExp(pattern: string): RegExp {
  const anchored = pattern.startsWith('/');
  const body = anchored ? pattern.slice(1) : pattern;
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '*' && body[i + 1] === '*') {
      if (body[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${out}$`);
}

describe('redtestfix-c398 (re-land of #4841)', () => {
  it('the tier1 smoke-gate suite is G1-protected and owned in CODEOWNERS', () => {
    const path = 'test/self-update-smoke-gate-04.test.ts';
    expect(matchProtectedPath(path, { selfRepo: true }), 'suite must stay Tier-1 protected').not.toBeNull();
    const codeowners = readFileSync(join(import.meta.dirname, '..', '.github', 'CODEOWNERS'), 'utf8');
    const patterns = codeowners.split('\n').filter(line => line.trim() && !line.startsWith('#')).map(line => line.split(' ')[0]!);
    expect(patterns.some(pattern => codeownersRegExp(pattern).test(path)), `${path} must have a CODEOWNERS owner`).toBe(true);
  });

  it('fails the apply and records the commit when smoke fails without updated:true', async () => {
    const result = await apply({ updated: false, upToDate: true, smokeOk: false, commitAfter });
    expect(result).toMatchObject({ outcome: 'failed', reason: 'smoke test failed', toCommit: commitAfter, restart: { required: false } });
    expect(result.steps.at(-1)).toMatchObject({ name: 'update', ok: false, note: 'smoke test failed' });
  });
});

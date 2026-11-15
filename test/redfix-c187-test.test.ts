/**
 * RQ-PHX-REDTESTFIXC187 pin: the routines CLI reaches the sandboxed engine only
 * through src/cli/routines-engines.ts. The engine module is Tier-1, so a test
 * whose mock specifier names it becomes a `tier1-test` and needs a CODEOWNERS
 * line; mocking the seam keeps feature tests out of the owner lane.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

describe('routines engine seam', () => {
  it('keeps the Tier-1 engine specifier out of the CLI dispatcher and its tests', () => {
    expect(read('src/cli/routines.ts')).not.toContain('sandboxed-engine');
    expect(read('src/cli/routines.ts')).toContain('./routines-engines.js');
    expect(read('test/routine-placement.test.ts')).not.toContain('sandboxed-engine');
  });

  it('re-exports both sandbox runners the dispatcher selects between', async () => {
    const seam = await import('../src/cli/routines-engines.js');
    expect(typeof seam.runEngineSandboxed).toBe('function');
    expect(typeof seam.runApiModelSandboxed).toBe('function');
  });
});

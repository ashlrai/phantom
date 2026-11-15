import { describe, expect, it } from 'vitest';
import { authoritySummary } from '../scripts/authority-regen.mjs';

describe('authority regeneration summary', () => {
  it('reports additions and removals from snapshot and ownership fixtures', () => {
    const before = { roots: ['src/old.ts'], closure: ['src/old.ts', 'src/shared.ts'] };
    const after = { roots: ['src/new.ts'], closure: ['src/new.ts', 'src/shared.ts'] };
    expect(authoritySummary(before, after, '# generated\n/old @owner\n', '# generated\n/new @owner\n')).toBe([
      'Tier-1 roots:', '- src/old.ts', '+ src/new.ts',
      'Tier-1 closure:', '- src/old.ts', '+ src/new.ts',
      'CODEOWNERS lines:', '- /old @owner', '+ /new @owner',
    ].join('\n'));
    expect(authoritySummary(before, before, '/old @owner\n', '/old @owner\n')).toContain('  (no changes)');
  });
});

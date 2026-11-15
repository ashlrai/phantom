import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('release candidate 3.30.29', () => {
  it('extracts the existing release notes', () => {
    const notes = execFileSync(process.execPath, ['scripts/extract-changelog.mjs', '3.30.29'], { encoding: 'utf8' });
    expect(notes).toContain('### Fixes');
    expect(notes).toContain('### Changes');
  });
});

/**
 * Regression test: no tracked file should end in .orig (merge leftover).
 *
 * This test runs `git ls-files` from the repo root and asserts that no
 * tracked path matches the `.orig` suffix.  It guards against accidentally
 * committing merge leftovers.
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');

function getTrackedOrigFiles(): string[] {
  const output = execSync(
    'git ls-files | grep "\\.orig$" || true',
    { cwd: ROOT, encoding: 'utf-8' },
  );
  return output.trim().split('\n').filter(Boolean);
}

describe('no .orig merge leftovers', () => {
  it('tracks no file ending in .orig', () => {
    const origFiles = getTrackedOrigFiles();
    expect(origFiles).toHaveLength(0);
  });
});

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

function ignored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('.gitignore routing eval output', () => {
  it('ignores generated eval output but not the checked-in corpus', () => {
    expect(ignored('eval/routing/out/routing-eval.json')).toBe(true);
    expect(ignored('test/fixtures/routing-eval/corpus.json')).toBe(false);
  });

  it('keeps the fleet runtime block contiguous and the usage-readings exception', () => {
    const lines = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n');
    const fleet = lines.indexOf('.ashlr/');
    expect(lines.slice(fleet, fleet + 3)).toEqual(['.ashlr/', '*.launchd.err.log', '*.launchd.out.log']);
    expect(lines).toContain('!/usage-readings.log');
  });
});

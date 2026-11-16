import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}

describe('source artifacts', () => {
  it('contains no tracked patch or editor backup files', () => {
    let files: string[];
    try {
      files = execFileSync('git', ['ls-files', 'src'], { cwd: process.cwd() })
        .toString()
        .split('\n')
        .filter(Boolean);
    } catch {
      files = walk(join(process.cwd(), 'src'));
    }

    expect(files.length, 'source scan must include more than 100 files').toBeGreaterThan(100);
    const artifacts = files.filter((file) => /\.(patch|orig|rej|backup|bak)$/.test(file));
    expect(artifacts, `Stray source artifacts:\n${artifacts.join('\n')}`).toEqual([]);
  });
});

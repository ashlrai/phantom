import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const guide = readFileSync(join(root, 'docs/FLEET-API.md'), 'utf8');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() ? [path] : [];
  });
}

describe('fleet API documentation', () => {
  it('only names Verse path literals found in core source', () => {
    const paths = [...guide.matchAll(/`(\/api\/verse\/[^`]+)`/g)].map(match => match[1]!);
    expect(paths.length).toBeGreaterThan(15);
    const missing = new Set(paths);
    for (const file of sourceFiles(join(root, 'src/core'))) {
      const source = readFileSync(file, 'utf8');
      for (const path of missing) if (source.includes(path)) missing.delete(path);
      if (missing.size === 0) break;
    }
    expect([...missing]).toEqual([]);
  });

  it('links only to existing source files', () => {
    const targets = [...guide.matchAll(/\]\(\.\.\/(src\/[^)#]+)(?:#[^)]*)?\)/g)].map(match => match[1]!);
    expect(targets.length).toBeGreaterThan(15);
    for (const target of targets) expect(existsSync(resolve(root, target)), target).toBe(true);
  });

  it('is linked from the documentation index', () => {
    expect(readFileSync(join(root, 'docs/README.md'), 'utf8')).toContain('[Fleet API](FLEET-API.md)');
  });
});

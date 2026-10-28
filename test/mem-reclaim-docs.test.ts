import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('memory reclaim documentation discovery', () => {
  it('keeps the memory guide reachable from the packaged documentation index', () => {
    const index = readFileSync(resolve(root, 'docs/README.md'), 'utf8');
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { files: string[] };
    const guide = 'docs/MEM-RECLAIM.md';
    const target = manifest.files.includes(guide)
      ? 'MEM-RECLAIM.md'
      : `https://github.com/ashlrai/phantom/blob/master/${guide}`;
    expect(index).toContain(`[Memory reclaim](${target})`);
    expect(readFileSync(resolve(root, guide), 'utf8')).toContain('# Memory reclaim');
  });
});

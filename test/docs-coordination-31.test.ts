import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const page = readFileSync(resolve(root, 'docs/COORDINATION.md'), 'utf8');

describe('coordination guide', () => {
  it('references existing repository paths', () => {
    const paths = [...page.matchAll(/\b(?:src|docs)\/[A-Za-z0-9_./-]+/g)].map(match => match[0]);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(existsSync(resolve(root, path)), path).toBe(true);
  });

  it('names the outside PR API and fleet branch prefix', () => {
    expect(page).toContain('/api/verse/fleet/live/outside-prs');
    expect(page).toContain('codex-bridge/');
  });
});

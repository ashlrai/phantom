import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('published author identity', () => {
  it('uses the current AshlrAI contact, not the retired domain', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { author: string };
    expect(pkg.author).toBe('Mason Wyatt <mason@ashlr.ai>');
    const desktop = readFileSync('desktop/src-tauri/Cargo.toml', 'utf8');
    expect(desktop).toContain('Mason Wyatt <mason@ashlr.ai>');
    expect(desktop).not.toContain('evero-consulting.com');
  });
});

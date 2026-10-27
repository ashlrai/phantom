import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error -- plain .mjs script without types
import { lastPage } from '../scripts/ecosystem-stats.mjs';

describe('ecosystem stats', () => {
  it('parses the last page from a GitHub Link header', () => {
    expect(lastPage('<https://api.github.com/x?per_page=1&page=2>; rel="next", <https://api.github.com/x?per_page=1&page=4521>; rel="last"')).toBe(4521);
    expect(lastPage(null)).toBeNull();
  });
  it('keeps the ecosystem repo list in one config', () => {
    const cfg = JSON.parse(readFileSync('ecosystem/repos.json', 'utf8'));
    expect(cfg.owner).toBe('ashlrai');
    expect(cfg.repos).toContain('phantom');
    expect(new Set(cfg.repos).size).toBe(cfg.repos.length);
  });
});

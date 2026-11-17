import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');

describe('ecosystem-stats workflow inputs', () => {
  it('ships the script the daily workflow runs', () => {
    const wf = readFileSync(join(root, '.github/workflows/ecosystem-stats.yml'), 'utf8');
    const m = /node (scripts\/[\w.-]+\.mjs)/.exec(wf);
    expect(m).not.toBeNull();
    expect(existsSync(join(root, m![1]))).toBe(true);
  });

  it('lists repos in ecosystem/repos.json', () => {
    const cfg = JSON.parse(readFileSync(join(root, 'ecosystem/repos.json'), 'utf8'));
    expect(cfg.owner).toBe('ashlrai');
    expect(cfg.repos.length).toBeGreaterThan(0);
  });

  it('parses the last page from a Link header', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eco-stats-'));
    try {
      const { lastPage } = await import(join(root, 'scripts/ecosystem-stats.mjs'));
      expect(lastPage('<https://api.github.com/x?per_page=1&page=42>; rel="last"')).toBe(42);
      expect(lastPage(null)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

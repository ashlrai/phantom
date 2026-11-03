import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const page = readFileSync(join(root, 'docs/fleet-health.md'), 'utf8');
const examples = [...page.matchAll(/\| `ashlr (fleet [^`]+ --json)` \|/g)].map(match => match[1]!);

describe('fleet health guide', () => {
  it('starts with doctor, is indexed and explains unknown evidence', () => {
    expect(page.startsWith('```sh\nashlr fleet doctor\n```')).toBe(true);
    expect(readFileSync(join(root, 'docs/README.md'), 'utf8')).toContain('](fleet-health.md)');
    expect(page).toContain('Unknown does not mean healthy');
    expect(page).toContain('not an `ok`/`warn`/`red` report');
    expect(examples).toHaveLength(16);
    expect(page.split('\n').length).toBeLessThan(65);
  });

  it.each(examples)('runs documented example: ashlr %s', command => {
    const home = mkdtempSync(join(tmpdir(), 'fleet-health-doc-'));
    try {
      mkdirSync(join(home, '.ashlr'));
      writeFileSync(join(home, '.ashlr/config.json'), '{}');
      mkdirSync(join(home, 'Projects/ashlrai/wt'), { recursive: true });
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...command.split(' ')], {
        cwd: root,
        env: { ...process.env, HOME: home, ASHLR_RUNS_DIR: join(home, '.ashlr-runs') },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      // 1 is a health result; 2 would mean the documented syntax is wrong.
      expect([0, 1], result.stderr).toContain(result.status);
      expect(() => JSON.parse(result.stdout), result.stderr).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 35_000);
});

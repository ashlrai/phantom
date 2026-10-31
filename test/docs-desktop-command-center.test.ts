import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(resolve('docs/DESKTOP-COMMAND-CENTER.md'), 'utf8');
const lines = doc.trimEnd().split('\n');

describe('desktop command center architecture', () => {
  it('keeps the agreed headings and length', () => {
    expect(lines.length).toBeLessThanOrEqual(180);
    expect(lines.filter((line) => /^#{1,2} /.test(line))).toEqual([
      '# Phantom desktop: watch and steer the fleet',
      '## One surface, five places',
      '## Pulse and incidents',
      '## Phone',
      '## Honesty rules',
      '## Kill switches',
      '## For the next job',
    ]);
  });

  it('keeps non-landing backtick paths in the checkout', () => {
    const paths = lines.filter((line) => !line.includes('[^landing]'))
      .flatMap((line) => Array.from(line.matchAll(/`((?:src|docs|test|scripts)\/[^`]+)`/g), (match) => match[1]));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(existsSync(resolve(path)), path).toBe(true);
  });

  it('finds every route marked on master as a core string literal', () => {
    const routes = lines.filter((line) => line.includes('[^master]'))
      .flatMap((line) => Array.from(line.matchAll(/`(?:GET|POST|PUT|PATCH|DELETE) (\/api\/[^`\s]+)`/g), (match) => match[1]));
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      const files = execFileSync('git', ['grep', '-l', '-F', '--', route, 'src/core'], { encoding: 'utf8' }).trim().split('\n');
      const literal = new RegExp(`['"\\x60]${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\\x60]`);
      expect(files.some((file) => literal.test(readFileSync(file, 'utf8'))), route).toBe(true);
    }
  });
});

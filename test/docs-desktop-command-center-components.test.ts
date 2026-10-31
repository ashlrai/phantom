import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const lines = readFileSync(resolve('docs/DESKTOP-COMMAND-CENTER.md'), 'utf8').trimEnd().split('\n');

describe('desktop command center component claims', () => {
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

  it('names existing components on master lines and never mixes statuses', () => {
    const master = lines.filter((line) => line.includes('[^master]'));
    const paths = master.flatMap((line) => Array.from(
      line.matchAll(/`((?:src\/web-ui|src\/core)\/[^`]+)`/g), (match) => match[1],
    ));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(existsSync(resolve(path)), path).toBe(true);
    for (const line of lines.filter((entry) => entry.includes('[^landing]'))) {
      expect(line).not.toContain('[^master]');
    }
    for (const route of ['/api/verse/fleet/runs', '/api/verse/fleet/runs/inbox']) {
      expect(master.some((line) => line.includes(` ${route}\``)), route).toBe(true);
    }
  });
});

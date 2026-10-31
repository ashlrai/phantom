/**
 * README top-half brand contract (RQ-README-BRAND-PHANTOM).
 *
 * The rewritten header must stay lean: a one-line pitch, a quickstart, the
 * phm.dev/connect onboarding link, current screenshots or a diagram, and
 * badges only for live checks. Anything badge-like that is not a hosted CI
 * check (static shields text, registry stats, endpoint JSON) fails here, so
 * the header cannot grow a badge garden again without review.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const topHalf = readme.split('## The desktop app (macOS)')[0]!;

describe('README top-half brand contract', () => {
  it('opens with the one-line pitch', () => {
    const lines = readme.split('\n');
    expect(lines[0]).toBe('# Phantom');
    const pitch = lines.find((line) => line.startsWith('**') && line.endsWith('**'));
    expect(pitch).toMatch(/runs all engineering/i);
    expect(pitch).toMatch(/manages resources/i);
  });

  it('has exactly one Quickstart section with the real install commands', () => {
    expect(readme.match(/^## Quickstart$/gm)).toHaveLength(1);
    const quickstart = readme.split('## Quickstart')[1]!.split(/^## /m)[0]!;
    expect(quickstart).toContain('npm install -g @ashlr/phantom');
    expect(quickstart).toContain('phm verse');
    expect(quickstart).toContain('http://127.0.0.1:7777/verse/');
  });

  it('links the phm.dev/connect onboarding path', () => {
    expect(readme).toContain('](https://phm.dev/connect)');
  });

  it('keeps the candidate-version honesty line exactly once', () => {
    const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    const line = `This source tree targets version ${version}; check canonical release availability and exact matching assets before installation.`;
    expect(readme.split(line)).toHaveLength(2);
  });

  it('shows current screenshots or a diagram before the desktop section', () => {
    expect(topHalf).toMatch(/!\[[^\]]*\]\([^)]*docs\/images\/[^)]+\)/);
    expect(topHalf).toContain('```mermaid');
  });

  it('carries badges for live checks only', () => {
    const badges = [...topHalf.matchAll(/\[!\[[^\]]*\]\(([^)]+)\)\]\(([^)]+)\)/g)];
    expect(badges.length).toBeGreaterThan(0);
    for (const [, image, target] of badges) {
      expect(
        /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+\.yml\/badge\.svg$/.test(image!),
        `badge image ${image} is not a live GitHub Actions check`,
      ).toBe(true);
      expect(target).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+\.yml$/);
    }
  });
});

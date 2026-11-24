import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const links = [
  ['docs/CONTRIBUTE-WITH-AN-AGENT.md', 'which-tests-the-fast-gate-runs'],
  ['docs/CONTRIBUTE-WITH-AN-AGENT.md', 'protected-paths-wait-for-the-owner'],
  ['docs/FAQ.md', ''],
  ['docs/GLOSSARY.md', ''],
] as const;

function hasLink(index: string, path: string, fragment: string): boolean {
  const target = `${path}${fragment ? `#${fragment}` : ''}`;
  return [...index.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].some((match) => match[1] === target);
}

describe('root contribution navigation', () => {
  const index = read('llms.txt');

  it('links to the recovered guides and actual destination headings', () => {
    for (const [path, fragment] of links) {
      expect(hasLink(index, path, fragment)).toBe(true);
      const headings = [...read(path).matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) =>
        match[1]!.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-'),
      );
      expect(fragment ? headings : headings.length).toEqual(fragment ? expect.arrayContaining([fragment]) : expect.any(Number));
      expect(headings.length).toBeGreaterThan(0);
    }
  });

  it('detects removed links and incorrect fragments', () => {
    for (const [path, fragment] of links) {
      const target = `${path}${fragment ? `#${fragment}` : ''}`;
      expect(hasLink(index.replace(`](${target})`, '](missing.md)'), path, fragment)).toBe(false);
      if (fragment) expect(hasLink(index.replace(target, `${path}#wrong`), path, fragment)).toBe(false);
    }
  });

  it('retains the mission and contribution quickstart', () => {
    expect(index).toContain('## Mission');
    expect(index).toContain('(docs/strategy/RECURSIVE-SELF-IMPROVEMENT-AND-OPEN-FLEET-2026-11.md)');
    expect(index).toContain('(docs/CONTRIBUTE-WITH-AN-AGENT.md)');
    expect(index).toContain('node scripts/verify-changed.mjs');
    expect(index).toContain('gh pr create --repo ashlrai/phantom');
  });
});

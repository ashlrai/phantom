import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(path), 'utf8');
const faq = read('docs/FAQ.md');

describe('original FAQ onboarding preservation', () => {
  it('resolves every relative FAQ link and its heading anchor', () => {
    const links = [...faq.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
    expect(links.length).toBeGreaterThan(5);
    for (const link of links) {
      if (/^(?:https?:|mailto:)/.test(link)) continue;
      const [path, anchor] = link.split('#');
      const target = resolve(dirname('docs/FAQ.md'), path || 'FAQ.md');
      expect(existsSync(target), link).toBe(true);
      if (anchor) {
        const headings = readFileSync(target, 'utf8').match(/^#{1,6} .+$/gm) ?? [];
        const slugs = headings.map((heading) => heading.replace(/^#+\s+/, '').toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-'));
        expect(slugs, link).toContain(anchor);
      }
    }
    expect(faq).toContain('(GLOSSARY.md)');
  });

  it('points to distinct chat and fleet readiness supported by the interface and guide', () => {
    expect(faq).toMatch(/chat readiness[\s\S]*fleet readiness separately[\s\S]*connection alone does not establish readiness/i);
    const guide = read('docs/QUICKSTART.md');
    expect(guide).toMatch(/chat readiness[\s\S]*connected badge alone does not mean/i);
    expect(guide).toMatch(/fleet\s+readiness\*\* separately before unattended work/i);
    const component = read('src/web-ui/routes/verse/resources/ReadinessLines.tsx');
    expect(component).toContain('GET /api/verse/budget/readiness');
    expect(component).toContain('<Line label="Chat" verdict={row.chat}');
    expect(component).toContain('<Line label="Fleet" verdict={row.fleet}');
    expect(component).toContain('separate from connection and usage');
  });

  it('retains mission, quickstart, ecosystem and private security reporting', () => {
    for (const text of ['recursive self-improvement', 'QUICKSTART.md', 'ECOSYSTEM-MAP.md', 'private vulnerability reporting', 'Do **not** open a public issue']) expect(faq).toContain(text);
  });
});

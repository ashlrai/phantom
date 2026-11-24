import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const guide = read('CONTRIBUTING.md');
const introduction = guide.split('\n---\n')[0];

describe('PR #7065 contributor introduction preservation', () => {
  it('keeps the mission, contributor roles and newer first-contribution route', () => {
    expect(introduction).toContain(`\`${JSON.parse(read('package.json')).name}\``);
    expect(introduction).toContain('**Mission:** chasing open-source RSI');
    expect(introduction).toContain('**Who contributes:** mostly coding agents');
    expect(introduction).toContain('passwords, 2FA, device approvals and payments');
    expect(introduction).toContain('sanctioned workflow');
    expect(introduction).toContain('**First contribution?**');
    expect(introduction).toContain('`Merge Gate`');
    const ecosystem = read('README.md');
    for (const companion of ['Phantom Secrets', 'Ashlr Plugin', 'Locus', 'Lexicon', 'Ashlr MD', 'Ashlr Stack']) {
      expect(introduction).toContain(companion);
      expect(ecosystem).toContain(companion);
    }
  });

  it('resolves every introductory link and its heading anchor', () => {
    const targets = [...introduction.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
    expect(targets).toEqual([
      'docs/README.md', 'README.md#mission', 'README.md#the-phantom-ecosystem',
      'AGENTS.md', '#definition-of-green', 'docs/CONTRIBUTE-WITH-AN-AGENT.md', 'AGENTS.md',
    ]);
    for (const target of targets) {
      const [path, anchor] = target.split('#');
      const documentPath = path || 'CONTRIBUTING.md';
      expect(existsSync(resolve(root, documentPath)), target).toBe(true);
      if (anchor) {
        const headings = [...read(documentPath).matchAll(/^#{1,6} (.+)$/gm)]
          .map((match) => match[1].toLowerCase().replaceAll(' ', '-'));
        expect(headings, target).toContain(anchor);
      }
    }
    expect(read('llms.txt').startsWith('# Phantom\n')).toBe(true);
  });
});

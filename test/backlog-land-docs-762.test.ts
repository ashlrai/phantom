import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const index = readFileSync(resolve(root, 'llms.txt'), 'utf8');
const introduction = index.split('## Operator guides')[0];

describe('PR #7020 root documentation index preservation', () => {
  it('introduces Phantom before the existing operator guides', () => {
    expect(index.startsWith('# Phantom\n')).toBe(true);
    for (const heading of ['Mission', 'Install', 'Start here', 'Ecosystem', 'Operator guides']) {
      expect(index).toContain(`## ${heading}\n`);
    }
    expect(introduction).toContain('npm install -g @ashlr/phantom');
    expect(introduction).toContain('phm docs --agent --json');
    expect(introduction).toContain('registration does not prove readiness');
    expect(index).toContain('[Router gateway](docs/ROUTER-GATEWAY.md)');
    expect(index).toContain('[Job cost breakdown](docs/JOB-COST.md)');
  });

  it('keeps every carried navigation target resolvable', () => {
    const targets = [...introduction.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
    expect(targets.length).toBeGreaterThan(10);
    for (const target of targets) {
      if (target.startsWith('https://')) {
        expect(new URL(target).hostname).toBe('github.com');
      } else {
        const [path, anchor] = target.split('#');
        expect(existsSync(resolve(root, path)), target).toBe(true);
        if (anchor) {
          const document = readFileSync(resolve(root, path), 'utf8');
          expect(document.toLowerCase()).toContain(`## ${anchor.replaceAll('-', ' ')}`);
        }
      }
    }
  });
});

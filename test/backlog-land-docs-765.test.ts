import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const agentsUrl = new URL('../AGENTS.md', import.meta.url);
const agents = readFileSync(agentsUrl, 'utf8');
const mission = agents.split('## Mission and ecosystem\n')[1]?.split('\n## Article 1:')[0] ?? '';

describe('documentation preserved from PR #7073', () => {
  it('keeps the mission heading and the separately authorized ecosystem', () => {
    expect(existsSync(agentsUrl)).toBe(true);
    expect(agents).toContain('## Mission and ecosystem');
    expect(mission).toContain('RSI (recursive self-improvement)');
    expect(mission).toContain('ship releases through the sanctioned workflow');
    expect(mission).toContain('each with its own authorization boundary');
    for (const repo of ['phantom-secrets', 'ashlr-plugin', 'locus', 'lexicon', 'ashlr-md', 'ashlr-stack']) {
      expect(mission).toContain(`https://github.com/ashlrai/${repo}`);
    }
  });

  it('retains resolvable strategy, ecosystem, toolchain and authority navigation', () => {
    const targets = [...mission.matchAll(/\]\(([^)]+)\)/g)]
      .map((match) => match[1]!)
      .filter((href) => !href.startsWith('https://'));
    expect(targets).toEqual([
      'docs/strategy/RECURSIVE-SELF-IMPROVEMENT-AND-OPEN-FLEET-2026-11.md',
      'README.md#the-phantom-ecosystem',
      'docs/AGENT-TOOLCHAIN.md',
      'docs/STANDING-AUTHORITY.md',
    ]);
    for (const href of targets) {
      expect(existsSync(new URL(`../${href.split('#')[0]}`, import.meta.url)), href).toBe(true);
    }
    expect(readFileSync(new URL('../README.md', import.meta.url), 'utf8')).toContain('## The Phantom ecosystem');
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone documentation checker has no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const guide = read('CONTRIBUTING.md');
const walkthrough = guide.split('## Contribute with an agent\n')[1]?.split('\n---\n')[0] ?? '';

describe('PR #7164 inline contributor walkthrough preservation', () => {
  it('keeps all seven steps alongside the newer contributor guidance', () => {
    expect(existsSync(resolve(root, 'CONTRIBUTING.md'))).toBe(true);
    const steps = [...walkthrough.matchAll(/^\d\. \*\*([^*]+)\*\*/gm)].map((match) => match[1]);
    expect(steps).toEqual([
      'Clone upstream, push to your fork.', 'Install.', 'Brief the agent.',
      'Verify locally', 'Commit and open the pull request.',
      'What hosted CI requires.', 'How it merges.',
    ]);
    expect(walkthrough).toContain('origin/master');
    expect(walkthrough).toContain('npm run test:ci -- test/<affected>.test.ts');
    expect(walkthrough).toContain('hermetic tests');
    expect(walkthrough).toContain("also need the owner's review");
    expect(walkthrough).toContain('Never weaken a test');
    expect(guide).toContain('**Mission:** chasing open-source RSI');
    expect(guide).toContain('**First contribution?**');
  });

  it('resolves guide links, anchors and absolute source links in the docs index', () => {
    const result = checkDocumentation({
      root, mode: 'source', entrypoints: ['CONTRIBUTING.md', 'docs/README.md', 'README.md'],
    });
    expect(result.errors).toEqual([]);
    expect(result.localLinks).toBeGreaterThan(0);
    expect(result.sourceLinks).toBeGreaterThan(0);
    expect(result.externalRequests).toBe(0);
    const index = read('docs/README.md');
    expect(index).toContain('https://github.com/ashlrai/phantom/blob/master/docs/CONTRIBUTE-WITH-AN-AGENT.md');
  });

  it('retains the existing navigation instead of restoring superseded targets', () => {
    const target = 'https://github.com/ashlrai/phantom/blob/master/docs/CONTRIBUTE-WITH-AN-AGENT.md';
    expect(read('README.md')).toContain(target);
    expect(read('docs/README.md')).toContain(target);
    expect(walkthrough).toContain('docs/CONTRIBUTE-WITH-AN-AGENT.md#6-what-ci-requires');
    expect(read('llms.txt').startsWith('# Phantom\n')).toBe(true);
  });
});

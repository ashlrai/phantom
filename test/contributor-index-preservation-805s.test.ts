import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('root contributor index', () => {
  it('links to the guides and describes the upstream and fork workflow', () => {
    const text = readFileSync(resolve('llms.txt'), 'utf8');
    const section = text.match(/^## Contribute\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
    expect(section).toBeDefined();
    for (const target of ['docs/CONTRIBUTE-WITH-AN-AGENT.md', 'docs/verify-changed.md']) {
      expect(section).toContain(`](${target})`);
      expect(existsSync(resolve(target))).toBe(true);
    }
    expect(section).toContain('origin/master');
    expect(section).toContain('git clone https://github.com/ashlrai/phantom.git');
    expect(section).toContain('git remote add fork https://github.com/<you>/phantom.git');
    expect(section).toContain('node scripts/verify-changed.mjs');
    expect(section).toContain('git push fork <topic-branch>');
    expect(section).toContain('gh pr create --repo ashlrai/phantom --base master');
  });
});

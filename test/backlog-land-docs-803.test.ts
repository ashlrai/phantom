import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('PR #9859 community onboarding preservation', () => {
  it('keeps the conduct, starter queue and community guidance in the contributor guide', () => {
    expect(existsSync(resolve(root, 'CONTRIBUTING.md'))).toBe(true);
    const doc = read('CONTRIBUTING.md');
    expect(doc).toContain('**New to the project?**');
    expect(doc).toContain('under the [Code of Conduct](CODE_OF_CONDUCT.md)');
    expect(doc).toContain('are the starter queue');
    expect(doc).toContain('[The Dev Shack](https://discord.gg/jBQrSU6XeD)');
    // Keep the setup guidance already landed from #9699.
    expect(doc).toContain('gh repo fork ashlrai/phantom --clone=false');
    expect(read('llms.txt').startsWith('# Phantom')).toBe(true);
  });

  it('resolves every carried link and preserves both starter issue filters', () => {
    const doc = read('CONTRIBUTING.md');
    const paragraph = doc.split('**New to the project?**')[1]?.split('\n---')[0];
    expect(paragraph).toBeDefined();
    const links = [...paragraph!.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(match => match[1]);
    expect(links).toHaveLength(4);
    for (const link of links) {
      if (!link.startsWith('https://')) {
        expect(existsSync(resolve(root, link)), link).toBe(true);
        continue;
      }
      const url = new URL(link);
      if (url.hostname === 'github.com') {
        expect(url.pathname).toBe('/ashlrai/phantom/issues');
        expect(url.searchParams.get('q')).toMatch(/^is:issue is:open label:"(?:good first issue|help wanted)"$/);
      } else {
        expect(url.hostname).toBe('discord.gg');
        expect(url.pathname).toBe('/jBQrSU6XeD');
      }
    }
    for (const label of ['good first issue', 'help wanted']) {
      expect(links.some(link => link.startsWith('https://github.com/')
        && new URL(link).searchParams.get('q') === `is:issue is:open label:"${label}"`)).toBe(true);
    }
  });
});

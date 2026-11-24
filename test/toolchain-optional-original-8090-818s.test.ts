import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('optional companion onboarding from PR 8090', () => {
  it('keeps both toolchain index entries aligned with the contributor guidance', () => {
    const entries = ['docs/llms-source.txt', 'docs/llms.txt'].map((path) => {
      const matches = read(path).split('\n').filter((line) => line.includes('[Agent toolchain](AGENT-TOOLCHAIN.md)'));
      expect(matches, path).toHaveLength(1);
      expect(matches[0]).toMatch(/all optional for outside contributors/i);
      return matches[0];
    });
    expect(entries[0]).toBe(entries[1]);
    const guidance = read('docs/AGENT-TOOLCHAIN.md').replace(/\s+/g, ' ');
    expect(guidance).toMatch(/Outside contributors:.*every server below is optional/i);
    expect(guidance).toMatch(/None is needed to install, build or run the tests/i);
    expect(guidance).toContain('[Contribute with an agent](CONTRIBUTE-WITH-AN-AGENT.md)');
  });
});

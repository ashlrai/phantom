import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('preserved safety-test references from PR 7555', () => {
  it('links the legacy safety claims to existing concrete test files', () => {
    const doc = read('docs/HUB-REFERENCE.md');
    const safety = doc.split('## Safety model')[1].split('## The `~/.ashlr/` home layout')[0];
    for (const name of [
      'h4.sandbox-enrollment-kill', 'h6.audit-policy', 'm48.fleet-supervisor',
      'm45.foundry', 'm21.worktree', 'h4.sandbox-containment',
      'm47.merge', 'm47_1.provenance',
    ]) {
      const path = `test/${name}.test.ts`;
      expect(safety).toContain(`https://github.com/ashlrai/phantom/blob/master/${path}`);
      expect(existsSync(resolve(root, path)), path).toBe(true);
    }
    expect(safety).not.toContain('test/m47-1.*');
    expect(safety).toContain('legacy enrolled-repository fleet');
    expect(safety).toContain('Separate foreground runtimes require their own cancellation and reconciliation.');
    expect(safety).toContain('evidence mode refuses local fallback and self-target merges');
  });

  it('keeps master references alongside the recovered contributor references', () => {
    const doc = read('CONTRIBUTING.md');
    for (const path of [
      'test/h4.proposal-only.test.ts', 'test/h6.audit-policy.test.ts',
      'test/m21.worktree.test.ts', 'test/h4.sandbox-containment.test.ts',
      'test/h6.audit-completeness.test.ts', 'test/h1.apply-guardrails.test.ts',
    ]) {
      expect(doc).toContain(path);
      expect(existsSync(resolve(root, path)), path).toBe(true);
    }
    expect(doc).toContain('no producer verdict, test result or documentation change grants authority by itself');
    expect(read('llms.txt').startsWith('# Phantom')).toBe(true);
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone documentation checker has no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const documents = ['AGENTS.md', 'docs/AGENT-OPERATIONS.md'];
const compact = (text: string) => text.replace(/\s+/g, ' ');

describe('PR #7315 agent operations documentation preservation', () => {
  it('documents topic-named suites while retaining the older naming conventions', () => {
    for (const path of documents) {
      expect(existsSync(resolve(root, path)), path).toBe(true);
      const text = read(path);
      expect(text, path).toContain('<topic>.test.ts');
      expect(text, path).toContain('m<N>.<topic>.test.ts');
    }
    expect(read('docs/AGENT-OPERATIONS.md')).toContain('test/h<N>.*.test.ts');
  });

  it('distinguishes advisory merge checks from exact-commit release requirements', () => {
    for (const path of documents) {
      const text = compact(read(path));
      expect(text, path).toContain('`Check authority drift (hermetic)`');
      expect(text, path).toContain('advisory');
      expect(text, path).toContain('Auto-tag and the release gate require');
      expect(text, path).toContain('green on the exact commit; fix drift in the same');
    }
    const workflow = read('.github/workflows/ci.yml');
    const gate = workflow.split('    name: Merge Gate\n')[1]?.split('\n  master-full:')[0] ?? '';
    expect(gate).toContain("const advisory = fast && !release ? ['quick'] : [];");
    const needs = gate.match(/needs: \[([^\]]+)\]/)?.[1] ?? '';
    expect(needs).toContain('fast-gate');
    expect(needs).not.toContain('authority-drift');
    expect(read('.github/scripts/ci-release-gate.mjs')).toContain("['Check authority drift (hermetic)', 'any']");
    expect(read('.github/workflows/auto-tag.yml')).toContain('"Check authority drift (hermetic)"');
  });

  it('preserves revert-state guidance without replacing newer generated CLI descriptions', () => {
    const operations = compact(read('docs/AGENT-OPERATIONS.md'));
    expect(operations).toContain('`phm router outcomes --json` includes recorded merge and revert state');
    const command = read('src/cli/router-outcomes.ts');
    expect(command).toContain('reverted=${text(o.reverted)}');
    expect(read('docs/CLI-REFERENCE.md')).toContain('phm fleet coding-regret --evidence');
    expect(read('docs/cli.md')).toContain('merge latency (ttm_s)');
  });

  it('resolves the carried documents and their key file and anchor links', () => {
    const report = checkDocumentation({ root, mode: 'source', entrypoints: documents });
    expect(report.errors).toEqual([]);
    expect(report.localLinks + report.sourceLinks).toBeGreaterThan(0);
    expect(read('docs/AGENT-OPERATIONS.md')).toContain('[CLI reference](CLI-REFERENCE.md)');
    expect(read('llms.txt').startsWith('# Phantom\n')).toBe(true);
  });
});

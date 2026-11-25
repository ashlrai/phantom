import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
// @ts-expect-error Standalone documentation checker has no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');
const compact = (path: string): string => read(path).replace(/\s+/g, ' ');
const documents = [
  ['AGENTS.md', '## Working in this repository'],
  ['CLAUDE.md', '## Commands'],
  ['CONTRIBUTING.md', '## Everyday commands'],
  ['docs/CONTRIBUTE-WITH-AN-AGENT.md', '### Skipping a flaky test'],
  ['docs/DIAGNOSIS-MERGE-DRAIN.md', '### Rebase PRs run the authority drift tests before publish'],
] as const;

describe('PR #7463 local verification guidance preservation', () => {
  it('keeps the original guides, key headings and navigation targets', () => {
    for (const [path, heading] of documents) expect(read(path), path).toContain(heading);
    const report = checkDocumentation({ root, mode: 'source', entrypoints: documents.map(([path]) => path) });
    expect(report.errors).toEqual([]);
    expect(read('llms.txt').startsWith('# Phantom\n')).toBe(true);
  });

  it('warns that a skipped local lint is not covered by PR CI', () => {
    for (const path of ['AGENTS.md', 'CLAUDE.md']) {
      expect(compact(path), path).toContain('do not run ESLint or `check:docs`');
    }
    expect(compact('CONTRIBUTING.md')).toContain('not ESLint or `check:docs`; run those locally before pushing');
    const guide = compact('docs/CONTRIBUTE-WITH-AN-AGENT.md');
    expect(guide).toContain('Do not rely on the "Merge Gate lints on CI" hint');
    expect(guide).toContain('a skipped local lint means the change merges unlinted');
    expect(guide).toContain('`npm run lint` and `npm run check:docs` do not run on pull requests');
    expect(compact('docs/DIAGNOSIS-MERGE-DRAIN.md')).toContain('Do not resolve a drift failure by editing the test. Merge Gate stays the required check');
  });

  it('agrees with the workflow exclusion of full lint and docs jobs on PRs', () => {
    const workflow = parse(read('.github/workflows/ci.yml')) as {
      jobs: Record<string, { if?: string; steps?: { run?: string }[] }>;
    };
    const fullChecks = Object.values(workflow.jobs).filter((job) =>
      job.steps?.some((step) => /npm run (lint|check:docs)\b/.test(step.run ?? '')),
    );
    expect(fullChecks.length).toBeGreaterThan(0);
    for (const job of fullChecks) expect(job.if).toContain("github.event_name != 'pull_request'");
    expect(read('test/cli-tidy-json.test.ts')).toMatch(/import \{ requireBuiltDist \} from '\.\/helpers\/require-built-dist\.js'/);
  });
});

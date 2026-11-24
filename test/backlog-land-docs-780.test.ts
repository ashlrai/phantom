import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
// @ts-expect-error Standalone documentation checker has no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');
const text = (path: string): string => read(path).replace(/\s+/g, ' ');

describe('PR #7453 hosted CI guidance preservation', () => {
  it('explains release-call deferral and the Windows service lane', () => {
    const guide = text('CONTRIBUTING.md');
    expect(guide).toContain('Windows service authority lane');
    expect(guide).toContain('The reusable release call retains the Ubuntu/Windows matrix but defers the macOS and Windows service lanes to the scheduled run.');
    expect(guide).toContain('Failures there are fixed forward.');

    const workflow = parse(read('.github/workflows/ci.yml')) as {
      jobs: Record<string, { if: string }>;
    };
    for (const lane of ['windows-service-authority', 'ci-shared-macos', 'mac-general', 'mac-isolated', 'native-macos-broker-foundation']) {
      expect(workflow.jobs[lane]?.if, lane).toContain("github.event_name != 'push'");
    }
    // The portability matrix still runs for reusable tag pushes, while a
    // direct master push takes the fast lane, as both operator guides say.
    expect(workflow.jobs.ci?.if).toContain("!(github.event_name == 'push' && github.ref == 'refs/heads/master')");
    expect(text('docs/AGENT-OPERATIONS.md')).toContain('No pull request, merge-queue commit or direct `master` push may occupy a macOS or Windows runner');
  });

  it('keeps both source documents and their links and anchors valid', () => {
    const report = checkDocumentation({
      root,
      mode: 'source',
      entrypoints: ['CONTRIBUTING.md', 'docs/AGENT-OPERATIONS.md'],
    });
    expect(report.errors).toEqual([]);
  });
});

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const contributingPath = resolve(process.cwd(), 'CONTRIBUTING.md');
const scriptPath = resolve(process.cwd(), 'scripts/verify-changed.mjs');

describe('contributing verify-changed row', () => {
  it('CONTRIBUTING.md references node scripts/verify-changed.mjs', () => {
    const content = readFileSync(contributingPath, 'utf-8');
    expect(content).toContain('node scripts/verify-changed.mjs');
  });

  it('scripts/verify-changed.mjs exists', () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('table row sits inside the Everyday commands section', () => {
    const content = readFileSync(contributingPath, 'utf-8');
    const sectionStart = content.indexOf('## Everyday commands');
    expect(sectionStart).toBeGreaterThanOrEqual(0);
    // Find the next "## " heading (section boundary)
    const nextSection = content.indexOf('## ', sectionStart + '## Everyday commands'.length);
    const sectionEnd = nextSection >= 0 ? nextSection : content.length;
    const section = content.slice(sectionStart, sectionEnd);
    expect(section).toContain('node scripts/verify-changed.mjs');
  });

  // CONTRIBUTING.md once said Merge Gate "runs the full check" and that a
  // `ci:full-mac` label starts the Mac lanes on a pull request. ci.yml runs only
  // the fast gate on pull requests and never runs macOS lanes there, so hold
  // the guide to the workflow instead of letting that drift come back.
  it('describes hosted CI the way ci.yml runs it', () => {
    const content = readFileSync(contributingPath, 'utf-8');
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf-8');
    expect(workflow).toContain('macOS lanes never run on PR or merge_group');
    expect(content).not.toMatch(/Merge Gate`? (still |stays |remains )?(runs )?the full (CI )?check/);
    expect(content).not.toMatch(/full CI check remains the merge gate/);
    expect(content).not.toContain('ci:full-mac');
    expect(content).toContain('docs/CONTRIBUTE-WITH-AN-AGENT.md#6-what-ci-requires');
  });
});

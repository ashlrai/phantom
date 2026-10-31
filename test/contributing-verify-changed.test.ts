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
});

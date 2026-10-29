/**
 * Drift guard for docs/cli.md.
 *
 * docs/cli.md is generated from `phm --help` output by
 * scripts/generate-cli-docs.mjs and committed. This regenerates the document
 * in memory and compares it byte-for-byte with the committed file, so a
 * help-text change that forgets the regeneration step fails here instead of
 * letting the published CLI reference drift from the binary a user runs.
 *
 * Fix a failure with: node scripts/generate-cli-docs.mjs
 *
 * The subprocess capture lives inside the imported generator module, so this
 * file carries no spawn marker and stays in the unit lane; the capture itself
 * gets an explicit 60s hook budget for the two real `phm` subprocesses.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// @ts-expect-error standalone Node generator script has no declaration output
import {
  buildCliDocs,
  checkCliDocs,
  firstDiff,
  normalizeHelpOutput,
  renderCliDoc,
} from '../scripts/generate-cli-docs.mjs';

const ROOT = join(__dirname, '..');
const DOC_PATH = join(ROOT, 'docs/cli.md');

let generated = '';
beforeAll(() => {
  generated = buildCliDocs({ repoRoot: ROOT });
}, 60_000);

describe('docs/cli.md drift guard', () => {
  it('committed doc matches fresh `phm --help` output byte-for-byte', () => {
    expect(existsSync(DOC_PATH), 'docs/cli.md missing; run `node scripts/generate-cli-docs.mjs`').toBe(true);
    const actual = readFileSync(DOC_PATH, 'utf8');
    const diff = firstDiff(actual, generated);
    expect(
      diff,
      'docs/cli.md is stale; run `node scripts/generate-cli-docs.mjs` to regenerate',
    ).toBeNull();
    expect(actual).toBe(generated);
  });

  it('the script check path agrees', () => {
    expect(checkCliDocs(ROOT).ok).toBe(true);
  });

  it('generated output is ANSI-free, ASCII-dashed and trimmed', () => {
    expect(generated).not.toContain('\u001b');
    expect(generated).not.toMatch(/[\u2010-\u2015\u2212]/);
    expect(generated).not.toMatch(/[ \t]+$/m);
    expect(generated.endsWith('\n')).toBe(true);
    expect(generated.endsWith('\n\n')).toBe(false);
  });

  it('embeds both help surfaces with real command rows', () => {
    expect(generated).toContain('`phm --help`');
    expect(generated).toContain('`phm help --all`');
    expect(generated).toContain('phm help <topic>');
    expect(generated).toContain('Core - index, navigate, configure');
    expect(generated).toContain('Scaffold - new projects + shipping');
  });

  it('normalizeHelpOutput strips ANSI, CRLF, trailing spaces and non-ASCII dashes', () => {
    expect(normalizeHelpOutput('\u001b[31m  a \u2014 b \u2013 c   \r\n\r\n')).toBe('  a - b - c\n');
    expect(normalizeHelpOutput('plain\n')).toBe('plain\n');
    expect(normalizeHelpOutput('')).toBe('');
  });

  it('renderCliDoc and firstDiff behave on minimal sections', () => {
    const doc = renderCliDoc([{ title: 'phm --help', note: 'note', output: 'row\n' }]);
    expect(doc).toContain('```text\nrow\n```');
    expect(firstDiff('a\nb\n', 'a\nc\n')).toEqual({ line: 2, actual: 'b', expected: 'c' });
    expect(firstDiff('a\n', 'a\n')).toBeNull();
  });
});

/**
 * test/composer-commands-doc-31.test.ts — verifies docs/COMPOSER-COMMANDS.md
 * stays in sync with src/web-ui/routes/verse/composer/composer-text.ts.
 *
 * Reads both files as text (from origin/master for source, local for doc).
 * Collects command ids from the SLASH_COMMANDS array via regex; asserts that
 * every "## /name" heading in the doc is one of those ids (doc ⊆ catalog),
 * and that the doc has at least 8 sections.
 */
import { describe, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

function readFromMaster(filePath: string): string {
  return execSync(`git show origin/master:${filePath}`, { encoding: 'utf-8', cwd: ROOT });
}

function readLocal(filePath: string): string {
  const abs = resolve(ROOT, filePath);
  return readFileSync(abs, 'utf-8');
}

function extractCommandIds(source: string): string[] {
  const ids: string[] = [];
  const re = /id:\s*'([a-z]+)'/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    ids.push(m[1]!);
  }
  return ids;
}

function extractDocSections(doc: string): string[] {
  const sections: string[] = [];
  const re = /^## \/([a-z]+)$/gm;
  let m;
  while ((m = re.exec(doc)) !== null) {
    sections.push(m[1]!);
  }
  return sections;
}

describe('composer-commands-doc-31', () => {
  it('collects command ids from SLASH_COMMANDS', () => {
    const source = readFromMaster('src/web-ui/routes/verse/composer/composer-text.ts');
    const ids = extractCommandIds(source);
    if (ids.length < 8) {
      throw new Error(`SLASH_COMMANDS should have at least 8 commands, got ${ids.length}`);
    }
  });

  it('doc sections are a subset of SLASH_COMMANDS ids (doc ⊆ catalog)', () => {
    const source = readFromMaster('src/web-ui/routes/verse/composer/composer-text.ts');
    const doc = readLocal('docs/COMPOSER-COMMANDS.md');
    const catalogIds = new Set(extractCommandIds(source));
    const docSections = extractDocSections(doc);

    const missing = docSections.filter((s) => !catalogIds.has(s));
    if (missing.length > 0) {
      throw new Error(`Doc headings not in SLASH_COMMANDS: ${missing.join(', ')}`);
    }
  });

  it('doc has at least 8 command sections', () => {
    const doc = readLocal('docs/COMPOSER-COMMANDS.md');
    const sections = extractDocSections(doc);
    if (sections.length < 8) {
      throw new Error(`Doc should have at least 8 sections, got ${sections.length}`);
    }
  });
});

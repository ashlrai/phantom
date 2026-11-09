/**
 * Freshness block regeneration for README.md, CHANGELOG.md and the Markdown
 * under docs/ and examples/ — managed `fresh:` markers rewritten from
 * package.json and the first dated CHANGELOG.md release.
 *
 * Ported from scripts/freshness/sync.test.mjs (node:test) so the coverage runs
 * in the vitest suite; main()/synchronize() are exercised in-process instead of
 * through spawned scripts, so the file carries no spawn marker and stays in
 * the unit lane.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error standalone Node generator script has no declaration output
import { main, regenerate, renderBlock, synchronize } from '../scripts/freshness/sync.mjs';

const facts = { version: '3.0.0', released: '2.9.0', date: '2026-10-01' };
const tmpdirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'phantom-freshness-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (tmpdirs.length) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

/** Run the check/sync entrypoint in-process; returns { status, stdout }. */
function runCli(check: boolean, root: string): { status: number; stdout: string } {
  process.exitCode = undefined;
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => lines.push(args.map(String).join(' ')));
  try {
    // The spawned entrypoint catches main() throws into exit 1; mirror that here.
    try {
      main(check, ['--root', root]);
    } catch {
      process.exitCode = 1;
    }
    return { status: process.exitCode ?? 0, stdout: lines.join('\n') };
  } finally {
    log.mockRestore();
    process.exitCode = undefined;
  }
}

describe('freshness managed blocks', () => {
  it.each([
    ['version-badge', 'source-3.0.0-blue'],
    ['install-snippet', 'npm install -g @ashlr/phantom@2.9.0'],
    ['version-table', '| Latest dated changelog release (2026-10-01) | 2.9.0 |'],
    ['example-version-pin', 'npx --package=@ashlr/phantom@2.9.0 phm --version'],
  ])('regenerates %s and preserves surrounding content', (name, expected) => {
    const before = `keep\n<!-- fresh:begin ${name} -->\nstale\n<!-- fresh:end -->\nhistory\n`;
    const after = regenerate(before, facts);
    expect(after).toContain(expected);
    expect(after).toBe(`keep\n<!-- fresh:begin ${name} -->\n${renderBlock(name, facts)}\n<!-- fresh:end -->\nhistory\n`);
    expect(regenerate(after, facts)).toBe(after);
  });

  it('rejects unknown, nested, unclosed, unmatched and malformed blocks', () => {
    for (const text of [
      '<!-- fresh:begin missing -->\n<!-- fresh:end -->',
      '<!-- fresh:begin version-table --><!-- fresh:begin version-table -->',
      '<!-- fresh:begin version-table -->',
      '<!-- fresh:end -->',
      '<!-- fresh:begin Version-table -->',
    ]) {
      expect(() => regenerate(text, facts)).toThrow();
    }
  });

  it('preserves CRLF and repeated block instances', () => {
    const text = '<!-- fresh:begin version-table -->\r\nstale\r\n<!-- fresh:end -->\r\n';
    const generated = regenerate(text + text, facts);
    expect(generated.match(/Source package/g)!.length).toBe(2);
    expect(/(?<!\r)\n/.test(generated)).toBe(false);
  });

  it('renders all blocks together and leaves unmarked historical pins intact', () => {
    const names = ['version-badge', 'install-snippet', 'version-table', 'example-version-pin'];
    const text = names.map((name) => `<!-- fresh:begin ${name} -->\nstale\n<!-- fresh:end -->`).join('\n') + '\nHistorical @ashlr/phantom@1.0.0\n';
    const result = regenerate(text, facts);
    expect(result).not.toContain('stale');
    expect(result.endsWith('Historical @ashlr/phantom@1.0.0\n')).toBe(true);
    expect(regenerate(result, facts)).toBe(result);
  });
});

describe('freshness sync and check on a fixture checkout', () => {
  it('check detects seeded drift, sync repairs it, and check is read-only', () => {
    const root = tmp();
    mkdirSync(join(root, 'docs'));
    mkdirSync(join(root, 'examples'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@ashlr/phantom', version: facts.version }));
    const history = '## [3.0.0] - Unreleased\n\n## [2.9.0] - 2026-10-01\n\nHistorical pin 1.0.0\n';
    writeFileSync(join(root, 'CHANGELOG.md'), history);
    const stale = '<!-- fresh:begin version-badge -->\nseeded drift\n<!-- fresh:end -->\n';
    writeFileSync(join(root, 'README.md'), stale);

    const check = runCli(true, root);
    expect(check.status).toBe(1);
    expect(check.stdout).toMatch(/drift: README.md/);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(stale);

    expect(runCli(false, root).status).toBe(0);
    expect(runCli(true, root).status).toBe(0);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(history);
    expect(synchronize(root)).toEqual([]);

    // A later malformed document prevents even earlier valid writes.
    writeFileSync(join(root, 'README.md'), stale);
    writeFileSync(join(root, 'docs', 'broken.md'), '<!-- fresh:end -->');
    expect(() => synchronize(root)).toThrow(/docs\/broken\.md/);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(stale);

    writeFileSync(join(root, 'CHANGELOG.md'), '## [3.0.0] - Unreleased\n');
    expect(runCli(true, root).status).toBe(1);
  });
});

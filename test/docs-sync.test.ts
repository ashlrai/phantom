/**
 * docs-sync: one command keeps every generated documentation surface honest.
 *
 * The committed tree must match what the generators produce. This suite runs
 * scripts/docs-sync.mjs in --check mode over the real checkout for the local
 * surfaces — the check newly covers markdown `fresh:` blocks (README.md,
 * CHANGELOG.md, docs/, examples/), docs/llms.txt's generated page index and
 * site/llms.txt + site/llms-full.txt, which previously drifted silently, as
 * well as the site/ managed blocks and docs/CODEMAP.md inventory that already
 * had their own guards. The two help-generated references (docs/cli.md,
 * docs/CLI-REFERENCE.md) rerun the CLI through tsx; their own drift suites
 * (cli-docs-drift, cli-reference-drift) hold them instead.
 *
 * Fix a failure with: node scripts/docs-sync.mjs  (or npm run docs:sync)
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { docsSync } from '../scripts/docs-sync.mjs';
import { CODEMAP_SECTIONS, codemapInventory, regenerateCodemap, syncCodemap } from '../scripts/codemap.mjs';

const ROOT = join(__dirname, '..');
const tmpdirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'docs-sync-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpdirs.length) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

/** Minimal checkout exercising the four fixture-friendly local surfaces. */
function fixtureRoot(): string {
  const root = tmp();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@ashlr/phantom', version: '3.0.0' }));
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [3.0.0] - Unreleased\n\n## [2.9.0] - 2026-10-01\n\nHistorical pin 1.0.0\n');
  writeFileSync(join(root, 'README.md'), 'keep\n<!-- fresh:begin version-badge -->\nstale\n<!-- fresh:end -->\n');
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'examples'), { recursive: true });
  mkdirSync(join(root, 'site'), { recursive: true });
  mkdirSync(join(root, 'src', 'cli'), { recursive: true });
  mkdirSync(join(root, 'src', 'core', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'CODEMAP.md'), [
    '# Source code map',
    '',
    '<!-- codemap:src:start -->',
    '- `src/old/`',
    '<!-- codemap:src:end -->',
    '',
    '<!-- codemap:core:start -->',
    '<!-- codemap:core:end -->',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'docs', 'GUIDE.md'), '# Guide\n\nA page.\n');
  writeFileSync(join(root, 'docs', 'llms.txt'), '# Phantom\n\n> Docs.\n');
  writeFileSync(join(root, 'site', 'index.html'), '<html><head><title>Phantom</title><link rel="canonical" href="https://verse.ashlr.ai/"></head><body></body></html>\n');
  return root;
}

describe('committed generated docs stay in sync', () => {
  it('reports no drift across every local surface of the real checkout', () => {
    const report = docsSync(ROOT, { check: true, external: false });
    const drift = report.surfaces.flatMap((s) => (s.status === 'clean' ? [] : [`${s.id}: ${s.status}`, ...s.files]));
    expect(
      report.surfaces.map((s) => s.id),
      'surface set changed — review which generated files docs-sync covers',
    ).toEqual(['markdown-freshness', 'site-freshness', 'codemap', 'docs-llms', 'site-llms']);
    expect(drift, 'run `node scripts/docs-sync.mjs` to regenerate').toEqual([]);
    expect(report.ok).toBe(true);
    // src/ is scanned recursively; under a loaded shard 5s is too tight.
  }, 60_000);
});

const FIXTURE_SURFACES = ['markdown-freshness', 'codemap', 'docs-llms', 'site-llms'];

describe('docs-sync ledger on a fixture checkout', () => {
  it('check reports every drifted file without writing; sync repairs them', () => {
    const root = fixtureRoot();
    const codemapBefore = readFileSync(join(root, 'docs', 'CODEMAP.md'), 'utf8');

    const check = docsSync(root, { check: true, external: false, surfaces: FIXTURE_SURFACES });
    expect(check.ok).toBe(false);
    const byId = Object.fromEntries(check.surfaces.map((s) => [s.id, s]));
    expect(byId['markdown-freshness']?.files).toEqual(['README.md']);
    expect(byId['codemap']?.files).toEqual(['docs/CODEMAP.md']);
    expect(byId['docs-llms']?.files).toEqual(['docs/llms.txt']);
    expect(byId['site-llms']?.files).toEqual(['site/llms.txt', 'site/llms-full.txt']);
    expect(readFileSync(join(root, 'docs', 'CODEMAP.md'), 'utf8')).toBe(codemapBefore);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('stale');

    const synced = docsSync(root, { external: false, surfaces: FIXTURE_SURFACES });
    expect(synced.ok).toBe(true);
    expect(synced.surfaces.find((s) => s.id === 'codemap')?.status).toBe('updated');
    expect(docsSync(root, { check: true, external: false, surfaces: FIXTURE_SURFACES }).ok).toBe(true);
    const codemap = readFileSync(join(root, 'docs', 'CODEMAP.md'), 'utf8');
    expect(codemap).toContain('- `src/cli/`');
    expect(codemap).toContain('- `src/core/`');
    expect(codemap).toContain('- `src/core/alpha/`');
    expect(codemap).not.toContain('src/old');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('source-3.0.0-blue');
    expect(readFileSync(join(root, 'docs', 'llms.txt'), 'utf8')).toContain('(GUIDE.md)');
    expect(readFileSync(join(root, 'site', 'llms.txt'), 'utf8')).toContain('# Phantom');
  });

  it('limits a run to the named surfaces and rejects unknown ids', () => {
    const root = fixtureRoot();
    const report = docsSync(root, { check: true, external: false, surfaces: ['codemap', 'site-llms'] });
    expect(report.surfaces.map((s) => s.id)).toEqual(['codemap', 'site-llms']);
    expect(() => docsSync(root, { surfaces: ['bogus'] })).toThrow(/Unknown docs-sync surface/);
  });
});

describe('codemap regeneration', () => {
  it('renders the same inventory the drift guard expects', () => {
    const root = fixtureRoot();
    expect(codemapInventory(root, 'src')).toEqual(['- `src/cli/`', '- `src/core/`']);
    expect(syncCodemap(root, { check: true })).toEqual(['docs/CODEMAP.md']);
    expect(syncCodemap(root, { check: true })).toEqual(['docs/CODEMAP.md']); // check stays read-only
    syncCodemap(root);
    expect(syncCodemap(root, { check: true })).toEqual([]);
    expect([...CODEMAP_SECTIONS.keys()]).toEqual(['src', 'core']);
  });

  it('fails closed on unknown, unbalanced and malformed markers', () => {
    const root = fixtureRoot();
    expect(() => regenerateCodemap('<!-- codemap:bogus:start -->\nx\n<!-- codemap:bogus:end -->', root))
      .toThrow(/Unknown codemap section/);
    expect(() => regenerateCodemap('<!-- codemap:src:start -->', root)).toThrow(/Unclosed/);
    expect(() => regenerateCodemap('<!-- codemap:src:end -->', root)).toThrow(/Unmatched/);
    expect(() => regenerateCodemap('<!-- codemap:src:start --><!-- codemap:src:start --><!-- codemap:src:end -->', root))
      .toThrow(/Nested/);
    expect(() => regenerateCodemap('<!--codemap:src:start-->', root)).toThrow(/Malformed/);
    expect(() => regenerateCodemap('<!-- codemap:SRC:start -->', root)).toThrow(/Malformed/);
  });
});

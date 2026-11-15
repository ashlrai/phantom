import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateEcosystemChangelog, TIERS } from '../scripts/generate-ecosystem-changelog.mjs';

const fixtureRoot = resolve('test/fixtures/ecosystem-changelog');
const inputs = Object.fromEntries(TIERS.flat().map((repo: string) => [repo,
  readFileSync(join(fixtureRoot, repo, 'CHANGELOG.md'), 'utf8'),
]));
const generate = (phantom: string) => generateEcosystemChangelog({ ...inputs, phantom });

describe('ecosystem changelog', () => {
  it('matches the seven-repo golden fixture byte for byte', () => {
    expect(generateEcosystemChangelog(inputs)).toBe(readFileSync(join(fixtureRoot, 'expected.md'), 'utf8'));
  });

  it('is deterministic across input key order and newline conventions', () => {
    const reversed = Object.fromEntries(Object.entries(inputs).reverse().map(([repo, text]) =>
      [repo, (text as string).replace(/\n/g, '\r\n')]));
    expect(generateEcosystemChangelog(reversed)).toBe(generateEcosystemChangelog(inputs));
  });

  it('links PRs, retains existing links and flags cross-repo references', () => {
    const output = generate('## [Unreleased]\n- Fix #12 and locus#34 and ashlrai/lexicon#56.\n'
      + '- Existing [#8](https://github.com/ashlrai/phantom/pull/8).\n'
      + '- URL https://github.com/ashlrai/locus/pull/9\n- [cross-repo] Coordinate changes.');
    expect(output).toContain('[#12](https://github.com/ashlrai/phantom/pull/12)');
    expect(output).toContain('[locus#34](https://github.com/ashlrai/locus/pull/34)');
    expect(output).toContain('[ashlrai/lexicon#56](https://github.com/ashlrai/lexicon/pull/56). [cross-repo]');
    expect(output).toContain('- Existing [#8](https://github.com/ashlrai/phantom/pull/8).\n');
    expect(output).toContain('- URL https://github.com/ashlrai/locus/pull/9 [cross-repo]');
    expect(output).toContain('- [cross-repo] Coordinate changes.\n');
  });

  it('preserves fenced examples and inline code without mistaking example headings for releases', () => {
    expect(() => generate('# Changelog\n```md\n## [fake]\n- fake\n```')).toThrow('release heading');
    const output = generate('## [1.0.0]\n- Keep `#12` literal.\n```md\n## Example\n#45\n```');
    expect(output).toContain('- Keep `#12` literal.\n```md\n## Example\n#45\n```');
  });

  it('normalizes em dashes, nests headings and preserves release history', () => {
    const output = generate('## [2.0.0] \u2014 Unreleased\n### Added\n- One \u2014 two.\n## [1.0.0]\n- Old.');
    expect(output).not.toContain('\u2014');
    expect(output).toContain('#### [2.0.0] - Unreleased\n##### Added');
    expect(output).toContain('#### [1.0.0]\n- Old.');
  });

  it('refuses missing, malformed and empty inputs', () => {
    expect(() => generateEcosystemChangelog({ ...inputs, locus: undefined })).toThrow('locus: missing');
    expect(() => generate('# Introduction\nNothing released.')).toThrow('release heading');
    expect(() => generate('## [1.0.0]\n\n### Added\n')).toThrow('no release content');
  });

  it('runs offline as a CLI and leaves the output intact on invalid input', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ecosystem-changelog-'));
    try {
      const output = join(scratch, 'ECOSYSTEM_CHANGELOG.md');
      const run = (...args: string[]) => spawnSync(process.execPath,
        ['scripts/generate-ecosystem-changelog.mjs', ...args], { encoding: 'utf8' });
      expect(run(fixtureRoot, output).status).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe(generateEcosystemChangelog(inputs));
      writeFileSync(output, 'preserve me');
      const failed = run(scratch, output);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('ENOENT');
      expect(readFileSync(output, 'utf8')).toBe('preserve me');
      expect(run(fixtureRoot, join(fixtureRoot, 'phantom', 'CHANGELOG.md')).status).toBe(1);
      expect(readFileSync(join(fixtureRoot, 'phantom', 'CHANGELOG.md'), 'utf8')).toBe(inputs.phantom);
      expect(run('--unknown').status).toBe(1);
      expect(run(fixtureRoot, output, 'unexpected').status).toBe(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

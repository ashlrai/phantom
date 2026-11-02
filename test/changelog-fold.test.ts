import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  foldChangelog,
  listFragments,
  unreleasedSection,
  type FragmentFs,
} from '../src/core/fleet/changelog-fold.js';

const fs = nodeFs as unknown as FragmentFs;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-fold-'));
  dirs.push(dir);
  return dir;
}

const CHANGELOG = `# Changelog

## [1.4.0] — Unreleased

### Added
- existing added bullet

### Fixed
- existing fix

## [1.3.0] — 2026-10-01

### Added
- dated entry must never move
`;

const DATED_TAIL = CHANGELOG.slice(CHANGELOG.indexOf('## [1.3.0]'));

describe('foldChangelog', () => {
  it('appends fragment bullets to the matching existing heading', () => {
    const result = foldChangelog(CHANGELOG, [
      { path: 'changelog.d/job-1.added.md', heading: 'Added', bullets: ['- new feature landed'] },
    ]);
    expect(result.folded).toEqual(['changelog.d/job-1.added.md']);
    expect(result.skipped).toEqual([]);
    expect(result.text).toContain('### Added\n- existing added bullet\n- new feature landed\n');
    // The dated section below the fold is byte-identical.
    expect(result.text.slice(result.text.indexOf('## [1.3.0]'))).toBe(DATED_TAIL);
    // Nothing above the Unreleased heading changed either.
    expect(result.text.startsWith('# Changelog\n\n## [1.4.0] — Unreleased\n')).toBe(true);
  });

  it('creates a missing heading at the end of the section, before the next ## heading', () => {
    const result = foldChangelog(CHANGELOG, [
      { path: 'changelog.d/job-2.removed.md', heading: 'Removed', bullets: ['- dropped the flag'] },
    ]);
    const expected = `# Changelog

## [1.4.0] — Unreleased

### Added
- existing added bullet

### Fixed
- existing fix

### Removed
- dropped the flag

${DATED_TAIL}`;
    expect(result.text).toBe(expected);
  });

  it('does not duplicate a bullet already in the subsection exactly', () => {
    const result = foldChangelog(CHANGELOG, [
      { path: 'changelog.d/job-3.fixed.md', heading: 'Fixed', bullets: ['- existing fix', '- brand new fix'] },
    ]);
    expect(result.text).toContain('### Fixed\n- existing fix\n- brand new fix\n');
    expect(result.text.match(/- existing fix/g)).toHaveLength(1);
  });

  it('returns text unchanged when no fragment carries new bullets', () => {
    const result = foldChangelog(CHANGELOG, [
      { path: 'changelog.d/job-3.fixed.md', heading: 'Fixed', bullets: ['- existing fix'] },
    ]);
    expect(result.folded).toEqual(['changelog.d/job-3.fixed.md']);
    expect(result.text).toBe(CHANGELOG);
  });

  it('returns unchanged text and a skipped reason when there is no Unreleased section', () => {
    const dated = CHANGELOG.replace(' — Unreleased', ' — 2026-10-15');
    const result = foldChangelog(dated, [
      { path: 'changelog.d/job-4.added.md', heading: 'Added', bullets: ['- orphan'] },
    ]);
    expect(result.text).toBe(dated);
    expect(result.folded).toEqual([]);
    expect(result.skipped).toEqual([{ path: 'changelog.d/job-4.added.md', reason: 'no-unreleased-section' }]);
  });

  it('folds only into the FIRST Unreleased section', () => {
    const text = CHANGELOG + '\n## [1.2.0] — Unreleased\n\n### Added\n- stale\n';
    const result = foldChangelog(text, [
      { path: 'changelog.d/job-5.fixed.md', heading: 'Fixed', bullets: ['- fresh fix'] },
    ]);
    const staleSection = result.text.slice(result.text.indexOf('## [1.2.0]'));
    expect(staleSection).toBe('## [1.2.0] — Unreleased\n\n### Added\n- stale\n');
    expect(result.text.indexOf('- fresh fix')).toBeLessThan(result.text.indexOf('## [1.2.0]'));
  });

  it('appends several fragments in order, sharing a created heading once', () => {
    const result = foldChangelog(CHANGELOG, [
      { path: 'changelog.d/a.fixed.md', heading: 'Fixed', bullets: ['- fix a'] },
      { path: 'changelog.d/b.fixed.md', heading: 'Fixed', bullets: ['- fix b'] },
      { path: 'changelog.d/c.docs.md', heading: 'Documentation', bullets: ['- doc c'] },
    ]);
    expect(result.folded).toHaveLength(3);
    expect(result.text).toContain('### Fixed\n- existing fix\n- fix a\n- fix b\n');
    expect(result.text).toContain('### Documentation\n- doc c\n\n## [1.3.0]');
    expect(result.text.match(/### Fixed/g)).toHaveLength(1);
  });

  it('leaves an Unreleased section at EOF well formed', () => {
    const text = '# Changelog\n\n## [9.9.9] — Unreleased\n';
    const result = foldChangelog(text, [
      { path: 'changelog.d/e.chore.md', heading: 'Chore', bullets: ['- sweep'] },
    ]);
    expect(result.text).toBe('# Changelog\n\n## [9.9.9] — Unreleased\n\n### Chore\n- sweep\n');
  });
});

describe('unreleasedSection', () => {
  it('returns the first Unreleased section or null', () => {
    const section = unreleasedSection(CHANGELOG);
    expect(section).not.toBeNull();
    expect(section!.startsWith('## [1.4.0] — Unreleased')).toBe(true);
    expect(section!).not.toContain('## [1.3.0]');
    expect(unreleasedSection(CHANGELOG.replace(' — Unreleased', ' — 2026-10-15'))).toBeNull();
  });
});

describe('listFragments', () => {
  function write(dir: string, name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }

  it('lists fragments sorted by kind order then id, with parsed fields', () => {
    const dir = tempDir();
    write(dir, 'job-b.fixed.md', '### Fixed\n\n- b fix\n');
    write(dir, 'job-a.added.md', '### Added\n\n- a add\n');
    write(dir, 'job-c.added.md', '### Added\n\n- c add\n');
    write(dir, 'job-d.security.md', '### Security\n\n- d sec\n');
    const { fragments, skipped } = listFragments(dir, fs);
    expect(skipped).toEqual([]);
    expect(fragments.map((f) => `${f.kind}:${f.id}`)).toEqual([
      'added:job-a', 'added:job-c', 'fixed:job-b', 'security:job-d',
    ]);
    expect(fragments[0]).toMatchObject({
      name: 'job-a.added.md', heading: 'Added', bullets: ['- a add'],
    });
  });

  it('ignores names that are not <id>.<kind>.md with a known kind', () => {
    const dir = tempDir();
    for (const name of [
      'notes.md', 'job-1.unknown.md', 'job-2.fixed.txt', 'job-3.FIXED.md',
      '.fixed.md', 'job-4.fixed.md.bak', 'job-5.fixed', 'a.b.fixed.md',
    ]) {
      write(dir, name, '### Fixed\n\n- ignored\n');
    }
    const { fragments, skipped } = listFragments(dir, fs);
    expect(fragments).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('refuses symlinks and oversize files with reasons', () => {
    const dir = tempDir();
    const target = write(dir, 'real.fixed.md', '### Fixed\n\n- real\n');
    symlinkSync(target, join(dir, 'link.fixed.md'));
    write(dir, 'big.added.md', `### Added\n\n- ${'x'.repeat(17 * 1024)}\n`);
    const { fragments, skipped } = listFragments(dir, fs);
    expect(fragments.map((f) => f.name)).toEqual(['real.fixed.md']);
    expect(skipped).toEqual([
      { path: join(dir, 'big.added.md'), reason: 'oversize' },
      { path: join(dir, 'link.fixed.md'), reason: 'symlink' },
    ]);
  });

  it('skips fragments with a missing or unknown heading or no bullets', () => {
    const dir = tempDir();
    write(dir, 'noh.added.md', '- bullet without a heading\n');
    write(dir, 'unk.fixed.md', '### Nonsense\n\n- stray\n');
    write(dir, 'empty.chore.md', '### Chore\n\nnothing here\n');
    const { fragments, skipped } = listFragments(dir, fs);
    expect(fragments).toEqual([]);
    expect(skipped).toEqual([
      { path: join(dir, 'noh.added.md'), reason: 'no-heading' },
      { path: join(dir, 'unk.fixed.md'), reason: 'unknown-heading' },
      { path: join(dir, 'empty.chore.md'), reason: 'no-bullets' },
    ]);
  });

  it('returns empty lists for a missing directory', () => {
    expect(listFragments(join(tempDir(), 'absent'), fs)).toEqual({ fragments: [], skipped: [] });
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  changelogFragmentPath,
  fleetEditCollision,
  fleetEditRefusals,
  renderChangelogFragment,
  sanitizeFleetEdits,
  type FleetFileEdit,
} from '../src/core/fleet/collision-free-edits.js';

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function rulesOf(paths: readonly string[]) {
  return fleetEditRefusals(paths).map((hit) => `${hit.path}:${hit.rule}`);
}

describe('collision-free fleet edit refusal', () => {
  it('admits ordinary source, docs and changelog.d fragment paths', () => {
    expect(fleetEditRefusals([
      'src/cli/foo.ts', 'test/foo.test.ts', 'docs/guide.md', 'package.json',
      'changelog.d/rq-1.added.md', 'changelog.d/deep/rq-2.fixed.md', 'src/CHANGELOGGER.md',
    ])).toEqual([]);
  });

  it.each([
    ['CHANGELOG.md', 'changelog-singleton'],
    ['docs/CHANGELOG.md', 'changelog-singleton'],
    ['changelog.rst', 'changelog-singleton'],
    ['CHANGELOG', 'changelog-singleton'],
    ['Changelog.MD', 'changelog-singleton'],
    ['CLAUDE.md', 'agent-guide'],
    ['docs/CLAUDE.MD', 'agent-guide'],
    ['README.md', 'readme-singleton'],
    ['src/sub/README.rst', 'readme-singleton'],
    ['package-lock.json', 'lockfile'],
    ['a/b/yarn.lock', 'lockfile'],
    ['Cargo.lock', 'lockfile'],
    ['deep/THIRD-PARTY.LOCK', 'lockfile'],
    ['pnpm-lock.yaml', 'lockfile'],
    ['go.sum', 'lockfile'],
    ['Package.resolved', 'lockfile'],
  ])('refuses %s as %s', (path, rule) => {
    expect(fleetEditRefusals([path])).toMatchObject([{ path, rule }]);
  });

  it('marks a changelog refusal as divertable to a fragment', () => {
    expect(fleetEditCollision('CHANGELOG.md')).toMatchObject({ redirect: 'changelog-fragment' });
    expect(fleetEditCollision('README.md')?.redirect).toBeNull();
    expect(fleetEditCollision('package-lock.json')?.redirect).toBeNull();
  });

  it.each(['../CHANGELOG.md', '/abs/README.md', 'a//b.ts', '.git/config', 'x/../y.ts', 'with\ttab/x.ts'])(
    'refuses unsafe path %s', (path) => {
      expect(fleetEditCollision(path)?.rule).toBe('unsafe-path');
    },
  );

  it('keeps refusals in input order without duplicates', () => {
    expect(rulesOf(['src/ok.ts', 'README.md', 'yarn.lock', 'readme.md', 'README.md'])).toEqual([
      'README.md:readme-singleton', 'yarn.lock:lockfile', 'readme.md:readme-singleton',
    ]);
  });
});

describe('changelog.d fragment writing', () => {
  it('renders a towncrier-style fragment path and content', () => {
    expect(changelogFragmentPath('RQ-COLLISION-FREE-1', 'fixed')).toBe('changelog.d/RQ-COLLISION-FREE-1.fixed.md');
    const fragment = renderChangelogFragment({ id: 'RQ-9', kind: 'added', entries: ['- first entry', '* second', 'plain'] });
    expect(fragment).toEqual({
      path: 'changelog.d/RQ-9.added.md',
      content: '### Added\n\n- first entry\n- second\n- plain\n',
    });
  });

  it.each(['', '..', 'a/b', 'a\\b', '.hidden', '-dash', 'a.b', 'x'.repeat(200)])(
    'refuses an unusable fragment id %j', (id) => {
      expect(changelogFragmentPath(id, 'added')).toBeNull();
      expect(renderChangelogFragment({ id, kind: 'added', entries: ['x'] })).toBeNull();
    },
  );

  it.each([
    { id: 'RQ-1', kind: 'bogus' as never, entries: ['x'] },
    { id: 'RQ-1', kind: 'added' as const, entries: [] },
    { id: 'RQ-1', kind: 'added' as const, entries: ['   '] },
    { id: 'RQ-1', kind: 'added' as const, entries: ['line\nbreak'] },
    { id: 'RQ-1', kind: 'added' as const, entries: ['x'.repeat(501)] },
  ])('refuses a malformed fragment spec %j', (spec) => {
    expect(renderChangelogFragment(spec)).toBeNull();
  });
});

describe('sanitizeFleetEdits', () => {
  const source: FleetFileEdit = { path: 'src/feature.ts', content: 'export {};\n' };

  it('passes a clean edit set through untouched', () => {
    const result = sanitizeFleetEdits([source]);
    expect(result).toMatchObject({ ok: true, refusals: [], diverted: [] });
    expect(result.edits).toEqual([source]);
  });

  it('diverts a changelog edit into a fragment instead of refusing the work', () => {
    const changelog = { path: 'CHANGELOG.md', content: '# Changelog\nnew entry\n' };
    const result = sanitizeFleetEdits([changelog, source], {
      changelog: { id: 'RQ-1', kind: 'fixed', entries: ['the changelog entry'] },
    });
    expect(result.ok).toBe(true);
    expect(result.refusals).toEqual([]);
    expect(result.diverted).toEqual([{ from: 'CHANGELOG.md', to: 'changelog.d/RQ-1.fixed.md' }]);
    expect(result.edits).toEqual([source, {
      path: 'changelog.d/RQ-1.fixed.md',
      content: '### Fixed\n\n- the changelog entry\n',
    }]);
  });

  it('refuses a changelog edit when no fragment is supplied', () => {
    const result = sanitizeFleetEdits([{ path: 'CHANGELOG.md', content: 'x' }, source]);
    expect(result.ok).toBe(false);
    expect(result.refusals).toMatchObject([{ path: 'CHANGELOG.md', rule: 'changelog-singleton', redirect: 'changelog-fragment' }]);
    expect(result.edits).toEqual([source]);
  });

  it('refuses a changelog delete even with a fragment supplied', () => {
    const result = sanitizeFleetEdits([{ path: 'CHANGELOG.md', content: null }], {
      changelog: { id: 'RQ-1', kind: 'removed', entries: ['gone'] },
    });
    expect(result.ok).toBe(false);
    expect(result.refusals).toMatchObject([{ path: 'CHANGELOG.md', rule: 'changelog-singleton', redirect: null }]);
    expect(result.diverted).toEqual([]);
  });

  it('fails closed when the supplied fragment cannot render', () => {
    const result = sanitizeFleetEdits([{ path: 'CHANGELOG.md', content: 'x' }], {
      changelog: { id: 'bad/id', kind: 'added', entries: ['x'] },
    });
    expect(result.ok).toBe(false);
    expect(result.refusals).toMatchObject([{ path: 'CHANGELOG.md', rule: 'changelog-singleton' }]);
    expect(result.diverted).toEqual([]);
  });

  it('refuses CLAUDE.md, README.md and lockfiles outright while keeping the rest', () => {
    const result = sanitizeFleetEdits([
      { path: 'CLAUDE.md', content: 'instructions' },
      source,
      { path: 'docs/README.md', content: 'readme' },
      { path: 'package-lock.json', content: '{}' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.refusals.map((hit) => hit.rule)).toEqual(['agent-guide', 'readme-singleton', 'lockfile']);
    expect(result.edits).toEqual([source]);
  });

  it('refuses a job racing itself on one case-folded path', () => {
    const result = sanitizeFleetEdits([{ path: 'src/A.ts', content: '1' }, { path: 'src/a.ts', content: '2' }]);
    expect(result.ok).toBe(false);
    expect(result.refusals).toMatchObject([{ path: 'src/a.ts', rule: 'unsafe-path' }]);
  });

  it.each([null, [{ path: 1 }], [{ path: 'x.ts' }], [{ path: 'x.ts', content: 42 }]])(
    'throws on a malformed edit set %j', (edits) => {
      expect(() => sanitizeFleetEdits(edits as never)).toThrow('Invalid fleet edit set');
    },
  );
});

describe('two concurrent fragment PRs merge clean', () => {
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'collision-free-'));
    homes.push(dir);
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
    git('init', '--quiet', '-b', 'main');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '--allow-empty', '-m', 'initial');
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n\n### Added\n- shipped\n');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'feature.ts'), 'export {};\n');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'base');
    return { dir, git };
  }

  function branchWithEdits(git: (...args: string[]) => string, dir: string, name: string, edits: FleetFileEdit[]) {
    git('checkout', '--quiet', '-b', name, 'main');
    for (const edit of edits) {
      if (edit.content === null) continue;
      mkdirSync(join(dir, ...edit.path.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(dir, ...edit.path.split('/')), edit.content);
    }
    git('add', '-A');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', name);
  }

  it('merges two PRs whose changelog entries were diverted to fragments', () => {
    const { dir, git } = repo();
    const prA = sanitizeFleetEdits([{ path: 'src/a.ts', content: 'export const a = 1;\n' }, { path: 'CHANGELOG.md', content: 'edited' }], {
      changelog: { id: 'rq-a', kind: 'added', entries: ['feature A'] },
    });
    const prB = sanitizeFleetEdits([{ path: 'src/b.ts', content: 'export const b = 1;\n' }, { path: 'CHANGELOG.md', content: 'edited' }], {
      changelog: { id: 'rq-b', kind: 'fixed', entries: ['fix B'] },
    });
    expect(prA.ok).toBe(true);
    expect(prB.ok).toBe(true);
    branchWithEdits(git, dir, 'pr-a', prA.edits);
    branchWithEdits(git, dir, 'pr-b', prB.edits);
    git('checkout', '--quiet', 'main');
    git('merge', '--no-edit', 'pr-a');
    git('merge', '--no-edit', 'pr-b');
    expect(git('status', '--porcelain')).toBe('');
    expect(readFileSync(join(dir, 'changelog.d', 'rq-a.added.md'), 'utf8')).toContain('feature A');
    expect(readFileSync(join(dir, 'changelog.d', 'rq-b.fixed.md'), 'utf8')).toContain('fix B');
    // The singleton both jobs wanted to write is untouched in the merge result.
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toContain('## [1.0.0]');
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).not.toContain('edited');
  });

  it('conflicts under the same fixture when two PRs edit CHANGELOG.md directly', () => {
    const { dir, git } = repo();
    for (const [branch, entry] of [['c-a', 'entry A'], ['c-b', 'entry B']] as const) {
      git('checkout', '--quiet', '-b', branch, 'main');
      writeFileSync(join(dir, 'CHANGELOG.md'), `# Changelog\n\n- ${entry}\n\n## [1.0.0] - 2026-10-01\n\n### Added\n- shipped\n`);
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', branch);
    }
    git('checkout', '--quiet', 'main');
    git('merge', '--no-edit', 'c-a');
    let conflicted = false;
    try {
      git('merge', '--no-edit', 'c-b');
    } catch {
      conflicted = true;
    }
    expect(conflicted).toBe(true);
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toContain('<<<<<<<');
    git('merge', '--abort');
  });
});

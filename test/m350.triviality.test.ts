import { describe, expect, it } from 'vitest';

import { classifyDiff, isTrivialProposal } from '../src/planning/triviality.js';

describe('M350 trivial proposal diff classifier', () => {
  it('counts only hunk changed lines and tags markdown as docs', () => {
    const diff = [
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1,2 +1,2 @@',
      ' # Ashlr',
      '-old docs',
      '+new docs',
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 2,
      categories: ['docs'],
    });
    expect(isTrivialProposal(diff)).toBe(true);
  });

  it('tags comment-only code changes as comments', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' export function foo() {',
      '-  // old explanation',
      '+  // new explanation',
      ' }',
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 2,
      categories: ['comments'],
    });
    expect(isTrivialProposal(diff)).toBe(true);
  });

  it('tags indentation-only rewrites as formatting', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' if (ok) {',
      '-const value = call(arg);',
      '+  const value = call(arg);',
      ' }',
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 2,
      categories: ['formatting'],
    });
    expect(isTrivialProposal(diff)).toBe(true);
  });

  it('fails closed for semantic code changes', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' export function foo() {',
      '-  return false;',
      '+  return true;',
      ' }',
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 2,
      categories: ['code'],
    });
    expect(isTrivialProposal(diff)).toBe(false);
  });

  it('does not mark threshold-sized trivial diffs as trivial', () => {
    const changed = Array.from({ length: 15 }, (_, i) => `+line ${i}`);
    const diff = [
      'diff --git a/notes.txt b/notes.txt',
      '--- a/notes.txt',
      '+++ b/notes.txt',
      '@@ -0,0 +1,15 @@',
      ...changed,
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 15,
      categories: ['docs'],
    });
    expect(isTrivialProposal(diff)).toBe(false);
    expect(isTrivialProposal(diff, 16)).toBe(true);
  });

  it('fails closed for semantic comment directives', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' export function foo(value: unknown) {',
      '-  // @ts-ignore',
      '+  // @ts-expect-error intentional fixture',
      '   return value.missing();',
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 2,
      categories: ['code'],
    });
    expect(isTrivialProposal(diff)).toBe(false);
  });

  it('fails closed when whitespace changes string semantics', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1 +1 @@',
      '-export const label = "a b";',
      '+export const label = "ab";',
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 2,
      categories: ['code'],
    });
    expect(isTrivialProposal(diff)).toBe(false);
  });

  it('does not treat leading star code as a comment', () => {
    const diff = [
      'diff --git a/src/pointer.c b/src/pointer.c',
      '--- a/src/pointer.c',
      '+++ b/src/pointer.c',
      '@@ -1 +1 @@',
      '-*enabled = false;',
      '+*enabled = true;',
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 2,
      categories: ['code'],
    });
    expect(isTrivialProposal(diff)).toBe(false);
  });

  it('does not treat fixture text as docs', () => {
    const diff = [
      'diff --git a/test/fixtures/expected.txt b/test/fixtures/expected.txt',
      '--- a/test/fixtures/expected.txt',
      '+++ b/test/fixtures/expected.txt',
      '@@ -1 +1 @@',
      '-old snapshot',
      '+new snapshot',
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 2,
      categories: ['code'],
    });
    expect(isTrivialProposal(diff)).toBe(false);
  });
});

describe('M350 triviality classifier edge cases', () => {
  /** Builds a single-file unified diff whose hunk contains `lines`. */
  function diffFor(path: string, lines: string[], oldPath = `a/${path}`, newPath = `b/${path}`): string {
    return [
      `diff --git a/${path} b/${path}`,
      `--- ${oldPath}`,
      `+++ ${newPath}`,
      '@@ -1 +1 @@',
      ...lines,
    ].join('\n');
  }

  describe('diff parsing', () => {
    it('reports zero changed lines for an empty diff', () => {
      expect(classifyDiff('')).toEqual({ changedLines: 0, categories: [] });
      expect(isTrivialProposal('')).toBe(false);
    });

    it('reports zero changed lines for binary and mode-only diffs', () => {
      const binary = [
        'diff --git a/img.png b/img.png',
        'index 123..456 100644',
        'Binary files a/img.png and b/img.png differ',
      ].join('\n');
      const modeOnly = [
        'diff --git a/script.sh b/script.sh',
        'old mode 100644',
        'new mode 100755',
      ].join('\n');

      for (const diff of [binary, modeOnly]) {
        expect(classifyDiff(diff)).toEqual({ changedLines: 0, categories: [] });
        expect(isTrivialProposal(diff)).toBe(false);
      }
    });

    it('accumulates changed lines across hunks and dedupes categories', () => {
      const diff = diffFor('src/a.ts', [
        '-// old one',
        '+// new one',
        '@@ -10 +10 @@',
        '-// old two',
        '+// new two',
      ]);

      expect(classifyDiff(diff)).toEqual({
        changedLines: 4,
        categories: ['comments'],
      });
      expect(isTrivialProposal(diff)).toBe(true);
    });

    it('unions categories across files and counts every hunk line', () => {
      const diff = [
        'diff --git a/docs/a.md b/docs/a.md',
        '--- a/docs/a.md',
        '+++ b/docs/a.md',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        'diff --git a/src/b.ts b/src/b.ts',
        '--- a/src/b.ts',
        '+++ b/src/b.ts',
        '@@ -1 +1 @@',
        '-// old',
        '+// new',
      ].join('\n');

      expect(classifyDiff(diff)).toEqual({
        changedLines: 4,
        categories: ['docs', 'comments'],
      });
      expect(isTrivialProposal(diff)).toBe(true);
    });

    it('fails closed when any file in a multi-file diff changes code', () => {
      const diff = [
        'diff --git a/docs/a.md b/docs/a.md',
        '--- a/docs/a.md',
        '+++ b/docs/a.md',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        'diff --git a/src/b.ts b/src/b.ts',
        '--- a/src/b.ts',
        '+++ b/src/b.ts',
        '@@ -1 +1 @@',
        '-oldCall();',
        '+newCall();',
      ].join('\n');

      expect(classifyDiff(diff)).toEqual({
        changedLines: 4,
        categories: ['docs', 'code'],
      });
      expect(isTrivialProposal(diff)).toBe(false);
    });

    it('splits formatting pairing at context lines', () => {
      const diff = diffFor('src/a.ts', [
        '-foo();',
        ' unchanged();',
        '+foo();',
      ]);

      expect(classifyDiff(diff)).toEqual({
        changedLines: 2,
        categories: ['code'],
      });
      expect(isTrivialProposal(diff)).toBe(false);
    });

    it('ignores the no-newline marker inside hunks', () => {
      const diff = diffFor('src/a.ts', [
        '-a();',
        '\\ No newline at end of file',
        '+b();',
      ]);

      expect(classifyDiff(diff)).toEqual({
        changedLines: 2,
        categories: ['code'],
      });
    });

    it('does not count hunk lines that collide with file headers', () => {
      // A removed line whose content begins with `--` renders as `---...` and an
      // added line beginning with `++` renders as `+++...`; the parser cannot
      // distinguish them from `---`/+++` headers, so both are skipped.
      const removed = diffFor('src/a.c', ['---flag = 1;', ' keep();']);
      const added = diffFor('src/a.c', ['-i;', '+++i;']);

      expect(classifyDiff(removed)).toEqual({ changedLines: 0, categories: [] });
      expect(classifyDiff(added)).toEqual({
        changedLines: 1,
        categories: ['code'],
      });
    });

    it('resolves quoted diff --git paths containing spaces', () => {
      const diff = [
        'diff --git "a/docs/my guide.md" "b/docs/my guide.md"',
        '--- "a/docs/my guide.md"',
        '+++ "b/docs/my guide.md"',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ].join('\n');

      expect(classifyDiff(diff)).toEqual({
        changedLines: 2,
        categories: ['docs'],
      });
      expect(isTrivialProposal(diff)).toBe(true);
    });

    it('classifies header fragments that lack a diff --git line', () => {
      const diff = [
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1 @@',
        '-oldCall();',
        '+newCall();',
      ].join('\n');

      expect(classifyDiff(diff)).toEqual({
        changedLines: 2,
        categories: ['code'],
      });
    });
  });

  describe('path classification', () => {
    it('tags markdown anywhere under docs/', () => {
      const diff = diffFor('docs/deep/nested/guide.md', ['-a', '+b']);
      expect(classifyDiff(diff)).toEqual({
        changedLines: 2,
        categories: ['docs'],
      });
      expect(isTrivialProposal(diff)).toBe(true);
    });

    it.each([
      'pkg/sub/README.md',
      'packages/x/LICENSE.txt',
      'contrib/CHANGELOG.md',
      'pkg/SECURITY.md',
      'pkg/CODE_OF_CONDUCT.md',
      'pkg/CONTRIBUTING.md',
      'pkg/ARCHITECTURE.md',
      'pkg/ROADMAP.md',
    ])('tags well-known doc basename %s at any depth', (path) => {
      expect(classifyDiff(diffFor(path, ['-a', '+b'])).categories).toEqual(['docs']);
    });

    it('does not tag arbitrary nested markdown as docs', () => {
      const diff = diffFor('notes/guide.md', ['-a', '+b']);
      expect(classifyDiff(diff).categories).toEqual(['code']);
      expect(isTrivialProposal(diff)).toBe(false);
    });

    it.each([
      'src/README.md',
      'test/x.md',
      'tests/x.md',
      'prompts/x.md',
      'fixtures/x.md',
      '__fixtures__/x.md',
      'snapshots/x.md',
      '__snapshots__/x.md',
    ])('does not tag markdown under code/fixture dir %s', (path) => {
      expect(classifyDiff(diffFor(path, ['-a', '+b'])).categories).toEqual(['code']);
    });

    it('requires an .md or .txt extension', () => {
      for (const path of ['docs/guide.mdx', 'README', 'LICENSE']) {
        expect(classifyDiff(diffFor(path, ['-a', '+b'])).categories).toEqual(['code']);
      }
    });

    it('matches doc extensions case-insensitively', () => {
      expect(classifyDiff(diffFor('docs/GUIDE.MD', ['-a', '+b'])).categories).toEqual(['docs']);
    });

    it('normalizes backslash path separators', () => {
      const diff = diffFor('docs\\nested\\guide.md', ['-a', '+b'], 'docs\\nested\\guide.md', 'docs\\nested\\guide.md');
      expect(classifyDiff(diff).categories).toEqual(['docs']);
    });

    it('classifies renames by the new path', () => {
      const diff = [
        'diff --git a/README.md b/src/util.ts',
        'similarity index 90%',
        'rename from README.md',
        'rename to src/util.ts',
        '--- a/README.md',
        '+++ b/src/util.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n');

      expect(classifyDiff(diff)).toEqual({
        changedLines: 2,
        categories: ['code'],
      });
      expect(isTrivialProposal(diff)).toBe(false);
    });

    it('classifies deletions by the old path', () => {
      const diff = diffFor('docs/guide.md', ['-content'], 'a/docs/guide.md', '/dev/null');
      expect(classifyDiff(diff)).toEqual({
        changedLines: 1,
        categories: ['docs'],
      });
      expect(isTrivialProposal(diff)).toBe(true);
    });

    it('classifies new files by the added path', () => {
      const diff = diffFor('docs/guide.md', ['+content'], '/dev/null', 'b/docs/guide.md');
      expect(classifyDiff(diff)).toEqual({
        changedLines: 1,
        categories: ['docs'],
      });
      expect(isTrivialProposal(diff)).toBe(true);
    });
  });

  describe('line classification', () => {
    it('tags whitespace-only change segments', () => {
      const diff = diffFor('src/a.ts', [' x();', '+', ' y();']);
      expect(classifyDiff(diff)).toEqual({
        changedLines: 1,
        categories: ['whitespace'],
      });
      expect(isTrivialProposal(diff)).toBe(true);
    });

    it('tags hash comments but not shebangs', () => {
      const comment = diffFor('src/a.py', ['-# old note', '+# new note']);
      const shebang = diffFor('src/a.py', ['-#!/usr/bin/env python', '+#!/usr/bin/env python3']);

      expect(classifyDiff(comment).categories).toEqual(['comments']);
      expect(classifyDiff(shebang).categories).toEqual(['code']);
    });

    it('does not treat block-comment continuation lines as comments', () => {
      const diff = diffFor('src/a.ts', ['- * old text', '+ * new text']);
      expect(classifyDiff(diff).categories).toEqual(['code']);
      expect(isTrivialProposal(diff)).toBe(false);
    });

    it.each([
      ['semicolon', 'a/x.ini', ['-; old', '+; new']],
      ['sql dash', 'a/q.sql', [' x = 1;', '+-- new']],
      ['docstring', 'a/m.py', ['-""" old', '+""" new']],
      ['html', 'a/p.html', ['-<!-- old -->', '+<!-- new -->']],
    ])('recognizes %s comment style', (_name, path, lines) => {
      expect(classifyDiff(diffFor(path, lines)).categories).toEqual(['comments']);
    });

    it.each([
      '// eslint-disable-next-line',
      '//go:build linux',
      '// +build linux',
      '//go:generate ./x',
      '// prettier-ignore',
      '// biome-ignore lint/x',
      '// oxlint-disable x',
      '// deno-lint-ignore x',
      '// istanbul ignore next',
      '// c8 ignore next',
      '// v8 ignore next',
      '// @flow',
      '// @jsxImportSource x',
      '// @format',
      '// @generated by tool',
      '/* @__PURE__ */',
      '/* #__PURE__ */',
      ' * @generated',
      '# noqa: F401',
      '# type: ignore',
      '# pyright: ignore',
      '# mypy: ignore-errors',
      '# pylint: disable=x',
      '# ruff: noqa',
      '# shellcheck disable=SC2086',
      '# frozen_string_literal: true',
      '# encoding: utf-8',
      '//fmt: off',
      '// ESLINT-DISABLE',
      '<!--[if IE 8]>',
    ])('fails closed for semantic directive: %s', (line) => {
      const diff = diffFor('src/a.ts', ['-oldCall();', `+${line}`]);
      expect(classifyDiff(diff).categories).toEqual(['code']);
      expect(isTrivialProposal(diff)).toBe(false);
    });

    it('classifies mixed segments line by line in first-seen order', () => {
      const diff = diffFor('src/a.ts', [
        ' ctx();',
        '+// a note',
        '+realCall();',
        '+',
      ]);

      expect(classifyDiff(diff)).toEqual({
        changedLines: 3,
        categories: ['comments', 'code', 'whitespace'],
      });
      expect(isTrivialProposal(diff)).toBe(false);
    });

    it('treats a lone added comment as trivial', () => {
      const diff = diffFor('src/a.ts', ['+// hello']);
      expect(classifyDiff(diff)).toEqual({
        changedLines: 1,
        categories: ['comments'],
      });
      expect(isTrivialProposal(diff)).toBe(true);
    });
  });

  describe('formatting pairing', () => {
    it('requires pairwise trim equality between removed and added lines', () => {
      const reordered = diffFor('src/a.ts', ['-aaa();', '-bbb();', '+bbb();', '+aaa();']);
      expect(classifyDiff(reordered).categories).toEqual(['code']);
      expect(isTrivialProposal(reordered)).toBe(false);
    });

    it('requires equal removed and added line counts', () => {
      const diff = diffFor('src/a.ts', ['-aaa();', '-bbb();', '+aaa();']);
      expect(classifyDiff(diff).categories).toEqual(['code']);
      expect(isTrivialProposal(diff)).toBe(false);
    });

    it('excludes blank lines from formatting pairs but still counts them', () => {
      const diff = diffFor('src/a.ts', ['-foo();', '-', '+  foo();']);
      expect(classifyDiff(diff)).toEqual({
        changedLines: 3,
        categories: ['formatting'],
      });
      expect(isTrivialProposal(diff)).toBe(true);
    });

    it.each([
      'src/a.py',
      'src/a.pyi',
      'cfg/app.yaml',
      'cfg/app.yml',
      'scripts/s.sh',
      'scripts/s.bash',
      'scripts/s.zsh',
      'scripts/s.fish',
      'scripts/s.ps1',
      'tools/x.mk',
      'Makefile',
      'GNUmakefile',
      'Dockerfile',
    ])('fails closed for indentation-only changes in whitespace-sensitive %s', (path) => {
      const diff = diffFor(path, ['-call_me()', '+    call_me()']);
      expect(classifyDiff(diff).categories).toEqual(['code']);
      expect(isTrivialProposal(diff)).toBe(false);
    });
  });

  describe('isTrivialProposal thresholds', () => {
    const trivialDiff = diffFor('README.md', ['-a', '+b']);

    it.each([0, -1, -10])('returns false for non-positive threshold %d', (threshold) => {
      expect(isTrivialProposal(trivialDiff, threshold)).toBe(false);
    });

    it('returns false when no changed line count can satisfy the threshold', () => {
      expect(isTrivialProposal(trivialDiff, 1)).toBe(false);
      expect(isTrivialProposal(trivialDiff, 2)).toBe(false);
    });

    it('accepts fractional thresholds', () => {
      expect(isTrivialProposal(trivialDiff, 2.5)).toBe(true);
      expect(isTrivialProposal(trivialDiff, 3)).toBe(true);
    });

    it('stays trivial when all categories are trivial', () => {
      const diff = [
        'diff --git a/docs/a.md b/docs/a.md',
        '--- a/docs/a.md',
        '+++ b/docs/a.md',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        'diff --git a/src/b.ts b/src/b.ts',
        '--- a/src/b.ts',
        '+++ b/src/b.ts',
        '@@ -1 +1 @@',
        ' keep();',
        '+',
        'diff --git a/src/c.ts b/src/c.ts',
        '--- a/src/c.ts',
        '+++ b/src/c.ts',
        '@@ -1 +1 @@',
        '-// old note',
        '+// new note',
      ].join('\n');

      expect(classifyDiff(diff)).toEqual({
        changedLines: 5,
        categories: ['docs', 'whitespace', 'comments'],
      });
      expect(isTrivialProposal(diff)).toBe(true);
    });
  });
});

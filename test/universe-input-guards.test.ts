import type { Stats } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  containsAsciiControlChars,
  containsControlChars,
  formatUniverseRootFlag,
  isCanonicalAbsolutePath,
  isSameRegularFile,
  snapshotBoundedJson,
} from '../src/core/universe/input-guards.js';

function fakeStat(overrides: Partial<{
  file: boolean;
  symlink: boolean;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}> = {}): Stats {
  return {
    isFile: () => overrides.file ?? true,
    isSymbolicLink: () => overrides.symlink ?? false,
    dev: overrides.dev ?? 1,
    ino: overrides.ino ?? 42,
    size: overrides.size ?? 128,
    mtimeMs: overrides.mtimeMs ?? 1_000,
    ctimeMs: overrides.ctimeMs ?? 2_000,
  } as unknown as Stats;
}

describe('universe input-guards shared helpers', () => {
  it('distinguishes C0/DEL/C1 control checks from ASCII-only checks and honors allowWhitespace', () => {
    expect(containsControlChars('clean text ✓')).toBe(false);
    expect(containsControlChars('a\x00b')).toBe(true);
    expect(containsControlChars('a\x7fb')).toBe(true);
    expect(containsControlChars('a\u0085b')).toBe(true);
    expect(containsControlChars('a\tb\nc\rd')).toBe(true);
    expect(containsControlChars('a\tb\nc\rd', { allowWhitespace: true })).toBe(false);
    expect(containsControlChars('a\tb\u0085c', { allowWhitespace: true })).toBe(true);

    expect(containsAsciiControlChars('a\u0085b')).toBe(false);
    expect(containsAsciiControlChars('a\x00b')).toBe(true);
    expect(containsAsciiControlChars('a\x7fb')).toBe(true);
    expect(containsAsciiControlChars('a\tb\nc\rd', { allowWhitespace: true })).toBe(false);
    expect(containsAsciiControlChars('a\x07b', { allowWhitespace: true })).toBe(true);
  });

  it('validates canonical absolute paths with byte, length, root and control options', () => {
    expect(isCanonicalAbsolutePath('/private/universe/store')).toBe(true);
    expect(isCanonicalAbsolutePath('relative/path')).toBe(false);
    expect(isCanonicalAbsolutePath('/private/../universe')).toBe(false);
    expect(isCanonicalAbsolutePath('/private/universe/')).toBe(false);
    expect(isCanonicalAbsolutePath('/')).toBe(false);
    expect(isCanonicalAbsolutePath('/', { allowRoot: true })).toBe(true);
    expect(isCanonicalAbsolutePath(null)).toBe(false);

    // UTF-8 byte bound vs JS code-unit length bound.
    const multibyte = `/${'é'.repeat(2_048)}`;
    expect(multibyte.length).toBe(2_049);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBe(4_097);
    expect(isCanonicalAbsolutePath(multibyte)).toBe(false);
    expect(isCanonicalAbsolutePath(multibyte, { maxLength: 4_096 })).toBe(true);

    // C1 vs ASCII-only control checks.
    expect(isCanonicalAbsolutePath('/private/x\u0085y')).toBe(false);
    expect(isCanonicalAbsolutePath('/private/x\u0085y', { asciiControlsOnly: true })).toBe(true);
    expect(isCanonicalAbsolutePath('/private/x\ny', { asciiControlsOnly: true })).toBe(false);
  });

  it('detects file identity drift and symlink transitions', () => {
    const before = fakeStat();
    expect(isSameRegularFile(before, fakeStat())).toBe(true);
    expect(isSameRegularFile(before, fakeStat({ file: false }))).toBe(false);
    expect(isSameRegularFile(before, fakeStat({ symlink: true }))).toBe(false);
    expect(isSameRegularFile(before, fakeStat({ dev: 2 }))).toBe(false);
    expect(isSameRegularFile(before, fakeStat({ ino: 43 }))).toBe(false);
    expect(isSameRegularFile(before, fakeStat({ size: 129 }))).toBe(false);
    expect(isSameRegularFile(before, fakeStat({ mtimeMs: 1_001 }))).toBe(false);
    expect(isSameRegularFile(before, fakeStat({ ctimeMs: 2_001 }))).toBe(false);
  });

  it('formats optional shell-quoted --root flags', () => {
    expect(formatUniverseRootFlag(undefined)).toBe('');
    expect(formatUniverseRootFlag('')).toBe('');
    expect(formatUniverseRootFlag('/tmp/universe')).toBe(" --root '/tmp/universe'");
    expect(formatUniverseRootFlag("/tmp/o'reilly")).toBe(" --root '/tmp/o'\\''reilly'");
  });

  it('detaches bounded plain JSON without invoking getters or accepting exotic inputs', () => {
    const copy = snapshotBoundedJson<{ a: number; nested: { ok: boolean }; items: string[] }>({
      a: 1,
      nested: { ok: true },
      items: ['x', 'y'],
    });
    expect(copy).toEqual({ a: 1, nested: { ok: true }, items: ['x', 'y'] });
    expect(Object.getPrototypeOf(copy)).toBeNull();
    expect(Object.getPrototypeOf(copy.nested)).toBeNull();

    let getterCalled = false;
    const withGetter = Object.defineProperty({}, 'trap', {
      enumerable: true,
      get() {
        getterCalled = true;
        return 'boom';
      },
    });
    expect(() => snapshotBoundedJson(withGetter, { errorMessage: 'custom-reject' })).toThrow('custom-reject');
    expect(getterCalled).toBe(false);

    class Custom { value = 1; }
    const sparse: unknown[] = [];
    sparse[2] = 'x';
    const withSymbol = { [Symbol('s')]: 1 };
    const nonEnum = Object.defineProperty({}, 'hidden', { value: 1, enumerable: false });

    expect(() => snapshotBoundedJson(new Custom())).toThrow();
    expect(() => snapshotBoundedJson(sparse)).toThrow();
    expect(() => snapshotBoundedJson(withSymbol)).toThrow();
    expect(() => snapshotBoundedJson(nonEnum)).toThrow();
    expect(() => snapshotBoundedJson(Number.NaN)).toThrow();
    expect(() => snapshotBoundedJson(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => snapshotBoundedJson('abcdef', { maxStringBytes: 4 })).toThrow();
    expect(() => snapshotBoundedJson(['abc', 'def'], { maxTotalStringBytes: 5 })).toThrow();
    expect(() => snapshotBoundedJson({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toThrow();
    expect(() => snapshotBoundedJson([1, 2, 3], { maxArrayLength: 2 })).toThrow();
    expect(() => snapshotBoundedJson({ longkey: 1 }, { maxKeyLength: 4 })).toThrow();
    expect(() => snapshotBoundedJson([1, 2, 3], { maxNodes: 3 })).toThrow();
  });
});

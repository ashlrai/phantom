import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindOwnDataMethod,
  captureStrictOwnDataOptions,
  cloneCanonicalEngineeringData,
  containsPath,
  engineeringDigest,
  failResourceSupervisor,
  hasExactEngineeringKeys,
  hasExactEngineeringOwnKeys,
  isBoundedEngineeringText,
  isCanonicalAbsoluteNonRootPath,
  isCanonicalEngineeringCharPath,
  isCanonicalEngineeringPath,
  isEngineeringCommit,
  isEngineeringGraphId,
  isEngineeringHash,
  isEngineeringId,
  isEngineeringInteger,
  isEngineeringIsoTimestamp,
  isEngineeringObject,
  pathExistsStrict,
  pathsOverlap,
  resolveTsxWorkerEntrypoint,
  writeExclusivePrivateJson,
} from '../src/core/resources/engineering-shared.js';
import { ResourceSupervisorError } from '../src/core/resources/pool-supervisor.js';
import {
  quoteAshlrCommand,
  reportResourceCheckError,
  resourceCheckSha256,
  ResourceCheckUsageError,
} from '../src/cli/resource-check-options.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-eng-shared-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('engineering-shared validators and predicates', () => {
  it('validates ids, graph ids, digests, commits, timestamps and integers', () => {
    expect(isEngineeringId('eng-1_a')).toBe(true);
    expect(isEngineeringId('Eng-1')).toBe(false);
    expect(isEngineeringId('-bad')).toBe(false);
    expect(isEngineeringGraphId('Graph_1-a')).toBe(true);
    expect(isEngineeringGraphId('')).toBe(false);

    expect(isEngineeringHash('a'.repeat(64))).toBe(true);
    expect(isEngineeringHash('A'.repeat(64))).toBe(false);
    expect(isEngineeringHash('a'.repeat(63))).toBe(false);

    expect(isEngineeringCommit('b'.repeat(40))).toBe(true);
    expect(isEngineeringCommit('c'.repeat(64))).toBe(true);
    expect(isEngineeringCommit('d'.repeat(41))).toBe(false);

    expect(isEngineeringIsoTimestamp('2026-11-26T04:00:00.000Z')).toBe(true);
    expect(isEngineeringIsoTimestamp('2026-11-26T04:00:00Z')).toBe(false);
    expect(isEngineeringIsoTimestamp('not-a-date')).toBe(false);

    expect(isEngineeringInteger(5, 1, 10)).toBe(true);
    expect(isEngineeringInteger(0, 1, 10)).toBe(false);
    expect(isEngineeringInteger(1.5, 1, 10)).toBe(false);
    expect(isEngineeringInteger('5', 1, 10)).toBe(false);
  });

  it('distinguishes enumerable key checks from strict own-key checks', () => {
    expect(isEngineeringObject({ a: 1 })).toBe(true);
    expect(isEngineeringObject(null)).toBe(false);
    expect(isEngineeringObject([])).toBe(false);

    const hidden = { a: 1 };
    Object.defineProperty(hidden, 'secret', { value: 2, enumerable: false });
    expect(hasExactEngineeringKeys(hidden, ['a'])).toBe(true);
    expect(hasExactEngineeringOwnKeys(hidden, ['a'])).toBe(false);

    const sym = Symbol('extra');
    const withSym = { a: 1, [sym]: 2 };
    expect(hasExactEngineeringKeys(withSym, ['a'])).toBe(true);
    expect(hasExactEngineeringOwnKeys(withSym, ['a'])).toBe(false);
    expect(hasExactEngineeringOwnKeys({ a: 1, b: 2 }, ['a', 'b'])).toBe(true);
  });

  it('validates bounded text and canonical engineering paths', () => {
    expect(isBoundedEngineeringText('ok\tline\nnext\r', 32)).toBe(true);
    expect(isBoundedEngineeringText('   ', 32)).toBe(false);
    expect(isBoundedEngineeringText('bad\x00char', 32)).toBe(false);
    expect(isBoundedEngineeringText('bad\x7fchar', 32)).toBe(false);
    expect(isBoundedEngineeringText('éé', 3)).toBe(false);
    expect(isBoundedEngineeringText('éé', 4)).toBe(true);

    expect(isCanonicalAbsoluteNonRootPath('/tmp/work')).toBe(true);
    expect(isCanonicalAbsoluteNonRootPath('/')).toBe(false);
    expect(isCanonicalAbsoluteNonRootPath('/tmp/../work')).toBe(false);
    expect(isCanonicalAbsoluteNonRootPath('relative/path')).toBe(false);

    expect(isCanonicalEngineeringPath('/tmp/work')).toBe(true);
    expect(isCanonicalEngineeringPath('/tmp/bad\npath')).toBe(false);
    const multibytePath = '/' + 'é'.repeat(2049);
    expect(multibytePath.length).toBe(2050);
    expect(Buffer.byteLength(multibytePath)).toBe(4099);
    expect(isCanonicalEngineeringPath(multibytePath)).toBe(false);
    expect(isCanonicalEngineeringCharPath(multibytePath)).toBe(true);
  });
});

describe('engineering-shared cloning, paths, files and capabilities', () => {
  it('clones canonical data and enforces byte bounds and supervisor errors', () => {
    const cloned = cloneCanonicalEngineeringData<{ b: number; a: number }>({ b: 2, a: 1 }, 64, () => {
      throw new Error('bad');
    });
    expect(cloned).toEqual({ a: 1, b: 2 });
    expect(engineeringDigest({ b: 2, a: 1 })).toBe(engineeringDigest({ a: 1, b: 2 }));

    expect(() => cloneCanonicalEngineeringData({ x: 'a'.repeat(100) }, 32, () =>
      failResourceSupervisor('INVALID_INPUT', 'too large'))).toThrow(ResourceSupervisorError);

    expect(() => cloneCanonicalEngineeringData({ bad: Number.NaN }, 64, () =>
      failResourceSupervisor('CONFLICT', 'non-finite'))).toThrow('non-finite');
  });

  it('checks path containment, overlap, existence and writes exclusive private json', () => {
    expect(containsPath('/a/b', '/a/b')).toBe(true);
    expect(containsPath('/a/b', '/a/b/c')).toBe(true);
    expect(containsPath('/a/b', '/a/bc')).toBe(false);
    expect(pathsOverlap('/a/b/c', '/a/b')).toBe(true);
    expect(pathsOverlap('/a/b', '/a/c')).toBe(false);

    const dir = makeTempDir();
    const target = join(dir, 'record.json');
    expect(pathExistsStrict(target)).toBe(false);

    writeExclusivePrivateJson(target, { b: 2, a: 1 });
    expect(pathExistsStrict(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('{"a":1,"b":2}\n');
    expect(statSync(target).mode & 0o777).toBe(0o600);

    expect(() => writeExclusivePrivateJson(target, { a: 1 })).toThrow();

    const linkTarget = join(dir, 'outside.json');
    writeFileSync(linkTarget, '{}');
    const link = join(dir, 'link.json');
    symlinkSync(linkTarget, link);
    expect(() => writeExclusivePrivateJson(link, { a: 1 })).toThrow();
  });

  it('captures strict own data options and binds own data methods without triggering getters', () => {
    let invoked = false;
    const withGetter = { a: 1 } as Record<string, unknown>;
    Object.defineProperty(withGetter, 'b', {
      enumerable: true,
      get() {
        invoked = true;
        return 2;
      },
    });
    expect(() => captureStrictOwnDataOptions(withGetter, ['a'], ['b'], () => {
      throw new Error('rejected');
    })).toThrow('rejected');
    expect(invoked).toBe(false);

    const source = { a: 1, opt: 'ok' };
    const captured = captureStrictOwnDataOptions(source, ['a'], ['opt'], () => {
      throw new Error('unexpected');
    });
    source.a = 99;
    expect(captured).toEqual({ a: 1, opt: 'ok' });

    class CustomHost {
      a = 1;
    }
    expect(() => captureStrictOwnDataOptions(new CustomHost(), ['a'], [], () => {
      throw new Error('proto');
    })).toThrow('proto');
    expect(captureStrictOwnDataOptions(new CustomHost(), ['a'], [], () => {
      throw new Error('proto');
    }, false)).toEqual({ a: 1 });

    const receiver = {
      tag: 'bound',
      read(this: { tag: string }) {
        return this.tag;
      },
    };
    const bound = bindOwnDataMethod(receiver, 'read', () => {
      throw new Error('invalid');
    });
    expect(bound()).toBe('bound');

    const protoObj = Object.create({ inherited() { return 'nope'; } }) as { inherited(): string };
    expect(() => bindOwnDataMethod(protoObj, 'inherited', () => {
      throw new Error('inherited');
    })).toThrow('inherited');
  });

  it('resolves worker entrypoints for source .ts and compiled .js modules', () => {
    const jsUrl = resolveTsxWorkerEntrypoint('file:///app/dist/core/resources/engineering-background.js', '/engineering-background.ts', 'engineering-background-worker');
    expect(jsUrl.href).toBe('file:///app/dist/core/resources/engineering-background-worker.js');

    const tsUrl = resolveTsxWorkerEntrypoint(
      new URL('../src/core/resources/engineering-background.ts', import.meta.url).href,
      '/engineering-background.ts',
      'engineering-background-worker',
    );
    expect(tsUrl.protocol).toBe('data:');
    expect(decodeURIComponent(tsUrl.pathname)).toContain('engineering-background-worker.ts');
  });
});

describe('resource-check-options shared CLI helpers', () => {
  it('validates optional and required SHA256 options', () => {
    const valid = 'a'.repeat(64);
    const values = new Map([['--expected-plan-digest', valid]]);
    expect(resourceCheckSha256(values, '--expected-plan-digest', 'bad digest', true)).toBe(valid);
    expect(resourceCheckSha256(new Map(), '--expected-plan-digest', 'bad digest')).toBeUndefined();
    expect(() => resourceCheckSha256(new Map(), '--expected-plan-digest', 'missing digest', true))
      .toThrow(ResourceCheckUsageError);
    expect(() => resourceCheckSha256(new Map([['--expected-plan-digest', 'xyz']]), '--expected-plan-digest', 'bad digest'))
      .toThrow('bad digest');
  });

  it('quotes CLI commands and formats usage vs runtime errors', () => {
    expect(quoteAshlrCommand(['resources', "it's", 'ok'])).toBe("node bin/ashlr 'resources' 'it'\\''s' 'ok'");

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(reportResourceCheckError(['--json'], new ResourceCheckUsageError('bad arg'), 'fallback')).toBe(2);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ error: 'bad arg' }));

    expect(reportResourceCheckError([], new Error('internal details'), 'safe fallback')).toBe(1);
    expect(errSpy).toHaveBeenCalledWith('safe fallback');
  });
});

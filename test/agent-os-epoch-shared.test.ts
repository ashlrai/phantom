import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  AGENT_OS_EPOCH_MAX_POLICY_GENERATION_V1,
  AGENT_OS_EPOCH_MAX_V1,
  AGENT_OS_EPOCH_PRIVATE_DIRECTORY_MODE,
  AGENT_OS_EPOCH_PRIVATE_FILE_MODE,
  DEFAULT_CANONICAL_EPOCH_BOUNDS,
  ROLLOVER_CANONICAL_EPOCH_BOUNDS,
  canonicalEpochBytes,
  canonicalEpochClone,
  canonicalEpochDomainBytes,
  canonicalEpochJson,
  canonicalEpochJsonDigest,
  decodeEpochBase64url,
  deepFreezeEpochValue,
  epochPlainRecord,
  epochToken,
  exactDenseEpochArray,
  exactEpochBytes,
  exactEpochKeys,
  exactOwnDataKeys,
  immutablePlainDataSnapshot,
  isPlainDataGraph,
  isPrivateEpochDirectory,
  isPrivateEpochFile,
  isValidEpoch,
  isValidEpochPolicyGeneration,
  isValidEpochTimestamp,
  isValidPrefixedEpochDigest,
  isValidRawEpochDigest,
  matchesEpochAuthority,
  nonProxyPlainRecord,
  ownDataPropertyValue,
  rawEpochDigest,
  sameEpochDigest,
  sameEpochFileIdentity,
  type EpochFileStatLike,
} from '../src/core/vision/agent-os-epoch-shared.js';
import {
  isValidAgentOsMonotonicAnchorCasResultV1,
  isValidAgentOsMonotonicAnchorReadResultV1,
} from '../src/core/vision/agent-os-rollover-protocol.js';

function fakeStat(overrides: Partial<EpochFileStatLike> = {}): EpochFileStatLike {
  const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : 0n;
  return {
    dev: 1n,
    ino: 2n,
    uid,
    mode: BigInt(AGENT_OS_EPOCH_PRIVATE_DIRECTORY_MODE),
    nlink: 1n,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
    ...overrides,
  };
}

describe('agent-os-epoch-shared helpers', () => {
  it('validates plain records, exact keys, and dense arrays strictly', () => {
    const nullProto = Object.assign(Object.create(null), { a: 1, b: 2 });
    expect(epochPlainRecord({ a: 1 })).toEqual({ a: 1 });
    expect(epochPlainRecord(nullProto)).toBe(nullProto);
    expect(epochPlainRecord(null)).toBeNull();
    expect(epochPlainRecord([])).toBeNull();
    expect(epochPlainRecord(new Date())).toBeNull();
    expect(epochPlainRecord({ get x() { return 1; } })).toBeNull();
    expect(epochPlainRecord(Object.defineProperty({}, 'hidden', { value: 1, enumerable: false }))).toBeNull();
    expect(epochPlainRecord({ [Symbol('k')]: 1 })).toBeNull();

    expect(exactEpochKeys({ b: 2, a: 1 }, ['a', 'b'])).toBe(true);
    expect(exactEpochKeys({ b: 2, a: 1 }, new Set(['a', 'b']))).toBe(true);
    expect(exactEpochKeys({ a: 1 }, ['a', 'b'])).toBe(false);
    expect(exactEpochKeys({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toBe(false);

    expect(exactDenseEpochArray([1, 'two'], 2)).toEqual([1, 'two']);
    expect(exactDenseEpochArray([1, 2, 3], 2)).toBeNull();
    expect(exactDenseEpochArray('not-array', 2)).toBeNull();
    // eslint-disable-next-line no-sparse-arrays
    expect(exactDenseEpochArray([1, , 3], 3)).toBeNull();
    const extraProp = Object.assign([1], { extra: true });
    expect(exactDenseEpochArray(extraProp, 2)).toBeNull();
    const getterArray: unknown[] = [];
    Object.defineProperty(getterArray, '0', { enumerable: true, get: () => 1 });
    expect(exactDenseEpochArray(getterArray, 2)).toBeNull();
  });

  it('deep-freezes nested objects with cycle and TypedArray safety', () => {
    const buf = new Uint8Array([1, 2, 3]);
    const node: Record<string, unknown> = { nested: { ok: true }, buf };
    node['self'] = node;
    const frozen = deepFreezeEpochValue(node);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen['nested'])).toBe(true);
    expect(frozen['buf']).toBe(buf);
  });

  it('canonicalizes integer-only JSON and enforces explicit bounds', () => {
    const bytes = canonicalEpochBytes({ b: 2, a: [1, { d: true, c: null }] });
    expect(bytes?.toString('utf8')).toBe('{"a":[1,{"c":null,"d":true}],"b":2}');
    expect(canonicalEpochClone({ z: 1, a: 2 })).toEqual({ a: 2, z: 1 });

    // Non-canonical numbers, non-plain objects, and cycles fail closed.
    expect(canonicalEpochBytes({ n: 1.5 })).toBeNull();
    expect(canonicalEpochBytes({ n: -0 })).toBeNull();
    expect(canonicalEpochBytes({ d: new Date() })).toBeNull();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(canonicalEpochBytes(cyclic)).toBeNull();

    // minBytes differs between DEFAULT (2) and ROLLOVER (1) for single-byte scalars.
    expect(canonicalEpochBytes(0, DEFAULT_CANONICAL_EPOCH_BOUNDS)).toBeNull();
    expect(canonicalEpochBytes(0, ROLLOVER_CANONICAL_EPOCH_BOUNDS)?.toString('utf8')).toBe('0');
    expect(canonicalEpochBytes({ a: 'x'.repeat(20) }, { minBytes: 2, maxBytes: 10, maxDepth: 4, maxNodes: 10 })).toBeNull();
    expect(canonicalEpochBytes({ a: { b: { c: 1 } } }, { minBytes: 2, maxBytes: 1024, maxDepth: 2, maxNodes: 100 })).toBeNull();
  });

  it('validates digests, epochs, policy generations, timestamps, base64url, and authority', () => {
    const raw = rawEpochDigest('domain\0', Buffer.from('payload', 'utf8'));
    expect(isValidRawEpochDigest(raw)).toBe(true);
    expect(isValidRawEpochDigest(raw.toUpperCase())).toBe(false);
    expect(isValidPrefixedEpochDigest(`sha256:${raw}`)).toBe(true);
    expect(isValidPrefixedEpochDigest(raw)).toBe(false);

    expect(exactEpochBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(exactEpochBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(exactEpochBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(sameEpochDigest(raw, raw)).toBe(true);
    expect(sameEpochDigest(raw, `${raw.slice(0, 63)}0` === raw ? `${raw.slice(0, 63)}1` : `${raw.slice(0, 63)}0`)).toBe(false);

    expect(isValidEpoch(1)).toBe(true);
    expect(isValidEpoch(AGENT_OS_EPOCH_MAX_V1)).toBe(true);
    expect(isValidEpoch(0)).toBe(false);
    expect(isValidEpoch(AGENT_OS_EPOCH_MAX_V1 + 1)).toBe(false);
    expect(epochToken(42)).toBe('000000000042');

    expect(isValidEpochPolicyGeneration(1)).toBe(true);
    expect(isValidEpochPolicyGeneration(AGENT_OS_EPOCH_MAX_POLICY_GENERATION_V1)).toBe(true);
    expect(isValidEpochPolicyGeneration(0)).toBe(false);
    expect(isValidEpochPolicyGeneration(AGENT_OS_EPOCH_MAX_POLICY_GENERATION_V1 + 1)).toBe(false);

    expect(isValidEpochTimestamp('2026-11-26T01:02:03.456Z')).toBe(true);
    expect(isValidEpochTimestamp('2026-11-26T01:02:03Z')).toBe(false);
    expect(isValidEpochTimestamp('2026-02-30T01:02:03.000Z')).toBe(false);

    const encoded = Buffer.from('hello-epoch', 'utf8').toString('base64url');
    expect(decodeEpochBase64url(encoded, 1, 64)?.toString('utf8')).toBe('hello-epoch');
    expect(decodeEpochBase64url(`${encoded}=`, 1, 64)).toBeNull();
    expect(decodeEpochBase64url(encoded, 32, 64)).toBeNull();

    const authority = Object.freeze({ authority: 'observation-only', executionAuthority: false });
    expect(matchesEpochAuthority({ authority: 'observation-only', executionAuthority: false, extra: 1 }, authority)).toBe(true);
    expect(matchesEpochAuthority({ authority: 'observation-only', executionAuthority: true }, authority)).toBe(false);
  });

  it('validates private stat ownership, modes, link counts, and file identity', () => {
    expect(isPrivateEpochDirectory(fakeStat())).toBe(true);
    expect(isPrivateEpochDirectory(fakeStat({ isSymbolicLink: () => true }))).toBe(false);
    if (process.platform !== 'win32') {
      expect(isPrivateEpochDirectory(fakeStat({ mode: 0o755n }))).toBe(false);
    }

    const fileStat = fakeStat({
      isDirectory: () => false,
      isFile: () => true,
      mode: BigInt(AGENT_OS_EPOCH_PRIVATE_FILE_MODE),
    });
    expect(isPrivateEpochFile(fileStat)).toBe(true);
    expect(isPrivateEpochFile(fakeStat({ ...fileStat, nlink: 2n }))).toBe(false);
    if (typeof process.getuid === 'function') {
      expect(isPrivateEpochFile(fakeStat({ ...fileStat, uid: BigInt(process.getuid()) + 1n }))).toBe(false);
    }

    expect(sameEpochFileIdentity({ dev: 7n, ino: 99n }, { dev: 7n, ino: 99n })).toBe(true);
    expect(sameEpochFileIdentity({ dev: 7n, ino: 99n }, { dev: 7n, ino: 100n })).toBe(false);
  });

  it('validates rollover anchor read and CAS results', () => {
    expect(isValidAgentOsMonotonicAnchorReadResultV1({ state: 'missing' })).toBe(true);
    expect(isValidAgentOsMonotonicAnchorReadResultV1({ state: 'present', canonicalHeadBytes: new Uint8Array([1]) })).toBe(true);
    expect(isValidAgentOsMonotonicAnchorReadResultV1({ state: 'present', canonicalHeadBytes: 'bad' })).toBe(false);
    expect(isValidAgentOsMonotonicAnchorReadResultV1({ state: 'missing', extra: true })).toBe(false);

    expect(isValidAgentOsMonotonicAnchorCasResultV1({ state: 'advanced', canonicalHeadBytes: new Uint8Array([1]) })).toBe(true);
    expect(isValidAgentOsMonotonicAnchorCasResultV1({ state: 'conflict', canonicalHeadBytes: null })).toBe(true);
    expect(isValidAgentOsMonotonicAnchorCasResultV1({ state: 'indeterminate' })).toBe(true);
    expect(isValidAgentOsMonotonicAnchorCasResultV1({ state: 'advanced', canonicalHeadBytes: null })).toBe(false);
    expect(isValidAgentOsMonotonicAnchorCasResultV1({ state: 'unknown' })).toBe(false);
  });

  it('validates non-proxy plain records, own data keys/values, plain data graphs, and canonical JSON digests', () => {
    const proxied = new Proxy({ a: 1 }, {});
    const nullProto = Object.assign(Object.create(null), { a: 1 });
    expect(nonProxyPlainRecord({ a: 1 })).toEqual({ a: 1 });
    expect(nonProxyPlainRecord(nullProto)).toBe(nullProto);
    expect(nonProxyPlainRecord(proxied)).toBeNull();
    expect(nonProxyPlainRecord([])).toBeNull();
    expect(nonProxyPlainRecord(new Date())).toBeNull();

    expect(exactOwnDataKeys({ b: 2, a: 1 }, ['a', 'b'])).toBe(true);
    expect(exactOwnDataKeys({ a: 1, [Symbol('s')]: 2 }, ['a'])).toBe(false);
    expect(exactOwnDataKeys({ get a() { return 1; } }, ['a'])).toBe(false);

    let getterCalls = 0;
    const withGetter = Object.defineProperty({ ok: 42 }, 'trap', {
      enumerable: true,
      get: () => { getterCalls += 1; return 'boom'; },
    });
    const inherited = Object.create({ parent: 'nope' }) as Record<string, unknown>;
    expect(ownDataPropertyValue(withGetter, 'ok')).toBe(42);
    expect(ownDataPropertyValue(withGetter, 'trap')).toBeUndefined();
    expect(getterCalls).toBe(0);
    expect(ownDataPropertyValue(inherited, 'parent')).toBeUndefined();
    expect(ownDataPropertyValue(proxied, 'a')).toBeUndefined();
    expect(ownDataPropertyValue(null, 'a')).toBeUndefined();

    const source = { nested: { list: [1, 2], flag: true } };
    const frozen = immutablePlainDataSnapshot(source);
    expect(frozen).toEqual(source);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen?.nested)).toBe(true);
    source.nested.list.push(99);
    expect(frozen?.nested.list).toEqual([1, 2]);

    expect(isPlainDataGraph({ ok: 1.5 })).toBe(false);
    expect(isPlainDataGraph(proxied)).toBe(false);
    expect(immutablePlainDataSnapshot(proxied, { rejectProxy: false })).toBeNull();
    expect(isPlainDataGraph(withGetter)).toBe(false);
    expect(isPlainDataGraph({ [Symbol('k')]: 1 })).toBe(false);
    expect(isPlainDataGraph({ list: [1] }, { allowArrays: false })).toBe(false);
    expect(isPlainDataGraph({ list: [1, 2, 3] }, { maxArrayLength: 2 })).toBe(false);
    expect(isPlainDataGraph({ a: { b: { c: 1 } } }, { maxDepth: 1 })).toBe(false);
    const shared = { x: 1 };
    expect(isPlainDataGraph({ left: shared, right: shared })).toBe(false);
    expect(immutablePlainDataSnapshot(withGetter)).toBeNull();

    const json = canonicalEpochJson({ z: 1, a: [{ d: true, c: null }] });
    expect(json).toBe('{"a":[{"c":null,"d":true}],"z":1}');
    expect(canonicalEpochDomainBytes('dom\0', { b: 2, a: 1 }).toString('utf8')).toBe('dom\0{"a":1,"b":2}');
    expect(canonicalEpochJsonDigest('dom\0', { b: 2, a: 1 })).toBe(
      rawEpochDigest('dom\0', Buffer.from('{"a":1,"b":2}', 'utf8')),
    );
  });

  it('keeps agent-os-epoch-shared pure with zero filesystem or network imports', () => {
    const source = readFileSync(
      new URL('../src/core/vision/agent-os-epoch-shared.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/from ['"]node:(?:fs|net|http|https|tls|dgram|child_process)/u);
  });
});

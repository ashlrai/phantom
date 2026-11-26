import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  canonicalValuesEqual,
  decodeCanonicalBase64url,
  decodeCanonicalJsonFrame,
  domainBytesSha256,
  domainCanonicalSha256,
  equalSha256Digest,
  formatStatSnapshotIdentity,
  hasExactKeys,
  isBoundedSingleLineText,
  isCanonicalTimestamp,
  isPathContained,
  isPlainRecord,
  parseStrictCanonicalJsonBytes,
  runtimePermitKeyId,
  sameStatIdentity,
  sameStatSnapshot,
  sha256Hex,
  strictCanonicalJson,
  strictDataRecord,
  verifyEd25519RuntimePermit,
  type RuntimeEd25519TrustRoot,
  type RuntimeStatSnapshot,
} from '../src/core/daemon/runtime-protocol-shared.js';

describe('runtime-protocol-shared', () => {
  describe('digests and canonical JSON', () => {
    it('hashes and compares lowercase sha256 digests in constant time', () => {
      const digest = sha256Hex('phantom-runtime');
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      expect(equalSha256Digest(digest, digest)).toBe(true);
      expect(equalSha256Digest(digest, digest.toUpperCase())).toBe(false);
      expect(equalSha256Digest(digest, sha256Hex('other'))).toBe(false);
      expect(equalSha256Digest('short', digest)).toBe(false);
    });

    it('canonicalizes JSON strictly and respects omitUndefinedProperties', () => {
      expect(strictCanonicalJson({ b: -0, a: [1, true, null, 'x'] })).toBe('{"a":[1,true,null,"x"],"b":0}');
      expect(() => strictCanonicalJson({ a: undefined })).toThrow('invalid JSON value');
      expect(strictCanonicalJson({ b: undefined, a: 1 }, { omitUndefinedProperties: true })).toBe('{"a":1}');
      expect(() => strictCanonicalJson(undefined, { omitUndefinedProperties: true }))
        .toThrow('undefined root JSON value');
      expect(() => strictCanonicalJson([undefined], { omitUndefinedProperties: true }))
        .toThrow('undefined JSON array entry');
      expect(() => strictCanonicalJson(Number.NaN)).toThrow('non-finite JSON number');
      expect(() => strictCanonicalJson(new Date())).toThrow('non-plain JSON object');

      const sparse = new Array(2);
      sparse[1] = 1;
      expect(() => strictCanonicalJson(sparse)).toThrow('sparse JSON array');

      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;
      expect(() => strictCanonicalJson(cyclic)).toThrow('invalid JSON value');

      expect(domainCanonicalSha256('domain:v1', { b: 2, a: 1 }))
        .toBe(domainBytesSha256('domain:v1', '{"a":1,"b":2}'));
    });

    it('parses canonical JSON byte envelopes and frames strictly', () => {
      const parsed = parseStrictCanonicalJsonBytes('{"a":1,"b":2}\n', 64, 'envelope', { requireObject: true });
      expect(parsed.canonicalJson).toBe('{"a":1,"b":2}\n');
      expect(parsed.value).toEqual({ a: 1, b: 2 });

      expect(() => parseStrictCanonicalJsonBytes('', 64, 'envelope')).toThrow('byte length is invalid');
      expect(() => parseStrictCanonicalJsonBytes(Buffer.from([0xff, 0xfe]), 64, 'envelope'))
        .toThrow('is not valid UTF-8');
      expect(() => parseStrictCanonicalJsonBytes('[1]\n', 64, 'envelope', { requireObject: true }))
        .toThrow('must be a JSON object');
      expect(() => parseStrictCanonicalJsonBytes('{"b":2,"a":1}\n', 64, 'envelope'))
        .toThrow('encoding is not canonical');

      const frame = decodeCanonicalJsonFrame('{"a":1}\n', 64, strictCanonicalJson);
      expect(frame).toEqual({ text: '{"a":1}\n', value: { a: 1 } });
      expect(decodeCanonicalJsonFrame('{"a":1}', 64, strictCanonicalJson)).toBeNull();
      expect(decodeCanonicalJsonFrame('{"b":2,"a":1}\n', 64, strictCanonicalJson)).toBeNull();
      expect(decodeCanonicalJsonFrame(Buffer.from([0xff, 0x0a]), 64, strictCanonicalJson)).toBeNull();

      expect(canonicalValuesEqual({ b: 2, a: 1 }, { a: 1, b: 2 }, strictCanonicalJson)).toBe(true);
      expect(canonicalValuesEqual({ a: 1 }, { a: 2 }, strictCanonicalJson)).toBe(false);
      expect(canonicalValuesEqual({ a: Number.NaN }, { a: 1 }, strictCanonicalJson)).toBe(false);
    });
  });

  describe('records, text, timestamps, base64url, paths and stat snapshots', () => {
    it('validates plain records, exact keys and strict enumerable data records', () => {
      expect(isPlainRecord({ a: 1 })).toBe(true);
      expect(isPlainRecord(Object.create(null))).toBe(true);
      expect(isPlainRecord(null)).toBe(false);
      expect(isPlainRecord([])).toBe(false);
      expect(isPlainRecord(new Map())).toBe(false);

      expect(hasExactKeys({ b: 2, a: 1 }, ['a', 'b'])).toBe(true);
      expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false);

      expect(strictDataRecord({ b: 2, a: 1 }, ['a', 'b'])).toEqual({ b: 2, a: 1 });
      const withGetter = Object.defineProperty({}, 'a', { enumerable: true, get: () => 1 });
      expect(strictDataRecord(withGetter, ['a'])).toBeNull();
      const withSymbol = { a: 1, [Symbol('s')]: 2 };
      expect(strictDataRecord(withSymbol, ['a'])).toBeNull();
      const hostileProxy = new Proxy({}, {
        ownKeys() {
          throw new Error('trap');
        },
      });
      expect(strictDataRecord(hostileProxy, [])).toBeNull();
    });

    it('validates canonical timestamps, base64url, single-line text and path containment', () => {
      expect(isCanonicalTimestamp('2026-11-26T00:00:00.000Z')).toBe(true);
      expect(isCanonicalTimestamp('2026-11-26T00:00:00Z')).toBe(false);
      expect(isCanonicalTimestamp('not-a-date')).toBe(false);

      const raw = Buffer.from('0123456789abcdef', 'utf8');
      const encoded = raw.toString('base64url');
      expect(decodeCanonicalBase64url(encoded, 16)?.equals(raw)).toBe(true);
      expect(decodeCanonicalBase64url(encoded, 15)).toBeNull();
      expect(decodeCanonicalBase64url(encoded, undefined, 8)).toBeNull();
      expect(decodeCanonicalBase64url(`${encoded}=`)).toBeNull();
      expect(decodeCanonicalBase64url('A')).toBeNull();

      expect(isBoundedSingleLineText('release/bin', 32)).toBe(true);
      expect(isBoundedSingleLineText('', 32)).toBe(false);
      expect(isBoundedSingleLineText('a\nb', 32)).toBe(false);
      expect(isBoundedSingleLineText('a\0b', 32)).toBe(false);

      expect(isPathContained('/root', '/root/sub/file')).toBe(true);
      expect(isPathContained('/root', '/root')).toBe(false);
      expect(isPathContained('/root', '/root', true)).toBe(true);
      expect(isPathContained('/root', '/root-sibling/file')).toBe(false);
      expect(isPathContained('/root', '/other')).toBe(false);
    });

    it('compares and formats BigInt stat identities and snapshots', () => {
      const base: RuntimeStatSnapshot = {
        dev: 1n,
        ino: 2n,
        mode: 0o100444n,
        uid: 501n,
        gid: 20n,
        nlink: 1n,
        size: 128n,
        mtimeNs: 1000n,
        ctimeNs: 2000n,
      };
      expect(sameStatIdentity(base, { dev: 1n, ino: 2n })).toBe(true);
      expect(sameStatIdentity(base, { dev: 1n, ino: 3n })).toBe(false);
      expect(sameStatSnapshot(base, { ...base })).toBe(true);
      expect(sameStatSnapshot(base, { ...base, mtimeNs: 1001n })).toBe(false);
      expect(formatStatSnapshotIdentity(base)).toBe(`1:2:${0o100444}:501:20:1:128:1000:2000`);
    });
  });

  describe('verifyEd25519RuntimePermit', () => {
    const domain = 'ashlr:test-runtime-permit:v1';
    const issuedAt = '2026-11-26T00:00:00.000Z';
    const expiresAt = '2026-11-26T00:01:00.000Z';
    const nowMs = Date.parse('2026-11-26T00:00:30.000Z');
    const keyIdPattern = /^[a-f0-9]{64}$/;

    function makeFixture() {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const keyId = runtimePermitKeyId(domain, publicKey);
      const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
      const signingBytes = Buffer.from(`${domain}\0{"ok":true}`, 'utf8');
      const signature = sign(null, signingBytes, privateKey).toString('base64url');
      const root: RuntimeEd25519TrustRoot = {
        algorithm: 'ed25519',
        keyId,
        publicKeySpki: spki,
        validFrom: '2026-11-25T00:00:00.000Z',
        validUntil: '2026-11-27T00:00:00.000Z',
      };
      return { keyId, root, signature, signingBytes };
    }

    it('accepts a valid signed permit and rejects window, root and signature violations', () => {
      const f = makeFixture();
      const base = {
        label: 'test permit',
        permitDomain: domain,
        issuedAt,
        expiresAt,
        keyId: f.keyId,
        signature: f.signature,
        signingBytes: f.signingBytes,
        roots: [f.root],
        nowMs,
        maxValidityMs: 120_000,
        maxFutureSkewMs: 30_000,
        keyIdPattern,
        maxRoots: 8,
        requireOrderedRootWindow: true,
      };

      expect(verifyEd25519RuntimePermit(base)).toBeNull();
      expect(verifyEd25519RuntimePermit({ ...base, nowMs: Date.parse(expiresAt) }))
        .toBe('test permit permit is outside its validity window');
      expect(verifyEd25519RuntimePermit({ ...base, roots: [f.root, f.root] }))
        .toBe('test permit signing root is unavailable');
      expect(verifyEd25519RuntimePermit({
        ...base,
        roots: [{ ...f.root, validFrom: '2026-11-27T00:00:00.000Z', validUntil: '2026-11-26T00:00:00.000Z' }],
      })).toBe('test permit signing root is unavailable');
      expect(verifyEd25519RuntimePermit({ ...base, maxRoots: 0 }))
        .toBe('test permit signing root is unavailable');
      expect(verifyEd25519RuntimePermit({ ...base, signingBytes: Buffer.from('tampered', 'utf8') }))
        .toBe('test permit permit signature is invalid');
    });
  });
});

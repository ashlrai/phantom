import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  VERIFIER_EXECUTION_DIGEST_RE,
  VERIFIER_EXECUTION_PLATFORMS,
  canonicalBase64Url,
  canonicalIso,
  denseArray,
  ed25519KeyId,
  exactPlainRecord,
  plainDataGraph,
  sha256Domain,
  sortedEnumArray,
  verifiedEd25519PublicKey,
  verifyEd25519Signature,
} from '../src/core/run/verifier-execution-shared.js';
import {
  VERIFIER_EXECUTION_SIGNATURE_ALGORITHM,
  VERIFIER_EXECUTION_TRUST_PROTOCOL_V1,
  verifierExecutionAuthorityKeyId,
  verifierExecutionAuthorityTrustPolicyDigest,
} from '../src/core/run/verifier-execution-authority.js';
import {
  verifierExecutionApprovedTrustPolicyDigestV1,
  verifierExecutionPolicyApproverKeyId,
} from '../src/core/run/verifier-execution-policy-approval.js';

function exportSpkiBase64Url(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).toString('base64url');
}

describe('verifier-execution shared helpers', () => {
  it('computes domain-separated SHA-256 digests consistently across string and binary parts', () => {
    const payload = Buffer.from('payload-bytes', 'utf8');
    const suffix = Buffer.from([1, 2, 3, 4]);
    const expected = createHash('sha256')
      .update(Buffer.concat([Buffer.from('domain:v1\0', 'utf8'), payload, suffix]))
      .digest('hex');

    expect(VERIFIER_EXECUTION_DIGEST_RE.test(expected)).toBe(true);
    expect(VERIFIER_EXECUTION_DIGEST_RE.test(expected.toUpperCase())).toBe(false);
    expect(sha256Domain('domain:v1', payload, suffix)).toBe(expected);
    expect(sha256Domain('domain:v1', 'payload-bytes', suffix)).toBe(expected);
    expect(sha256Domain('domain:v2', payload, suffix)).not.toBe(expected);
  });

  it('rejects getters, custom prototypes, cyclic graphs, and sparse arrays', () => {
    expect(exactPlainRecord({ a: 1, b: 2 }, ['b', 'a'])).toBe(true);
    expect(exactPlainRecord(Object.assign(Object.create(null), { a: 1 }), ['a'])).toBe(true);
    expect(exactPlainRecord({ a: 1 }, ['a', 'b'])).toBe(false);
    expect(exactPlainRecord(new Date(), [])).toBe(false);

    const withGetter = {};
    Object.defineProperty(withGetter, 'a', { enumerable: true, get: () => 1 });
    expect(exactPlainRecord(withGetter, ['a'])).toBe(false);

    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(plainDataGraph(cyclic)).toBe(false);

    const shared = { x: 1 };
    expect(plainDataGraph({ a: shared, b: shared })).toBe(false);

    let deep: unknown = { leaf: true };
    for (let i = 0; i < 10; i += 1) deep = { child: deep };
    expect(plainDataGraph(deep)).toBe(false);

    const sparse = new Array(2);
    sparse[0] = 'only-zero';
    expect(denseArray(sparse, 1, 4)).toBe(false);
    expect(denseArray(Object.assign(['a'], { extra: true }), 1, 4)).toBe(false);
    expect(denseArray(['a', 'b'], 1, 2)).toBe(true);
  });

  it('enforces canonical ISO-8601 timestamps, canonical base64url, and sorted unique enums', () => {
    expect(canonicalIso('2026-08-02T15:00:00.000Z')).toBe(true);
    expect(canonicalIso('2026-08-02T15:00:00Z')).toBe(false);
    expect(canonicalIso('2026-08-02T15:00:00.000+00:00')).toBe(false);

    const exact = Buffer.alloc(24, 9).toString('base64url');
    expect(canonicalBase64Url(exact, 24)?.length).toBe(24);
    expect(canonicalBase64Url(exact, 16, 64)?.length).toBe(24);
    expect(canonicalBase64Url(exact, 32)).toBeNull();
    expect(canonicalBase64Url(`${exact}=`, 24)).toBeNull();

    expect(sortedEnumArray(['darwin', 'linux'], VERIFIER_EXECUTION_PLATFORMS)).toBe(true);
    expect(sortedEnumArray(['linux', 'darwin'], VERIFIER_EXECUTION_PLATFORMS)).toBe(false);
    expect(sortedEnumArray(['linux', 'linux'], VERIFIER_EXECUTION_PLATFORMS)).toBe(false);
  });

  it('parses canonical Ed25519 SPKI keys, separates key-id domains, and verifies signatures', () => {
    const ed = generateKeyPairSync('ed25519');
    const spki = exportSpkiBase64Url(ed.publicKey);
    const domainA = 'ashlr:test-domain-a:v1';
    const domainB = 'ashlr:test-domain-b:v1';

    const keyIdA = ed25519KeyId(domainA, spki);
    const keyIdB = ed25519KeyId(domainB, spki);
    expect(keyIdA).toMatch(VERIFIER_EXECUTION_DIGEST_RE);
    expect(keyIdB).toMatch(VERIFIER_EXECUTION_DIGEST_RE);
    expect(keyIdA).not.toBe(keyIdB);

    const parsedKey = verifiedEd25519PublicKey(domainA, spki, keyIdA!);
    expect(parsedKey).not.toBeNull();
    expect(verifiedEd25519PublicKey(domainA, spki, keyIdB!)).toBeNull();

    const payload = Buffer.from('canonical-statement-payload', 'utf8');
    const sig = sign(null, payload, ed.privateKey).toString('base64url');
    expect(verifyEd25519Signature(payload, parsedKey!, sig)?.length).toBe(64);
    expect(verifyEd25519Signature(Buffer.from('tampered', 'utf8'), parsedKey!, sig)).toBeNull();
    expect(verifyEd25519Signature(payload, parsedKey!, `${sig}=`)).toBeNull();

    const rsaSpki = exportSpkiBase64Url(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey);
    expect(ed25519KeyId(domainA, rsaSpki)).toBeNull();
    expect(verifiedEd25519PublicKey(domainA, rsaSpki, keyIdA!)).toBeNull();
  });

  it('keeps approved trust-policy digest identical to capsule authority trust-policy digest', () => {
    const capsule = generateKeyPairSync('ed25519');
    const spki = exportSpkiBase64Url(capsule.publicKey);
    const keyId = verifierExecutionAuthorityKeyId(spki)!;

    expect(keyId).not.toBe(verifierExecutionPolicyApproverKeyId(spki));

    const policy = {
      schemaVersion: 1 as const,
      protocol: VERIFIER_EXECUTION_TRUST_PROTOCOL_V1,
      policyVersion: 'shared-parity-2026-11',
      keys: [{
        keyId,
        signatureAlgorithm: VERIFIER_EXECUTION_SIGNATURE_ALGORITHM,
        role: 'verifier-capsule-admission-signer' as const,
        publicKeySpki: spki,
        notBefore: '2026-08-02T14:00:00.000Z',
        notAfter: '2026-08-02T16:00:00.000Z',
        allowedPlatforms: ['darwin', 'linux', 'win32'],
        allowedArchitectures: ['arm64', 'x64'],
        allowedBackends: [
          'linux-namespace-cgroup-broker',
          'macos-virtualization-framework-broker',
          'windows-appcontainer-job-broker',
        ],
      }],
    };

    const authorityDigest = verifierExecutionAuthorityTrustPolicyDigest(policy);
    expect(authorityDigest).toMatch(VERIFIER_EXECUTION_DIGEST_RE);
    expect(verifierExecutionApprovedTrustPolicyDigestV1(policy)).toBe(authorityDigest);
    expect(verifierExecutionApprovedTrustPolicyDigestV1({ ...policy, keys: [] })).toBeNull();
  });
});

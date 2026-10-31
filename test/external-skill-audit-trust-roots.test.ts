import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_SKILL_AUDIT_SIGNATURE_ALGORITHM,
  EXTERNAL_SKILL_AUDIT_SIGNER_ROLE,
  EXTERNAL_SKILL_AUDIT_TRUST_PROTOCOL,
  EXTERNAL_SKILL_AUDIT_TRUST_POLICY,
} from '../src/core/fleet/external-skill-audit-trust-roots.js';

describe('EXTERNAL_SKILL_AUDIT_TRUST_PROTOCOL', () => {
  it('is the expected protocol string', () => {
    expect(EXTERNAL_SKILL_AUDIT_TRUST_PROTOCOL).toBe(
      'ashlr-external-skill-audit-trust-v1',
    );
  });
});

describe('EXTERNAL_SKILL_AUDIT_SIGNER_ROLE', () => {
  it('is the expected signer role string', () => {
    expect(EXTERNAL_SKILL_AUDIT_SIGNER_ROLE).toBe(
      'external-skill-audit-verifier',
    );
  });
});

describe('EXTERNAL_SKILL_AUDIT_SIGNATURE_ALGORITHM', () => {
  it('is the expected algorithm string', () => {
    expect(EXTERNAL_SKILL_AUDIT_SIGNATURE_ALGORITHM).toBe('ed25519');
  });
});

describe('EXTERNAL_SKILL_AUDIT_TRUST_POLICY', () => {
  it('has schemaVersion 1, matching protocol, generation 0, and empty roots', () => {
    const policy = EXTERNAL_SKILL_AUDIT_TRUST_POLICY;
    expect(policy.schemaVersion).toBe(1);
    expect(policy.protocol).toBe(EXTERNAL_SKILL_AUDIT_TRUST_PROTOCOL);
    expect(policy.policyGeneration).toBe(0);
    expect(Array.isArray(policy.roots)).toBe(true);
    expect(policy.roots).toHaveLength(0);
  });

  it('prevents mutation of roots and the policy object itself', () => {
    const policy = EXTERNAL_SKILL_AUDIT_TRUST_POLICY;
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.roots)).toBe(true);
    expect(() => {
      (policy as any).schemaVersion = 2;
    }).toThrow();
    expect(() => {
      (policy.roots as any[]).push({
        keyId: 'k',
        publicKeySpki: 's',
        signerRole: 'external-skill-audit-verifier',
        signatureAlgorithm: 'ed25519',
        auditPolicyDigest: 'd',
        notBefore: '2026-01-01T00:00:00.000Z',
        notAfter: '2027-01-01T00:00:00.000Z',
        revokedAt: null,
      });
    }).toThrow();
  });
});

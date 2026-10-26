import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  parseReleasePathPolicyBytes,
  validateReleasePathPolicy,
  verifyPublishedRelease,
} from '../scripts/verify-release-policy.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const policyPath = join(repoRoot, '.github', 'release-policies', 'release-path-v2.json');
const candidate = '3'.repeat(40);
const tarball = Buffer.from('synthetic qualified archive bytes');
const hex = createHash('sha512').update(tarball).digest('hex');
const sri = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;

function policy(): Record<string, unknown> {
  return structuredClone(parseReleasePathPolicyBytes(readFileSync(policyPath)).policy) as Record<string, unknown>;
}

function evidence(over: Record<string, unknown> = {}) {
  const statement = {
    subject: [{ name: 'pkg:npm/%40ashlr/phantom@3.29.15', digest: { sha512: hex } }],
    predicate: { buildDefinition: { externalParameters: { workflow: {
      ref: 'refs/heads/master',
      repository: 'https://github.com/ashlrai/phantom',
      path: '.github/workflows/publish-canonical-npm.yml',
    } } } },
  };
  return {
    versionDocument: { name: '@ashlr/phantom', version: '3.29.15', dist: { integrity: sri, attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } } },
    attestations: { attestations: [
      { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: {} },
      { predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } } },
    ] },
    tarball,
    tagRef: { ref: 'refs/tags/v3.29.15', object: { type: 'commit', sha: candidate } },
    ciRun: { id: 1, path: '.github/workflows/ci.yml', repository: { html_url: 'https://github.com/ashlrai/phantom' }, head_sha: candidate, status: 'completed', conclusion: 'success' },
    candidateRevision: candidate,
    ...over,
  };
}

describe('release-path policy v2', () => {
  it('ships one canonical static policy allowing @ashlr/hub and @ashlr/phantom with no authority', () => {
    const { policy: parsed } = parseReleasePathPolicyBytes(readFileSync(policyPath));
    expect(parsed.packages).toEqual(['@ashlr/hub', '@ashlr/phantom']);
    expect(Object.values(parsed.authority).filter((value) => value !== 'evidence-only')).toEqual(Array(6).fill(false));
  });

  it('accepts a release whose archive matches the registry integrity, provenance, tag and green CI', () => {
    expect(verifyPublishedRelease(policy(), evidence())).toMatchObject({ ok: true, package: '@ashlr/phantom', integrity: sri });
  });

  it('rejects a package outside the allowlist and a widened policy', () => {
    const doc = evidence().versionDocument;
    expect(() => verifyPublishedRelease(policy(), evidence({ versionDocument: { ...doc, name: '@ashlr/other' } }))).toThrow(/allowlist/u);
    expect(() => validateReleasePathPolicy({ ...policy(), registry: 'https://example.invalid/' })).toThrow(/registry/u);
    expect(() => validateReleasePathPolicy({ ...policy(), extra: true })).toThrow(/closed schema/u);
  });

  it('rejects archive bytes that differ from the registry-reported integrity', () => {
    expect(() => verifyPublishedRelease(policy(), evidence({ tarball: Buffer.from('other') }))).toThrow(/registry-reported integrity/u);
  });

  it('rejects missing or foreign provenance', () => {
    expect(() => verifyPublishedRelease(policy(), evidence({ attestations: { attestations: [] } }))).toThrow();
    const e = evidence();
    const payload = JSON.parse(Buffer.from(e.attestations.attestations[1]!.bundle.dsseEnvelope!.payload, 'base64').toString());
    payload.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/other.yml';
    e.attestations.attestations[1]!.bundle.dsseEnvelope!.payload = Buffer.from(JSON.stringify(payload)).toString('base64');
    expect(() => verifyPublishedRelease(policy(), e)).toThrow(/publisher/u);
  });

  it('rejects a tag that is not v<version> on the candidate and a CI run that is not green', () => {
    expect(() => verifyPublishedRelease(policy(), evidence({ tagRef: { ref: 'refs/tags/v3.29.14', object: { type: 'commit', sha: candidate } } }))).toThrow(/tag/u);
    expect(() => verifyPublishedRelease(policy(), evidence({ tagRef: { ref: 'refs/tags/v3.29.15', object: { type: 'commit', sha: '4'.repeat(40) } } }))).toThrow(/candidate/u);
    const ci = evidence().ciRun;
    expect(() => verifyPublishedRelease(policy(), evidence({ ciRun: { ...ci, conclusion: 'failure' } }))).toThrow(/not green/u);
    expect(() => verifyPublishedRelease(policy(), evidence({ ciRun: { ...ci, head_sha: '5'.repeat(40) } }))).toThrow(/different revision/u);
  });
});

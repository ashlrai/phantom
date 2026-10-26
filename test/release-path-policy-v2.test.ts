import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  parseReleasePathPolicyBytes,
  validateReleasePathPolicy,
  verifyPublishedRelease,
  verifyRequiredChecks,
  verifyCandidateOnProtectedBranch,
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

function green(event: string, over: Record<string, unknown> = {}) {
  return { name: 'Merge Gate', appId: 15368, status: 'completed', conclusion: 'success', event, headBranch: event === 'push' ? 'master' : 'gh-readonly-queue/master/pr-1', ...over };
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
    compare: { status: 'behind' },
    requiredChecks: ['Merge Gate'],
    checkRuns: [
      green('merge_group'),
      green('push'),
      { ...green('pull_request'), conclusion: 'failure' },
    ],
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

  it('rejects a tag that is not v<version> on the candidate', () => {
    expect(() => verifyPublishedRelease(policy(), evidence({ tagRef: { ref: 'refs/tags/v3.29.14', object: { type: 'commit', sha: candidate } } }))).toThrow(/tag/u);
    expect(() => verifyPublishedRelease(policy(), evidence({ tagRef: { ref: 'refs/tags/v3.29.15', object: { type: 'commit', sha: '4'.repeat(40) } } }))).toThrow(/candidate/u);
  });
});

describe('release-path policy v2 required checks on the release SHA', () => {
  const p = () => policy();
  it('accepts when every required name has only green merge_group or master push runs (PR runs ignored)', () => {
    expect(verifyRequiredChecks(p(), ['Merge Gate'], evidence().checkRuns)).toEqual(['Merge Gate']);
  });
  it('rejects a missing required name', () => {
    expect(() => verifyRequiredChecks(p(), ['Merge Gate', 'Other'], [green('push')])).toThrow(/missing.*Other/u);
  });
  it('rejects a failed duplicate', () => {
    expect(() => verifyRequiredChecks(p(), ['Merge Gate'], [green('merge_group'), green('push', { conclusion: 'failure' })])).toThrow(/not green/u);
  });
  it('rejects a pending duplicate', () => {
    expect(() => verifyRequiredChecks(p(), ['Merge Gate'], [green('push'), green('merge_group', { status: 'in_progress', conclusion: null })])).toThrow(/not green/u);
  });
  it('ignores another app with the same name, so it cannot satisfy the check', () => {
    expect(() => verifyRequiredChecks(p(), ['Merge Gate'], [green('push', { appId: 99 })])).toThrow(/missing/u);
  });
  it('rejects PR-event-only evidence and pushes to other branches', () => {
    expect(() => verifyRequiredChecks(p(), ['Merge Gate'], [green('pull_request')])).toThrow(/missing/u);
    expect(() => verifyRequiredChecks(p(), ['Merge Gate'], [green('push', { headBranch: 'codex/x' })])).toThrow(/missing/u);
  });
  it('fails the full release verification when CI on the release SHA is red', () => {
    expect(() => verifyPublishedRelease(policy(), evidence({ checkRuns: [green('push', { conclusion: 'failure' })] }))).toThrow(/not green/u);
  });
  it('rejects a candidate that is not on master (diverged or ahead), even with green checks', () => {
    expect(() => verifyPublishedRelease(policy(), evidence({ compare: { status: 'diverged' } }))).toThrow(/not a merged commit/u);
    expect(() => verifyPublishedRelease(policy(), evidence({ compare: { status: 'ahead' } }))).toThrow(/not a merged commit/u);
    expect(() => verifyCandidateOnProtectedBranch({})).toThrow(/not a merged commit/u);
  });
  it('accepts a candidate on master (tip or ancestor) with green Merge Gate', () => {
    expect(verifyCandidateOnProtectedBranch({ status: 'identical' })).toBe('identical');
    expect(verifyPublishedRelease(policy(), evidence({ compare: { status: 'identical' }, checkRuns: [green('push')] }))).toMatchObject({ ok: true });
    expect(verifyPublishedRelease(policy(), evidence({ compare: { status: 'behind' }, checkRuns: [green('merge_group')] }))).toMatchObject({ ok: true });
  });
});
